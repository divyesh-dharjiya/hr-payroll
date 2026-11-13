import { defineConfig } from 'vitest/config';

// Unit tests for the in-browser API (business rules, permissions, the payroll engine). They run in Node with an
// in-memory store, so no browser is needed.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Building the demo company (about 3,000 attendance days and four payroll runs) takes a few seconds.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
