/**
 * JWT issuer and verifier for internal agent identity (ADR-018).
 *
 * Agents hold short-lived RS256 JWT tokens. withAgentScope() verifies
 * the JWT signature before setting session vars. State transitions
 * record JWT-verified identity.
 *
 * No external dependencies — Node `crypto` only (P4: boring infrastructure).
 *
 * Key management (order of precedence):
 *   1. AGENT_JWT_KEY_PATH env var → dedicated PEM file (production)
 *   2. GITHUB_APP_PRIVATE_KEY_PATH env var → reuse GitHub App PEM
 *   3. Neither → crypto.generateKeyPairSync('rsa') ephemeral pair (dev/CI)
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomUUID } from 'crypto';
import { readFileSync } from 'fs';

let privateKey = null;
let publicKey = null;
let keySource = null;

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Base64url encode (no padding, URL-safe alphabet).
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64url decode.
 */
function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Load or generate RSA key pair. Call once at startup.
 */
export async function initializeJwtKeys() {
  // 1a. PEM content directly in env var (Railway/Docker — no filesystem access)
  if (process.env.AGENT_JWT_KEY_PEM) {
    const pem = process.env.AGENT_JWT_KEY_PEM.replace(/\\n/g, '\n');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'env-pem';
  }
  // 1b. Dedicated agent JWT key file
  else if (process.env.AGENT_JWT_KEY_PATH) {
    const pem = readFileSync(process.env.AGENT_JWT_KEY_PATH, 'utf-8');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'dedicated-key';
  }
  // 2. Reuse GitHub App PEM
  else if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const pem = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'github-app';
  }
  // 3. Ephemeral key pair (dev/CI)
  else {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    keySource = 'ephemeral';
  }

  console.log(`[startup] JWT signing initialized (source: ${keySource})`);
}

/**
 * Extract public key from a PEM private key.
 */
function extractPublicKey(pem) {
  return createPublicKey(pem).export({ type: 'spki', format: 'pem' });
}

/**
 * Tier mapping from agent config type to spec tier name.
 */
const TIER_MAP = {
  orchestrator: 'orchestrator',
  strategist: 'strategist',
  architect: 'architect',
  reviewer: 'reviewer',
  executor: 'executor',
};

/**
 * Issue a short-lived JWT for an agent.
 *
 * @param {string} agentId - Agent identifier (e.g., 'executor-triage')
 * @param {object} agentConfig - Agent config from agents.json
 * @returns {{ token: string, expiresAt: number }}
 */
export function issueAgentToken(agentId, agentConfig) {
  if (!privateKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: 'optimus-agent',
    sub: agentId,
    tier: TIER_MAP[agentConfig.type] || 'executor',
    tools: agentConfig.tools || [],
    iat: now,
    exp,
    jti: randomUUID(),
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return {
    token: `${signable}.${signature}`,
    expiresAt: exp * 1000, // ms for JS Date compat
  };
}

/**
 * Verify an agent JWT and return its claims.
 *
 * @param {string} token - JWT string
 * @returns {{ sub: string, tier: string, tools: string[], iat: number, exp: number, jti: string }}
 * @throws {Error} on invalid signature, expired token, or malformed claims
 */
export function verifyAgentToken(token) {
  if (!publicKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 parts');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signable = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signable);
  if (!verifier.verify(publicKey, signature)) {
    throw new Error('JWT signature verification failed');
  }

  // Decode and validate claims
  const claims = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(`JWT expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }

  // Validate issuer (must be optimus-agent — board tokens use separate verifier)
  if (claims.iss && claims.iss !== 'optimus-agent') {
    throw new Error(`Invalid JWT issuer: ${claims.iss} (expected optimus-agent)`);
  }

  // Validate sub format
  if (!/^[a-z0-9_-]+$/.test(claims.sub)) {
    throw new Error(`Invalid JWT sub claim: ${claims.sub}`);
  }

  return claims;
}
