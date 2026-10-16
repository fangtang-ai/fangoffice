import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { localDirectory, openLocalDatabase, serviceDirectory } from './local-database'

it('uses only the marked tmp cluster with real PostgreSQL 18 and pgvector 0.8.7', async () => {
  const { pool, settings } = await openLocalDatabase('bootstrap')
  try {
    const result = await pool.query<{
      version: string
      vector: string
      data: string
      address: string
      port: string
    }>(`
      SELECT current_setting('server_version') AS version,
      (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector,
      current_setting('data_directory') AS data, current_setting('listen_addresses') AS address,
      current_setting('port') AS port`)
    expect(result.rows[0]?.version).toMatch(/^18\./)
    expect(result.rows[0]?.vector).toBe('0.8.7')
    expect(result.rows[0]?.data.replaceAll('\\', '/').toLowerCase()).toBe(
      `${settings.root.replaceAll('\\', '/').toLowerCase()}/data`,
    )
    expect(result.rows[0]?.address).toBe('127.0.0.1')
    expect(result.rows[0]?.port).toBe('55432')
  } finally {
    await pool.end()
  }
})

it('records the exact generated candidate, FORCE supplement and local-only privilege artifacts', async () => {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'migration-receipt.json'), 'utf8'),
  ) as {
    instanceId: string
    artifacts: { name: string; sha256: string }[]
  }
  const { pool, settings } = await openLocalDatabase('bootstrap')
  try {
    expect(receipt.instanceId).toBe(settings.instanceId)
    expect(receipt.artifacts.map((entry) => entry.name)).toEqual([
      'drizzle/0000_knowledge_base.sql',
      'security/force-rls.sql',
      'security/local-grants.sql',
    ])
    for (const artifact of receipt.artifacts)
      expect(
        createHash('sha256')
          .update(await readFile(resolve(serviceDirectory, artifact.name)))
          .digest('hex'),
      ).toBe(artifact.sha256)
  } finally {
    await pool.end()
  }
})

it('refuses migration replay without overwriting the accepted local schema or receipt', async () => {
  const before = await readFile(resolve(localDirectory, 'migration-receipt.json'), 'utf8')
  await expect(
    promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', resolve(serviceDirectory, 'integration/apply-local.mjs')],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to overwrite an existing knowledge schema'),
  })
  expect(await readFile(resolve(localDirectory, 'migration-receipt.json'), 'utf8')).toBe(before)
})
