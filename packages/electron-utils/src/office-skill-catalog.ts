import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getFreshAccountManagedToken } from './account-defaults'
import { loadFangTangAccountConfig } from './factory-defaults'
import { loadPresetFiles, type PresetFileDef } from './preset-files'

export interface CloudOfficeSkill extends PresetFileDef {
  enabled: boolean
}
export interface CloudOfficeCatalog {
  version: number
  publishedAt: string | null
  skills: CloudOfficeSkill[]
}
const MAX_BYTES = 2_000_000
const APPS = new Set(['docs', 'sheets', 'slides', 'pdf', 'markdown'])
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/
const requests = new Map<
  string,
  { attemptedAt: number; pending?: Promise<CloudOfficeCatalog | null> }
>()

export function parseCloudOfficeCatalog(value: unknown): CloudOfficeCatalog {
  if (!value || typeof value !== 'object') throw new Error('Invalid skill catalog')
  const catalog = value as CloudOfficeCatalog
  if (
    !Number.isSafeInteger(catalog.version) ||
    catalog.version < 0 ||
    !Array.isArray(catalog.skills) ||
    catalog.skills.length > 200
  )
    throw new Error('Invalid skill catalog version or size')
  if (
    catalog.publishedAt !== null &&
    (typeof catalog.publishedAt !== 'string' || !Number.isFinite(Date.parse(catalog.publishedAt)))
  )
    throw new Error('Invalid publication date')
  if (catalog.version === 0 && catalog.skills.length)
    throw new Error('Unpublished catalog must be empty')
  const ids = new Set<string>()
  for (const skill of catalog.skills) {
    if (
      !skill ||
      typeof skill !== 'object' ||
      typeof skill.id !== 'string' ||
      !ID.test(skill.id) ||
      ids.has(skill.id) ||
      !APPS.has(skill.app) ||
      typeof skill.enabled !== 'boolean'
    )
      throw new Error('Invalid or duplicate skill')
    for (const [key, max, required] of [
      ['name', 100, true],
      ['systemPrompt', 100000, true],
      ['nameEn', 100, false],
      ['description', 1000, false],
      ['descriptionEn', 1000, false],
    ] as const) {
      const text = skill[key]
      if (!required && text === undefined) continue
      if (typeof text !== 'string' || text.length > max || (required && !text.trim()))
        throw new Error(`Invalid skill ${key}`)
    }
    if (
      skill.mcpServers !== undefined &&
      (!Array.isArray(skill.mcpServers) ||
        skill.mcpServers.length > 20 ||
        skill.mcpServers.some(
          (server) => typeof server !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(server),
        ))
    )
      throw new Error('Invalid skill MCP names')
    ids.add(skill.id)
  }
  if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_BYTES)
    throw new Error('Skill catalog too large')
  return catalog
}

/** Official updates never write into the user's custom preset directory. */
export function mergeOfficeSkillCatalog(
  builtin: readonly PresetFileDef[],
  bundled: PresetFileDef[],
  cloud: CloudOfficeSkill[],
  custom: PresetFileDef[],
) {
  const fileApps = new Set(bundled.map((skill) => skill.app))
  const merged = new Map(
    [...builtin.filter((skill) => !fileApps.has(skill.app)), ...bundled].map((skill) => [
      skill.id,
      skill,
    ]),
  )
  for (const skill of cloud) {
    if (skill.enabled) merged.set(skill.id, skill)
    else merged.delete(skill.id)
  }
  for (const skill of custom) merged.set(skill.id, skill)
  return [...merged.values()]
}

async function readCatalog(path: string) {
  try {
    return parseCloudOfficeCatalog(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

async function downloadCatalog(url: string, token: string, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok || !response.body) throw new Error(`Skill sync HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BYTES) throw new Error('Skill response too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    success?: boolean
    data?: unknown
  }
  if (envelope.success !== true) throw new Error('Skill sync failed')
  return parseCloudOfficeCatalog(envelope.data)
}

async function storeCatalog(path: string, catalog: CloudOfficeCatalog) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(catalog), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/** Cache is scoped to the configured API origin, separating test and production. */
export async function syncOfficeSkillCatalog(
  userData: string,
  apiBase: string,
  token: string | null,
  fetcher: typeof fetch = fetch,
) {
  const endpoint = new URL('/api/office/skills', apiBase)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new Error('Office skills require HTTPS')
  const url = endpoint.href
  const path = join(
    userData,
    `office-skills-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.json`,
  )
  const cached = await readCatalog(path)
  if (!token) return cached
  const key = `${path}:${url}`
  const previous = requests.get(key)
  if (previous?.pending) return previous.pending
  if (previous && Date.now() - previous.attemptedAt < 30_000) return cached
  const state: { attemptedAt: number; pending?: Promise<CloudOfficeCatalog | null> } = {
    attemptedAt: Date.now(),
  }
  state.pending = (async () => {
    try {
      const catalog = await downloadCatalog(url, token, fetcher)
      await mkdir(userData, { recursive: true })
      await storeCatalog(path, catalog)
      return catalog
    } catch {
      console.warn('[office-skills] Sync unavailable; retaining the last working catalog')
      return cached
    } finally {
      delete state.pending
    }
  })()
  requests.set(key, state)
  return state.pending
}

export async function loadOfficePresetCatalog(
  builtin: readonly PresetFileDef[],
  bundledDir: string,
  userData: string,
) {
  let cloud: CloudOfficeCatalog | null = null
  try {
    const base = loadFangTangAccountConfig().accountApiBase
    if (base) {
      const token = await getFreshAccountManagedToken().catch(() => null)
      cloud = await syncOfficeSkillCatalog(userData, base, token)
    }
  } catch {
    console.warn('[office-skills] Using local skills while account access is unavailable')
  }
  return mergeOfficeSkillCatalog(
    builtin,
    loadPresetFiles(bundledDir),
    cloud?.skills ?? [],
    loadPresetFiles(join(userData, 'presets')),
  )
}
