import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The integration tests share one Postgres database and truncate between
    // cases, so test files must not run against it concurrently.
    fileParallelism: false,
  },
});
