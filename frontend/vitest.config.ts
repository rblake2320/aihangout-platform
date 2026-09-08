import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Frontend-only component tests. Separate from the root vitest.config.mjs, which
// runs the Worker suite against a real D1/workerd instance -- that config has no
// jsdom/React setup and is not meant to run React component tests. This one never
// touches src/worker.js or any backend/D1 state.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
})
