import { beforeEach, vi } from 'vitest'
import type {} from 'vitest/jsdom'

function bindBrowserStorage() {
  // Browser code must use actual DOM storage, not the host Node runtime's storage placeholder.
  if (typeof jsdom !== 'undefined') vi.stubGlobal('localStorage', jsdom.window.localStorage)
}

bindBrowserStorage()
beforeEach(bindBrowserStorage)
