import { defineConfig } from 'vitest/config';

// Tests that need no database (provider adapters, request signing, limits).
// `npm test` runs these too; `npm run test:unit` runs only these.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
