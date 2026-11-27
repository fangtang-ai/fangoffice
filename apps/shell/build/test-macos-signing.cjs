const TEST_UPDATE_URL = 'https://fangtang-office-updates.oss-cn-hangzhou.aliyuncs.com/test'

function requireTestMacSigning(env) {
  if (env.FANGTANG_BUILD_ENV !== 'test' || env.FANGTANG_UPDATE_URL !== TEST_UPDATE_URL) {
    throw new Error('Signed test builds require the test environment and exact test update URL')
  }
  const missing = [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ].filter((key) => !env[key]?.trim())
  if (missing.length) throw new Error(`Missing test macOS signing credentials: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('Invalid Apple Team ID')
  if (!env.CSC_NAME.startsWith('Developer ID Application: ') || !env.CSC_NAME.endsWith(`(${env.APPLE_TEAM_ID})`)) {
    throw new Error('Test signing requires a Developer ID Application identity matching Apple Team ID')
  }
  // electron-builder selects the certificate type and rejects this prefix in mac.identity.
  return env.CSC_NAME.slice('Developer ID Application: '.length)
}

module.exports = { TEST_UPDATE_URL, requireTestMacSigning }
