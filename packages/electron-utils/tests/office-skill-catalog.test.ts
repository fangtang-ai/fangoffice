import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mergeOfficeSkillCatalog,
  parseCloudOfficeCatalog,
  syncOfficeSkillCatalog,
  type CloudOfficeSkill,
} from '../src/office-skill-catalog'

const skill: CloudOfficeSkill = {
  id: 'docs-test',
  app: 'docs',
  name: '总结',
  systemPrompt: '按材料总结，不编造。',
  enabled: true,
}
const catalog = (version = 1) => ({
  version,
  publishedAt: '2026-11-10T00:00:00.000Z',
  skills: [skill],
})
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  })
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'office-skill-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('official skill merge', () => {
  it('keeps all other shipped skills when adding one cloud skill', () => {
    const builtin = [{ ...skill, id: 'sheets-existing', app: 'sheets' }]
    const bundled = [{ ...skill, id: 'docs-local-bundled' }]
    expect(mergeOfficeSkillCatalog(builtin, bundled, [skill], []).map((s) => s.id)).toEqual([
      'sheets-existing',
      'docs-local-bundled',
      'docs-test',
    ])
  })
  it('hides disabled official skills while preserving user custom overrides and additions', () => {
    const custom = [
      { ...skill, name: '我的自定义规则' },
      { ...skill, id: 'user-custom' },
    ]
    const result = mergeOfficeSkillCatalog([skill], [], [{ ...skill, enabled: false }], custom)
    expect(result.find((s) => s.id === skill.id)?.name).toBe('我的自定义规则')
    expect(result.some((s) => s.id === 'user-custom')).toBe(true)
    expect(mergeOfficeSkillCatalog([skill], [], [{ ...skill, enabled: false }], [])).toEqual([])
  })
  it('retains the existing file-based per-app replacement rule before applying cloud and user layers', () => {
    const result = mergeOfficeSkillCatalog(
      [skill],
      [{ ...skill, id: 'file', name: '文件规则' }],
      [],
      [],
    )
    expect(result.map((s) => s.id)).toEqual(['file'])
  })
})

describe('catalog validation', () => {
  it.each([
    { version: -1 },
    { skills: [skill, skill] },
    { skills: [{ ...skill, app: 'scripts' }] },
    { skills: [{ ...skill, enabled: 'true' }] },
    { skills: [{ ...skill, systemPrompt: ' ' }] },
    { skills: [{ ...skill, id: '../../file' }] },
    { skills: [{ ...skill, mcpServers: ['https://evil.example'] }] },
    { publishedAt: 'not-a-date' },
    { skills: [{ ...skill, name: 'n'.repeat(101) }] },
  ])('rejects malformed releases %j', (change) => {
    expect(() => parseCloudOfficeCatalog({ ...catalog(), ...change })).toThrow()
  })
})

describe('authenticated sync and offline persistence', () => {
  it('fetches only the configured HTTPS endpoint and stores no token in the cache', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(catalog()))
    expect(
      (await syncOfficeSkillCatalog(dir, 'https://test.example/api', 'secret-token', fetcher))
        ?.version,
    ).toBe(1)
    expect(fetcher).toHaveBeenCalledWith(
      'https://test.example/api/office/skills',
      expect.objectContaining({
        redirect: 'error',
        headers: { Authorization: 'Bearer secret-token' },
      }),
    )
    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    expect(await readFile(join(dir, files[0]!), 'utf8')).not.toContain('secret-token')
    expect(
      (await syncOfficeSkillCatalog(dir, 'https://test.example/api', null, fetcher))?.skills,
    ).toEqual([skill])
  })
  it('retains the last release through network or validation failure and applies a later rollback release', async () => {
    let time = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(catalog(2)))
    await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher)
    time += 31_000
    fetcher.mockRejectedValueOnce(new Error('offline'))
    expect(
      (await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher))?.version,
    ).toBe(2)
    time += 31_000
    fetcher.mockResolvedValueOnce(
      response({ ...catalog(3), skills: [{ ...skill, app: 'invalid' }] }),
    )
    expect(
      (await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher))?.version,
    ).toBe(2)
    time += 31_000
    fetcher.mockResolvedValueOnce(
      response({ ...catalog(4), skills: [{ ...skill, enabled: false }] }),
    )
    expect(
      (await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher))?.skills[0]
        ?.enabled,
    ).toBe(false)
  })
  it('coalesces concurrent requests and throttles focus or polling refreshes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response(catalog())
    })
    const both = await Promise.all(
      [1, 2, 3].map(() => syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher)),
    )
    expect(both.map((c) => c?.version)).toEqual([1, 1, 1])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('isolates test and production origins and rejects HTTP or embedded credentials', async () => {
    await syncOfficeSkillCatalog(
      dir,
      'https://test.example',
      'token',
      vi.fn<typeof fetch>().mockResolvedValue(response(catalog())),
    )
    expect(await syncOfficeSkillCatalog(dir, 'https://production.example', null)).toBeNull()
    for (const url of ['http://example.com', 'https://user:password@example.com'])
      await expect(syncOfficeSkillCatalog(dir, url, 'token')).rejects.toThrow('HTTPS')
  })
  it('ignores corrupt cache and rejects oversized HTTP bodies before writing them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(catalog()))
    await syncOfficeSkillCatalog(dir, 'https://test.example', 'token', fetcher)
    const files = await readdir(dir)
    await writeFile(join(dir, files[0]!), '{broken')
    expect(await syncOfficeSkillCatalog(dir, 'https://test.example', null)).toBeNull()
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2_000_001)))
    expect(await syncOfficeSkillCatalog(dir, 'https://different.example', 'token', huge)).toBeNull()
    expect(await readdir(dir)).toHaveLength(1)
  })
})
