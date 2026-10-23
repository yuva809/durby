import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // Component tests opt into jsdom per file (`// @vitest-environment jsdom`); the session tests
    // check that no browser storage exists, so node stays the default.
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e'],
  },
});
