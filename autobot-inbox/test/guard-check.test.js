import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftGates } from '../src/runtime/guard-check.js';

// Stub txClient that returns empty rows — avoids PGlite init for unit tests.
// G6 rate-limit check queries action_proposals; without a DB this crashes.
const stubClient = { query: async () => ({ rows: [], rowCount: 0 }) };

describe('checkDraftGates', () => {
  it('passes clean draft', async () => {
    const draft = {
      body: 'Hi John, thanks for reaching out. Let me review this and get back to you.',
      to_addresses: ['john@example.com'],
    };

    const result = await checkDraftGates(draft, null, stubClient);
    assert.ok(result.passed);
  });

  it('flags commitment language (G2)', async () => {
    const draft = {
      body: 'I promise we will deliver the feature by March 15th for $5,000.',
      to_addresses: ['client@example.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('flags large recipient list (G5)', async () => {
    const draft = {
      body: 'Quick update for the team.',
      to_addresses: ['a@test.com', 'b@test.com', 'c@test.com'],
      cc_addresses: ['d@test.com', 'e@test.com', 'f@test.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G5.passed, false);
    assert.ok(result.gates.G5.recipientCount > 5);
  });

  it('flags pricing precedent (G7)', async () => {
    const draft = {
      body: 'Our pricing for this service is $500 per month.',
      to_addresses: ['prospect@example.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G7.passed, false);
    assert.ok(result.gates.G7.matches.length > 0);
  });

  it('email_draft runs all gates (backward compat)', async () => {
    const draft = {
      body: 'Quick update for the team.',
      to_addresses: ['a@test.com'],
    };

    const result = await checkDraftGates(draft, null, null, null, 'email_draft');
    for (const gateId of ['G2', 'G3', 'G5', 'G6', 'G7']) {
      assert.equal(result.gates[gateId].skipped, undefined, `${gateId} should not be skipped for email_draft`);
    }
  });

  it('content_post skips G3, G5, G6', async () => {
    const draft = {
      body: 'Excited to share our latest insights on supply chain optimization.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    for (const gateId of ['G3', 'G5', 'G6']) {
      assert.equal(result.gates[gateId].skipped, true, `${gateId} should be skipped for content_post`);
      assert.equal(result.gates[gateId].passed, true, `${gateId} should auto-pass when skipped`);
    }
  });

  it('content_post still checks G2 (commitment language)', async () => {
    const draft = {
      body: 'I promise we will deliver this feature by next Friday.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    assert.equal(result.gates.G2.passed, false);
    assert.equal(result.gates.G2.skipped, undefined);
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('content_post still checks G7 (pricing language)', async () => {
    const draft = {
      body: 'Our pricing for this tier starts at $200 per month.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    assert.equal(result.gates.G7.passed, false);
    assert.equal(result.gates.G7.skipped, undefined);
    assert.ok(result.gates.G7.matches.length > 0);
  });

  it('unknown actionType skips all type-restricted gates', async () => {
    const draft = {
      body: 'I promise to deliver by Friday for $1000.',
      to_addresses: ['a@test.com'],
    };

    const result = await checkDraftGates(draft, null, null, null, 'slack_message');
    // Gates with explicit applicableTo that excludes slack_message are skipped
    for (const gateId of ['G3', 'G5', 'G6']) {
      assert.equal(result.gates[gateId].skipped, true, `${gateId} should be skipped for unknown type`);
    }
    // G2 and G7 include only email_draft + content_post, so they are also skipped
    assert.equal(result.gates.G2.skipped, true, 'G2 should be skipped for slack_message');
    assert.equal(result.gates.G7.skipped, true, 'G7 should be skipped for slack_message');
    // All gates pass (skipped = auto-pass) — this is the fail-open behavior
    assert.equal(result.passed, true);
  });
});
