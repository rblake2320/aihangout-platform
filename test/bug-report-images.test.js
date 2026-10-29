import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const image = { name: 'screenshot.png', dataUrl: `data:image/png;base64,${png}` };
let sequence = 0;
async function call(path, body, token) {
  const response = await SELF.fetch(`https://aihangout.ai${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.187', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}
const report = images => ({ title: `Screenshot fixture ${++sequence}`, description: 'Local image persistence test.', bugType: 'UI/UX Issue', images });

describe('bug report screenshot delivery', () => {
  it('stores anonymous attachments, restricts reads, and returns them to the admin reviewer', async () => {
    const registered = await call('/api/auth/register', { username: 'image_reviewer', email: 'image_reviewer@example.test', password: 'local-image-reviewer-passphrase', accept_tos: true });
    expect(registered.status).toBe(200);
    const token = registered.data.token;
    const fixture = report([image, image]);
    const created = await call('/api/bug-reports', { ...fixture, userId: registered.data.user.id, username: 'forged' });
    expect(created.status).toBe(200);
    expect(created.data.imageCount).toBe(2);
    const id = created.data.bugReportId;
    expect((await call(`/api/bug-reports/${id}`)).status).toBe(403);
    expect((await call(`/api/bug-reports/${id}`, undefined, token)).status).toBe(403);
    await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(registered.data.user.id).run();
    const detail = await call(`/api/bug-reports/${id}`, undefined, token);
    expect(detail.status).toBe(200);
    expect(detail.data.bugReport.user_id).toBeNull();
    expect(detail.data.images).toHaveLength(2);
    expect(detail.data.images[0].dataUrl).toBe(image.dataUrl);
    expect(detail.data.images[0].byteLength).toBe(atob(png).length);
    const list = await call('/api/bug-reports', undefined, token);
    expect(list.data.bugReports.find(row => row.id === id).image_count).toBe(2);
    expect(JSON.stringify(list.data)).not.toContain(png);
    await expect.poll(async () => (await env.AIHANGOUT_DB.prepare("SELECT payload FROM activity_log WHERE path='/api/bug-reports' AND json_extract(payload, '$.title')=? ORDER BY id DESC LIMIT 1").bind(fixture.title).first())?.payload).toContain('[REDACTED]');
  });

  it('preserves text-only submissions', async () => {
    const created = await call('/api/bug-reports', report(undefined));
    expect(created.status).toBe(200); expect(created.data.imageCount).toBe(0);
  });

  it('rejects excessive count, SVG, spoofed MIME, invalid base64 and oversized images before insertion', async () => {
    const count = async () => (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM bug_reports').first()).n;
    const before = await count();
    for (const images of [Array(4).fill(image), [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }], [{ dataUrl: `data:image/jpeg;base64,${png}` }], [{ dataUrl: 'data:image/png;base64,!' }], [{ dataUrl: `data:image/png;base64,${'A'.repeat(699056)}` }], 'not-an-array']) {
      expect((await call('/api/bug-reports', report(images))).status).toBe(400);
    }
    expect(await count()).toBe(before);
  });

  it('enforces the total body limit, including requests without a length header', async () => {
    const result = await call('/api/bug-reports', { ...report([]), description: 'a'.repeat(2_200_001) });
    expect(result.status).toBe(413);
  });

  it('rolls back the report if storing an image fails', async () => {
    const title = `atomic fixture ${++sequence}`;
    await env.AIHANGOUT_DB.exec("CREATE TRIGGER reject_test_image BEFORE INSERT ON bug_report_images WHEN NEW.filename='reject.png' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    try {
      expect((await call('/api/bug-reports', { ...report([{ ...image, name: 'reject.png' }]), title })).status).toBe(503);
      expect(await env.AIHANGOUT_DB.prepare('SELECT id FROM bug_reports WHERE title=?').bind(title).first()).toBeNull();
    } finally { await env.AIHANGOUT_DB.exec('DROP TRIGGER reject_test_image;'); }
  });
});
