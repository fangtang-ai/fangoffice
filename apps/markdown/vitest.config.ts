import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: [fileURLToPath(new URL('../../tools/vitest-browser-setup.ts', import.meta.url))],
    testTimeout: 20000,
  },
})
