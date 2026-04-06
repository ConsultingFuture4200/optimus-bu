import readline from 'readline';
import chalk from 'chalk';
import 'dotenv/config';

import { inboxCommand } from './commands/inbox.js';
import { reviewCommand } from './commands/review.js';
import { briefingCommand } from './commands/briefing.js';
import { statsCommand } from './commands/stats.js';
import { haltCommand, resumeCommand } from './commands/halt.js';
import { directiveCommand } from './commands/directive.js';
import { voiceCommand } from './commands/voice.js';
import { sendCommand } from './commands/send.js';
import { decideCommand } from './commands/decide.js';
import { intentsCommand } from './commands/intents.js';
import { researchCommand } from './commands/research.js';
import { initializeDatabase, close, query } from '../db.js';

/**
 * CLI: Board interface for autobot-inbox.
 * P6: Familiar interfaces for humans. Eric operates through what he already uses.
 *
 * Commands:
 *   inbox   — View triaged emails, pending items
 *   review  — Approve/edit/reject pending drafts
 *   briefing — View today's briefing
 *   stats   — Cost, throughput, autonomy metrics
 *   halt    — Emergency stop all agents
 *   resume  — Resume after halt
 *   directive — Create a board directive (task)
 *   voice   — Voice profile management
 *   quit    — Exit
 */

const COMMANDS = {
  inbox:     { fn: inboxCommand, desc: 'View triaged emails and pending items' },
  review:    { fn: reviewCommand, desc: 'Approve/edit/reject pending drafts' },
  send:      { fn: sendCommand, desc: 'Send approved drafts' },
  briefing:  { fn: briefingCommand, desc: "View today's daily briefing" },
  stats:     { fn: statsCommand, desc: 'Cost, throughput, autonomy metrics' },
  halt:      { fn: haltCommand, desc: 'Emergency stop all agents' },
  resume:    { fn: resumeCommand, desc: 'Resume operations after halt' },
  directive: { fn: directiveCommand, desc: 'Create a board directive' },
  decide:    { fn: decideCommand, desc: 'Review strategic decisions / reverse past decisions' },
  intents:   { fn: intentsCommand, desc: 'Review and manage agent-proposed intents' },
  voice:     { fn: voiceCommand, desc: 'Voice profile management' },
  research:  { fn: researchCommand, desc: 'Start deep research on a topic' },
};

async function main() {
  // Initialize PGlite (auto-migrate on first launch)
  try {
    await initializeDatabase();
    await query('SELECT 1');
    console.log(chalk.green('Database connected'));
  } catch (err) {
    console.error(chalk.red(`Database initialization failed: ${err.message}`));
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('autobot> '),
  });

  console.log(chalk.bold('\nAutoBot Inbox — Board CLI'));
  console.log(chalk.gray('Type "help" for commands, "quit" to exit\n'));

  rl.prompt();

  rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/);

    if (!cmd) {
      rl.prompt();
      return;
    }

    if (cmd === 'help') {
      console.log(chalk.bold('\nAvailable commands:'));
      for (const [name, { desc }] of Object.entries(COMMANDS)) {
        console.log(`  ${chalk.cyan(name.padEnd(12))} ${desc}`);
      }
      console.log(`  ${chalk.cyan('quit'.padEnd(12))} Exit CLI`);
      console.log();
    } else if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      await close();
      rl.close();
      process.exit(0);
    } else if (COMMANDS[cmd]) {
      try {
        await COMMANDS[cmd].fn(args, rl);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
      }
    } else {
      console.log(chalk.yellow(`Unknown command: ${cmd}. Type "help" for available commands.`));
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await close();
    process.exit(0);
  });
}

main().catch(console.error);
