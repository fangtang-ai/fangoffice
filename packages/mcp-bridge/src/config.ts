/**
 * Built-in MCP server configuration (fangtang-mcp.json). Two sources merge,
 * user-level entries (userData) overriding bundled ones by server name:
 * 1. the deployment file shipped next to the app (Resources/ when packaged,
 *    apps/shell/resources/ in dev) — edited by IT;
 * 2. userData/fangtang-mcp.json — per-profile additions without repackaging.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type McpTransport = 'stdio' | 'http'

/**
 * Expands ${VAR} references (process.env) so secrets can come from the
 * environment instead of living in the config file: urls, header values,
 * stdio command/args and child env values all support it. Unknown variables
 * expand to '' — a server whose auth header collapses to "Bearer " fails its
 * own connection with a clear error rather than leaking a placeholder.
 */
export function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
    name === 'ACCOUNT_TOKEN' || name === 'ACCOUNT_API_BASE' ? '' : (process.env[name] ?? ''),
  )
}

export interface McpServerConfig {
  transport: McpTransport
  /** Main-process account capability; never a static token placeholder. */
  auth?: 'fangtang-account'
  /** stdio: executable to spawn */
  command?: string
  /** stdio: argument list */
  args?: string[]
  /** stdio: extra environment for the child */
  env?: Record<string, string>
  /** http: streamable HTTP endpoint */
  url?: string
  /** http: request headers (e.g. auth) */
  headers?: Record<string, string>
  /** false = configured but switched off (default true) */
  enabled?: boolean
  /** true = tools join every AI chat; otherwise only presets naming the server (default false) */
  alwaysAvailable?: boolean
  /** per-call timeout in ms (default 30000) */
  timeoutMs?: number
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

function parseConfig(raw: unknown, source: string): McpConfig {
  const servers: Record<string, McpServerConfig> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { servers }
  const record = (raw as Record<string, unknown>).mcpServers
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { servers }
  for (const [name, value] of Object.entries(record as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const server = parseServer(value as Record<string, unknown>)
    if (server) servers[name] = server
    else console.warn(`[mcp] ${source}: invalid server "${name}" — skipped`)
  }
  return { servers }
}

function expandStringRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, text]) => [key, expandEnvRefs(text)]),
  )
}

function parseServer(cfg: Record<string, unknown>): McpServerConfig | undefined {
  const transport = cfg.transport === 'http' ? 'http' : 'stdio'
  const managed = cfg.auth === 'fangtang-account'
  if (cfg.auth !== undefined && !managed) return undefined
  if (managed && transport !== 'http') return undefined
  if (transport === 'stdio' && typeof cfg.command !== 'string') return undefined
  if (transport === 'http' && typeof cfg.url !== 'string') return undefined
  // 账号占位符不属于通用环境变量，只有受管 URL 可以保留基址占位符。
  const outsideUrl = JSON.stringify({ ...cfg, ...(managed ? { url: undefined } : {}) })
  if (/\$\{ACCOUNT_(TOKEN|API_BASE)\}/.test(outsideUrl)) return undefined
  if (managed && typeof cfg.url === 'string' && cfg.url.includes('${ACCOUNT_TOKEN}'))
    return undefined
  const env = expandStringRecord(cfg.env)
  const headers = expandStringRecord(cfg.headers)
  return {
    transport,
    ...(managed ? { auth: 'fangtang-account' } : {}),
    enabled: cfg.enabled !== false,
    alwaysAvailable: cfg.alwaysAvailable === true,
    ...(typeof cfg.command === 'string' ? { command: expandEnvRefs(cfg.command) } : {}),
    ...(Array.isArray(cfg.args) ? { args: cfg.args.map((arg) => expandEnvRefs(String(arg))) } : {}),
    ...(env ? { env } : {}),
    ...(typeof cfg.url === 'string' ? { url: managed ? cfg.url : expandEnvRefs(cfg.url) } : {}),
    ...(headers ? { headers } : {}),
    ...(typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? { timeoutMs: cfg.timeoutMs } : {}),
  }
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.warn(`[mcp] failed to read ${path}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

function bundledConfigPath(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath && existsSync(join(resourcesPath, 'fangtang-mcp.json'))) {
    // a sibling .local.json (gitignored) holds deployment secrets without
    // touching the shipped template
    const local = join(resourcesPath, 'fangtang-mcp.local.json')
    if (existsSync(local)) return local
    return join(resourcesPath, 'fangtang-mcp.json')
  }
  // dev / standalone-app runs: the shared file lives in the shell's resources dir
  const candidates = [
    join(__dirname, '../../../../apps/shell/resources/fangtang-mcp.local.json'),
    join(__dirname, '../../../../apps/shell/resources/fangtang-mcp.json'),
    join(__dirname, '../../../apps/shell/resources/fangtang-mcp.local.json'),
    join(__dirname, '../../../apps/shell/resources/fangtang-mcp.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]!
}

/**
 * Merge the bundled deployment config with the user-level overrides. User
 * entries replace same-named bundled servers entirely (an explicit way to
 * retire a bundled endpoint for one profile).
 */
export function loadMcpConfig(bundledPath?: string, userPath?: string): McpConfig {
  const bundled = parseConfig(
    readJsonFile(bundledPath ?? bundledConfigPath()),
    bundledPath ?? 'bundled fangtang-mcp.json',
  )
  if (!userPath) return bundled
  const user = parseConfig(readJsonFile(userPath), userPath)
  return { servers: { ...bundled.servers, ...user.servers } }
}
