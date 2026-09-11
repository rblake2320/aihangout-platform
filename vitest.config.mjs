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
            BETA_MODE: 'true',
            MOBILE_APP_ID: 'ai.hangout.test',
            MOBILE_APP_CERT_SHA256: 'a'.repeat(64),
            // Enables the one-shot ambiguous-POST fault injector for recovery
            // tests only (armed per test via POST /api/mobile/fault-arm). Never
            // set in any wrangler.toml environment.
            MOBILE_FAULT_INJECT_ENABLED: '1',
            // Mobile assistance under test: enabled, low cap, and the in-process
            // provider stub (only honoured together with the fault flag above).
            // No OPENAI_API_KEY here -- tests never reach the real provider.
            MOBILE_ASSISTANCE_ENABLED: '1',
            MOBILE_ASSISTANCE_MAX_CALLS: '50',
            MOBILE_CAMERA_ANALYSIS_ENABLED: '1',
            MOBILE_CAMERA_ANALYSIS_MAX_CALLS: '3',
            MOBILE_CAMERA_ANALYSIS_TEST_MODE: '1',
            OPENAI_BASE_URL: 'stub://responses',
            // Isolated test scope only; not production configuration.
            PATHBOOK_TEST_SCOPE_ID: 'vitest-isolated-pathbook-scope',
            PATHBOOK_TEST_SCOPE_AUTHORIZATION: 'vitest-only-pathbook-scope-capability' 
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
