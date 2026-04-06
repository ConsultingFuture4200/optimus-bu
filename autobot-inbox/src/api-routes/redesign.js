import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { transitionState } from '../runtime/state-machine.js';
import { emit } from '../runtime/event-bus.js';
import { lookup } from 'dns/promises';

/**
 * Website Redesign API routes.
 *
 * POST /api/redesign/submit       — submit a URL for redesign
 * GET  /api/redesign/status/:id   — poll job status
 * GET  /api/redesign/preview/:id  — redirect to preview URL
 * GET  /api/redesign/strategy/:id — serve strategy rationale
 *
 * Public endpoints — no auth required (rate-limited instead).
 * These are the first Optimus-as-a-service endpoints.
 */

const MAX_PER_IP_24H = 3;
const MAX_GLOBAL_24H = 10;

/**
 * Validate that a URL is safe to scrape (no SSRF).
 * Blocks RFC1918, loopback, link-local addresses.
 */
async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: 'Only http/https URLs are allowed' };
  }

  const hostname = parsed.hostname;

  // Block obvious local hostnames
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname)) {
    return { valid: false, reason: 'Local URLs are not allowed' };
  }

  // DNS resolution check — block private IPs
  try {
    const { address } = await lookup(hostname);
    const parts = address.split('.').map(Number);

    // RFC1918
    if (parts[0] === 10) return { valid: false, reason: 'Private IP' };
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return { valid: false, reason: 'Private IP' };
    if (parts[0] === 192 && parts[1] === 168) return { valid: false, reason: 'Private IP' };
    // Loopback
    if (parts[0] === 127) return { valid: false, reason: 'Loopback IP' };
    // Link-local
    if (parts[0] === 169 && parts[1] === 254) return { valid: false, reason: 'Link-local IP' };
  } catch {
    return { valid: false, reason: 'DNS resolution failed' };
  }

  return { valid: true, url: parsed.href };
}

/**
 * Normalize URL for dedup (strip trailing slash, lowercase host).
 */
function normalizeUrl(urlString) {
  const parsed = new URL(urlString);
  parsed.hash = '';
  let normalized = parsed.href;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * Lightweight business type classification from raw HTML.
 * Mirrors logic from redesign-strategy.js detectBusinessType() but
 * works on raw HTML string instead of structured scraped data.
 */
function classifyFromHtml(html) {
  const lower = html.toLowerCase();

  // JSON-LD detection
  const jsonLdMatches = lower.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const jsonLdText = jsonLdMatches.join(' ').toLowerCase();

  // Aggregate all visible text signals (title, meta, headings, nav)
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].toLowerCase() : '';
  const metaDescMatch = html.match(/<meta[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].toLowerCase() : '';
  const headingMatches = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [];
  const headings = headingMatches.map(h => h.replace(/<[^>]+>/g, '').toLowerCase()).join(' ');
  const allText = `${jsonLdText} ${title} ${metaDesc} ${headings}`;

  const scores = {};
  function bump(type, weight) { scores[type] = (scores[type] || 0) + weight; }

  // JSON-LD type signals (high confidence)
  if (/law|attorney|legalservice/i.test(jsonLdText)) bump('legal', 3);
  if (/medicalorganization|physician|hospital|dentist/i.test(jsonLdText)) bump('healthcare', 3);
  if (/restaurant|foodestablishment|cafe|bar/i.test(jsonLdText)) bump('restaurant', 3);
  if (/realestate/i.test(jsonLdText)) bump('real-estate', 3);
  if (/educationalorganization|school|course/i.test(jsonLdText)) bump('education', 3);
  if (/financialservice|bankaccount/i.test(jsonLdText)) bump('finance', 3);
  if (/nonprofit|ngo/i.test(jsonLdText)) bump('nonprofit', 3);
  if (/product|store|offer/i.test(jsonLdText)) bump('ecommerce', 2);
  if (/softwareapplication/i.test(jsonLdText)) bump('saas', 2);
  if (/localbusiness|homeandconstructionbusiness|autobodyshop|autorepair|electrician|plumber|roofingcontractor|hvac|locksmith|movingcompany/i.test(jsonLdText)) bump('home-services', 3);

  // Keyword signals from visible text (lower confidence)
  if (/\b(attorney|lawyer|law\s*firm|legal\s*services|practice\s*areas)\b/.test(allText)) bump('legal', 2);
  if (/\b(patient|doctor|medical|clinic|health\s*care|appointment|wellness|therapy|dental)\b/.test(allText)) bump('healthcare', 2);
  if (/\b(menu|reserv|dine|cuisine|chef|appetizer|entree|brunch)\b/.test(allText)) bump('restaurant', 2);
  if (/\b(listing|property|realtor|mls|mortgage|sq\s*ft|bedroom|open\s*house)\b/.test(allText)) bump('real-estate', 2);
  if (/\b(tuition|curriculum|enroll|student|campus|learn|course|class)\b/.test(allText)) bump('education', 2);
  if (/\b(invest|portfolio|wealth|banking|loan|credit|insurance|fintech)\b/.test(allText)) bump('finance', 2);
  if (/\b(donate|mission|impact|volunteer|501c|charity|cause)\b/.test(allText)) bump('nonprofit', 2);
  if (/\b(shop|cart|product|add\s*to\s*bag|checkout|shipping|price)\b/.test(allText)) bump('ecommerce', 1);
  if (/\b(saas|api|integration|platform|dashboard|workflow|pricing\s*plan)\b/.test(allText)) bump('saas', 1);
  if (/\b(agency|portfolio|creative|branding|design\s*studio|our\s*work)\b/.test(allText)) bump('agency', 1);
  if (/\b(consult|advisory|strategy|solutions|expertise|engagement)\b/.test(allText)) bump('consulting', 1);
  if (/\b(software|developer|open.source|github|stack|deploy|infrastructure)\b/.test(allText)) bump('technology', 1);
  // Home services / local service businesses (repair, install, contractors, etc.)
  if (/\b(repair|install|replacement|maintenance|free\s*(?:quote|estimate)|service\s*area|windshield|auto\s*glass|roofing|plumbing|hvac|landscaping|garage\s*door|pest|cleaning|remodel|contractor|handyman|fencing|paving|towing|locksmith|siding|gutter|flooring|painting|moving|junk\s*removal|pressure\s*wash|tree\s*service)\b/.test(allText)) bump('home-services', 3);
  if (/\b(licensed|insured|bonded|family.owned|locally.owned|serving|same.day|emergency|residential|commercial)\b/.test(allText)) bump('home-services', 1);

  let best = 'default';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) { best = type; bestScore = score; }
  }
  return best;
}

/**
 * Lightweight audience detection from raw HTML.
 */
function classifyAudienceFromHtml(html) {
  const lower = html.toLowerCase();
  const b2b = (lower.match(/enterprise|solutions|integration|api|platform|teams|business|b2b|roi|workflow/gi) || []).length;
  const b2c = (lower.match(/shop|buy|personal|family|home|lifestyle|cart|order/gi) || []).length;
  if (b2b > b2c + 2) return 'B2B';
  if (b2c > b2b + 2) return 'B2C';
  return 'mixed';
}

export function registerRedesignRoutes(routes) {
  // POST /api/redesign/classify — lightweight industry classification
  routes.set('POST /api/redesign/classify', async (req, body) => {
    const { url } = body || {};
    if (!url || typeof url !== 'string') {
      const err = new Error('Missing required field: url');
      err.statusCode = 400;
      throw err;
    }

    const validation = await validateUrl(url);
    if (!validation.valid) {
      const err = new Error(validation.reason);
      err.statusCode = 400;
      throw err;
    }

    // Lightweight fetch — just HTML, no Playwright, 5s timeout, 50KB limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let html;
    try {
      const res = await fetch(validation.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'STAQS-Classify/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Read only first 50KB
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 50 * 1024;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes >= MAX_BYTES) break;
      }
      reader.cancel();
      html = new TextDecoder().decode(Buffer.concat(chunks).slice(0, MAX_BYTES));
    } catch (fetchErr) {
      // If fetch fails, return generic classification
      return { businessType: 'default', audience: 'mixed', industry: [] };
    } finally {
      clearTimeout(timeout);
    }

    const businessType = classifyFromHtml(html);
    const audience = classifyAudienceFromHtml(html);

    return { businessType, audience };
  });
  // POST /api/redesign/submit
  routes.set('POST /api/redesign/submit', async (req, body) => {
    const { url, email } = body || {};
    if (!url || typeof url !== 'string') {
      const err = new Error('Missing required field: url');
      err.statusCode = 400;
      throw err;
    }

    // Validate URL safety (SSRF prevention)
    const validation = await validateUrl(url);
    if (!validation.valid) {
      const err = new Error(validation.reason);
      err.statusCode = 400;
      throw err;
    }

    // Extract requester IP from headers (X-Forwarded-For for proxied requests)
    const requesterIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';

    // Rate limit: per-IP (3/24h)
    const ipCountResult = await query(
      `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND metadata->>'requester_ip' = $1
         AND created_at > now() - interval '24 hours'`,
      [requesterIp]
    );
    if (parseInt(ipCountResult.rows[0].cnt, 10) >= MAX_PER_IP_24H) {
      const err = new Error('Rate limit: maximum 3 redesigns per 24 hours');
      err.statusCode = 429;
      throw err;
    }

    // Rate limit: global (10/24h)
    const globalCountResult = await query(
      `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND created_at > now() - interval '24 hours'`
    );
    if (parseInt(globalCountResult.rows[0].cnt, 10) >= MAX_GLOBAL_24H) {
      const err = new Error('Service busy: daily capacity reached. Try again tomorrow.');
      err.statusCode = 429;
      throw err;
    }

    // Admission control removed — API and executor-redesign run on different machines
    // (Railway vs M1), making liveness detection unreliable. Instead, we rely on:
    // 1. Reaper cancels stale-assigned jobs after 60 minutes
    // 2. Status endpoint returns terminal state for missing/cancelled jobs

    // Dedup: same normalized URL within 24h returns existing job (skip failed/timed_out)
    const normalized = normalizeUrl(validation.url);
    const existingResult = await query(
      `SELECT id, status, metadata FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND metadata->>'target_url_normalized' = $1
         AND created_at > now() - interval '24 hours'
         AND status NOT IN ('failed', 'cancelled', 'timed_out')
        AND NOT (status = 'in_progress' AND updated_at < now() - interval '10 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [normalized]
    );
    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      const meta = existing.metadata || {};
      return {
        jobId: existing.id,
        status: existing.status,
        previewUrl: meta.preview_url || null,
        deduplicated: true,
      };
    }

    // Create work item in the task graph
    const metadata = {
      target_url: validation.url,
      target_url_normalized: normalized,
      requester_email: email || null,
      requester_ip: requesterIp,
    };

    const result = await query(
      `INSERT INTO agent_graph.work_items
       (type, title, routing_class, metadata, status, assigned_to, created_by)
       VALUES ('task', $2, 'FULL', $1, 'assigned', 'executor-redesign', 'orchestrator')
       RETURNING id, status, created_at`,
      [JSON.stringify(metadata), `Redesign: ${validation.url}`]
    );

    const jobId = result.rows[0].id;

    // Emit task event so executor-redesign agent can claim it
    await emit({
      eventType: 'task_created',
      workItemId: jobId,
      targetAgentId: 'executor-redesign',
      priority: 0,
      eventData: { target_url: validation.url },
    });

    await publishEvent(
      'redesign_submitted',
      `Website redesign submitted for ${validation.url}`,
      null, jobId,
      { target_url: validation.url }
    );

    return {
      jobId,
      status: 'created',
      createdAt: result.rows[0].created_at,
    };
  });

  // GET /api/redesign/status/:id — poll job status
  routes.set('GET /api/redesign/status/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    if (!jobId) {
      const err = new Error('Missing job ID');
      err.statusCode = 400;
      throw err;
    }

    const result = await query(
      `SELECT id, status, metadata, created_at, updated_at
       FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );

    if (result.rows.length === 0) {
      // Return terminal status instead of 404 so frontend stops polling.
      // The job may have been cancelled, cleared, or never existed.
      return {
        jobId,
        status: 'failed',
        hasPreview: false,
        error: 'Job not found — it may have been cancelled or expired.',
        createdAt: null,
        updatedAt: null,
      };
    }

    const job = result.rows[0];
    const meta = job.metadata || {};

    // If HTML output exists, report as completed regardless of internal state
    // (the reaper may have timed out the task after the HTML was stored)
    const effectiveStatus = meta.html_output ? 'completed' : job.status;

    // Queue position: count jobs ahead of this one (created earlier, not yet completed)
    let queuePosition = null;
    if (['created', 'assigned'].includes(job.status) && !meta.html_output) {
      const queueResult = await query(
        `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
         WHERE type = 'task' AND metadata ? 'target_url'
           AND status IN ('created', 'assigned', 'in_progress')
           AND created_at < $1
           AND id != $2`,
        [job.created_at, jobId]
      );
      queuePosition = parseInt(queueResult.rows[0].cnt, 10) + 1; // 1-indexed
    }

    return {
      jobId: job.id,
      status: effectiveStatus,
      hasPreview: !!meta.html_output,
      hasStrategy: !!meta.strategy_rationale,
      costUsd: meta.cost_usd || null,
      auditBefore: meta.audit_before || null,
      auditAfter: meta.audit_after || null,
      businessContext: meta.business_context || null,
      progressPhase: meta.progress_phase || null,
      heartbeatAt: meta.heartbeat_at || null,
      queuePosition,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  });

  // POST /api/redesign/notify — save email for completion notification
  routes.set('POST /api/redesign/notify', async (req, body) => {
    const { jobId, email } = body || {};
    if (!jobId || !email || typeof email !== 'string' || !email.includes('@')) {
      const err = new Error('Missing jobId or valid email');
      err.statusCode = 400;
      throw err;
    }

    // Store email in the work item metadata
    await query(
      `UPDATE agent_graph.work_items
       SET metadata = metadata || jsonb_build_object('notify_email', $1::text)
       WHERE id = $2 AND type = 'task' AND metadata ? 'target_url'`,
      [email, jobId]
    );

    return { ok: true };
  });

  // POST /api/redesign/:id/cancel — manually cancel a stuck job (requires API_SECRET)
  routes.set('POST /api/redesign/:id/cancel', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    // URL: /api/redesign/<id>/cancel → id is parts[parts.length - 2]
    const jobId = parts[parts.length - 2];

    // Verify it exists and is in a cancellable state
    const result = await query(
      `SELECT id, status FROM agent_graph.work_items WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );
    if (result.rows.length === 0) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }
    const job = result.rows[0];
    if (!['in_progress', 'assigned', 'created'].includes(job.status)) {
      const err = new Error(`Cannot cancel job in state: ${job.status}`);
      err.statusCode = 409;
      throw err;
    }

    await transitionState({
      workItemId: jobId,
      toState: 'cancelled',
      agentId: 'board',
      configHash: 'manual',
      reason: 'Manual cancellation by board',
    });

    return { jobId, status: 'cancelled' };
  });

  // POST /api/redesign/:id/retry — retry a stuck/failed/cancelled job (requires API_SECRET)
  routes.set('POST /api/redesign/:id/retry', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 2];

    const result = await query(
      `SELECT id, status, retry_count, assigned_to FROM agent_graph.work_items WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );
    if (result.rows.length === 0) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }
    const job = result.rows[0];
    if (!['in_progress', 'timed_out', 'failed', 'cancelled'].includes(job.status)) {
      const err = new Error(`Cannot retry job in state: ${job.status}`);
      err.statusCode = 409;
      throw err;
    }

    // If still in_progress, transition to timed_out first
    if (job.status === 'in_progress') {
      await transitionState({
        workItemId: jobId,
        toState: 'timed_out',
        agentId: 'board',
        configHash: 'manual',
        reason: 'Manual retry requested by board',
      });
    }

    // Increment retry count and reset to assigned
    await query(
      `UPDATE agent_graph.work_items SET retry_count = retry_count + 1, status = 'assigned', assigned_to = 'executor-redesign', updated_at = now() WHERE id = $1`,
      [jobId]
    );

    // Emit event so executor-redesign picks it up
    await emit({
      eventType: 'task_assigned',
      workItemId: jobId,
      targetAgentId: 'executor-redesign',
      priority: 0,
      eventData: { retry: (job.retry_count || 0) + 1, reason: 'manual_retry' },
    });

    return { jobId, status: 'assigned', retryCount: (job.retry_count || 0) + 1 };
  });

  // DELETE /api/redesign/clear — admin: clear all redesign jobs (requires API_SECRET)
  routes.set('DELETE /api/redesign/clear', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const result = await query(
      `DELETE FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
       RETURNING id, title, status`
    );

    return {
      deleted: result.rowCount,
      jobs: result.rows.map(r => ({ id: r.id, title: r.title, status: r.status })),
    };
  });

  // GET /api/redesign/strategy/:id — serve strategy rationale as standalone page
  routes.set('GET /api/redesign/strategy/:id', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    const result = await query(
      `SELECT metadata FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );

    const meta = result.rows[0]?.metadata;
    if (!meta?.strategy_rationale) {
      const err = new Error('Strategy rationale not available');
      err.statusCode = 404;
      throw err;
    }

    const targetUrl = meta.target_url || '';
    const domain = targetUrl ? new URL(targetUrl).hostname : 'site';
    const bc = meta.business_context || {};
    const rationale = meta.strategy_rationale;

    // Convert markdown to simple HTML for display
    const htmlBody = rationale
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Strategy Rationale — ${domain}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 40px 24px; color: #1a1a2e; line-height: 1.7; background: #fafafa; }
    h1 { color: #0f1923; border-bottom: 2px solid #22c55e; padding-bottom: 8px; }
    h2 { color: #1a2332; margin-top: 32px; }
    h3 { color: #334155; }
    li { margin: 4px 0; }
    strong { color: #0f1923; }
    .meta { color: #64748b; font-size: 14px; margin-bottom: 24px; }
    .badge { display: inline-block; background: #22c55e; color: #0f1923; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-right: 8px; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 13px; }
    footer a { color: #22c55e; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Strategy Rationale</h1>
  <div class="meta">
    <span class="badge">${bc.businessType || 'website'}</span>
    <span class="badge">${bc.audience || 'general'}</span>
    <span class="badge">goal: ${bc.primaryConversionGoal || 'contact'}</span>
    <br>Redesign of <strong>${domain}</strong>
  </div>
  <div>${htmlBody}</div>
  <footer>
    Generated by <a href="https://staqs.io">STAQS.IO</a> strategic redesign pipeline
  </footer>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(html);
    return '__sse__';
  });

  // GET /api/redesign/preview/:id — serve generated HTML directly from Postgres
  routes.set('GET /api/redesign/preview/:id', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    const result = await query(
      `SELECT metadata FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'
         AND metadata ? 'html_output'`,
      [jobId]
    );

    const htmlOutput = result.rows[0]?.metadata?.html_output;
    if (!htmlOutput) {
      const err = new Error('Preview not available');
      err.statusCode = 404;
      throw err;
    }

    // Serve the self-contained HTML directly
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' fonts.googleapis.com fonts.gstatic.com; img-src 'self' data: https:; script-src 'none'",
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(htmlOutput);
    return '__sse__'; // Signal to api.js that we handled the response
  });

}
