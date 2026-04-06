import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { query } from '../db.js';

/**
 * Upsert a single contact into signal.contacts.
 * COALESCE preserves existing reactive data; || merges metadata.
 */
async function upsertContact(email, name, org, resourceName) {
  await query(
    `INSERT INTO signal.contacts (email_address, name, organization, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_address) DO UPDATE SET
       name = COALESCE(signal.contacts.name, EXCLUDED.name),
       organization = COALESCE(signal.contacts.organization, EXCLUDED.organization),
       metadata = signal.contacts.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [email, name, org, JSON.stringify({
      google_contact: true,
      resource_name: resourceName,
      synced_at: new Date().toISOString(),
    })]
  );
}

/**
 * Sync Google Contacts into signal.contacts.
 * Fetches both "My Contacts" (connections.list) and "Other contacts"
 * (otherContacts.list) to cover explicitly-added and auto-saved contacts.
 *
 * @param {import('googleapis').Auth.OAuth2Client|null} authClient
 * @param {string|null} accountId - inbox.accounts.id (used if authClient is null)
 * @returns {Promise<number>} Number of contact entries synced
 */
export async function syncGoogleContacts(authClient = null, accountId = null) {
  const auth = authClient || (accountId ? await getAuthForAccount(accountId) : getAuth());
  const people = google.people({ version: 'v1', auth });

  let synced = 0;

  console.log('[contacts-sync] Starting Google Contacts sync...');

  // 1. My Contacts (explicitly added)
  let pageToken = null;
  do {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'names,emailAddresses,organizations',
      pageToken,
    });

    for (const person of (res.data.connections || [])) {
      const name = person.names?.[0]?.displayName || null;
      const org = person.organizations?.[0]?.name || null;

      for (const entry of (person.emailAddresses || [])) {
        const email = entry.value?.toLowerCase();
        if (!email) continue;
        await upsertContact(email, name, org, person.resourceName);
        synced++;
      }
    }

    pageToken = res.data.nextPageToken;
    if (synced > 0 && synced % 100 === 0) {
      console.log(`[contacts-sync] Synced ${synced} contacts...`);
    }
  } while (pageToken);

  console.log(`[contacts-sync] My Contacts done: ${synced} synced`);

  // 2. Other Contacts (auto-saved from interactions)
  let otherSynced = 0;
  pageToken = null;
  try {
    do {
      const res = await people.otherContacts.list({
        pageSize: 1000,
        readMask: 'names,emailAddresses',
        pageToken,
      });

      for (const person of (res.data.otherContacts || [])) {
        const name = person.names?.[0]?.displayName || null;
        const org = person.organizations?.[0]?.name || null;

        for (const entry of (person.emailAddresses || [])) {
          const email = entry.value?.toLowerCase();
          if (!email) continue;
          await upsertContact(email, name, org, person.resourceName);
          otherSynced++;
        }
      }

      pageToken = res.data.nextPageToken;
      if (otherSynced > 0 && otherSynced % 100 === 0) {
        console.log(`[contacts-sync] Other contacts: ${otherSynced} synced...`);
      }
    } while (pageToken);
  } catch (err) {
    console.warn(`[contacts-sync] Other contacts fetch failed (non-fatal): ${err.message}`);
  }

  synced += otherSynced;
  console.log(`[contacts-sync] Complete: ${synced} contacts synced (${synced - otherSynced} primary + ${otherSynced} other)`);
  return synced;
}
