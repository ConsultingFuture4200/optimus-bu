#!/usr/bin/env node
/**
 * Issue a NemoClaw board JWT for a board member.
 *
 * Usage:
 *   node issue-token.js <github-username> [api-url]
 *
 * Reads API_SECRET from autobot-inbox/.env automatically.
 * Writes OPTIMUS_TOKEN + OPTIMUS_API_URL export lines to ~/.nemoclaw-env
 * which can be sourced in your shell profile.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const username = process.argv[2];
const apiUrl = process.argv[3] || process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

if (!username) {
  console.error('Usage: node issue-token.js <github-username> [api-url]');
  process.exit(1);
}

// Load API_SECRET from autobot-inbox/.env
let apiSecret = process.env.API_SECRET;
if (!apiSecret) {
  const envPath = resolve(__dirname, '../../autobot-inbox/.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf8');
    const match = envContent.match(/^API_SECRET=(.+)$/m);
    if (match) apiSecret = match[1].trim();
  }
}
if (!apiSecret) {
  console.error('API_SECRET not found. Set it in env or autobot-inbox/.env');
  process.exit(1);
}

console.log(`Issuing token for ${username} via ${apiUrl}...`);

const res = await fetch(`${apiUrl}/api/auth/token`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiSecret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ github_username: username }),
  signal: AbortSignal.timeout(10000),
});

const data = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`Error ${res.status}: ${data.error || 'Unknown'}`);
  process.exit(1);
}

// Write env file
const envFile = resolve(process.env.HOME, '.nemoclaw-env');
writeFileSync(envFile, [
  `export OPTIMUS_TOKEN="${data.token}"`,
  `export OPTIMUS_API_URL="${apiUrl}"`,
  '',
].join('\n'));

console.log(`\nToken issued for ${data.member.github_username}`);
console.log(`Expires: ${new Date(data.expiresAt).toISOString()}`);
console.log(`Saved to: ${envFile}`);
console.log(`\nAdd to ~/.zshrc:\n`);
console.log(`  [ -f ~/.nemoclaw-env ] && source ~/.nemoclaw-env`);
console.log();
