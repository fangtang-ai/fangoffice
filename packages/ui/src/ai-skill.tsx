/**
 * Generation-skill picker for the AI chat composer: a compact dropdown listing
 * the built-in presets (技能) plus a "none" escape. Rendered in the composer's
 * footerStart slot; the active preset's name becomes the trigger label so the
 * selection stays visible while typing. Styling: ai-skill.css (gs-dd base
 * classes + composer-button sizing).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { presetsForApp, type PresetSkillDef } from '@genoffice/agent-core'
import { Dropdown } from './dropdown'

export interface AiSkillOption {
  readonly id: string
  /** zh-first display name (falls back naturally per locale) */
  readonly name: string
}

export function AiSkillPicker({
  presets,
  activeId,
  onPick,
  label,
  noneLabel,
  tip,
}: {
  readonly presets: ReadonlyArray<AiSkillOption>
  readonly activeId: string | null
  readonly onPick: (id: string | null) => void
  /** accessible name for the control (技能) */
  readonly label: string
  /** the "no skill" option label */
  readonly noneLabel: string
  /** ScreenTip for the trigger */
  readonly tip?: string
}): React.JSX.Element {
  return (
    <Dropdown
      className="ai-skill-dd"
      value={activeId ?? ''}
      ariaLabel={label}
      {...(tip !== undefined ? { tip } : {})}
      options={[
        { value: '', label: noneLabel },
        ...presets.map((p) => ({ value: p.id, label: p.name })),
      ]}
      onPick={(v) => onPick(v === '' ? null : v)}
    />
  )
}

export const aiSkillStorageKey = (app: string): string => `ft-ai-skill-${app}`

/**
 * Per-panel skill state: the catalog for one app, the persisted active
 * selection (localStorage; UI preference), and the disabled list fetched from
 * the shared ai-features config (Settings → 技能). `loadFeatures` is the
 * per-app preload binding; when it is missing (standalone modes without the
 * shared channels) every preset stays offered.
 */
export function useAiSkills(
  app: string,
  loadFeatures?: () => Promise<{ disabledPresets?: string[] } | undefined> | undefined,
  loadPresets?: () => Promise<PresetSkillDef[] | undefined | null>,
): {
  all: PresetSkillDef[]
  presets: AiSkillOption[]
  active: PresetSkillDef | null
  pick: (id: string | null) => void
} {
  // compiled-in catalog first (instant); the deployment's effective catalog
  // (file presets under presets/<app>/) replaces it once loaded over IPC
  const all = useMemo(() => presetsForApp(app), [app])
  const [catalog, setCatalog] = useState<PresetSkillDef[] | null>(null)
  const loaderRef = useRef(loadPresets)
  loaderRef.current = loadPresets
  const featuresRef = useRef(loadFeatures)
  featuresRef.current = loadFeatures
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void Promise.resolve()
        .then(() => loaderRef.current?.())
        .then((next) => {
          if (alive && Array.isArray(next)) setCatalog(next.filter((p) => p.app === app))
        })
        .catch(() => {})
      void Promise.resolve()
        .then(() => featuresRef.current?.())
        .then((features) => {
          if (alive && features?.disabledPresets) setDisabled(new Set(features.disabledPresets))
        })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [app])
  const effective = catalog ?? all
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      const id = localStorage.getItem(aiSkillStorageKey(app))
      return id || null
    } catch {
      return null
    }
  })
  const pick = useCallback(
    (id: string | null) => {
      setActiveId(id)
      try {
        if (id) localStorage.setItem(aiSkillStorageKey(app), id)
        else localStorage.removeItem(aiSkillStorageKey(app))
      } catch {
        // persistence is best-effort; the selection still applies to the session
      }
    },
    [app],
  )
  const presets = useMemo(
    () => effective.filter((p) => !disabled.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
    [effective, disabled],
  )
  const active = useMemo(
    () => effective.find((p) => p.id === activeId && !disabled.has(p.id)) ?? null,
    [effective, activeId, disabled],
  )
  return { all: effective, presets, active, pick }
}
