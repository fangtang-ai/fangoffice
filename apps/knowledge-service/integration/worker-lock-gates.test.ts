import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { localDirectory, localSettings, serviceDirectory } from './local-database'

interface GateReceipt {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}

for (const [label, previous] of [
  ['worker-lock-order', 'capacity-publish'],
  ['worker-phase-lock', 'worker-lock-order'],
  ['operation-attempt-binding', 'worker-phase-lock'],
  ['operation-attempt-fence', 'operation-attempt-binding'],
]) {
  it(`records ${label} as an independent immutable supplement after ${previous}`, async () => {
    const receipt = JSON.parse(
      await readFile(resolve(localDirectory, `${label}-receipt.json`), 'utf8'),
    ) as GateReceipt
    const prior = JSON.parse(
      await readFile(resolve(localDirectory, `${previous}-receipt.json`), 'utf8'),
    ) as GateReceipt
    expect(receipt.instanceId).toBe((await localSettings()).instanceId)
    expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
    expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
      ...(label === 'operation-attempt-binding'
        ? ['drizzle/0002_operation_attempt_binding.sql']
        : []),
      `security/${label}.sql`,
    ])
    for (const artifact of [...receipt.baseline, ...receipt.artifacts])
      expect(
        createHash('sha256')
          .update(await readFile(resolve(serviceDirectory, artifact.name)))
          .digest('hex'),
      ).toBe(artifact.sha256)
  })

  it(`refuses ${label} replay without changing any accepted receipt`, async () => {
    const files = [
      'migration',
      'immutable-facts',
      'build-content',
      'build-lifecycle',
      'build-publish',
      'capacity-reserve',
      'replacement-reserve',
      'capacity-cancel',
      'capacity-cancel-publish',
      'capacity-cancel-worker',
      'capacity-retry',
      'capacity-publish',
      'worker-lock-order',
      'worker-phase-lock',
      'operation-attempt-binding',
      'operation-attempt-fence',
    ]
    const receipts = () =>
      Promise.all(
        files.map((name) => readFile(resolve(localDirectory, `${name}-receipt.json`), 'utf8')),
      )
    const before = await receipts()
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--experimental-strip-types',
          resolve(serviceDirectory, `integration/apply-${label}-local.mjs`),
        ],
        { windowsHide: true, timeout: 15000 },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Refusing to replay the ${label} migration`),
    })
    expect(await receipts()).toEqual(before)
  })
}
