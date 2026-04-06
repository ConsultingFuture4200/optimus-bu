import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { initializeDatabase, close, query } from './db.js';
import { orchestratorLoop, startPolling } from './agents/orchestrator.js';
import { pollAllAccounts } from './gmail/poller.js';
import { strategistLoop } from './agents/strategist.js';
import { intakeLoop } from './agents/executor-intake.js';
import { triageLoop } from './agents/executor-triage.js';
import { responderLoop } from './agents/executor-responder.js';
import { reviewerLoop } from './agents/reviewer.js';
import { architectLoop } from './agents/architect.js';
import { ticketLoop } from './agents/executor-ticket.js';
import { coderLoop } from './agents/executor-coder.js';
import { researchLoop } from './agents/executor-research.js';
import { redesignLoop } from './agents/executor-redesign.js';
import { blueprintLoop } from './agents/executor-blueprint.js';
import { workshopLoop } from './agents/claw-workshop/index.js';
import { initPgNotify, unsubscribeAll } from './runtime/event-bus.js';
import { startApiServer, warmApiCache, startCacheInvalidationListener } from './api.js';
import { loadDemoEmails } from './demo.js';
import { Reaper } from './runtime/reaper.js';
import { runTier2Audit } from './audit/tier2-ai-auditor.js';
import { runTier3Audit } from './audit/tier3-cross-model.js';
import { checkDeadManSwitch } from './runtime/dead-man-switch.js';
import { syncLlmExpenses } from './finance/financial-script.js';
import { checkCircuitBreaker } from './runtime/exploration-monitor.js';
import { publishAllProofs } from './runtime/merkle-publisher.js';
import { runReconciliation, createHashCheckpoint, verifyToolRegistry } from './runtime/infrastructure.js';
import { initSlackApp, startSlack, stopSlack } from './slack/client.js';
import { registerSlackListeners } from './slack/listener.js';
import { initTelegramBot, startTelegram, stopTelegram } from './telegram/client.js';
import { registerTelegramListeners } from './telegram/listener.js';
import { pollAllDriveWatches } from './drive/watcher.js';
import { pollTldvTranscripts } from './tldv/poller.js';
import { registerAdapter } from './adapters/registry.js';
import { createEmailAdapter } from './adapters/email-adapter.js';
import { createOutlookAdapter } from './adapters/outlook-adapter.js';
import { createSlackAdapter } from './adapters/slack-adapter.js';
import { createWebhookAdapter } from './adapters/webhook-adapter.js';
import { createTelegramAdapter } from './adapters/telegram-adapter.js';
import { measureProductValue } from './value/value-measurement.js';
import { runPhase1MetricsCollection } from './runtime/phase1-metrics.js';
import { expireStaleIntents } from './runtime/intent-manager.js';
import { reconcileGitHubIssues } from './github/issue-monitor.js';
import { checkSpecDrift } from './runtime/spec-drift-detector.js';
import { initGraph, closeGraph } from './graph/client.js';
import { ensureSchema } from './graph/schema.js';
import { seedGraph } from './graph/seed.js';
import { seedSpecGraph } from './graph/spec-seed.js';
import { startGraphSync, stopGraphSync } from './graph/sync.js';
import { startIntentExecutor, stopIntentExecutor } from './runtime/intent-executor.js';
import { extractPatterns, startPatternListener, stopPatternListener } from './graph/pattern-extractor.js';
import { onAnyEvent } from './runtime/event-bus.js';
import { extractTranscriptActions } from './transcripts/action-extractor.js';

const agentsConfig = JSON.parse(readFileSync(new URL('../config/agents.json', import.meta.url), 'utf-8'));
const DEMO_MODE = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';

// PROCESS_ROLE: run a subset of the system in a single process.
// Values: 'ingestion' | 'agents' | 'api' | 'full' (default)
// Deploy as one process now; split into 3 Railway services when volume demands it.
const PROCESS_ROLE = process.env.PROCESS_ROLE || 'full';
const runIngestion = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'ingestion';
const runAgents = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'agents';
const runApi = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'api';

/**
 * AutoBot Inbox: AI inbox management system.
 * Entry point: starts all agent loops + Gmail polling.
 *
 * No Express. No framework. Just Postgres + agent event loops.
 * P4: Boring infrastructure.
 */

const agentRegistry = {
  orchestrator: orchestratorLoop,
  strategist: strategistLoop,
  'executor-intake': intakeLoop,
  'executor-triage': triageLoop,
  'executor-responder': responderLoop,
  reviewer: reviewerLoop,
  architect: architectLoop,
  'executor-ticket': ticketLoop,
  'executor-coder': coderLoop,
  'executor-research': researchLoop,
  'executor-redesign': redesignLoop,
  'executor-blueprint': blueprintLoop,
  'claw-workshop': workshopLoop,
};

// AGENTS_ENABLED env var: comma-separated list of agent IDs to run (overrides agents.json enabled flag).
// Split topology: Railway runs all enabled agents (everything except executor-coder + executor-redesign).
// Jamie's M1 runs ONLY the CLI agents: AGENTS_ENABLED=executor-redesign,executor-coder
// Both executor-coder and executor-redesign use spawnCLI() which requires Claude CLI (flat-rate sub).
const agentsEnabledOverride = process.env.AGENTS_ENABLED
  ? new Set(process.env.AGENTS_ENABLED.split(',').map(s => s.trim()))
  : null;

const agents = Object.entries(agentRegistry)
  .filter(([id]) => {
    const cfg = agentsConfig.agents[id];
    if (!cfg) return false;
    if (agentsEnabledOverride) return agentsEnabledOverride.has(id);
    return cfg.enabled !== false;
  })
  .map(([, loop]) => loop);

if (agents.length === 0) {
  console.warn('[startup] WARNING: No agents enabled in config/agents.json');
}

async function main() {
  console.log('AutoBot Inbox v0.1.0');
  console.log('====================\n');

  if (DEMO_MODE) {
    console.log('** DEMO MODE — using synthetic emails, no Gmail required **\n');
  }

  // Verify environment — PGlite doesn't need DATABASE_URL
  const required = DEMO_MODE ? [] : ['ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in values.');
    process.exit(1);
  }

  // Initialize PGlite (creates DB + runs migrations on first launch)
  try {
    const isNew = await initializeDatabase();
    console.log(isNew ? 'Database created and initialized' : 'Database connected');
  } catch (err) {
    console.error(`Database initialization failed: ${err.message}`);
    process.exit(1);
  }

  // Sync agent config hashes — runtime computes real SHA-256, DB must match
  await syncConfigHashes();

  // Initialize board JWT keys (separate keypair for external client auth)
  try {
    const { initializeBoardJwtKeys } = await import('./runtime/board-jwt.js');
    await initializeBoardJwtKeys();
  } catch (err) {
    console.warn(`[startup] Board JWT initialization skipped: ${err.message}`);
  }

  // Ensure today's budget exists
  await ensureDailyBudget();

  // Log deploy event for metric 12 (promotion-to-production lag)
  await logDeployEvent();

  // Knowledge graph (graceful — disabled if NEO4J_URI not set)
  await initGraph();
  await ensureSchema();
  await seedGraph();
  try {
    await seedSpecGraph();
  } catch (err) {
    // spec/ directory may not exist in Railway container — non-fatal
    console.warn(`[startup] Spec graph seeding skipped: ${err.message}`);
  }
  startGraphSync();

  console.log(`[startup] PROCESS_ROLE=${PROCESS_ROLE} (ingestion=${runIngestion}, agents=${runAgents}, api=${runApi})`);

  // Register channel adapters (used by context-loader to fetch bodies + build prompt context)
  // Needed by both ingestion and agents roles
  if (runIngestion || runAgents) {
    registerAdapter('gmail', createEmailAdapter());
    registerAdapter('outlook', createOutlookAdapter());
    registerAdapter('slack', createSlackAdapter());
    registerAdapter('webhook', createWebhookAdapter());
    registerAdapter('telegram', createTelegramAdapter());
  }

  // --- Ingestion: Slack, Telegram, Gmail, Drive polling ---
  let pollTimer;
  let driveTimeoutTimer;
  let driveIntervalTimer;

  if (runIngestion) {
    // Start Slack if configured
    const slackAccounts = await query(
      `SELECT id, label FROM inbox.accounts WHERE channel = 'slack' AND is_active = true`
    );
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const slackApp = await initSlackApp();
        const slackAccountId = slackAccounts.rows[0]?.id || 'default-slack';
        if (slackAccounts.rows.length === 0) {
          console.warn('[slack] SLACK_BOT_TOKEN set but no active Slack account in inbox.accounts — messages will use fallback ID');
        } else if (slackAccounts.rows.length > 1) {
          console.warn(`[slack] ${slackAccounts.rows.length} active Slack accounts found — using first: ${slackAccounts.rows[0].label || slackAccountId}`);
        }
        registerSlackListeners(slackApp, slackAccountId);
        await startSlack();
        console.log(`[slack] Connected (account: ${slackAccounts.rows[0]?.label || slackAccountId}, mode: socket)`);
      } catch (err) {
        console.error(`[slack] Init failed: ${err.message}`);
        console.error('[slack] Check: SLACK_BOT_TOKEN valid? SLACK_APP_TOKEN set? Socket Mode enabled in Slack app settings?');
      }
    } else if (slackAccounts.rows.length > 0) {
      console.warn(`[slack] ${slackAccounts.rows.length} active Slack account(s) in DB but SLACK_BOT_TOKEN not set — Slack channel disabled`);
      console.warn('[slack] To enable: set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env');
    }

    // Start Telegram if configured
    if (process.env.TELEGRAM_BOT_TOKEN) {
      if (!process.env.TELEGRAM_BOARD_USER_IDS) {
        console.warn('[telegram] TELEGRAM_BOT_TOKEN set but TELEGRAM_BOARD_USER_IDS is empty — all messages will be ignored');
      }
      try {
        const bot = await initTelegramBot();
        const telegramAccounts = await query(
          `SELECT id, label FROM inbox.accounts WHERE channel = 'telegram' AND is_active = true`
        );
        const telegramAccountId = telegramAccounts.rows[0]?.id || 'default-telegram';
        registerTelegramListeners(bot, telegramAccountId);
        await startTelegram();
        console.log(`[telegram] Connected (account: ${telegramAccounts.rows[0]?.label || telegramAccountId}, mode: polling)`);
      } catch (err) {
        console.error(`[telegram] Init failed: ${err.message}`);
      }
    }

    // Start Gmail polling or demo mode
    if (DEMO_MODE) {
      await loadDemoEmails();
    } else {
      const pollInterval = parseInt(process.env.GMAIL_POLL_INTERVAL || '60', 10) * 1000;
      pollTimer = await startPolling(pollInterval);
      console.log(`Gmail polling started (${pollInterval / 1000}s interval)`);
    }

    // Start Drive folder polling (if any watches exist)
    if (!DEMO_MODE) {
      const driveInterval = parseInt(process.env.DRIVE_POLL_INTERVAL || '300', 10) * 1000;
      let driveWatches = { rows: [] };
      try {
        driveWatches = await query(`SELECT 1 FROM inbox.drive_watches WHERE is_active = true LIMIT 1`);
      } catch (err) {
        console.log(`[drive] Table not available (migration may have failed): ${err.message}`);
      }
      if (driveWatches.rows.length > 0) {
        driveTimeoutTimer = setTimeout(() => {
          pollAllDriveWatches().catch(err => console.error(`[drive] Poll error: ${err.message}`));
          driveIntervalTimer = setInterval(() => {
            pollAllDriveWatches().catch(err => console.error(`[drive] Poll error: ${err.message}`));
          }, driveInterval);
        }, 15_000);
        console.log(`Drive polling scheduled (${driveInterval / 1000}s interval, 15s startup delay)`);
      } else {
        console.log('Drive polling skipped (no active watches — add via Settings)');
      }

      // TLDv API polling (direct transcript fetch, replaces brain-rag cron)
      if (process.env.TLDV_API_KEY) {
        const tldvInterval = parseInt(process.env.TLDV_POLL_INTERVAL_MS || '300000', 10); // 5 min default
        setTimeout(() => {
          pollTldvTranscripts().catch(err => console.error(`[tldv] Poll error: ${err.message}`));
          setInterval(() => {
            pollTldvTranscripts().catch(err => console.error(`[tldv] Poll error: ${err.message}`));
          }, tldvInterval);
        }, 20_000);
        console.log(`TLDv polling scheduled (${tldvInterval / 1000}s interval, 20s startup delay)`);
      } else {
        console.log('TLDv polling skipped (TLDV_API_KEY not set)');
      }
    }
  } else {
    console.log('[startup] Ingestion disabled (PROCESS_ROLE is not ingestion/full)');
  }

  // --- API server ---
  let apiServer;
  if (runApi) {
    await initPgNotify(); // receive pg_notify from M1 executors (cross-process cache invalidation)
    startCacheInvalidationListener(); // invalidate pipeline/status cache on state changes
    const apiPort = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
    apiServer = startApiServer(apiPort);
    await warmApiCache();
  } else {
    console.log('[startup] API server disabled (PROCESS_ROLE is not api/full)');
  }

  // --- Agent loops ---
  if (runAgents) {
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const delay = i * 2000;
      setTimeout(() => {
        agent.start().catch(err => {
          console.error(`[${agent.agentId}] Fatal error:`, err.message);
        });
      }, delay);
    }

    const agentNames = agents.map(a => a.agentId).join(', ');
    console.log(`\n${agents.length} agents started (${agentNames}). Use CLI (npm run cli) for board operations.\n`);
  } else {
    console.log('[startup] Agent loops disabled (PROCESS_ROLE is not agents/full)');
  }

  // Phase 2-4 periodic services
  const periodicTimers = [];

  // Track consecutive failures per service for alerting
  const serviceFailures = new Map();

  function scheduleService(name, fn, intervalMs, delayMs = 0) {
    const runWithTracking = async () => {
      const start = Date.now();
      try {
        await fn();
        const dur = Date.now() - start;
        if (dur > 30000) console.warn(`[${name}] Slow execution: ${(dur / 1000).toFixed(1)}s`);
        // Reset failure count on success
        if (serviceFailures.has(name)) {
          const prev = serviceFailures.get(name);
          if (prev >= 2) console.log(`[${name}] Recovered after ${prev} consecutive failure(s)`);
          serviceFailures.delete(name);
        }
      } catch (err) {
        const count = (serviceFailures.get(name) || 0) + 1;
        serviceFailures.set(name, count);
        console.error(`[${name}] Error (failure #${count}):`, err.message);
        if (count > 0 && count % 3 === 0) {
          console.error(`[${name}] ALERT: ${count} consecutive failures — service may be broken`);
          // Notify via Telegram if available
          try {
            const { notifyBoard } = await import('./telegram/sender.js');
            await notifyBoard(`⚠️ Service "${name}" failed 3x consecutively: ${err.message.slice(0, 100)}`);
          } catch { /* telegram not configured — log only */ }
        }
      }
    };

    const timer = setTimeout(() => {
      runWithTracking();
      const interval = setInterval(runWithTracking, intervalMs);
      periodicTimers.push(interval);
    }, delayMs);
    periodicTimers.push(timer);
  }

  // Reaper + periodic services: only run on the primary instance (not satellite runners)
  const isPrimaryInstance = !agentsEnabledOverride;
  const reaper = new Reaper();
  if (isPrimaryInstance) {
    reaper.start();
  } else {
    console.log('[startup] Periodic services skipped (AGENTS_ENABLED satellite runner)');
  }

  if (isPrimaryInstance) {
    // Architect daily briefing — schedule task creation for 6 AM daily
    scheduleService('architect-daily', async () => {
      const { createWorkItem } = await import('./runtime/state-machine.js');
      const existing = await query(
        `SELECT 1 FROM agent_graph.work_items
         WHERE assigned_to = 'architect' AND created_at >= CURRENT_DATE
         LIMIT 1`
      );
      if (existing.rows.length > 0) return;
      await createWorkItem({
        type: 'task',
        title: `Daily briefing: ${new Date().toISOString().slice(0, 10)}`,
        description: 'Generate daily pipeline analysis, briefing, and email digest',
        createdBy: 'orchestrator',
        assignedTo: 'architect',
        priority: 0,
        metadata: { trigger: 'daily_schedule' },
      });
      console.log('[architect-daily] Created daily briefing task');
    }, 60 * 60_000, 30_000);

    scheduleService('tier2-audit', runTier2Audit, 24 * 60 * 60_000, 5 * 60_000);
    scheduleService('dead-man-switch', checkDeadManSwitch, 24 * 60 * 60_000, 60_000);
    scheduleService('finance-sync', () => syncLlmExpenses(new Date()), 6 * 60 * 60_000, 2 * 60_000);
    scheduleService('exploration-monitor', checkCircuitBreaker, 60 * 60_000, 3 * 60_000);
    scheduleService('merkle-publisher', publishAllProofs, 24 * 60 * 60_000, 10 * 60_000);
    scheduleService('reconciliation', runReconciliation, 5 * 60_000, 45_000);
    scheduleService('hash-checkpoint', createHashCheckpoint, 60 * 60_000, 2 * 60_000);
    scheduleService('tool-verify', verifyToolRegistry, 24 * 60 * 60_000, 5_000);
    scheduleService('tier3-audit', runTier3Audit, 7 * 24 * 60 * 60_000, 15 * 60_000);
    scheduleService('value-measurement', async () => {
      const result = await measureProductValue('autobot-inbox', new Date());
      if (result) {
        console.log(`[value-measurement] Shadow mode: value_ratio=${result.value_ratio}, net_value=${result.net_value}`);
      } else {
        console.log('[value-measurement] Shadow mode: no data (schema may not be ready)');
      }
    }, 24 * 60 * 60_000, 15 * 60_000);
    scheduleService('phase1-metrics', runPhase1MetricsCollection, 60 * 60_000, 5 * 60_000);
    scheduleService('intent-expiry', expireStaleIntents, 60 * 60_000, 60_000);
    startIntentExecutor();
    scheduleService('github-reconciliation', reconcileGitHubIssues, 12 * 60 * 60_000, 10 * 60_000);
    scheduleService('spec-drift-detector', checkSpecDrift, 24 * 60 * 60_000, 20 * 60_000);

    // Canary: detect pipeline death — messages arriving but no drafts being created (Liotta review)
    scheduleService('pipeline-canary', async () => {
      const result = await query(`
        SELECT
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours') AS messages_24h,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at > now() - interval '24 hours') AS drafts_24h,
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours' AND triage_category IN ('action_required', 'needs_response')) AS actionable_24h
      `);
      const { messages_24h, drafts_24h, actionable_24h } = result.rows[0] || {};
      if (Number(actionable_24h) > 3 && Number(drafts_24h) === 0) {
        console.error(`[pipeline-canary] ALERT: ${actionable_24h} actionable emails in 24h but 0 drafts — pipeline may be dead`);
        try {
          const { notifyBoard } = await import('./telegram/sender.js');
          await notifyBoard(`🚨 Pipeline canary: ${actionable_24h} actionable emails in 24h but 0 drafts created. Pipeline may be broken.`);
        } catch { /* telegram not configured */ }
      }
    }, 6 * 60 * 60_000, 30 * 60_000); // Every 6h, 30min startup delay

    // Daily digest: Telegram summary of what happened in the last 24h
    scheduleService('daily-digest', async () => {
      // Only run between 7-9 AM local time (approximate — server may be UTC)
      const hour = new Date().getUTCHour?.() ?? new Date().getHours();
      // Skip if not morning window (UTC 12-14 ≈ ET 7-9 AM)
      if (hour < 12 || hour > 14) return;

      const stats = await query(`
        SELECT
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours') AS emails_received,
          (SELECT COUNT(*) FROM inbox.messages WHERE archived_at > now() - interval '24 hours') AS emails_archived,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at > now() - interval '24 hours') AS drafts_created,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action IS NOT NULL AND acted_at > now() - interval '24 hours') AS drafts_acted,
          (SELECT COUNT(*) FROM inbox.signals WHERE created_at > now() - interval '24 hours' AND resolved = false) AS signals_unresolved,
          (SELECT COUNT(*) FROM agent_graph.work_items WHERE created_at > now() - interval '24 hours') AS tasks_total,
          (SELECT COUNT(*) FROM agent_graph.work_items WHERE status = 'completed' AND created_at > now() - interval '24 hours') AS tasks_completed,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.state_transitions WHERE created_at > now() - interval '24 hours') AS cost_24h
      `);
      const s = stats.rows[0] || {};
      const msg = [
        '📊 *Daily Digest*',
        '',
        `📧 Emails: ${s.emails_received} received, ${s.emails_archived} auto-archived`,
        `📝 Drafts: ${s.drafts_created} created, ${s.drafts_acted} reviewed`,
        `📡 Signals: ${s.signals_unresolved} unresolved`,
        `⚙️ Tasks: ${s.tasks_completed}/${s.tasks_total} completed`,
        `💰 Cost: $${Number(s.cost_24h || 0).toFixed(2)}`,
        '',
        'Review: board.staqs.io/today',
      ].join('\n');

      try {
        const { notifyBoard } = await import('./telegram/sender.js');
        await notifyBoard(msg);
        console.log('[daily-digest] Sent to board via Telegram');
      } catch { /* telegram not configured */ }
    }, 60 * 60_000, 5 * 60_000); // Check every hour, 5min startup delay

    scheduleService('pattern-extractor', extractPatterns, 24 * 60 * 60_000, 15 * 60_000);
    startPatternListener();

    // Transcript action extractor: listen for completed tl;dv triage work items
    const unsubTranscript = onAnyEvent(async (payload) => {
      if (payload.event_type !== 'state_changed') return;
      try {
        const wiResult = await query(
          `SELECT id, metadata FROM agent_graph.work_items
           WHERE id = $1 AND status = 'completed'
             AND metadata->>'webhook_source' = 'tldv'`,
          [payload.work_item_id]
        );
        const wi = wiResult.rows[0];
        if (wi?.metadata?.email_id) {
          await extractTranscriptActions(wi.metadata.email_id);
        }
      } catch (err) {
        console.warn(`[transcript-listener] Error: ${err.message}`);
      }
    });

    console.log('Periodic services scheduled (reaper, architect-daily, tier2-audit, tier3-audit, dead-man-switch, finance-sync, exploration-monitor, merkle-publisher, reconciliation, hash-checkpoint, tool-verify, value-measurement, phase1-metrics, intent-expiry, intent-executor, github-reconciliation, spec-drift-detector, pattern-extractor, pattern-listener, transcript-action-extractor)');
  }

  // Fix 17: Graceful shutdown with double-shutdown guard
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return; // prevent re-entrant shutdown
    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down...`);

    if (pollTimer) clearInterval(pollTimer);
    if (driveTimeoutTimer) clearTimeout(driveTimeoutTimer);
    if (driveIntervalTimer) clearInterval(driveIntervalTimer);

    // Stop periodic services
    reaper.stop();
    for (const timer of periodicTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }

    for (const agent of agents) {
      agent.stop();
    }

    unsubscribeAll();

    // Stop intent executor + pattern listener + graph sync and Neo4j
    stopIntentExecutor();
    stopPatternListener();
    stopGraphSync();
    await closeGraph();

    // Stop Slack and Telegram if running
    await stopSlack();
    await stopTelegram();

    // Close API server
    if (apiServer) apiServer.close();

    // Wait a moment for loops to finish
    await new Promise(resolve => setTimeout(resolve, 2000));
    await close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Sync agent config hashes from agents.json into the DB.
 * The AgentLoop computes SHA-256 from the JSON config; the guard check
 * compares against the DB. If they don't match, every task gets blocked
 * with 'config_hash_mismatch'. This updates the DB on every startup.
 */
async function syncConfigHashes() {
  for (const [agentId, config] of Object.entries(agentsConfig.agents)) {
    const hash = createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);

    const result = await query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1 WHERE id = $2 AND config_hash != $1`,
      [hash, agentId]
    );
    if (result.rowCount > 0) {
      console.log(`[config] Updated ${agentId} config_hash → ${hash}`);
    }
  }
}

async function logDeployEvent() {
  try {
    const { execFileSync } = await import('child_process');
    let gitSha = null;
    try {
      gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {}
    await query(
      `INSERT INTO agent_graph.deploy_events (event_type, git_sha, metadata)
       VALUES ('pipeline_start', $1, $2)`,
      [gitSha, JSON.stringify({ node_version: process.version, pid: process.pid })]
    );
    console.log(`Deploy event logged (pipeline_start, ${gitSha || 'no-git'})`);
  } catch (err) {
    // Table may not exist yet (pre-migration) — non-fatal
    console.warn(`[deploy-event] Skip: ${err.message}`);
  }
}

async function ensureDailyBudget() {
  const dailyBudget = parseFloat(process.env.DAILY_BUDGET_USD || '20');

  const existing = await query(
    `SELECT id FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE`
  );

  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
       VALUES ('daily', 'default', $1, CURRENT_DATE, CURRENT_DATE)`,
      [dailyBudget]
    );
    console.log(`Daily budget created: $${dailyBudget}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
