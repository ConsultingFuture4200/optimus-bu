import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { query } from '../../lib/db.js';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookup } from 'dns/promises';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { spawnCLI } from '../../lib/runtime/spawn-cli.js';
import { extractBusinessContext, generateStrategyBrief } from '../redesign-strategy/index.js';

const designSystem = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/design-system.json', import.meta.url), 'utf-8')
);

// Pre-compute framework color set for brand detection filtering
const FRAMEWORK_COLORS = new Set([
  ...designSystem.frameworkColors.bootstrap,
  ...designSystem.frameworkColors.tailwind,
  ...designSystem.frameworkColors.material,
]);

/**
 * Executor-Redesign agent: scrape → analyze → generate → review website redesigns.
 *
 * Runs on Jamie M1. Polls the task graph for website_redesign work items,
 * claims them atomically, and produces a self-contained HTML redesign.
 *
 * Pipeline:
 *   -1. Check design system cache (24h TTL, same URL)
 *   0. Lighthouse audit on original URL
 *   1. Scrape target URL with Playwright (HTML + design data + AEO audit)
 *   2. Analyze design with Claude Sonnet API (structured JSON output)
 *   2.1 Extract business context (pure JS, $0)
 *   2.2 Generate strategy brief (template, $0)
 *   2.3 Build structured design system → design-system.json (or use cache)
 *   2.4 Validate design system against JSON schema (P2 enforcement)
 *   2.5 Render design-brief.md FROM validated design system
 *   3. Generate redesign with Claude Code CLI (Pass 1) — strategic design partner
 *   4. Parallel review: Delphi (UI/UX + strategy) + Linus (code quality)
 *   5. Apply combined feedback (Pass 3)
 *   6. Audit redesign, store in Postgres (including design system + strategy rationale)
 *
 * Gates: G1 (budget), G6 (rate limiting in API layer)
 * Security: URL validation in API layer (SSRF), script stripping on output
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', '..', 'data', 'redesigns');
const DEFAULT_MAX_BUDGET_USD = 2.00;
const SCRAPE_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes for generation pass
const FALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for fallback models
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per review pass
const DB_KEEPALIVE_INTERVAL_MS = 20_000; // ping DB every 20s during long ops

/**
 * Scrape a URL using Playwright.
 * Returns { html, title, meta, designData }.
 */
async function scrapeUrl(targetUrl, workDir) {
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) STAQS-Redesign-Bot/1.0',
    });

    // Try networkidle first (strict: zero requests for 500ms), but fall back to
    // domcontentloaded + settle delay for sites that never stop network activity
    // (analytics, chat widgets, background polling). RC2 fix.
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 10_000 });
    } catch {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });
      await page.waitForTimeout(2000);
    }

    // Extract page data
    const html = await page.content();
    const title = await page.title();
    const meta = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el?.getAttribute('content') || null;
      };
      return {
        description: getMeta('description') || getMeta('og:description'),
        ogImage: getMeta('og:image'),
        themeColor: getMeta('theme-color'),
      };
    });

    // Extract all SEO-critical elements for preservation in redesign
    const seoElements = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el?.getAttribute('content') || null;
      };
      const ogTags = {};
      for (const el of document.querySelectorAll('meta[property^="og:"]')) {
        ogTags[el.getAttribute('property')] = el.getAttribute('content');
      }
      const jsonLd = [];
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { jsonLd.push(JSON.parse(script.textContent)); } catch {}
      }
      const canonical = document.querySelector('link[rel="canonical"]')?.href || null;
      const hreflang = [];
      for (const el of document.querySelectorAll('link[rel="alternate"][hreflang]')) {
        hreflang.push({ lang: el.getAttribute('hreflang'), href: el.href });
      }
      const robots = getMeta('robots');
      const lang = document.documentElement.getAttribute('lang');
      const headings = [];
      for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
        headings.push({ tag: h.tagName.toLowerCase(), text: h.textContent?.trim().slice(0, 120) });
      }
      const navLinks = [];
      for (const a of document.querySelectorAll('nav a[href], header a[href]')) {
        navLinks.push({ text: a.textContent?.trim().slice(0, 80), href: a.href });
      }
      return {
        title: document.title, metaDescription: getMeta('description'),
        canonical, lang, robots, ogTags, jsonLd, hreflang, headings, navLinks,
      };
    });

    writeFileSync(join(workDir, 'seo-elements.json'), JSON.stringify(seoElements, null, 2));

    const seoHeadLines = [];
    seoHeadLines.push('<meta charset="utf-8">');
    seoHeadLines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    if (seoElements.title) seoHeadLines.push(`<title>${seoElements.title}</title>`);
    if (seoElements.metaDescription) seoHeadLines.push(`<meta name="description" content="${seoElements.metaDescription.replace(/"/g, '&quot;')}">`);
    if (seoElements.canonical) seoHeadLines.push(`<link rel="canonical" href="${seoElements.canonical}">`);
    if (seoElements.lang) seoHeadLines.push(`<!-- IMPORTANT: Add lang="${seoElements.lang}" to the <html> tag -->`);
    if (seoElements.robots) seoHeadLines.push(`<meta name="robots" content="${seoElements.robots}">`);
    for (const [property, content] of Object.entries(seoElements.ogTags || {})) {
      if (content) seoHeadLines.push(`<meta property="${property}" content="${String(content).replace(/"/g, '&quot;')}">`);
    }
    for (const { lang: hLang, href } of (seoElements.hreflang || [])) {
      seoHeadLines.push(`<link rel="alternate" hreflang="${hLang}" href="${href}">`);
    }
    for (const block of (seoElements.jsonLd || [])) {
      seoHeadLines.push(`<script type="application/ld+json">${JSON.stringify(block, null, 2)}</script>`);
    }
    writeFileSync(join(workDir, 'seo-head.html'), seoHeadLines.join('\n'));
    console.log(`[executor-redesign] Generated seo-head.html with ${seoHeadLines.length} SEO elements`);

    // Extract computed styles and brand identity
    const frameworkColorList = [...FRAMEWORK_COLORS];
    const designData = await page.evaluate((fwColors) => {
      const frameworkColorSet = new Set(fwColors);
      const body = document.body;
      const computed = getComputedStyle(body);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5);

      // Helper: rgb string to hex
      function rgbToHex(rgb) {
        const m = rgb.match(/(\d+)/g);
        if (!m || m.length < 3) return rgb;
        return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
      }

      // Extract color palette from visible elements with frequency counting
      const colorFreq = {};
      const elements = document.querySelectorAll('*');
      for (let i = 0; i < Math.min(elements.length, 300); i++) {
        const style = getComputedStyle(elements[i]);
        const rect = elements[i].getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const area = rect.width * rect.height;

        for (const c of [style.color, style.backgroundColor]) {
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'rgb(0, 0, 0)' && c !== 'rgb(255, 255, 255)') {
            const hex = rgbToHex(c);
            if (frameworkColorSet.has(hex)) continue; // Skip framework grays
            colorFreq[hex] = (colorFreq[hex] || 0) + area;
          }
        }
      }

      // Sort by visual area (most prominent colors first)
      const sortedColors = Object.entries(colorFreq)
        .sort((a, b) => b[1] - a[1])
        .map(([hex]) => hex);

      // Brand color detection from high-signal elements
      const brandSignals = {
        logo: [],
        nav: [],
        buttons: [],
        headings: [],
        links: [],
      };

      // Logo area colors
      const logoEl = document.querySelector('[class*="logo" i], [id*="logo" i], header img, .site-header img, nav img');
      if (logoEl) {
        const parent = logoEl.closest('a, div, header');
        if (parent) {
          const ps = getComputedStyle(parent);
          if (ps.backgroundColor !== 'rgba(0, 0, 0, 0)') brandSignals.logo.push(rgbToHex(ps.backgroundColor));
          if (ps.color !== 'rgba(0, 0, 0, 0)') brandSignals.logo.push(rgbToHex(ps.color));
        }
      }

      // Nav/header colors
      const nav = document.querySelector('nav, header, [role="navigation"]');
      if (nav) {
        const ns = getComputedStyle(nav);
        brandSignals.nav.push(rgbToHex(ns.backgroundColor), rgbToHex(ns.color));
      }

      // Button/CTA colors
      for (const btn of document.querySelectorAll('a[class*="btn" i], a[class*="button" i], button, .cta, [class*="cta" i]')) {
        const bs = getComputedStyle(btn);
        if (bs.backgroundColor !== 'rgba(0, 0, 0, 0)') brandSignals.buttons.push(rgbToHex(bs.backgroundColor));
        if (bs.color !== 'rgba(0, 0, 0, 0)') brandSignals.buttons.push(rgbToHex(bs.color));
      }

      // Heading colors
      for (const h of headings) {
        const hs = getComputedStyle(h);
        brandSignals.headings.push(rgbToHex(hs.color));
      }

      // Link colors
      const links = document.querySelectorAll('a');
      for (let i = 0; i < Math.min(links.length, 20); i++) {
        brandSignals.links.push(rgbToHex(getComputedStyle(links[i]).color));
      }

      // Deduplicate brand signals
      for (const key of Object.keys(brandSignals)) {
        brandSignals[key] = [...new Set(brandSignals[key])].filter(c => c && c !== '#000000' && c !== '#ffffff');
      }

      // Determine if clear branding exists (3+ consistent non-black/white colors)
      const allBrandColors = [...new Set([
        ...brandSignals.logo, ...brandSignals.nav,
        ...brandSignals.buttons, ...brandSignals.headings,
      ])].filter(c => c && c !== '#000000' && c !== '#ffffff' && !frameworkColorSet.has(c));

      const hasClearBranding = allBrandColors.length >= 2;
      // Top brand colors = most frequent among brand elements
      const brandColorRanked = allBrandColors
        .sort((a, b) => (colorFreq[a] || 0) - (colorFreq[b] || 0))
        .reverse()
        .slice(0, 5);

      return {
        bodyFont: computed.fontFamily,
        bodyColor: computed.color,
        bodyBg: computed.backgroundColor,
        headings: headings.map(h => ({
          tag: h.tagName,
          text: h.textContent?.trim().slice(0, 100),
          font: getComputedStyle(h).fontFamily,
          color: rgbToHex(getComputedStyle(h).color),
        })),
        colorPalette: sortedColors.slice(0, 20),
        brand: {
          hasClearBranding,
          primaryColors: brandColorRanked,
          signals: brandSignals,
        },
      };
    }, frameworkColorList);

    // Extract image URLs for reuse in redesign
    const images = await page.evaluate(() => {
      const seen = new Set();
      const imgs = [];

      // <img> tags
      for (const img of document.querySelectorAll('img[src]')) {
        const src = img.src;
        if (!src || seen.has(src) || src.startsWith('data:')) continue;
        seen.add(src);
        const rect = img.getBoundingClientRect();
        imgs.push({
          src,
          alt: img.alt || '',
          width: img.naturalWidth || Math.round(rect.width),
          height: img.naturalHeight || Math.round(rect.height),
          context: img.closest('section, header, footer, main, div')?.className?.slice(0, 60) || '',
          isLogo: /logo/i.test(img.alt || img.className || img.src),
          isHero: rect.width > 600 || (rect.width > 300 && rect.top < 800),
        });
      }

      // CSS background images on visible elements
      const bgElements = document.querySelectorAll('[style*="background"], section, header, div, figure');
      for (let i = 0; i < Math.min(bgElements.length, 100); i++) {
        const style = getComputedStyle(bgElements[i]);
        const bgImg = style.backgroundImage;
        if (bgImg && bgImg !== 'none' && bgImg.startsWith('url(')) {
          const url = bgImg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
          if (!url.startsWith('data:') && !seen.has(url)) {
            seen.add(url);
            const rect = bgElements[i].getBoundingClientRect();
            imgs.push({
              src: url,
              alt: '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              context: bgElements[i].className?.slice(0, 60) || bgElements[i].tagName,
              isLogo: false,
              isHero: rect.width > 600 || (rect.width > 300 && rect.top < 800),
              isBackground: true,
            });
          }
        }
      }

      // OG image
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      if (ogImage && !seen.has(ogImage)) {
        imgs.push({ src: ogImage, alt: 'Open Graph image', width: 0, height: 0, context: 'og:image', isLogo: false, isHero: false });
      }

      return imgs;
    });

    // Save image manifest and brand data for CLI
    writeFileSync(join(workDir, 'images.json'), JSON.stringify(images, null, 2));
    writeFileSync(join(workDir, 'brand.json'), JSON.stringify(designData.brand, null, 2));

    // Generate human-readable image manifest for LLM consumption
    const manifestLines = ['# Image Manifest — USE THESE EXACT URLs\n'];
    const logos = images.filter(i => i.isLogo);
    const heroes = images.filter(i => i.isHero && !i.isLogo);
    const others = images.filter(i => !i.isLogo && !i.isHero);

    if (logos.length > 0) {
      manifestLines.push('## Logo Images (MUST use in header)');
      for (const img of logos) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || 'Logo'}" | ${img.width}x${img.height}`);
      }
      manifestLines.push('');
    }
    if (heroes.length > 0) {
      manifestLines.push('## Hero / Banner Images (use prominently above the fold)');
      for (const img of heroes) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || ''}" | ${img.width}x${img.height} | context: ${img.context || 'hero'}`);
      }
      manifestLines.push('');
    }
    if (others.length > 0) {
      manifestLines.push('## Other Images (reuse in relevant sections)');
      for (const img of others) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || ''}" | ${img.width}x${img.height} | context: ${img.context || 'general'}`);
      }
      manifestLines.push('');
    }
    manifestLines.push(`\nTotal: ${images.length} images available. Use ALL of them where contextually appropriate.`);
    writeFileSync(join(workDir, 'image-manifest.md'), manifestLines.join('\n'));

    console.log(`[executor-redesign] Extracted ${images.length} images from ${targetUrl}`);
    console.log(`[executor-redesign] Brand: ${designData.brand.hasClearBranding ? 'DETECTED' : 'weak'} — colors: ${designData.brand.primaryColors.join(', ') || 'none'}`);

    // AEO audit (reuse the already-open page)
    let aeoResult = null;
    try {
      aeoResult = await auditAEO(page);
    } catch (err) {
      console.warn(`[executor-redesign] AEO audit failed (non-fatal): ${err.message}`);
    }

    // Save HTML for Claude Code CLI to read
    const htmlPath = join(workDir, 'original.html');
    writeFileSync(htmlPath, html);

    // Enforce size limit (5MB)
    if (html.length > 5 * 1024 * 1024) {
      throw new Error('Page HTML exceeds 5MB limit');
    }

    return { html, title, meta, designData, aeoResult, images, seoElements };
  } finally {
    await browser.close();
  }
}

/**
 * Run Lighthouse audit against a live URL.
 * Returns { performance, accessibility, seo, 'best-practices' } scores (0-100).
 */
async function auditUrl(targetUrl) {
  const chromeLauncher = await import('chrome-launcher');
  const lighthouse = await import('lighthouse');

  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  try {
    const result = await lighthouse.default(targetUrl, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    const categories = result.lhr.categories;
    const scores = {
      performance: Math.round((categories.performance?.score || 0) * 100),
      accessibility: Math.round((categories.accessibility?.score || 0) * 100),
      seo: Math.round((categories.seo?.score || 0) * 100),
      'best-practices': Math.round((categories['best-practices']?.score || 0) * 100),
    };

    // Extract failing audits per category for targeted regression fixes
    const failingAudits = {};
    for (const [catKey, cat] of Object.entries(categories)) {
      const failed = (cat.auditRefs || [])
        .filter(ref => ref.weight > 0)
        .map(ref => result.lhr.audits[ref.id])
        .filter(a => a && a.score !== null && a.score < 1)
        .map(a => ({ id: a.id, title: a.title, score: a.score, description: (a.description || '').slice(0, 120) }));
      if (failed.length > 0) failingAudits[catKey] = failed;
    }
    scores._failingAudits = failingAudits;

    return scores;
  } finally {
    await chrome.kill();
  }
}

/**
 * Custom AEO (Answer Engine Optimization) scorer.
 * Evaluates HTML for AI/answer-engine extractability using the Playwright page object.
 * Returns { aeoScore: number, breakdown: {...} }.
 */
async function auditAEO(page) {
  return page.evaluate(() => {
    const breakdown = {};

    // 1. JSON-LD structured data (15 points)
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    const schemaTypes = new Set();
    jsonLdScripts.forEach(s => {
      try {
        const data = JSON.parse(s.textContent);
        if (data['@type']) schemaTypes.add(data['@type']);
        if (Array.isArray(data['@graph'])) data['@graph'].forEach(g => { if (g['@type']) schemaTypes.add(g['@type']); });
      } catch {}
    });
    breakdown.structured_data = Math.min(15, schemaTypes.size * 5);

    // 2. FAQ markup (15 points)
    const hasFaqSchema = Array.from(jsonLdScripts).some(s => s.textContent.includes('FAQPage'));
    const detailsEls = document.querySelectorAll('details');
    breakdown.faq_markup = hasFaqSchema ? 15 : Math.min(10, detailsEls.length * 3);

    // 3. Entity identification (10 points)
    const hasOrgSchema = Array.from(jsonLdScripts).some(s => {
      try { const d = JSON.parse(s.textContent); return d['@type'] === 'Organization' && d.name && d.url; } catch { return false; }
    });
    const hasPersonSchema = Array.from(jsonLdScripts).some(s => {
      try { const d = JSON.parse(s.textContent); return d['@type'] === 'Person' || (d.founder && d.founder['@type'] === 'Person'); } catch { return false; }
    });
    breakdown.entity_clarity = (hasOrgSchema ? 6 : 0) + (hasPersonSchema ? 4 : 0);

    // 4. Semantic heading hierarchy (10 points)
    const h1s = document.querySelectorAll('h1');
    const h2s = document.querySelectorAll('h2');
    const h3s = document.querySelectorAll('h3');
    let headingScore = 0;
    if (h1s.length === 1) headingScore += 4;
    else if (h1s.length > 0) headingScore += 2;
    if (h2s.length > 0) headingScore += 3;
    if (h3s.length > 0) headingScore += 3;
    breakdown.heading_hierarchy = headingScore;

    // 5. Meta description (5 points)
    const metaDesc = document.querySelector('meta[name="description"]');
    const descContent = metaDesc?.getAttribute('content') || '';
    breakdown.meta_description = metaDesc ? (descContent.length >= 120 && descContent.length <= 160 ? 5 : 3) : 0;

    // 6. Open Graph completeness (5 points)
    const ogTags = ['og:title', 'og:description', 'og:image', 'og:type'];
    const ogPresent = ogTags.filter(tag => document.querySelector(`meta[property="${tag}"]`)).length;
    breakdown.open_graph = Math.round((ogPresent / ogTags.length) * 5);

    // 7. Content-to-HTML ratio (10 points)
    const textContent = document.body?.innerText || '';
    const htmlContent = document.documentElement?.outerHTML || '';
    const ratio = textContent.length / (htmlContent.length || 1);
    breakdown.content_ratio = ratio >= 0.25 ? 10 : Math.round(ratio / 0.25 * 10);

    // 8. Direct answer blocks (10 points)
    const headings = document.querySelectorAll('h1, h2, h3, h4');
    let answerBlocks = 0;
    headings.forEach(h => {
      let next = h.nextElementSibling;
      if (next && (next.tagName === 'P' || next.tagName === 'DIV')) {
        const text = next.textContent?.trim() || '';
        if (text.length > 20 && text.length < 300) answerBlocks++;
      }
    });
    breakdown.answer_blocks = Math.min(10, answerBlocks * 3);

    // 9. Contact info extractability (10 points)
    const bodyText = document.body?.innerHTML || '';
    const hasEmail = /[\w.-]+@[\w.-]+\.\w{2,}/.test(bodyText);
    const hasPhone = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(bodyText);
    const hasAddress = Array.from(jsonLdScripts).some(s => s.textContent.includes('PostalAddress'));
    breakdown.contact_info = (hasEmail ? 4 : 0) + (hasPhone ? 3 : 0) + (hasAddress ? 3 : 0);

    // 10. Publication/freshness signals (10 points)
    const hasDateModified = Array.from(jsonLdScripts).some(s => s.textContent.includes('dateModified'));
    const hasDatePublished = Array.from(jsonLdScripts).some(s => s.textContent.includes('datePublished'));
    const hasAuthor = Array.from(jsonLdScripts).some(s => s.textContent.includes('"author"'));
    const hasTimestamp = !!document.querySelector('time[datetime]');
    breakdown.freshness_signals = (hasDateModified ? 4 : 0) + (hasDatePublished ? 3 : 0) + (hasAuthor ? 2 : 0) + (hasTimestamp ? 1 : 0);

    const aeoScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
    return { aeoScore, breakdown };
  });
}

/**
 * Run Lighthouse + AEO audit on a local HTML file by serving it via temp HTTP server.
 * Returns { lighthouse: {...scores}, aeo: { aeoScore, breakdown } }.
 */
async function auditLocalFile(filePath) {
  const http = await import('http');
  const fs = await import('fs');

  const html = fs.readFileSync(filePath, 'utf-8');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const localUrl = `http://127.0.0.1:${port}`;

  try {
    // Lighthouse audit
    const lighthouseScores = await auditUrl(localUrl);

    // AEO audit using Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    let aeoResult;
    try {
      const page = await browser.newPage();
      await page.goto(localUrl, { waitUntil: 'networkidle', timeout: 10000 });
      aeoResult = await auditAEO(page);
    } finally {
      await browser.close();
    }

    return { lighthouse: lighthouseScores, aeo: aeoResult };
  } finally {
    server.close();
  }
}

/**
 * Analyze the scraped design using Claude Sonnet API (structured output).
 * Returns a JSON analysis of the design.
 */
async function analyzeDesign(agent, scraped, taskId) {
  const systemPrompt = `You are a senior web designer analyzing a website for a redesign project.
Analyze the provided HTML and design data, then return a JSON object with your analysis.
Focus on actionable insights for improving the design while preserving brand identity.

Return ONLY valid JSON with this structure:
{
  "brand_identity": { "name": string, "colors": string[], "fonts": string[], "tone": string },
  "strengths": string[],
  "weaknesses": string[],
  "layout_pattern": string,
  "improvements": string[],
  "recommended_style": string,
  "accessibility_issues": string[]
}`;

  // Truncate HTML to fit context (keep head + first 3000 chars of body)
  const headMatch = scraped.html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = scraped.html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const truncatedHtml = (headMatch ? headMatch[0] : '') + '\n' +
    (bodyMatch ? bodyMatch[1].slice(0, 3000) + '...' : scraped.html.slice(0, 4000));

  const userMessage = `Analyze this website design:

Title: ${scraped.title}
Meta description: ${scraped.meta.description || 'none'}

Design data:
${JSON.stringify(scraped.designData, null, 2)}

HTML (truncated):
${truncatedHtml}`;

  const result = await agent.callLLM(systemPrompt, userMessage, {
    taskId,
    idempotencyKey: `redesign-analyze-${taskId}`,
    maxTokens: 2048,
  });

  // Parse JSON from response (handle markdown code blocks)
  let analysis;
  try {
    const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    analysis = JSON.parse(jsonStr);
  } catch {
    console.warn('[executor-redesign] Failed to parse analysis JSON, using raw text');
    analysis = { raw: result.text, strengths: [], weaknesses: [], improvements: [] };
  }

  return { analysis, costUsd: result.costUsd };
}

/**
 * Pass 1: Generate the initial redesign HTML.
 * Uses Stitch 2.0 (Gemini MCP extension) for initial visual design, then adapts
 * to pipeline requirements. Falls back to from-scratch generation if Stitch is unavailable.
 */
function generateRedesign({ scraped, analysis, businessContext, workDir, maxBudgetUsd, allowedTools, maxTurns, extensions, allowedMcpServers, model, backend, timeoutMs }) {
  const prompt = `You are redesigning a website homepage as a strategic design partner. Your output must be a SINGLE self-contained HTML file.

## Original Site
Title: ${scraped.title}
URL analyzed: see original.html in this directory

## Design Analysis
${JSON.stringify(analysis, null, 2)}

## Design Brief & Strategy
Read ./design-brief.md for audit scores, improvement targets, and strategic design directives.
Read ./strategy-brief.md for the full strategic consulting analysis (business context, conversion architecture, micro-interactions).
Read ./business-context.json for the structured business understanding.

## Your Task — Two-Phase Approach

### PHASE 1: Visual Design via Stitch
Use the Stitch design tools to generate a high-quality initial layout. If Stitch tools are unavailable or fail, skip directly to Phase 2 and create the design from scratch.

1. Read ./strategy-brief.md and ./business-context.json to understand the business, audience, and design direction
2. Use the create_project tool to create a new Stitch project for this redesign
3. Use the generate_screen_from_text tool with:
   - projectId: the project ID from step 2
   - prompt: a detailed description of the website redesign including:
     - Business type: ${businessContext.businessType || 'business'}
     - Target audience: ${businessContext.audience || 'general'}
     - Desired emotion: ${businessContext.targetEmotion?.primary || 'trust'} + ${businessContext.targetEmotion?.secondary || 'clarity'}
     - Layout style from strategy-brief.md
     - Primary conversion goal: ${businessContext.primaryConversionGoal || 'contact'}
     - Key sections: hero, features/services, social proof, FAQ, CTA, footer
   - deviceType: DESKTOP
4. Use get_screen to retrieve the generated screen HTML, then write it to ./stitch-output.html using write_file
5. If any Stitch tool call fails or times out, skip the remaining Stitch steps and proceed to Phase 2 — generate the design from scratch using the reference files

### PHASE 2: Adapt to Pipeline Requirements
Whether you have Stitch output or are starting from scratch, produce the final redesign:

1. If ./stitch-output.html exists, read it as your starting point. Otherwise, design from scratch using the reference files.
2. Read ./original.html for content and structure reference
3. Read ./design-brief.md for audit scores to beat AND strategic directives
4. Read ./strategy-brief.md — follow its hero engineering, cognitive fluency, micro-interaction, and conversion architecture directives
5. Read ./seo-head.html — this contains ALL SEO meta tags, OG tags, canonical links, hreflang, and JSON-LD from the original site. You MUST include every element from this file in your redesign's <head>.
6. Read ./business-context.json for business type and conversion goals
7. Create the final redesign as ./redesign.html

   CRITICAL CONVERSION — if starting from Stitch output:
   - Convert ALL Tailwind utility classes to equivalent inline <style> CSS rules
   - The final HTML must have ZERO Tailwind classes — all styling via <style> tags
   - Preserve the visual design and layout from Stitch while making it self-contained

8. The redesign MUST:
   - Be a single self-contained HTML file (all CSS inline in <style> tags)
   - Use Google Fonts via <link> tags (the only allowed external resource)
   - Be mobile-responsive (use CSS Grid/Flexbox, media queries)
   - Meet WCAG AA contrast requirements (4.5:1 text, 3:1 large text)
   - Have NO external CSS files or JS frameworks
   - Include an attribution footer: "Redesigned by STAQS.IO agents"
   - Use modern design patterns (clean typography, whitespace, clear hierarchy)

   SEO HEAD (NON-NEGOTIABLE):
   - Copy the ENTIRE contents of ./seo-head.html into your <head> tag
   - This includes: title, meta description, canonical, OG tags, hreflang, JSON-LD structured data
   - If seo-head.html has a comment about lang attribute, add it to the <html> tag
   - You may ADD additional structured data (e.g., FAQPage) but NEVER remove what's in seo-head.html
   - JSON-LD <script type="application/ld+json"> tags are ALLOWED and REQUIRED — they are not executable scripts

   BRAND IDENTITY (CRITICAL):
   - Read ./brand.json for detected brand colors
   - If hasClearBranding is true, you MUST use the brand's actual colors (primaryColors)
   - Do NOT invent a new color palette when clear branding exists
   - The redesign should feel like the same company, just better designed
   - Logo, nav colors, button colors, heading colors should match the original brand
   - You may adjust shades/tints for better contrast but keep the palette recognizable

   IMAGES (CRITICAL — READ THIS CAREFULLY):
   - Read ./images.json for ALL images extracted from the original site
   - You MUST use the EXACT src URLs from images.json — do NOT invent, generate, or guess image URLs
   - LOGO (isLogo=true): MUST appear in the header using the exact src URL
   - HERO images (isHero=true): Use as hero/banner backgrounds or prominent section images
   - Product/feature images: reuse in relevant sections — these are REAL photos from the client's site
   - EVERY section should have visual content — do not leave large empty areas where images should be
   - Use <img> tags with the original alt text and loading="lazy"
   - CSS gradients ONLY as supplementary decoration, NOT as replacement for real images
   - NEVER use placeholder URLs, broken URLs, made-up image paths, or AI-generated alt-text-only placeholders
   - If the original site has 5+ images, your redesign should use at least as many
   - Read ./image-manifest.md for a human-readable list of all available images with their URLs

   2026 DESIGN DIRECTIVES (CRITICAL):
   - Use the EXACT Google Fonts specified in strategy-brief.md § 2.5 — never substitute
   - Apply scroll-driven animations: \`animation-timeline: view()\` with \`animation-range: entry 10% cover 40%\` on content sections
   - Use glassmorphism (\`backdrop-filter: blur()\`) on the nav bar and feature cards
   - Apply depth with layered box-shadows (small/medium/large system from strategy-brief.md § 6)
   - If layout style is "organic": use clip-path section transitions and asymmetric grids
   - Break grid symmetry: use \`1fr 1.3fr\` or \`2fr 1fr\` instead of \`repeat(3, 1fr)\` for feature grids
   - Include at least one editorial pull quote with oversized typography
   - Use spring cubic-bezier \`(0.34, 1.56, 0.64, 1)\` for hover transitions instead of linear easing
   - Apply \`text-wrap: balance\` on headings, \`text-wrap: pretty\` on paragraphs
   - Include \`@media (prefers-reduced-motion: reduce)\` to disable all motion
   - Vary section backgrounds: no two adjacent sections should have the same treatment

9. SEO Requirements:
   - Start by copying ALL elements from ./seo-head.html into the <head>
   - Semantic HTML5 structure (header, nav, main, section, article, footer)
   - Single H1 tag, proper H2/H3 hierarchy
   - Alt text on all images
   - Preserve ALL original JSON-LD structured data; add FAQPage schema if appropriate

10. Accessibility Requirements:
   - ARIA labels on interactive elements
   - Sufficient color contrast (WCAG AA)
   - Logical focus order
   - Skip-to-content link
   - Descriptive link text (no "click here")

11. AEO (Answer Engine Optimization):
   - Short answer paragraphs (<300 chars) near headings
   - FAQ section with clear Q&A pairs
   - Contact info in both visible text and structured data

12. Write the final file to ./redesign.html

13. Write ./strategy-rationale.md explaining your strategic design decisions:
   - Whether Stitch (create_project + generate_screen_from_text) was used for the initial design and how it was adapted
   - What emotion the hero section engineers and why (reference strategy-brief.md)
   - How cognitive load was reduced vs. the original
   - Where micro-interactions were added and their purpose
   - How the layout guides visitors toward the primary conversion goal (${businessContext.primaryConversionGoal || 'contact'})
   - What business objective each major section serves

Focus on making it dramatically better while keeping the brand recognizable. Every design choice should be intentional and explainable.`;

  return spawnCLI({
    prompt,
    systemPrompt: `You are the STAQS redesign agent — a 2026 design innovator, not a template filler. Rules:
1. Try Stitch tools FIRST for initial visual design. If they fail, generate from scratch — never hard-fail.
2. Read strategy-brief.md FIRST — follow its exact font pairing, layout style, and motion patterns.
3. Use ONLY the fonts specified in the Typography section — never pick your own.
4. If using Stitch output, convert ALL Tailwind classes to inline <style> CSS — zero Tailwind in final output.
5. Use \`animation-timeline: view()\` for scroll-driven animations on content sections.
6. Include \`@media (prefers-reduced-motion: reduce)\` to disable all animations.
7. Break symmetry intentionally — no three identical cards in equal columns.
8. Every design choice must be tied to a business objective from the strategy brief.
Write both ./redesign.html and ./strategy-rationale.md. Do not ask questions — produce the best redesign you can.`,
    workDir,
    maxBudgetUsd,
    allowedTools,
    maxTurns,
    extensions,
    allowedMcpServers,
    timeoutMs: timeoutMs || CLI_TIMEOUT_MS,
    label: 'generate',
    agentTag: 'executor-redesign',
    backend: backend || 'gemini',
    model: model || 'gemini-2.5-pro',
  });
}

/**
 * Pass 2a: Delphi UI/UX review of the generated redesign.
 * Writes delphi-review.md to the work directory.
 */
function reviewDelphi({ workDir, model }) {
  return spawnCLI({
    prompt: `You are reviewing a website redesign for 2026 design quality, strategic intent, and human-designed feel.

Read ./redesign.html and ./strategy-brief.md, then evaluate against these criteria:

**2026 Design Quality:**
- Does it feel human-designed or AI-generated? (AI tells: symmetric 3-column grids, identical card heights, generic headlines, perfectly centered everything)
- Are scroll-driven animations present (\`animation-timeline: view()\`)? They should be on content sections.
- Is \`@media (prefers-reduced-motion: reduce)\` included? (accessibility requirement)
- Is glassmorphism/depth used on nav and/or cards (\`backdrop-filter: blur()\`)?
- Does typography use the prescribed font pairing from strategy-brief.md § 2.5?
- Is there typographic contrast (hero 2.5-4.5rem vs body ~1rem)?
- Does layout break grid symmetry (asymmetric columns, varied card sizes)?
- Are micro-interactions using spring cubic-bezier \`(0.34, 1.56, 0.64, 1)\` instead of linear?

**Image Usage (CRITICAL):**
- Read ./image-manifest.md — how many images were available from the original site?
- Count how many <img> tags are in the redesign — are ALL original images used?
- Are any <img> src URLs made up / not from images.json? Flag each one.
- Is the hero section using a real image or just text on a blank/gradient background? It MUST have visual imagery.
- Are sections sparse or empty where the original site had photos? Flag them.

**Strategic Design:**
- Does the hero create a single clear emotional impression within 50ms?
- Is there a clear visual path to the primary CTA within 2 seconds?
- Does each section have ONE clear purpose?
- Does the conversion architecture follow the strategy brief's section order?
- Is social proof placed near CTAs?

**Accessibility (WCAG 2.2 AA):**
- Color contrast (4.5:1 text, 3:1 large text)
- Focus indicators (\`:focus-visible\`)
- Skip-to-content link
- ARIA labels on interactive elements

Write your review to ./delphi-review.md with this structure:
## Score: X/10
## Human-Designed Feel (does it look like a human creative director designed it, or like AI output?)
## 2026 Design Compliance (scroll animations, glassmorphism, typography, depth)
## Strategic Alignment (strategy brief adherence)
## Critical Issues (must fix)
## Improvements (should fix)
## Strengths

SCORING GUIDE: Below 7/10 means "looks AI-generated" — flag specific symmetric/generic patterns.
Be specific — reference exact CSS properties, HTML elements, and line numbers.`,
    systemPrompt: 'You are Delphi, a 2026 design evaluator. Your primary lens is: does this feel human-designed or AI-generated? Check for scroll-driven animations, glassmorphism, asymmetric layouts, editorial typography, and spring-physics micro-interactions. Be specific and actionable.',
    workDir,
    maxBudgetUsd: 1.00,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write', 'Glob'],
    maxTurns: 15,
    timeoutMs: REVIEW_TIMEOUT_MS,
    label: 'delphi',
    agentTag: 'executor-redesign',
  });
}

/**
 * Pass 2b: Linus code quality review of the generated redesign.
 * Writes linus-review.md to the work directory.
 */
function reviewLinus({ workDir, model }) {
  return spawnCLI({
    prompt: `You are reviewing a website redesign for code quality and accessibility.

Read ./redesign.html and evaluate it for:
- HTML validity and semantic correctness
- CSS efficiency (no unused rules, proper cascade)
- Accessibility bugs (missing alt text, ARIA misuse, focus traps)
- Performance anti-patterns (render-blocking, excessive DOM, large inline styles)
- SEO issues (missing meta tags, heading hierarchy, structured data)
- Security (no inline scripts, no external JS, CSP-friendly)

Write your review to ./linus-review.md with this structure:
## Bugs (will break things)
## Accessibility Violations
## Performance Issues
## SEO Gaps
## Code Quality Notes

Be specific — cite exact elements and suggest the fix. No general advice.`,
    systemPrompt: 'You are Linus, a brutally honest code reviewer. Find real bugs, accessibility violations, and performance issues. Be specific and cite exact code.',
    workDir,
    maxBudgetUsd: 1.00,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write', 'Glob', 'Grep'],
    maxTurns: 15,
    timeoutMs: REVIEW_TIMEOUT_MS,
    label: 'linus',
    agentTag: 'executor-redesign',
  });
}

/**
 * Pass 3: Apply review feedback to the redesign.
 * Reads both review files and updates redesign.html.
 */
function applyReviewFeedback({ workDir, model }) {
  return spawnCLI({
    prompt: `You have reviews of a website redesign from two reviewers.

Read these files:
1. ./redesign.html (the current redesign)
2. ./delphi-review.md (UI/UX review — if it exists)
3. ./linus-review.md (code quality review — if it exists)

Apply ALL critical issues and bugs from both reviews. For improvements/suggestions, apply the ones that are clearly correct and low-risk.

Rules:
- The output must remain a SINGLE self-contained HTML file
- Do NOT add <script> tags (except type="application/ld+json" for structured data — preserve those)
- Do NOT break existing functionality
- Do NOT remove any SEO meta tags, OG tags, canonical links, or JSON-LD from the <head>
- Preserve the attribution footer
- Keep Google Fonts as the only external resource

Write the updated file to ./redesign.html (overwrite the existing one).
At the end, write a brief ./review-applied.md summarizing what you changed.`,
    systemPrompt: 'You are applying code review feedback to an HTML file. Be surgical — fix the real issues, skip the nitpicks. Maintain the existing design intent.',
    workDir,
    maxBudgetUsd: 2.00,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write', 'Glob', 'Grep'],
    maxTurns: 20,
    timeoutMs: CLI_TIMEOUT_MS,
    label: 'apply-fixes',
    agentTag: 'executor-redesign',
  });
}

/**
 * Pass 4 (conditional): Fix score regressions.
 * Targets specific metrics that dropped from before → after.
 */
function fixRegressions({ workDir, regressions, model }) {
  const regList = regressions
    .map(r => {
      let entry = `- ${r.label}: ${r.before} → ${r.after} (${r.delta}).`;
      if (r.failingAudits) entry += `\n  FAILING AUDITS:\n  ${r.failingAudits.split('\n').join('\n  ')}`;
      else entry += ` ${r.hint}`;
      return entry;
    })
    .join('\n\n');

  return spawnCLI({
    prompt: `The redesign at ./redesign.html has SCORE REGRESSIONS vs the original site.
These metrics got WORSE and must be fixed to at least match the original:

${regList}

Also read ./original.html and ./seo-head.html to see what the original had that the redesign is missing.

Step-by-step approach:
1. Read ./seo-head.html FIRST — this is the authoritative list of SEO elements that MUST be in the <head>
2. Read ./redesign.html
3. Read ./original.html for reference (see what meta tags, structured data, ARIA labels it had)
4. For EACH failing audit listed above, identify and fix the specific issue
5. Verify every fix is applied — especially that ALL elements from seo-head.html are present

Specific fixes by category:
- SEO: Copy ALL elements from ./seo-head.html into the <head> if missing. Ensure these ALL exist: <meta name="description">, <link rel="canonical">, og:title, og:description, og:image, og:type, <title>, single <h1>, proper h2/h3 hierarchy, alt on every <img>, JSON-LD (Organization schema min), lang attribute on <html>
- Accessibility: skip-to-content link as first <body> child, ARIA labels on nav/buttons/forms, role attributes, sufficient color contrast (4.5:1), logical tab order, :focus-visible styles, <label> on form inputs
- Performance: defer non-critical CSS, minimize unused rules, use font-display:swap on Google Fonts
- Best Practices: charset UTF-8, viewport meta, HTTPS links only (no http://), explicit width/height on all <img>, proper doctype, no deprecated APIs

Write the fixed file to ./redesign.html (overwrite).
Write ./regression-fixes.md listing exactly what you changed and why.`,
    systemPrompt: 'You are fixing Lighthouse/SEO score regressions. Read seo-head.html FIRST — it contains all required SEO elements. Then read the original HTML for reference. Be thorough — check EVERY item in the fix list. Missing meta tags and structured data are the #1 cause of SEO regression.',
    workDir,
    maxBudgetUsd: 2.00,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write', 'Glob', 'Grep'],
    maxTurns: 20,
    timeoutMs: REVIEW_TIMEOUT_MS,
    label: 'fix-regressions',
    agentTag: 'executor-redesign',
  });
}

// Audits that structurally fail in preview (http://localhost) — cannot be fixed by HTML editing
const PREVIEW_STRUCTURAL_AUDITS = new Set([
  'is-on-https',      // Best Practices: always fails on http://
  'redirects-http',   // Best Practices: HTTP→HTTPS redirect
  'robots-txt',       // SEO: temp server has no robots.txt
  'uses-http2',       // Performance: localhost Node server
]);

/**
 * Compare before/after audit scores and return any regressions.
 */
function findRegressions(auditBefore, auditAfter, aeoBeforeScore, aeoAfterScore) {
  if (!auditBefore || !auditAfter) return [];

  const checks = [
    { key: 'seo', label: 'SEO', hint: 'Check meta tags, heading hierarchy, structured data, alt text' },
    { key: 'accessibility', label: 'Accessibility', hint: 'Check contrast, ARIA labels, focus order, skip links' },
    { key: 'performance', label: 'Performance', hint: 'Reduce CSS bloat, optimize font loading, minimize DOM' },
    { key: 'best-practices', label: 'Best Practices', hint: 'Fix HTTPS, charset, doctype, image aspect ratios' },
  ];

  const regressions = [];
  const failingAudits = auditAfter._failingAudits || {};
  for (const { key, label, hint } of checks) {
    const before = auditBefore[key];
    const after = auditAfter[key];
    if (typeof before === 'number' && typeof after === 'number' && after < before) {
      const failedAuditIds = (failingAudits[key] || []).map(a => a.id);
      const hasNonStructuralFailure = failedAuditIds.some(id => !PREVIEW_STRUCTURAL_AUDITS.has(id));
      // Skip if every failure is structural (not fixable by HTML editing)
      if (failedAuditIds.length > 0 && !hasNonStructuralFailure) continue;
      const failed = (failingAudits[key] || []).map(a => `- ${a.title} (${a.id}): ${a.description}`).join('\n');
      regressions.push({ key, label, before, after, delta: after - before, hint, failingAudits: failed || hint });
    }
  }

  // AEO check
  if (typeof aeoBeforeScore === 'number' && typeof aeoAfterScore === 'number' && aeoAfterScore < aeoBeforeScore) {
    regressions.push({
      key: 'aeo', label: 'AEO / AI Readiness', before: aeoBeforeScore, after: aeoAfterScore,
      delta: aeoAfterScore - aeoBeforeScore, hint: 'Add structured data, FAQ markup, short answer paragraphs, contact info',
    });
  }

  return regressions;
}

/**
 * Strip <script> tags from HTML for output safety.
 */
function stripScripts(html) {
  return html.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*<\/script>/gi, (match) => {
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(match)) {
      return match;
    }
    return '';
  });
}

/**
 * Send redesign completion email via Resend API.
 * Template matches staqs.io terminal aesthetic.
 */
async function sendRedesignEmail(to, targetUrl, previewUrl, { auditBefore, auditAfter } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');

  const domain = new URL(targetUrl).hostname;

  // Build score comparison rows for the email
  const scoreCategories = [
    { key: 'seo', label: 'SEO' },
    { key: 'aeo', label: 'AEO / AI Readiness' },
    { key: 'performance', label: 'Performance' },
    { key: 'accessibility', label: 'Accessibility' },
    { key: 'best-practices', label: 'Best Practices' },
  ];

  function scoreColor(score) {
    if (score >= 90) return '#22c55e'; // green
    if (score >= 50) return '#eab308'; // yellow
    return '#ef4444'; // red
  }

  function buildScoreRows() {
    if (!auditBefore && !auditAfter) return '';
    return scoreCategories.map(({ key, label }) => {
      const before = auditBefore?.[key] ?? '—';
      const after = auditAfter?.[key] ?? '—';
      const delta = (typeof before === 'number' && typeof after === 'number')
        ? after - before : null;
      const deltaStr = delta !== null
        ? `<span style="color:${delta >= 0 ? '#22c55e' : '#ef4444'};">${delta >= 0 ? '+' : ''}${delta}</span>`
        : '';
      const beforeColor = typeof before === 'number' ? scoreColor(before) : '#64748b';
      const afterColor = typeof after === 'number' ? scoreColor(after) : '#64748b';
      return `<tr>
        <td style="padding:4px 8px;color:#94a3b8;font-size:12px;text-align:left;">${label}</td>
        <td style="padding:4px 8px;color:${beforeColor};font-size:12px;text-align:center;font-weight:600;">${before}</td>
        <td style="padding:4px 8px;color:#64748b;font-size:12px;text-align:center;">&rarr;</td>
        <td style="padding:4px 8px;color:${afterColor};font-size:12px;text-align:center;font-weight:600;">${after}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right;">${deltaStr}</td>
      </tr>`;
    }).join('\n');
  }

  function buildScoreTable() {
    if (!auditBefore && !auditAfter) return '';
    const rows = buildScoreRows();
    // Find worst "before" score to highlight as opportunity
    let worstCategory = null;
    let worstScore = 101;
    for (const { key, label } of scoreCategories) {
      const score = auditBefore?.[key];
      if (typeof score === 'number' && score < worstScore) {
        worstScore = score;
        worstCategory = label;
      }
    }
    const opportunityLine = worstCategory && worstScore < 70
      ? `<p style="color:#eab308;margin:12px 0 0;font-size:11px;">&#9888; Your ${worstCategory} score (${worstScore}/100) is hurting discoverability. We can fix that.</p>`
      : '';
    return `
        <div style="border-top:1px solid #2a3a4a;padding-top:16px;margin-top:16px;">
          <p style="color:#64748b;margin:0 0 8px;font-size:12px;">// site audit: before vs after</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:1px;">Metric</th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:center;text-transform:uppercase;letter-spacing:1px;">Before</th>
              <th style="padding:4px 8px;"></th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:center;text-transform:uppercase;letter-spacing:1px;">After</th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:1px;">Change</th>
            </tr>
            ${rows}
          </table>${opportunityLine}
        </div>`;
  }

  const scoreTableHtml = buildScoreTable();

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f1923;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#22c55e !important;font-size:28px;letter-spacing:4px;margin:0;font-weight:700;"><a href="https://staqs.io" style="color:#22c55e !important;text-decoration:none !important;">STAQS<span style="display:none;"> </span>.IO</a></h1>
      <p style="color:#64748b !important;font-size:11px;letter-spacing:3px;margin:4px 0 0;text-transform:uppercase;">Agentic Engineering Studio</p>
    </div>

    <!-- Terminal window -->
    <div style="background-color:#1a2332;border:1px solid #2a3a4a;border-radius:8px;overflow:hidden;">

      <!-- Title bar -->
      <div style="background-color:#152029;padding:10px 16px;display:flex;align-items:center;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#eab308;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:6px;"></span>
        <span style="color:#64748b;font-size:12px;margin-left:8px;">staqs@terminal ~ %</span>
      </div>

      <!-- Content -->
      <div style="padding:24px;">
        <p style="color:#22c55e;margin:0 0 4px;font-size:14px;">$ staqs redesign --complete</p>
        <p style="color:#64748b;margin:0 0 20px;font-size:12px;">// redesign pipeline finished</p>

        <p style="color:#e2e8f0;margin:0 0 6px;font-size:14px;"><span style="color:#22c55e;">[=========]</span> Done!</p>
        <p style="color:#e2e8f0;margin:0 0 20px;font-size:13px;">
          <span style="color:#22c55e;">&#10022;</span> Your redesign of <span style="color:#22c55e !important;">${domain.replace('.', '<span style="display:none;"> </span>.')}</span> is ready.
        </p>

        <!-- CTA Button -->
        <div style="text-align:center;margin:28px 0;">
          <a href="${previewUrl}" style="display:inline-block;background-color:#22c55e;color:#0f1923;padding:14px 32px;text-decoration:none;font-weight:700;font-size:14px;border-radius:4px;letter-spacing:1px;">VIEW YOUR REDESIGN &rarr;</a>
        </div>

        <p style="color:#64748b;margin:20px 0 4px;font-size:12px;">// shareable link (yours to keep):</p>
        <p style="margin:0 0 20px;font-size:12px;"><a href="${previewUrl}" style="color:#22c55e;text-decoration:underline;">${previewUrl}</a></p>

        ${scoreTableHtml}

        <div style="border-top:1px solid #2a3a4a;padding-top:16px;margin-top:16px;">
          <p style="color:#64748b;margin:0 0 4px;font-size:12px;">// what just happened:</p>
          <p style="color:#94a3b8;margin:0;font-size:12px;line-height:1.8;">
            &gt; Playwright scraped your live homepage<br>
            &gt; Analyzed your business, audience &amp; conversion goals<br>
            &gt; Generated a strategic design brief (hero psychology, cognitive fluency, conversion architecture)<br>
            &gt; Claude Code built a redesign driven by your business objectives<br>
            &gt; Output: self-contained, mobile-responsive, WCAG AA
          </p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;">
      <p style="color:#64748b;font-size:12px;margin:0 0 8px;">We analyzed your business, audience &amp; conversion goals. Impressed?</p>
      <p style="margin:0 0 16px;"><a href="mailto:hello@staqs.io" style="color:#22c55e;font-size:14px;text-decoration:none;font-weight:600;">hello@staqs.io &rarr;</a></p>
      <p style="color:#475569;font-size:11px;margin:0;">
        <a href="https://staqs.io" style="color:#475569;text-decoration:none;">staqs.io</a>
        &nbsp;&middot;&nbsp;
        <a href="https://github.com/staqsIO" style="color:#475569;text-decoration:none;">GitHub</a>
        &nbsp;&middot;&nbsp;
        <a href="https://linkedin.com/company/staqs" style="color:#475569;text-decoration:none;">LinkedIn</a>
      </p>
    </div>

  </div>
</body>
</html>`;

  // Build plain-text score table
  let scoreTextBlock = '';
  if (auditBefore || auditAfter) {
    const lines = scoreCategories.map(({ key, label }) => {
      const before = auditBefore?.[key] ?? '—';
      const after = auditAfter?.[key] ?? '—';
      const delta = (typeof before === 'number' && typeof after === 'number') ? after - before : null;
      const deltaStr = delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta})` : '';
      return `  ${label.padEnd(18)} ${String(before).padStart(3)}  →  ${String(after).padStart(3)}${deltaStr}`;
    });
    scoreTextBlock = `\nSite Audit (before → after):\n${lines.join('\n')}\n`;
  }

  const textVersion = `Your redesign of ${domain} is ready!

View it here: ${previewUrl}
${scoreTextBlock}
What happened:
- Playwright scraped your live homepage
- Analyzed your business, audience & conversion goals
- Generated a strategic design brief (hero psychology, cognitive fluency, conversion architecture)
- Claude Code built a redesign driven by your business objectives
- Output: self-contained, mobile-responsive, WCAG AA

We analyzed your business, audience & conversion goals. Impressed?
hello@staqs.io — https://staqs.io`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'STAQS.IO <hello@staqs.io>',
      to: [to],
      subject: `Your redesign of ${domain} is ready`,
      html,
      text: textVersion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

/**
 * Heartbeat: update work_items.updated_at and metadata.heartbeat_at every interval
 * to signal liveness. The reaper uses stale updated_at to detect dead agents.
 * Also writes progress_phase so the frontend can show real status.
 *
 * Returns { stop(), setPhase(phase) }.
 */
function startHeartbeat(workItemId) {
  let currentPhase = 'starting';

  const timer = setInterval(async () => {
    try {
      await query(
        `UPDATE agent_graph.work_items
         SET updated_at = now(),
             metadata = metadata || jsonb_build_object(
               'heartbeat_at', to_jsonb(now()::text),
               'progress_phase', to_jsonb($2::text)
             )
         WHERE id = $1`,
        [workItemId, currentPhase]
      );
    } catch (err) {
      console.warn(`[executor-redesign] Heartbeat failed: ${err.message}`);
    }
  }, DB_KEEPALIVE_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
    setPhase: (phase) => { currentPhase = phase; },
  };
}

/**
 * Query with retry — for critical writes that must not be lost.
 * Retries up to 3 times with 2s backoff.
 */
async function queryWithRetry(text, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await query(text, params);
    } catch (err) {
      console.warn(`[executor-redesign] DB query attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── Design System Extraction (DESIGN.md pipeline) ────────────────

const modernPatterns = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/modern-patterns.json', import.meta.url), 'utf-8')
);

/**
 * Analyze scraped HTML/CSS for 2025-2026 design pattern gaps.
 * Compares extracted patterns against config/modern-patterns.json checklist.
 * Returns array of { pattern, description, priority, directive } for missing patterns.
 */
function analyzePatternGaps(scraped) {
  const html = scraped.html || '';
  const gaps = [];

  for (const pattern of modernPatterns.patterns) {
    let detected = false;

    // Check CSS patterns in the HTML (inline styles + <style> blocks)
    for (const cssPat of (pattern.detect.cssPatterns || [])) {
      if (html.includes(cssPat)) { detected = true; break; }
    }

    // Check HTML patterns (class names, elements)
    if (!detected) {
      for (const htmlPat of (pattern.detect.htmlPatterns || [])) {
        // Handle attribute-contains selectors like class*="bento"
        const match = htmlPat.match(/^class\*="(.+)"$/);
        if (match) {
          if (html.toLowerCase().includes(match[1].toLowerCase())) { detected = true; break; }
        } else if (htmlPat.startsWith('data-')) {
          if (html.includes(htmlPat)) { detected = true; break; }
        } else {
          // Element name check (e.g., "svg")
          if (html.includes(`<${htmlPat}`)) { detected = true; break; }
        }
      }
    }

    if (!detected) {
      gaps.push({
        pattern: pattern.name,
        description: pattern.description,
        priority: pattern.priority,
        directive: pattern.directive,
      });
    }
  }

  return gaps;
}

/**
 * Build a structured design system JSON from all extracted data.
 * Consolidates scraped designData, analysis, businessContext, and audit scores
 * into a single validated artifact.
 */
function buildDesignSystem(scraped, analysis, businessContext, auditBefore) {
  const brand = scraped.designData?.brand || {};
  const images = scraped.images || [];
  const contentHash = createHash('sha256').update(scraped.html.slice(0, 10000)).digest('hex');

  // Separate primary brand colors from secondary palette
  const primaryColors = brand.primaryColors || [];
  const allPalette = scraped.designData?.colorPalette || [];
  const secondaryColors = allPalette
    .filter(c => !primaryColors.includes(c))
    .slice(0, 10);
  const neutralColors = allPalette
    .filter(c => /^#[0-9a-f]{6}$/i.test(c))
    .filter(c => {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      return Math.max(r, g, b) - Math.min(r, g, b) < 30; // low saturation = neutral
    })
    .slice(0, 5);

  // Detect button style from brand signals
  const buttonColors = brand.signals?.buttons || [];
  const buttonStyle = buttonColors.length > 0 ? 'fill' : 'outline';

  // Detect motion from HTML
  const hasAnimations = (scraped.html || '').includes('@keyframes') ||
    (scraped.html || '').includes('animation:') ||
    (scraped.html || '').includes('data-aos');
  const hasTransitions = (scraped.html || '').includes('transition:');

  // Pattern gap analysis
  const patternGaps = analyzePatternGaps(scraped);

  return {
    version: '1.0.0',
    source: {
      url: scraped.meta?.ogImage ? new URL(scraped.meta.ogImage).origin : 'unknown',
      scrapedAt: new Date().toISOString(),
      contentHash,
    },
    colors: {
      hasClearBranding: brand.hasClearBranding || false,
      primary: primaryColors,
      secondary: secondaryColors,
      neutral: neutralColors,
      semantic: {
        cta: buttonColors,
        nav: brand.signals?.nav || [],
        heading: brand.signals?.headings || [],
        link: brand.signals?.links || [],
        background: scraped.designData?.bodyBg || '',
      },
    },
    typography: {
      bodyFont: scraped.designData?.bodyFont || '',
      bodyColor: scraped.designData?.bodyColor || '',
      headings: (scraped.designData?.headings || []).map(h => ({
        tag: h.tag,
        font: h.font,
        color: h.color,
        text: h.text,
      })),
      recommended: businessContext.fontPairing ? {
        heading: businessContext.fontPairing.heading,
        body: businessContext.fontPairing.body,
        weights: businessContext.fontPairing.weights,
        vibe: businessContext.fontPairing.vibe,
      } : null,
    },
    spacing: {
      baseUnit: 8,
      scale: [4, 8, 12, 16, 24, 32, 48, 64, 96],
    },
    components: {
      buttons: {
        colors: buttonColors,
        style: buttonStyle,
      },
      cards: {
        shadowStyle: 'soft',
        borderRadius: '8px',
      },
      nav: {
        colors: brand.signals?.nav || [],
        style: 'sticky',
      },
      borderRadius: '8px',
    },
    layout: {
      style: businessContext.layoutStyle?.style || 'clean-grid',
      description: businessContext.layoutStyle?.description || '',
      responsive: {
        mobileNav: 'unknown',
        breakpoints: [],
      },
    },
    motion: {
      hasAnimations,
      style: hasAnimations ? 'moderate' : (hasTransitions ? 'minimal' : 'none'),
      speed: 'medium',
    },
    brand: {
      name: analysis?.brand_identity?.name || scraped.title || '',
      tone: analysis?.brand_identity?.tone || businessContext.targetEmotion?.primary || '',
      emotion: {
        primary: businessContext.targetEmotion?.primary || '',
        secondary: businessContext.targetEmotion?.secondary || '',
      },
      businessType: businessContext.businessType || '',
      audience: businessContext.audience || '',
      primaryConversionGoal: businessContext.primaryConversionGoal || '',
    },
    patternGaps,
    seo: {
      lighthouse: auditBefore ? {
        performance: auditBefore.performance,
        accessibility: auditBefore.accessibility,
        seo: auditBefore.seo,
        bestPractices: auditBefore['best-practices'],
      } : null,
      aeo: scraped.aeoResult ? {
        score: scraped.aeoResult.aeoScore,
        breakdown: scraped.aeoResult.breakdown,
      } : null,
    },
    images: {
      total: images.length,
      logos: images.filter(i => i.isLogo),
      heroes: images.filter(i => i.isHero && !i.isLogo),
    },
  };
}

/**
 * Validate a design system object against required fields.
 * Returns { valid: boolean, errors: string[] }.
 * Manual validation (no ajv dependency — P4 boring infrastructure).
 */
function validateDesignSystem(ds) {
  const errors = [];
  const required = ['version', 'source', 'colors', 'typography', 'spacing', 'components', 'layout', 'brand'];

  for (const field of required) {
    if (!ds[field]) errors.push(`Missing required field: ${field}`);
  }

  if (ds.version && ds.version !== '1.0.0') {
    errors.push(`Unsupported version: ${ds.version} (expected 1.0.0)`);
  }

  if (ds.source) {
    if (!ds.source.url) errors.push('Missing source.url');
    if (!ds.source.scrapedAt) errors.push('Missing source.scrapedAt');
    if (!ds.source.contentHash) errors.push('Missing source.contentHash');
  }

  if (ds.colors) {
    if (typeof ds.colors.hasClearBranding !== 'boolean') errors.push('colors.hasClearBranding must be boolean');
    if (!Array.isArray(ds.colors.primary)) errors.push('colors.primary must be array');
  }

  if (ds.typography) {
    if (typeof ds.typography.bodyFont !== 'string') errors.push('typography.bodyFont must be string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate design-brief.md FROM a validated design system.
 * The brief is a human/LLM-readable rendering of the structured JSON.
 */
function renderDesignBrief(ds, strategyBriefMd) {
  const lines = ['# Design Brief\n'];

  // Audit scores
  if (ds.seo?.lighthouse) {
    const lh = ds.seo.lighthouse;
    lines.push('## Current Lighthouse Scores (targets to beat)');
    lines.push(`- Performance: ${lh.performance}/100`);
    lines.push(`- Accessibility: ${lh.accessibility}/100`);
    lines.push(`- SEO: ${lh.seo}/100`);
    lines.push(`- Best Practices: ${lh.bestPractices}/100`);
    lines.push('');
  }
  if (ds.seo?.aeo) {
    lines.push(`## Current AEO Score: ${ds.seo.aeo.score}/100`);
    lines.push('Breakdown: ' + JSON.stringify(ds.seo.aeo.breakdown, null, 2));
    lines.push('');
  }

  // Brand identity
  if (ds.colors.hasClearBranding) {
    lines.push('## Brand Identity (MUST PRESERVE)');
    lines.push('Clear branding detected on the original site. You MUST use these colors:');
    lines.push(`Primary brand colors: ${ds.colors.primary.join(', ')}`);
    if (ds.colors.semantic?.nav?.length) lines.push(`Nav/header colors: ${ds.colors.semantic.nav.join(', ')}`);
    if (ds.colors.semantic?.cta?.length) lines.push(`Button/CTA colors: ${ds.colors.semantic.cta.join(', ')}`);
    if (ds.colors.semantic?.heading?.length) lines.push(`Heading colors: ${ds.colors.semantic.heading.join(', ')}`);
    lines.push('');
    lines.push('DO NOT invent a new color scheme. The redesign must look like it belongs');
    lines.push('to the same brand. You may adjust shades/tints for contrast, but the core');
    lines.push('brand palette must be recognizable.');
    lines.push('');
  } else {
    lines.push('## Brand Identity');
    lines.push('No strong brand colors detected. You may propose a modern color palette,');
    lines.push('but keep it consistent with any colors present in the original design.');
    lines.push('');
  }

  // Typography
  if (ds.typography.recommended) {
    lines.push('## Typography');
    lines.push(`Recommended pairing: **${ds.typography.recommended.heading}** (headings) + **${ds.typography.recommended.body}** (body)`);
    lines.push(`Vibe: ${ds.typography.recommended.vibe || 'modern'}`);
    lines.push('');
  }

  // Images
  lines.push('## Images (MUST REUSE — NON-NEGOTIABLE)');
  lines.push('The original site has real images. You MUST use them. Do NOT invent image URLs.');
  lines.push('Read ./image-manifest.md for the complete list with exact URLs.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Use the EXACT src URLs below — do not modify, shorten, or guess URLs');
  lines.push('- Every section of your redesign should have visual content — no sparse/empty areas');
  lines.push(`- The site has ${ds.images?.total || 0} images — use at least as many in your redesign`);
  lines.push('- CSS gradients are supplementary decoration, NOT replacements for real photos');
  lines.push('- NEVER output an <img> tag with a made-up src — only URLs from this list');
  lines.push('');

  // Strategic design directives
  lines.push('## Strategic Design Directives');
  lines.push('Read ./strategy-brief.md for the full strategy brief. Key directives:\n');
  lines.push(`### Hero Section (Halo Effect — 50ms first impression)`);
  lines.push(`- Target emotion: **${ds.brand.emotion?.primary || 'trust'}** + **${ds.brand.emotion?.secondary || 'confidence'}**`);
  lines.push('- Single clear promise visible without scrolling');
  lines.push('');

  // Pattern gap directives
  if (ds.patternGaps?.length > 0) {
    lines.push('## Modern Design Patterns (apply these)');
    const highPri = ds.patternGaps.filter(g => g.priority === 'high');
    const medPri = ds.patternGaps.filter(g => g.priority === 'medium');
    const lowPri = ds.patternGaps.filter(g => g.priority === 'low');

    if (highPri.length) {
      lines.push('\n### Must-Have (high priority)');
      for (const g of highPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    if (medPri.length) {
      lines.push('\n### Recommended (medium priority)');
      for (const g of medPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    if (lowPri.length) {
      lines.push('\n### Nice-to-Have (low priority)');
      for (const g of lowPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    lines.push('');
  }

  // Layout
  lines.push('## Layout');
  lines.push(`Style: ${ds.layout.style}`);
  if (ds.layout.description) lines.push(ds.layout.description);
  lines.push('');

  // Technical requirements
  lines.push('## Technical Requirements');
  lines.push('- Single self-contained HTML file with inline CSS');
  lines.push('- Mobile-responsive (test at 375px, 768px, 1440px)');
  lines.push('- Ensure WCAG AA contrast ratios (4.5:1 for text, 3:1 for large text)');
  lines.push('- Include JSON-LD structured data (Organization, FAQPage where appropriate)');
  lines.push('- Short answer paragraphs near headings for AI extractability');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main handler: scrape → analyze → generate → store in Postgres.
 */
async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const targetUrl = metadata.target_url;

  if (!targetUrl) {
    return { success: false, reason: 'No target_url in work item metadata' };
  }

  // Create work directory for this job
  const jobDir = join(WORK_DIR, task.work_item_id);
  mkdirSync(jobDir, { recursive: true });

  const costBreakdown = { analyze: 0, generate: 0, total: 0 };
  let heartbeat = null;
  let cachedDesignSystem = null;

  try {
    // Start heartbeat immediately — reaper uses updated_at freshness
    heartbeat = startHeartbeat(task.work_item_id);

    // ── Step -1: Check design system cache (24h TTL) ─────────────
    try {
      const cacheResult = await queryWithRetry(
        `SELECT metadata->'design_system' as ds
         FROM agent_graph.work_items
         WHERE metadata->>'target_url' = $1
         AND status = 'completed'
         AND metadata->'design_system' IS NOT NULL
         AND updated_at > NOW() - INTERVAL '24 hours'
         ORDER BY updated_at DESC LIMIT 1`,
        [targetUrl]
      );
      if (cacheResult.rows?.length > 0 && cacheResult.rows[0].ds) {
        cachedDesignSystem = cacheResult.rows[0].ds;
        console.log(`[executor-redesign] Cache HIT: reusing design system from previous run (24h TTL)`);
      }
    } catch (err) {
      console.warn(`[executor-redesign] Cache check failed (non-fatal): ${err.message}`);
    }

    // ── Step 0: Audit original URL ──────────────────────────────
    let auditBefore = null;
    try {
      console.log(`[executor-redesign] Auditing original URL: ${targetUrl}`);
      auditBefore = await auditUrl(targetUrl);
      console.log(`[executor-redesign] Lighthouse before:`, auditBefore);
    } catch (err) {
      console.warn(`[executor-redesign] Lighthouse audit failed (non-fatal): ${err.message}`);
    }

    // ── Step 0.5: Re-validate DNS before scrape (SSRF rebinding defense) ──
    // Force IPv4 to avoid IPv6 bypass (::1, ::ffff:127.0.0.1, fc00::, etc.)
    try {
      const { address } = await lookup(new URL(targetUrl).hostname, { family: 4 });
      const parts = address.split('.').map(Number);
      if (parts[0] === 0 ||                                             // 0.0.0.0
          parts[0] === 10 ||                                             // RFC1918
          parts[0] === 127 ||                                            // loopback
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||      // RFC1918
          (parts[0] === 192 && parts[1] === 168) ||                      // RFC1918
          (parts[0] === 169 && parts[1] === 254)) {                      // link-local
        return { success: false, reason: 'DNS rebinding detected — URL now resolves to private IP' };
      }
    } catch (err) {
      return { success: false, reason: `DNS re-validation failed: ${err.message}` };
    }

    // ── Step 1: Scrape ──────────────────────────────────────────
    heartbeat.setPhase('scraping');
    console.log(`[executor-redesign] Scraping ${targetUrl}`);
    let scraped;
    {
      const startMs = Date.now();
      try {
        await requirePermission(agent.agentId, 'tool', 'web_scrape');
        scraped = await scrapeUrl(targetUrl, jobDir);
        logCapabilityInvocation({
          agentId: agent.agentId, resourceType: 'tool', resourceName: 'web_scrape',
          success: true, durationMs: Date.now() - startMs, workItemId: task.work_item_id,
        });
      } catch (err) {
        logCapabilityInvocation({
          agentId: agent.agentId, resourceType: 'tool', resourceName: 'web_scrape',
          success: false, durationMs: Date.now() - startMs, errorMessage: err.message,
          workItemId: task.work_item_id,
        });
        return { success: false, reason: `Scrape failed: ${err.message}` };
      }
    }

    // ── Step 2: Analyze ─────────────────────────────────────────
    heartbeat.setPhase('analyzing');
    console.log(`[executor-redesign] Analyzing design`);
    const { analysis, costUsd: analyzeCost } = await analyzeDesign(agent, scraped, task.work_item_id);
    costBreakdown.analyze = analyzeCost;

    // Save analysis to work dir for the CLI session
    writeFileSync(join(jobDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

    // ── Step 2.1: Extract business context ($0, pure JS) ─────────
    console.log(`[executor-redesign] Extracting business context`);
    const businessContext = extractBusinessContext(scraped, analysis, targetUrl);
    writeFileSync(join(jobDir, 'business-context.json'), JSON.stringify(businessContext, null, 2));
    console.log(`[executor-redesign] Business: type=${businessContext.businessType}, audience=${businessContext.audience}, goal=${businessContext.primaryConversionGoal}, emotion=${businessContext.targetEmotion.primary}+${businessContext.targetEmotion.secondary}`);
    if (businessContext.fontPairing) {
      console.log(`[executor-redesign] Typography: ${businessContext.fontPairing.heading} + ${businessContext.fontPairing.body} (${businessContext.fontPairing.vibe})`);
    }
    if (businessContext.layoutStyle) {
      console.log(`[executor-redesign] Layout: ${businessContext.layoutStyle.style}`);
    }

    // ── Step 2.2: Generate strategy brief ($0, template) ─────────
    console.log(`[executor-redesign] Generating strategy brief`);
    const strategyBriefMd = generateStrategyBrief(businessContext, analysis);
    writeFileSync(join(jobDir, 'strategy-brief.md'), strategyBriefMd);

    // ── Step 2.3: Build structured design system (JSON) ──────────
    let extractedDesignSystem;
    if (cachedDesignSystem) {
      extractedDesignSystem = cachedDesignSystem;
      console.log(`[executor-redesign] Using cached design system (skipping extraction)`);
    } else {
      console.log(`[executor-redesign] Building design system artifact`);
      extractedDesignSystem = buildDesignSystem(scraped, analysis, businessContext, auditBefore);
      const validation = validateDesignSystem(extractedDesignSystem);
      if (!validation.valid) {
        console.warn(`[executor-redesign] Design system validation warnings: ${validation.errors.join(', ')}`);
      }
      console.log(`[executor-redesign] Design system: ${extractedDesignSystem.patternGaps.length} pattern gaps detected, branding=${extractedDesignSystem.colors.hasClearBranding}`);
    }
    writeFileSync(join(jobDir, 'design-system.json'), JSON.stringify(extractedDesignSystem, null, 2));

    // ── Step 2.5: Render design brief FROM design system ─────────
    let briefContent = renderDesignBrief(extractedDesignSystem, strategyBriefMd);

    // Append strategy directives not covered by renderDesignBrief
    const extraLines = [];
    extraLines.push('### Cognitive Fluency');
    extraLines.push('- ONE goal per section — each section should have exactly one purpose');
    extraLines.push('- Whitespace is a premium signal. Use padding >= 60px between sections');
    extraLines.push('- Visual hierarchy should tell the story even without reading details');
    extraLines.push('');
    if (businessContext.fontPairing) {
      const fp = businessContext.fontPairing;
      extraLines.push('### Typography (MUST USE)');
      extraLines.push(`- Heading font: **${fp.heading}** (weights: ${fp.weights.heading.join(', ')})`);
      extraLines.push(`- Body font: **${fp.body}** (weights: ${fp.weights.body.join(', ')})`);
      if (fp.accent) {
        extraLines.push(`- Accent font: **${fp.accent}** (weights: ${fp.weights.accent.join(', ')})`);
      }
      extraLines.push(`- Google Fonts link: \`${fp.googleFontsUrl}\``);
      extraLines.push('- Use `font-display: swap` for performance');
      extraLines.push('- Do NOT use any other fonts. This pairing was selected to match the brand emotion.');
      extraLines.push('');
    }
    if (businessContext.layoutStyle) {
      const ls = businessContext.layoutStyle;
      extraLines.push(`### Layout Style: ${ls.style}`);
      extraLines.push(ls.description);
      extraLines.push('');
    }
    extraLines.push('### Micro-Interactions (Peak-End Rule) — CSS only');
    extraLines.push('- CTA hover: `transform: translateY(-2px); box-shadow` transition');
    extraLines.push('- Card hover: subtle lift effect');
    extraLines.push('- `html { scroll-behavior: smooth }`');
    extraLines.push('- `:focus-visible` outlines on all interactive elements');
    extraLines.push('- Section fade-in animation (CSS `@keyframes`, no JS)');
    extraLines.push('- Button state transitions: `transition: background-color 0.2s, transform 0.2s`');
    extraLines.push('');
    extraLines.push('### Conversion Architecture');
    extraLines.push(`- Primary goal: **${businessContext.primaryConversionGoal}**`);
    extraLines.push('- Place social proof within one scroll of every CTA');
    extraLines.push('- Objection handling (FAQ/Why Us) section BEFORE the final CTA');
    extraLines.push('- At least one trust signal visible above the fold');
    extraLines.push('');
    extraLines.push('## Score Requirements (NON-NEGOTIABLE)');
    extraLines.push('Your redesign MUST score EQUAL OR BETTER on every metric:');
    if (auditBefore) {
      extraLines.push(`- SEO: must be >= ${auditBefore.seo}`);
      extraLines.push(`- Accessibility: must be >= ${auditBefore.accessibility}`);
      extraLines.push(`- Performance: must be >= ${auditBefore.performance}`);
      extraLines.push(`- Best Practices: must be >= ${auditBefore['best-practices']}`);
    }
    if (scraped.aeoResult) {
      extraLines.push(`- AEO: must be >= ${scraped.aeoResult.aeoScore}`);
    }
    extraLines.push('A regression on ANY metric is unacceptable.');
    extraLines.push('');
    extraLines.push('## SEO Preservation (NON-NEGOTIABLE)');
    extraLines.push('Read ./seo-head.html — it contains all SEO-critical <head> elements extracted from the original site.');
    extraLines.push('Copy EVERY element from seo-head.html into your redesign\'s <head> tag.');
    extraLines.push('This includes: title, meta description, canonical URL, OG tags, hreflang links, and JSON-LD structured data.');
    extraLines.push('You may ADD new structured data (e.g., FAQPage) but NEVER remove or modify the originals.');
    extraLines.push('JSON-LD <script type="application/ld+json"> tags are NOT executable scripts — they are required SEO data.');
    extraLines.push('');
    extraLines.push('## Improvement Directives');
    extraLines.push('- Use semantic HTML5 (header, nav, main, section, article, footer)');
    extraLines.push('- Proper heading hierarchy (single H1, H2s for sections, H3s for subsections)');
    extraLines.push('- Add alt text to all images');
    extraLines.push('- Use ARIA labels for interactive elements');
    extraLines.push('- Ensure WCAG AA contrast ratios (4.5:1 for text, 3:1 for large text)');
    extraLines.push('- Include JSON-LD structured data (Organization, FAQPage where appropriate)');
    extraLines.push('- Short answer paragraphs near headings for AI extractability');
    extraLines.push('');

    briefContent += '\n' + extraLines.join('\n');
    writeFileSync(join(jobDir, 'design-brief.md'), briefContent);

    // ── Step 3: Generate (Pass 1) ──────────────────────────────
    heartbeat.setPhase('generating');

    const claudeCodeConfig = agent.config?.claudeCode || {};
    const pipelineConfig = agent.config?.pipeline?.generate || {};
    const primaryModel = pipelineConfig.model || 'gemini-3.1-pro-preview';
    const fallbackModel = pipelineConfig.fallbackModel || 'gemini-2.5-pro';

    console.log(`[executor-redesign] Pass 1: Generating redesign with Gemini CLI + Stitch (model: ${primaryModel})`);
    {
      const startMs = Date.now();
      await requirePermission(agent.agentId, 'subprocess', 'claude_cli');

      const genOpts = {
        scraped,
        analysis,
        businessContext,
        workDir: jobDir,
        maxBudgetUsd: claudeCodeConfig.maxBudgetUsd || DEFAULT_MAX_BUDGET_USD,
        allowedTools: pipelineConfig.allowedTools || claudeCodeConfig.allowedTools,
        maxTurns: pipelineConfig.maxTurns || claudeCodeConfig.maxTurns,
        extensions: pipelineConfig.extensions,
        allowedMcpServers: pipelineConfig.allowedMcpServers,
      };

      // Model fallback chain: pro → pro fallback → flash (with Stitch) → Claude
      const fallbackChain = [
        primaryModel,
        ...(primaryModel !== fallbackModel ? [fallbackModel] : []),
        ...(pipelineConfig.flashModels || ['gemini-3-flash-preview', 'gemini-2.5-flash']),
      ];
      // Deduplicate
      const models = [...new Set(fallbackChain)];

      // Support "claude:model" prefix to auto-detect backend
      function parseModel(m) {
        if (m.startsWith('claude:')) {
          return { backend: 'claude', model: m.slice(7), isClaude: true };
        }
        return { backend: 'gemini', model: m, isClaude: false };
      }

      let genResult;
      for (let i = 0; i < models.length; i++) {
        const { backend: modelBackend, model: modelName, isClaude } = parseModel(models[i]);
        if (i > 0) {
          console.log(`[executor-redesign] Retrying Pass 1 with ${modelBackend}/${modelName}`);
          costBreakdown.generate += genResult.costUsd || 0;
        }
        const opts = isClaude
          ? { ...genOpts, model: modelName, backend: 'claude', extensions: undefined, allowedMcpServers: undefined, allowedTools: claudeCodeConfig.allowedTools || ['Read', 'Write', 'Glob', 'Grep'] }
          : { ...genOpts, model: modelName, backend: 'gemini', timeoutMs: i === 0 ? CLI_TIMEOUT_MS : FALLBACK_TIMEOUT_MS };
        genResult = await generateRedesign(opts);
        const produced = existsSync(join(jobDir, 'redesign.html'));
        if (!genResult.error && !genResult.isError && produced) break;
        const errDetail = genResult.error || genResult.result || 'no output';
        console.warn(`[executor-redesign] Pass 1 failed with ${modelBackend}/${modelName}: ${errDetail.slice(0, 200)}`);
      }

      // Final fallback: Claude Code CLI if everything in the chain failed
      let produced = existsSync(join(jobDir, 'redesign.html'));
      if (genResult.error || genResult.isError || !produced) {
        console.log(`[executor-redesign] All models exhausted — falling back to Claude Code CLI`);
        costBreakdown.generate += genResult.costUsd || 0;
        genResult = await generateRedesign({
          ...genOpts,
          model: claudeCodeConfig.model || 'sonnet',
          backend: 'claude',
          extensions: undefined,
          allowedMcpServers: undefined,
          allowedTools: claudeCodeConfig.allowedTools || ['Read', 'Write', 'Glob', 'Grep'],
        });
      }

      logCapabilityInvocation({
        agentId: agent.agentId, resourceType: 'subprocess', resourceName: 'claude_cli',
        success: !genResult.error && !genResult.isError, durationMs: Date.now() - startMs,
        errorMessage: genResult.error || null,
        workItemId: task.work_item_id,
        resultSummary: genResult.error ? null : `${genResult.numTurns} turns, $${genResult.costUsd?.toFixed(4)}`,
      });

      if (genResult.error || genResult.isError) {
        const errDetail = genResult.error || genResult.result || 'CLI error';
        console.error(`[executor-redesign] Pass 1 failed: ${errDetail.slice(0, 500)}`);
        return { success: false, reason: `Generation failed: ${errDetail.slice(0, 200)}` };
      }

      costBreakdown.generate += genResult.costUsd || 0;
    }

    // Verify Pass 1 produced output before review passes
    if (!existsSync(join(jobDir, 'redesign.html'))) {
      return { success: false, reason: 'Pass 1: Claude Code did not produce redesign.html' };
    }

    // ── Step 3.1: Parallel review (Pass 2a + 2b) ────────────────
    heartbeat.setPhase('auditing');
    console.log(`[executor-redesign] Pass 2: Running Delphi + Linus reviews in parallel`);
    const reviewStartMs = Date.now();
    const reviewModel = claudeCodeConfig.model || 'sonnet';
    const [delphiResult, linusResult] = await Promise.all([
      reviewDelphi({ workDir: jobDir, model: reviewModel }),
      reviewLinus({ workDir: jobDir, model: reviewModel }),
    ]);
    const reviewDurationMs = Date.now() - reviewStartMs;

    const delphiOk = !delphiResult.error && !delphiResult.isError;
    const linusOk = !linusResult.error && !linusResult.isError;
    console.log(`[executor-redesign] Pass 2 complete (${Math.round(reviewDurationMs / 1000)}s): delphi=${delphiOk ? 'ok' : 'failed'}, linus=${linusOk ? 'ok' : 'failed'}`);

    costBreakdown.generate += (delphiResult.costUsd || 0) + (linusResult.costUsd || 0);

    // ── Step 3.2: Apply feedback (Pass 3) ────────────────────────
    // Only run if at least one review succeeded and produced a file
    const hasDelphiReview = existsSync(join(jobDir, 'delphi-review.md'));
    const hasLinusReview = existsSync(join(jobDir, 'linus-review.md'));

    if (hasDelphiReview || hasLinusReview) {
      console.log(`[executor-redesign] Pass 3: Applying review feedback (delphi=${hasDelphiReview}, linus=${hasLinusReview})`);
      const fixResult = await applyReviewFeedback({ workDir: jobDir, model: reviewModel });

      if (fixResult.error || fixResult.isError) {
        console.warn(`[executor-redesign] Pass 3 failed (non-fatal, using Pass 1 output): ${fixResult.error || 'CLI error'}`);
      } else {
        console.log(`[executor-redesign] Pass 3 complete (${fixResult.numTurns} turns, $${fixResult.costUsd?.toFixed(4)})`);
        costBreakdown.generate += fixResult.costUsd || 0;
      }
    } else {
      console.log(`[executor-redesign] Skipping Pass 3: no review files produced`);
    }

    // Read generated HTML
    let redesignHtml;
    try {
      redesignHtml = readFileSync(join(jobDir, 'redesign.html'), 'utf-8');
    } catch {
      return { success: false, reason: 'Claude Code did not produce redesign.html' };
    }

    // ── Step 3.5: Audit redesign ────────────────────────────────
    let auditAfter = null;
    let aeoAfter = null;
    try {
      console.log(`[executor-redesign] Auditing redesign output`);
      const localAudit = await auditLocalFile(join(jobDir, 'redesign.html'));
      auditAfter = localAudit.lighthouse;
      aeoAfter = localAudit.aeo;
      console.log(`[executor-redesign] Lighthouse after:`, auditAfter);
      console.log(`[executor-redesign] AEO after:`, aeoAfter);
    } catch (err) {
      console.warn(`[executor-redesign] Redesign audit failed (non-fatal): ${err.message}`);
    }

    // ── Step 3.6: Regression gate — fix any scores that got worse ──
    const regressions = findRegressions(
      auditBefore, auditAfter,
      scraped.aeoResult?.aeoScore, aeoAfter?.aeoScore
    );

    if (regressions.length > 0) {
      heartbeat.setPhase('fixing_regressions');
      console.log(`[executor-redesign] Score regressions detected: ${regressions.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}`);
      for (const r of regressions) {
        if (r.failingAudits) console.log(`[executor-redesign] ${r.label} failing audits:\n${r.failingAudits}`);
      }
      const regResult = await fixRegressions({ workDir: jobDir, regressions, model: reviewModel });

      if (regResult.error || regResult.isError) {
        console.error(`[executor-redesign] Regression fix failed: ${regResult.error || 'CLI error'}`);
        return { success: false, reason: `Regression fix failed: ${regResult.error || 'CLI error'}. Scores regressed: ${regressions.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}` };
      } else {
        console.log(`[executor-redesign] Regression fix complete (${regResult.numTurns} turns, $${regResult.costUsd?.toFixed(4)})`);
        costBreakdown.generate += regResult.costUsd || 0;

        // Re-read the fixed HTML
        try {
          redesignHtml = readFileSync(join(jobDir, 'redesign.html'), 'utf-8');
        } catch {}

        // Re-audit to confirm fixes (best-effort)
        try {
          const reAudit = await auditLocalFile(join(jobDir, 'redesign.html'));
          auditAfter = reAudit.lighthouse;
          aeoAfter = reAudit.aeo;
          console.log(`[executor-redesign] Post-fix Lighthouse:`, auditAfter);

          // Check if regressions remain — retry once more if so
          const remaining = findRegressions(auditBefore, auditAfter, scraped.aeoResult?.aeoScore, aeoAfter?.aeoScore);
          if (remaining.length > 0) {
            console.warn(`[executor-redesign] Remaining regressions after fix 1: ${remaining.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}`);
            console.log(`[executor-redesign] Attempting second regression fix...`);

            const regResult2 = await fixRegressions({ workDir: jobDir, regressions: remaining });
            if (regResult2.error || regResult2.isError) {
              return { success: false, reason: `Regression fix 2 failed: ${regResult2.error || 'CLI error'}. Remaining: ${remaining.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}` };
            } else if (!regResult2.error && !regResult2.isError) {
              costBreakdown.generate += regResult2.costUsd || 0;
              try { redesignHtml = readFileSync(join(jobDir, 'redesign.html'), 'utf-8'); } catch {}
              try {
                const reAudit2 = await auditLocalFile(join(jobDir, 'redesign.html'));
                auditAfter = reAudit2.lighthouse;
                aeoAfter = reAudit2.aeo;
                const still = findRegressions(auditBefore, auditAfter, scraped.aeoResult?.aeoScore, aeoAfter?.aeoScore);
                if (still.length > 0) {
                  console.error(`[executor-redesign] Still regressed after 2 fixes: ${still.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}`);
                  return { success: false, reason: `Unresolvable regressions after 2 fix attempts: ${still.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}` };
                } else {
                  console.log(`[executor-redesign] All regressions resolved after fix 2`);
                }
              } catch {}
            }
          } else {
            console.log(`[executor-redesign] All regressions resolved after fix 1`);
          }
        } catch (err) {
          console.warn(`[executor-redesign] Post-fix audit failed (non-fatal): ${err.message}`);
        }
      }
    } else if (auditBefore && auditAfter) {
      console.log(`[executor-redesign] No regressions — all scores equal or better`);
    }

    // Output safety: strip any <script> tags
    redesignHtml = stripScripts(redesignHtml);

    costBreakdown.total = costBreakdown.analyze + costBreakdown.generate;

    // ── Step 4: Store in Postgres ───────────────────────────────
    heartbeat.setPhase('storing');
    heartbeat.stop();

    // Read strategy rationale if Claude generated it
    let strategyRationale = null;
    try {
      if (existsSync(join(jobDir, 'strategy-rationale.md'))) {
        strategyRationale = readFileSync(join(jobDir, 'strategy-rationale.md'), 'utf-8');
      }
    } catch {}

    console.log(`[executor-redesign] Storing redesign HTML in work_item metadata`);
    await queryWithRetry(
      `UPDATE agent_graph.work_items
       SET metadata = metadata || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          html_output: redesignHtml,
          cost_usd: costBreakdown.total,
          design_system: extractedDesignSystem,
          design_system_version: '1.0.0',
          design_analysis: analysis,
          business_context: businessContext,
          strategy_rationale: strategyRationale,
          audit_before: auditBefore ? { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null } : null,
          audit_after: auditAfter ? { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null } : null,
          aeo_breakdown_before: scraped.aeoResult?.breakdown || null,
          aeo_breakdown_after: aeoAfter?.breakdown || null,
          score_comparison: (() => {
            if (!auditBefore || !auditAfter) return null;
            const result = {};
            const keys = ['performance', 'accessibility', 'seo', 'best-practices', 'aeo'];
            const afterWithAeo = { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null };
            const beforeWithAeo = { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null };
            for (const k of keys) {
              const before = beforeWithAeo[k];
              const after = afterWithAeo[k];
              if (typeof before === 'number' && typeof after === 'number' && after >= before) {
                result[k] = { before, after, delta: after - before };
              }
            }
            return result;
          })(),
        }),
        task.work_item_id,
      ]
    );

    // Log CLI session to llm_invocations for audit trail (P3)
    try {
      const promptHash = createHash('sha256').update(targetUrl).digest('hex');
      const responseHash = createHash('sha256').update(redesignHtml.slice(0, 1000)).digest('hex');
      const idempotencyKey = `redesign-gen-${task.work_item_id}-${promptHash.slice(0, 16)}`;

      await queryWithRetry(
        `INSERT INTO agent_graph.llm_invocations
         (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
          prompt_hash, response_hash, latency_ms, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          agent.agentId, task.work_item_id, 'claude-sonnet-4-6',
          0, 0, costBreakdown.generate,
          promptHash, responseHash, 0, idempotencyKey,
        ]
      );
    } catch (err) {
      console.warn(`[executor-redesign] Failed to log to llm_invocations: ${err.message}`);
    }

    await publishEvent(
      'redesign_completed',
      `Website redesign completed for ${targetUrl}`,
      agent.agentId, task.work_item_id,
      { target_url: targetUrl, cost_usd: costBreakdown.total }
    );

    console.log(`[executor-redesign] Redesign complete for ${targetUrl} (cost: $${costBreakdown.total.toFixed(4)})`);

    // Send email notification if requested
    if (metadata.notify_email) {
      try {
        const previewUrl = `https://staqs.io/api/redesign/preview/${task.work_item_id}`;
        await sendRedesignEmail(metadata.notify_email, targetUrl, previewUrl, {
          auditBefore: auditBefore ? { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null } : null,
          auditAfter: auditAfter ? { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null } : null,
        });
        console.log(`[executor-redesign] Notification email sent to ${metadata.notify_email}`);
      } catch (emailErr) {
        console.warn(`[executor-redesign] Failed to send notification email: ${emailErr.message}`);
      }
    }

    return {
      success: true,
      reason: `Redesign completed for ${targetUrl} (cost: $${costBreakdown.total.toFixed(4)})`,
      costUsd: costBreakdown.total,
    };
  } finally {
    // Ensure heartbeat is stopped even on early errors
    try { heartbeat?.stop(); } catch {}
    // Cleanup work directory (best-effort)
    try {
      const { rm } = await import('fs/promises');
      await rm(jobDir, { recursive: true, force: true });
    } catch {}
  }
}

export const redesignLoop = new AgentLoop('executor-redesign', handler);
