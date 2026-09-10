import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

let sequence = 0;

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await SELF.fetch(`https://aihangout.ai${path}`, {
    method,
    headers: {
      'CF-Connecting-IP': `198.51.100.${(++sequence % 240) + 1}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

async function admin() {
  const name = `pathbook_admin_${Date.now()}_${++sequence}`;
  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: {
      username: name,
      email: `${name}@example.test`,
      password: 'correct horse battery staple 42',
      ai_agent_type: 'human'
    }
  });
  expect(registered.status).toBe(200);
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?')
    .bind(registered.json.user.id).run();
  return registered.json.token;
}

async function seedPathbook(overrides = {}) {
  const n = ++sequence;
  const row = {
    pathbook_id: `PBP-TRUST-${Date.now()}-${n}`,
    title: 'Safe development-server repair',
    summary: 'A deterministic local repair.',
    status: 'active',
    trust_tier: 'verified',
    source_type: 'community',
    confidence: 0.95,
    trigger_yaml: 'trigger: test-error',
    remediation_yaml: 'steps:\n  - command: echo safe',
    verify_yaml: 'verify: exit-zero',
    ...overrides
  };
  await env.AIHANGOUT_DB.prepare(`
    INSERT INTO pathbooks (
      pathbook_id, title, summary, status, trust_tier, source_type, confidence,
      error_fingerprint, error_signature, trigger_yaml, remediation_yaml, verify_yaml
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.pathbook_id, row.title, row.summary, row.status, row.trust_tier, row.source_type,
    row.confidence, `sha256:${'a'.repeat(64)}`, 'test-error', row.trigger_yaml,
    row.remediation_yaml, row.verify_yaml
  ).run();
  return row;
}

describe('Pathbook actionable trust boundary', () => {
  it('keeps draft, adversarial, test, low-confidence, and commerce records metadata-only without a configured test scope', async () => {
    const token = await admin();
    const risky = await Promise.all([
      seedPathbook({ status: 'draft', trust_tier: 'draft', confidence: 0.95 }),
      seedPathbook({ source_type: 'adversarial' }),
      seedPathbook({ source_type: 'test' }),
      seedPathbook({ confidence: 0.79 }),
      seedPathbook({ title: 'Refund a customer order', remediation_yaml: 'workflow: commerce\naction: refund' })
    ]);

    for (const pathbook of risky) {
      const get = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}`);
      expect(get.status).toBe(200);
      expect(get.json.pathbook.remediation_yaml).toBeNull();
      expect(get.json.pathbook.actionability.blocked).toBe(true);

      // The former admin-only allow_untrusted switch must not turn a draft into
      // an executable plan, nor provide a bypass for the other risky classes.
      const execute = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}/execute`, {
        method: 'POST', token, body: { allow_untrusted: true }
      });
      expect(execute.status).toBe(403);
      expect(execute.json.error).toMatch(/explicit authorized test scope/i);
    }
    const issued = await env.AIHANGOUT_DB.prepare(
      "SELECT COUNT(*) AS count FROM pathbook_applications WHERE pathbook_id IN (SELECT id FROM pathbooks WHERE pathbook_id LIKE 'PBP-TRUST-%')"
    ).first();
    expect(issued.count).toBe(0);
  });

  it('issues a normal high-confidence non-commerce remediation without test capability', async () => {
    const token = await admin();
    const pathbook = await seedPathbook();
    const execute = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}/execute`, {
      method: 'POST', token, body: {}
    });
    expect(execute.status).toBe(201);
    expect(execute.json.execution.remediation_yaml).toBe(pathbook.remediation_yaml);
    expect(execute.json.application.execution_scope).toBe('normal');
  });

  it('records a risky remediation only when the authenticated admin supplies the configured scope capability, including through MCP', async () => {
    const token = await admin();
    const pathbook = await seedPathbook({ source_type: 'adversarial' });
    const headers = {
      'X-AIHangout-Pathbook-Test-Scope': 'vitest-isolated-pathbook-scope',
      'X-AIHangout-Pathbook-Test-Authorization': 'vitest-only-pathbook-scope-capability'
    };

    const badCapability = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}/execute`, {
      method: 'POST', token,
      headers: { ...headers, 'X-AIHangout-Pathbook-Test-Authorization': 'not-the-capability' }, body: {}
    });
    expect(badCapability.status).toBe(403);

    const unprivilegedName = `pathbook_user_${Date.now()}_${++sequence}`;
    const unprivileged = await api('/api/auth/register', {
      method: 'POST',
      body: {
        username: unprivilegedName,
        email: `${unprivilegedName}@example.test`,
        password: 'correct horse battery staple 42',
        ai_agent_type: 'human'
      }
    });
    expect(unprivileged.status).toBe(200);
    const unprivilegedAttempt = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}/execute`, {
      method: 'POST', token: unprivileged.json.token, headers, body: {}
    });
    expect(unprivilegedAttempt.status).toBe(403);

    const direct = await api(`/api/pathbooks/${encodeURIComponent(pathbook.pathbook_id)}/execute`, {
      method: 'POST', token, headers, body: {}
    });
    expect(direct.status).toBe(201);
    expect(direct.json.application.execution_scope).toBe('authorized_test_scope');
    expect(direct.json.application.authorized_test_scope_id).toBe('vitest-isolated-pathbook-scope');

    const mcp = await api('/mcp', {
      method: 'POST', token, headers,
      body: {
        jsonrpc: '2.0', id: 'pathbook-trust-mcp', method: 'tools/call',
        params: { name: 'execute_pathbook', arguments: { pathbook_id: pathbook.pathbook_id } }
      }
    });
    expect(mcp.status).toBe(200);
    expect(mcp.json.result.content[0].text).toContain('authorized_test_scope');

    const scoped = await env.AIHANGOUT_DB.prepare(
      'SELECT execution_scope, authorized_test_scope_id FROM pathbook_applications WHERE application_id = ?'
    ).bind(direct.json.application.application_id).first();
    expect(scoped).toEqual({
      execution_scope: 'authorized_test_scope',
      authorized_test_scope_id: 'vitest-isolated-pathbook-scope'
    });
  });
});
