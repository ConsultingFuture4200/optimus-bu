/**
 * Google Drive auth via Service Account with domain-wide delegation.
 *
 * Used for Drive ingestion when OAuth tokens lack drive.readonly scope
 * (restricted scope requires app verification).
 *
 * Env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key contents (stringified)
 *   GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to JSON key file (fallback)
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';

let cachedAuth = null;

/**
 * Get a Drive-authorized client using the service account.
 * Impersonates the specified user for domain-wide delegation.
 *
 * @param {string} userEmail - Email to impersonate (e.g., eric@staqs.io)
 * @returns {import('googleapis').drive_v3.Drive}
 */
export function getDriveClient(userEmail) {
  const key = loadServiceAccountKey();
  if (!key) {
    throw new Error('No service account key configured (GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH)');
  }

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: userEmail, // Domain-wide delegation: impersonate this user
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Check if service account auth is available.
 */
export function hasServiceAccount() {
  try {
    return !!loadServiceAccountKey();
  } catch {
    return false;
  }
}

function loadServiceAccountKey() {
  if (cachedAuth) return cachedAuth;

  // Try env var first (JSON string)
  const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (envKey) {
    try {
      cachedAuth = JSON.parse(envKey);
      return cachedAuth;
    } catch (err) {
      console.error('[drive-sa] Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', err.message);
    }
  }

  // Try file path
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    try {
      cachedAuth = JSON.parse(readFileSync(keyPath, 'utf8'));
      return cachedAuth;
    } catch (err) {
      console.error(`[drive-sa] Failed to read ${keyPath}:`, err.message);
    }
  }

  return null;
}
