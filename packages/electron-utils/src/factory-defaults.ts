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
 *   "tavilyApiKey": ""             // optional: web search via Tavily; with neither,
 *                                  // search falls back to keyless DuckDuckGo
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
export function loadFangTangDefaults(): FangTangDefaultsFile {
  let file: FangTangDefaultsFile = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(defaultsFilePath(), 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      file = raw as FangTangDefaultsFile
    }
  } catch {
    // missing or unreadable file: no factory defaults
  }
  const env = process.env
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
 * Feeds the deployment's search keys into @genoffice/ai-search, which reads
 * SERPER_API_KEY / TAVILY_API_KEY from the environment. Real environment
 * variables always win (??= semantics). Call once at startup, before any AI
 * IPC can run a search.
 */
export function applySearchProviderEnv(factory: FangTangDefaultsFile): void {
  if (factory.serperApiKey) process.env.SERPER_API_KEY ??= factory.serperApiKey
  if (factory.tavilyApiKey) process.env.TAVILY_API_KEY ??= factory.tavilyApiKey
}
