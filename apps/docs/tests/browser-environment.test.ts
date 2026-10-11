import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => window.localStorage.removeItem('browser-storage-probe'))

describe('browser test environment', () => {
  it('uses the DOM storage for browser globals rather than a host runtime placeholder', () => {
    window.localStorage.setItem('browser-storage-probe', 'document-value')
    expect(localStorage.getItem('browser-storage-probe')).toBe('document-value')
    localStorage.removeItem('browser-storage-probe')
    expect(window.localStorage.getItem('browser-storage-probe')).toBeNull()
  })
})
