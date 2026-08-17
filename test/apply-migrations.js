import { applyD1Migrations, env } from 'cloudflare:test';

// Applies every migration in migrations/ to the real D1 instance backing these
// tests, before any test runs. If a migration is malformed, the suite fails here
// rather than silently testing against a half-built schema.
await applyD1Migrations(env.AIHANGOUT_DB, env.TEST_MIGRATIONS);
