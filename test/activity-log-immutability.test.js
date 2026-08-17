import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Regression tests for migration 0015: activity_log's append-only rule (0013's
// own comment: "never UPDATEd except quarantine/review columns, never
// DELETEd") is now enforced by BEFORE UPDATE / BEFORE DELETE triggers, not
// just route convention. These write to activity_log directly through
// env.AIHANGOUT_DB rather than driving a full HTTP request — the trigger
// fires on the mutation itself, independent of which route (or future route,
// or admin console query) attempts it.

async function insertFixtureRow(overrides = {}) {
  const row = {
    method: 'POST',
    path: '/api/test-fixture',
    action: 'test.fixture',
    user_id: null,
    username: null,
    agent_type: null,
    ip_hash: 'fixturehash',
    outcome: 'accepted',
    http_status: 200,
    reason: null,
    target_type: null,
    target_id: null,
    payload: '{"fixture":true}',
    payload_bytes: 17,
    ...overrides
  };
  const result = await env.AIHANGOUT_DB.prepare(`
    INSERT INTO activity_log
      (method, path, action, user_id, username, agent_type, ip_hash, outcome,
       http_status, reason, target_type, target_id, payload, payload_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    row.method, row.path, row.action, row.user_id, row.username, row.agent_type,
    row.ip_hash, row.outcome, row.http_status, row.reason, row.target_type,
    row.target_id, row.payload, row.payload_bytes
  ).first();
  return result.id;
}

async function getRow(id) {
  return env.AIHANGOUT_DB.prepare('SELECT * FROM activity_log WHERE id = ?').bind(id).first();
}

describe('activity_log is append-only: delete', () => {
  it('rejects a DELETE with an abort, and the row still exists afterward', async () => {
    const id = await insertFixtureRow();

    await expect(
      env.AIHANGOUT_DB.prepare('DELETE FROM activity_log WHERE id = ?').bind(id).run()
    ).rejects.toThrow(/append-only/);

    const stillThere = await getRow(id);
    expect(stillThere, 'row was deleted despite the trigger').not.toBeNull();
  });
});

describe('activity_log is append-only: protected columns', () => {
  it.each([
    ['payload', 'payload', '"tampered"'],
    ['http_status', 'http_status', 999],
    ['outcome', 'outcome', 'rejected'],
    ['reason', 'reason', 'rewritten after the fact'],
    ['method', 'method', 'DELETE'],
    ['path', 'path', '/api/rewritten'],
  ])('rejects an UPDATE that changes %s', async (_label, column, value) => {
    const id = await insertFixtureRow();
    const before = await getRow(id);

    await expect(
      env.AIHANGOUT_DB.prepare(`UPDATE activity_log SET ${column} = ? WHERE id = ?`).bind(value, id).run()
    ).rejects.toThrow(/append-only/);

    const after = await getRow(id);
    expect(after[column], `${column} changed despite the trigger`).toBe(before[column]);
  });

  it('rejects an UPDATE that changes a nullable column from NULL to a value', async () => {
    // The IS NOT (not !=) comparison exists specifically for this case — a
    // != comparison against NULL is neither true nor false in SQL and would
    // silently fail to fire here.
    const id = await insertFixtureRow({ user_id: null });

    await expect(
      env.AIHANGOUT_DB.prepare('UPDATE activity_log SET user_id = ? WHERE id = ?').bind(999, id).run()
    ).rejects.toThrow(/append-only/);

    const after = await getRow(id);
    expect(after.user_id).toBeNull();
  });
});

describe('activity_log is append-only: the allowed exception', () => {
  it('still allows updating only quarantined/quarantine_reason/reviewed_at/reviewed_by', async () => {
    const id = await insertFixtureRow();

    await env.AIHANGOUT_DB.prepare(`
      UPDATE activity_log
      SET quarantined = 1, quarantine_reason = 'manually_isolated', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = 42
      WHERE id = ?
    `).bind(id).run();

    const after = await getRow(id);
    expect(after.quarantined).toBe(1);
    expect(after.quarantine_reason).toBe('manually_isolated');
    expect(after.reviewed_by).toBe(42);
    expect(after.reviewed_at).not.toBeNull();
    // Everything else must be untouched by the legitimate quarantine path.
    expect(after.payload).toBe('{"fixture":true}');
    expect(after.http_status).toBe(200);
  });
});
