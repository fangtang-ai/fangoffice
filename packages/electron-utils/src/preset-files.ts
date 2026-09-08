/**
 * File-based preset skills (内置技能): each app's chat-window skills come from
 * markdown files, so IT can add or update presets without touching code.
 *
 * Layout (both dirs optional, per-app subdirectories):
 *   <dir>/<app>/*.md      e.g. presets/docs/方塘AI公文写作.md
 *
 * File format: optional key:value frontmatter between leading `---` fences,
 * the rest of the file is the playbook (injected as the skill's system
 * prompt). Recognized keys: id, name, nameEn, description, descriptionEn,
 * mcpServers (comma-separated). Without frontmatter the filename (sans
 * extension) becomes id and display name.
 *
 * Merge rule: for one app, user-level files override bundled files by id;
 * if an app has ANY file presets at all, they replace the compiled-in
 * catalog for that app (see composePresetCatalog in @genoffice/agent-core).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PresetFileDef {
  app: string
  id: string
  name: string
  nameEn?: string
  description?: string
  descriptionEn?: string
  mcpServers?: string[]
  systemPrompt: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parsePresetMarkdown(app: string, filename: string, content: string): PresetFileDef | null {
  const stem = filename.replace(/\.md$/i, '').trim()
  if (!stem) return null
  const def: PresetFileDef = { app, id: stem, name: stem, systemPrompt: '' }

  const match = FRONTMATTER_RE.exec(content)
  let body = content
  if (match) {
    body = content.slice(match[0].length)
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
      const sep = line.indexOf(':')
      if (sep <= 0) continue
      const key = line.slice(0, sep).trim()
      const value = line.slice(sep + 1).trim()
      if (!value) continue
      if (key === 'id') def.id = value
      else if (key === 'name') def.name = value
      else if (key === 'nameEn') def.nameEn = value
      else if (key === 'description') def.description = value
      else if (key === 'descriptionEn') def.descriptionEn = value
      else if (key === 'mcpServers') {
        const servers = value
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
        if (servers.length) def.mcpServers = servers
      }
      // unknown keys are ignored (forward compatibility)
    }
  }
  def.systemPrompt = body.trim()
  if (!def.systemPrompt || !def.id) return null
  return def
}

function loadDir(dir: string, into: Map<string, PresetFileDef>): void {
  if (!existsSync(dir)) return
  let apps: string[] = []
  try {
    apps = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return
  }
  for (const app of apps) {
    const appDir = join(dir, app)
    let files: string[] = []
    try {
      files = readdirSync(appDir).filter((f) => f.toLowerCase().endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const parsed = parsePresetMarkdown(app, file, readFileSync(join(appDir, file), 'utf8'))
        if (!parsed) {
          console.warn(`[presets] ${join(appDir, file)}: empty playbook — skipped`)
          continue
        }
        if (into.has(parsed.id)) {
          console.warn(`[presets] duplicate preset id "${parsed.id}" (${app}) — keeping the first`)
          continue
        }
        into.set(parsed.id, parsed)
      } catch (error) {
        console.warn(`[presets] failed to read ${join(appDir, file)}:`, error)
      }
    }
  }
}

/**
 * Bundled presets directory: Resources/presets when packaged; in dev the
 * shared dir lives in apps/shell/resources/presets, reached either from the
 * bundle layout (apps/<app>/out/<bundle>) or from package sources (tests).
 */
export function bundledPresetsDir(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath && existsSync(join(resourcesPath, 'presets'))) {
    return join(resourcesPath, 'presets')
  }
  for (const candidate of [
    join(__dirname, '../../../../apps/shell/resources/presets'), // bundled main (apps/<app>/out/<x>)
    join(__dirname, '../../../apps/shell/resources/presets'), // package sources (tests/tsx)
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return join(__dirname, '../../../../apps/shell/resources/presets')
}

/**
 * Bundled dir first, then the user dir (same-id override); within one app the
 * file set is returned as-is — per-app replacement against the compiled-in
 * catalog happens in composePresetCatalog.
 */
export function loadPresetFiles(bundledDir: string, userDir?: string): PresetFileDef[] {
  const byId = new Map<string, PresetFileDef>()
  loadDir(bundledDir, byId)
  if (userDir) loadDir(userDir, byId)
  return [...byId.values()]
}
