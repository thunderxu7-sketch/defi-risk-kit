import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Fork-based integration tests (anvil) live under test/fork and are
    // opted in via FORK_TESTS=1 so unit CI stays fast and network-free.
    exclude: process.env.FORK_TESTS ? [] : ['test/fork/**'],
    testTimeout: process.env.FORK_TESTS ? 120_000 : 5_000,
  },
})
