import 'dotenv/config';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { initializeDatabase, close } from './db.js';
import { initializeJwtKeys } from './runtime/agent-jwt.js';
import { initializeBoardJwtKeys } from './runtime/board-jwt.js';
import { initPgNotify, unsubscribeAll } from './runtime/event-bus.js';
import { syncConfigHashes, ensureDailyBudget, logDeployEvent } from './runtime/startup.js';
import { coderLoop } from './agents/executor-coder.js';
import { researchLoop } from './agents/executor-research.js';
import { campaignerLoop } from './agents/claw-campaigner/index.js';
import { workshopLoop } from './agents/claw-workshop/index.js';
import { redesignLoop } from './agents/executor-redesign.js';
import { blueprintLoop } from './agents/executor-blueprint.js';
import { triageLoop } from './agents/issue-triage/index.js';

/**
 * Optimus Runner: lightweight task worker for remote machines.
 *
 * Connects to the shared Postgres database and runs only the executor-coder
 * agent (or a configurable subset). Skips Gmail, Slack, Telegram, Drive,
 * API server, and all periodic services.
 *
 * Multiple runners can operate simultaneously — task claiming uses
 * SELECT ... FOR UPDATE SKIP LOCKED. Cross-process wake-up via pg_notify.
 *
 * Usage:
 *   npm run runner                         # default: executor-coder only
 *   node src/runner.js --agents executor-coder,executor-ticket
 *   RUNNER_ID=mac-m1 npm run runner        # human-friendly name
 */

// All agents that can run in runner mode
const RUNNER_AGENTS = {
  'executor-coder': coderLoop,
  'executor-redesign': redesignLoop,
  'executor-blueprint': blueprintLoop,
  'executor-research': researchLoop,
  'claw-campaigner': campaignerLoop,
  'claw-workshop': workshopLoop,
  'issue-triage': triageLoop,
};

function parseArgs() {
  const agentsArg = process.argv.find(a => a.startsWith('--agents='));
  const agentNames = agentsArg
    ? agentsArg.split('=')[1].split(',').map(s => s.trim())
    : ['executor-coder', 'claw-campaigner'];

  const invalid = agentNames.filter(n => !RUNNER_AGENTS[n]);
  if (invalid.length > 0) {
    console.error(`Unknown runner agent(s): ${invalid.join(', ')}`);
    console.error(`Available: ${Object.keys(RUNNER_AGENTS).join(', ')}`);
    process.exit(1);
  }

  return agentNames;
}

function generateRunnerId() {
  if (process.env.RUNNER_ID) return process.env.RUNNER_ID;
  const host = hostname().split('.')[0].toLowerCase();
  const suffix = randomBytes(3).toString('hex');
  return `${host}-${process.pid}-${suffix}`;
}

async function main() {
  // Prevent unhandled pg Client errors from crashing the process.
  // EADDRNOTAVAIL happens when macOS sleeps or Docker networking hiccups.
  process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRNOTAVAIL' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      console.error(`[runner] Connection error (${err.code}): ${err.message} — will recover`);
      return; // pg pool will create new connections on next query
    }
    console.error('[runner] Uncaught exception:', err);
    process.exit(1);
  });

  // Validate: DATABASE_URL is mandatory for runners (no PGlite)
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required for runner mode.');
    console.error('The runner connects to the shared Optimus Postgres database.');
    console.error('Copy .env.runner.example to .env and configure DATABASE_URL.');
    process.exit(1);
  }

  const agentNames = parseArgs();
  const runnerId = generateRunnerId();

  console.log('Optimus Runner');
  console.log('==============');
  console.log(`Runner ID:  ${runnerId}`);
  console.log(`Hostname:   ${hostname()}`);
  console.log(`Platform:   ${process.platform}`);
  console.log(`Agents:     ${agentNames.join(', ')}`);
  console.log(`Node:       ${process.version}`);
  console.log();

  // Initialize database connection
  try {
    await initializeDatabase();
  } catch (err) {
    console.error(`Database connection failed: ${err.message}`);
    console.error('Check DATABASE_URL and ensure the Postgres server is reachable.');
    process.exit(1);
  }

  // Shared startup sequence (same as index.js)
  await syncConfigHashes();
  await initializeJwtKeys();
  await initializeBoardJwtKeys();
  await ensureDailyBudget();

  // Enable cross-process task wake-up via pg_notify
  await initPgNotify();

  // Log deploy event with runner identity
  await logDeployEvent({
    runner_id: runnerId,
    hostname: hostname(),
    platform: process.platform,
    mode: 'runner',
  });

  // Start selected agents (pass runnerId to agents that support it)
  const agents = agentNames.map(name => RUNNER_AGENTS[name]);
  for (const agent of agents) {
    agent.start({ runnerId }).catch(err => {
      console.error(`[${agent.agentId}] Fatal error:`, err.message);
    });
  }

  console.log(`\n[runner] Online — polling for tasks (${agentNames.join(', ')})\n`);

  // ── Status ticker: periodic heartbeat so operators know the runner is alive ──
  const statusState = { lastError: null, errorCount: 0, suppressedCount: 0 };
  const STATUS_INTERVAL_MS = 60_000; // 1 minute

  setInterval(() => {
    const uptime = Math.floor(process.uptime());
    const mins = Math.floor(uptime / 60);
    const hrs = Math.floor(mins / 60);
    const uptimeStr = hrs > 0 ? `${hrs}h${mins % 60}m` : `${mins}m`;
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    // Count active campaigns across all agent loops
    const campaigner = RUNNER_AGENTS['claw-campaigner'];
    const activeCampaignCount = campaigner?._getActiveCampaignCount?.() ?? 0;

    const status = activeCampaignCount > 0
      ? `\x1b[32m● processing\x1b[0m (${activeCampaignCount} campaign${activeCampaignCount > 1 ? 's' : ''})`
      : '\x1b[36m○ idle\x1b[0m — waiting for approved campaigns';

    console.log(`[runner] ${status} | uptime ${uptimeStr} | ${mem}MB heap | ${agentNames.join(', ')}`);

    if (statusState.suppressedCount > 0) {
      console.log(`[runner] (${statusState.suppressedCount} repeated error${statusState.suppressedCount > 1 ? 's' : ''} suppressed since last status)`);
      statusState.suppressedCount = 0;
    }
  }, STATUS_INTERVAL_MS);

  // Listen for config changes via pg_notify — enables dashboard toggle without restart
  const { onAnyEvent } = await import('./runtime/event-bus.js');
  onAnyEvent(async (event) => {
    if (event?.type === 'agent_config_changed') {
      console.log('[runner] Agent config changed — checking for enable/disable updates');
      try {
        const { readFileSync } = await import('fs');
        const config = JSON.parse(readFileSync(new URL('../config/agents.json', import.meta.url), 'utf-8'));
        for (const name of Object.keys(RUNNER_AGENTS)) {
          const agentConfig = config.agents[name];
          const loop = RUNNER_AGENTS[name];
          if (!agentConfig) continue;
          const shouldRun = agentConfig.enabled !== false;
          const isRunning = agents.includes(loop);
          if (shouldRun && !isRunning) {
            console.log(`[runner] Starting ${name} (enabled via dashboard)`);
            loop.start().catch(err => console.error(`[${name}] Start error:`, err.message));
            agents.push(loop);
          } else if (!shouldRun && isRunning) {
            console.log(`[runner] Stopping ${name} (disabled via dashboard)`);
            loop.stop();
            agents.splice(agents.indexOf(loop), 1);
          }
        }
      } catch (err) {
        console.warn(`[runner] Config reload failed: ${err.message}`);
      }
    }
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down runner ${runnerId}...`);

    for (const agent of agents) {
      agent.stop();
    }
    unsubscribeAll();

    await new Promise(resolve => setTimeout(resolve, 2000));
    await close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
