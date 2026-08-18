import { defineConfig } from 'vitest/config'

// The invariants that matter most in this project are enforced by Postgres, not
// by TypeScript, so they need a real Postgres to be tested at all. Kept out of
// the default suite so `npm test` stays dependency-free.
//
//   createdb memory_engine_test
//   MEMORY_TEST_DATABASE_URL=postgresql://…/memory_engine_test npm run test:db
//
// Set REQUIRE_DB_TESTS=1 in CI so a missing database fails loudly instead of
// skipping the only proof that the archive is append-only.
export default defineConfig({
  test: {
    include: ['test-db/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
