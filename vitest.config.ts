import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // tests share one Postgres database, reset per file
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
