/**
 * Out-of-box configuration for a 方塘Office deployment. IT edits
 * fangtang-defaults.json (shipped next to the app in Resources/, or beside the
 * sources in dev); environment variables override individual fields so a
 * managed launch can inject secrets without touching the install dir.
 *
 * Shape:
 * {
 *   "provider": "custom",          // any AI provider id (custom = OpenAI-compatible)
 *   "baseUrl": "",                 // required for "custom"
 *   "apiKey": "",
 *   "model": "",
 *   "maxOutputTokens": 32768,
 *   "serperApiKey": "",            // optional: web/image search via Serper (google results)
 *   "tavilyApiKey": "",            // optional: web search via Tavily; with neither,
 *                                  // search falls back to keyless DuckDuckGo
 *   "account": {                   // optional: 方塘 account / AI billing (V1)
 *     "logtoEndpoint": "",         // Logto tenant origin, e.g. https://logto.fang-tang.cn
 *     "logtoClientId": "",         // Logto native-app client id for this Office build
 *     "logtoApiResource": "",      // LOGTO_API_RESOURCE audience for the office API
 *     "accountApiBase": "",        // office API origin, e.g. https://api.fang-tang.cn
 *     "rechargeUrl": ""            // top-up page opened by the account menu
 *   }
 * }
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FangTangDefaultsFile {
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  maxOutputTokens?: number
  serperApiKey?: string
  tavilyApiKey?: string
  account?: FangTangAccountConfig
}

/** 方塘 account/billing configuration (V1): Logto OIDC + office API endpoints. */
export interface FangTangAccountConfig {
  /** Logto tenant origin, e.g. https://logto.fang-tang.cn */
  logtoEndpoint?: string
  /** Logto native-app client id issued for this Office build */
  logtoClientId?: string
  /** LOGTO_API_RESOURCE audience; access tokens are minted for this API */
  logtoApiResource?: string
  /** office API origin, e.g. https://api.fang-tang.cn (ai-endpoint/usage calls) */
  accountApiBase?: string
  /** top-up page opened by the account menu; defaults to the company site */
  rechargeUrl?: string
}

function defaultsFilePath(): string {
  // A sibling .local.json (gitignored) holds deployment secrets without
  // touching the shipped template; it wins over the plain file everywhere.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath && existsSync(join(resourcesPath, 'fangtang-defaults.json'))) {
    const local = join(resourcesPath, 'fangtang-defaults.local.json')
    if (existsSync(local)) return local
    return join(resourcesPath, 'fangtang-defaults.json')
  }
  // dev / standalone-app runs: the shared file lives in the shell's resources
  // dir, reached either from the bundle layout or from package sources (tests)
  const candidates = [
    join(__dirname, '../../../../apps/shell/resources/fangtang-defaults.local.json'),
    join(__dirname, '../../../../apps/shell/resources/fangtang-defaults.json'),
    join(__dirname, '../../../apps/shell/resources/fangtang-defaults.local.json'),
    join(__dirname, '../../../apps/shell/resources/fangtang-defaults.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

/**
 * Reads the deployment defaults; env vars win over file fields. Returns {}
 * when nothing is configured, so callers can treat "empty" as "not
 * preconfigured" and let the AI panels show their not-configured hint.
 */
function readDefaultsFile(): FangTangDefaultsFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(defaultsFilePath(), 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as FangTangDefaultsFile
    }
  } catch {
    // missing or unreadable file: no factory defaults
  }
  return {}
}

/**
 * AI provider defaults from the deployment file + FANGTANG_AI_* env overrides.
 */
export function loadFangTangDefaults(): FangTangDefaultsFile {
  const env = process.env
  const file = readDefaultsFile()
  return {
    ...(file.serperApiKey || env.SERPER_API_KEY
      ? { serperApiKey: env.SERPER_API_KEY || file.serperApiKey }
      : {}),
    ...(file.tavilyApiKey || env.TAVILY_API_KEY
      ? { tavilyApiKey: env.TAVILY_API_KEY || file.tavilyApiKey }
      : {}),
    ...(file.provider || env.FANGTANG_AI_PROVIDER
      ? { provider: env.FANGTANG_AI_PROVIDER || file.provider }
      : {}),
    ...(file.baseUrl || env.FANGTANG_AI_BASE_URL
      ? { baseUrl: env.FANGTANG_AI_BASE_URL || file.baseUrl }
      : {}),
    ...(file.apiKey || env.FANGTANG_AI_API_KEY
      ? { apiKey: env.FANGTANG_AI_API_KEY || file.apiKey }
      : {}),
    ...(file.model || env.FANGTANG_AI_MODEL ? { model: env.FANGTANG_AI_MODEL || file.model } : {}),
    ...(typeof file.maxOutputTokens === 'number' && file.maxOutputTokens > 0
      ? { maxOutputTokens: file.maxOutputTokens }
      : {}),
  }
}

/**
 * Account/billing configuration from the same deployment source
 * (fangtang-defaults.json + FANGTANG_* env overrides). Empty result = account
 * features stay hidden and the app keeps its pre-V1 anonymous behavior.
 */
export function loadFangTangAccountConfig(): FangTangAccountConfig {
  const file = readDefaultsFile().account ?? {}
  const env = process.env
  // merged first, then stripped: exactOptionalPropertyTypes forbids explicit
  // undefined on the optional target props
  const merged = {
    logtoEndpoint: env.FANGTANG_LOGTO_ENDPOINT || file.logtoEndpoint,
    logtoClientId: env.FANGTANG_LOGTO_CLIENT_ID || file.logtoClientId,
    logtoApiResource: env.FANGTANG_LOGTO_API_RESOURCE || file.logtoApiResource,
    accountApiBase: env.FANGTANG_ACCOUNT_API_BASE || file.accountApiBase,
    rechargeUrl: env.FANGTANG_ACCOUNT_RECHARGE_URL || file.rechargeUrl,
  }
  const config: FangTangAccountConfig = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value) config[key as keyof FangTangAccountConfig] = value
  }
  return config
}

/**
 * Feeds the deployment's search keys into @genoffice/ai-search, which reads
 * SERPER_API_KEY / TAVILY_API_KEY from the environment. Real environment
 * variables always win (??= semantics). Call once at startup, before any AI
 * IPC can run a search.
 */
export function applySearchProviderEnv(factory: FangTangDefaultsFile): void {
  if (factory.serperApiKey) process.env.SERPER_API_KEY ??= factory.serperApiKey
  if (factory.tavilyApiKey) process.env.TAVILY_API_KEY ??= factory.tavilyApiKey
}
