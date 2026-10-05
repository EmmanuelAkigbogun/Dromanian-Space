import { defineConfig } from 'vitest/config';

// Tests run against the local Supabase emulation (tools/local-supabase), never a
// hosted project. tests/global-setup.ts starts it and applies migrations.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
