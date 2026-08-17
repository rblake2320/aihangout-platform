import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Tests run against src/worker.js directly, NOT the dist/ bundle that wrangler.toml
// points at. Testing the bundle would let a stale build pass a suite that the real
// source fails — the exact deployed-vs-committed drift this repo has hit before.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(rootDir, 'migrations'));

      return {
        main: './src/worker.js',
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2024-01-15',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { AIHANGOUT_DB: 'aihangout-test' },
          kvNamespaces: ['AIHANGOUT_KV'],
          bindings: {
            // Real migrations, read off disk, applied to a real D1 (SQLite) instance
            // inside workerd. Not a mock — the same SQL that runs in production.
            TEST_MIGRATIONS: migrations,
            // Ephemeral per-run secret for the local test runtime only. Production
            // JWT_SECRET lives in Cloudflare secrets and is never committed.
            JWT_SECRET: 'test-only-jwt-secret-32-chars-min!',
            ENVIRONMENT: 'test',
            BETA_MODE: 'true'
          }
        }
      };
    })
  ],
  test: {
    // Scoped deliberately: this project is the Worker suite and runs inside workerd.
    // Frontend component tests need a DOM environment and belong to their own config,
    // so globbing the whole repo would drag them into the wrong runtime.
    include: ['test/**/*.test.js'],
    setupFiles: ['./test/apply-migrations.js']
  }
});
