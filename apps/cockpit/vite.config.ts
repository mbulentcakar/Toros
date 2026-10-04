import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the cockpit. The cockpit is a viewer over Node Core's
// loopback HTTP surface: plain React + TypeScript, no state library, no
// component framework, no CSS framework. test.environment is jsdom so the
// acceptance tests (src/**/*.test.tsx) can mount components and assert on the
// rendered DOM.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
