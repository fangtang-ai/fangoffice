/**
 * userData/ai-features.json — cross-app AI feature toggles (built-in skill
 * visibility). Read/written by the shell settings pane and the editors' AI
 * panels through the ai:get-features / ai:set-features IPC channels; the JSON
 * lives in each app's userData so a deployment controls it per profile.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** Same shape as AiFeatures in @genoffice/agent-core (structural, no dep). */
export interface AiFeaturesFile {
  disabledPresets?: string[]
}

export function readAiFeatures(path: string): AiFeaturesFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rec = raw as Record<string, unknown>
      if (Array.isArray(rec.disabledPresets)) {
        return {
          disabledPresets: rec.disabledPresets.filter((v): v is string => typeof v === 'string'),
        }
      }
    }
  } catch {
    // missing or corrupt file: default features
  }
  return {}
}

/** Persist the features file as one atomic replacement. */
export function writeAiFeatures(path: string, features: AiFeaturesFile): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(features, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
    })
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // the write may have failed before the temporary file was created
    }
    throw error
  }
}
