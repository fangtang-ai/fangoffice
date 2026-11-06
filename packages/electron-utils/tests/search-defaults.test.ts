import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySearchProviderEnv, loadFangTangDefaults } from '../src/factory-defaults'

vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify({ aliyunIqsApiKey: 'deployment-key' }),
}))

afterEach(() => vi.unstubAllEnvs())

describe('IQS deployment configuration', () => {
  it('loads the deployment key and makes it available to shared search', () => {
    vi.stubEnv('ALIYUN_IQS_API_KEY', undefined)
    const defaults = loadFangTangDefaults()
    expect(defaults).toMatchObject({ aliyunIqsApiKey: 'deployment-key' })
    applySearchProviderEnv(defaults)
    expect(process.env.ALIYUN_IQS_API_KEY).toBe('deployment-key')
  })

  it('preserves an explicit environment override', () => {
    vi.stubEnv('ALIYUN_IQS_API_KEY', 'environment-key')
    expect(loadFangTangDefaults()).toMatchObject({ aliyunIqsApiKey: 'environment-key' })
    applySearchProviderEnv({ aliyunIqsApiKey: 'deployment-key' })
    expect(process.env.ALIYUN_IQS_API_KEY).toBe('environment-key')
  })
})
