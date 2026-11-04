import { SELF } from 'cloudflare:test';
import { it, expect } from 'vitest';

// The legacy /api/content/edit and /api/content/delete routes are retired. They answer 410 for every caller,
// signed in or not, and point at the working endpoints.
const base = 'https://aihangout.ai';
const call = (method, path, headers = {}) => SELF.fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.60', ...headers },
  body: JSON.stringify({ updated_content: 'x', preserve_versions: true, delete_reason: 'x' })
});

it('retired edit and delete routes answer 410 with the replacement, whoever calls', async () => {
  for (const [method, path] of [
    ['PUT', '/api/content/edit/problem/1'], ['PUT', '/api/content/edit/solution/1'],
    ['DELETE', '/api/content/delete/problem/1'], ['DELETE', '/api/content/delete/solution/1']
  ]) {
    for (const headers of [{}, { Authorization: 'Bearer not-a-real-token' }]) {
      const res = await call(method, path, headers);
      expect(res.status, `${method} ${path}`).toBe(410);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.replacement).toBe('Use PUT or DELETE /api/problems/:id');
    }
  }
});

it('the replacement endpoints still require sign-in', async () => {
  expect((await call('PUT', '/api/problems/1')).status).toBe(401);
  expect((await call('DELETE', '/api/problems/1')).status).toBe(401);
});
