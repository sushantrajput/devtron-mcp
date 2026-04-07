// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in /tests at root level
    include: ['tests/**/*.test.ts'],

    environment: 'node',

    reporters: ['verbose'],

    testTimeout: 10_000,

    // Tell Vitest to use the test-specific tsconfig
    // This is the one that includes "vitest/globals" in types
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },

  resolve: {
    // When Vitest sees import from './foo.js' it also tries './foo.ts'
    extensions: ['.ts', '.js'],
  },
});