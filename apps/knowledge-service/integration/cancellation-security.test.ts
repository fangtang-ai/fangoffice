import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  reserveInitialCapacity,
  writeBuildContent,
} from '../src/runtime'
import { cancellationState } from './cancellation-fixtures'
import {
  addCapacityUpload,
  capacityInput,
  capacityTransaction,
  withCapacityFixture,
} from './capacity-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

type Receipt = {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}
const signature = 'knowledge.cancel_capacity_reservation(uuid)'

it('preserves every accepted artifact and chains both cancellation increments to replacement admission', async () => {
  let prior = JSON.parse(
    await readFile(resolve(localDirectory, 'replacement-reserve-receipt.json'), 'utf8'),
  ) as Receipt
  for (const name of ['capacity-cancel', 'capacity-cancel-publish', 'capacity-cancel-worker']) {
    const receipt = JSON.parse(
      await readFile(resolve(localDirectory, `${name}-receipt.json`), 'utf8'),
    ) as Receipt
    expect(receipt.instanceId).toBe((await localSettings()).instanceId)
    expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
    expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([`security/${name}.sql`])
    for (const artifact of [...receipt.baseline, ...receipt.artifacts])
      expect(
        createHash('sha256')
          .update(await readFile(resolve(serviceDirectory, artifact.name)))
          .digest('hex'),
      ).toBe(artifact.sha256)
    prior = receipt
  }
})

it.each(['cancellation', 'cancellation-publish', 'cancellation-worker'] as const)(
  'refuses %s replay without replacing any migration receipt',
  async (name) => {
    const names = [
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
    ]
    const paths = names.map((label) => resolve(localDirectory, `${label}-receipt.json`))
    const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')))
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--experimental-strip-types',
          resolve(serviceDirectory, `integration/apply-${name}-local.mjs`),
        ],
        { windowsHide: true, timeout: 15000 },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Refusing to replay') })
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before)
  },
)

it('keeps cancellation API-only and grants only worker access to the invoker fact query', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    expect(
      (
        await client.query(
          `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
      role.rolname::text AS owner, role.rolsuper AS superuser, role.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner
      WHERE procedure.oid = $1::regprocedure`,
          [signature],
        )
      ).rows,
    ).toEqual([
      {
        definer: true,
        config: ['search_path=pg_catalog, pg_temp', 'row_security=on'],
        owner: roleNames.migrator,
        superuser: false,
        bypass: false,
        public_execute: false,
      },
    ])
    for (const role of ['api', 'worker', 'gc'] as const) {
      expect(
        (
          await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [
            roleNames[role],
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: role === 'api' }])
      expect(
        (
          await client.query(
            "SELECT has_function_privilege($1, 'knowledge.has_cancelled_reservation(text,uuid,uuid,uuid,bigint)', 'EXECUTE') AS allowed",
            [roleNames[role]],
          )
        ).rows,
      ).toEqual([{ allowed: role === 'worker' }])
    }
  })
})

it('keeps the worker cancellation predicate read-only and bound to its RLS owner', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.id),
    )
    for (const owner of fixture.owners) {
      await inRoleTransaction('worker', owner, async (client) => {
        expect(
          (
            await client.query(
              `SELECT knowledge.has_cancelled_reservation($1, $2, $2, $2, 0) AS cancelled`,
              [fixture.owners[0], fixture.id],
            )
          ).rows,
        ).toEqual([{ cancelled: owner === fixture.owners[0] }])
      })
    }
    await inRoleTransaction('bootstrap', undefined, async (client) => {
      expect(
        (
          await client.query(`SELECT prosecdef AS definer, proconfig AS config FROM pg_proc
        WHERE oid = 'knowledge.has_cancelled_reservation(text,uuid,uuid,uuid,bigint)'::regprocedure`)
        ).rows,
      ).toEqual([{ definer: false, config: ['search_path=pg_catalog'] }])
    })
  })
})

it.each(['worker', 'gc'] as const)('refuses direct %s cancellation', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.cancel_capacity_reservation($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('refuses cancellation without an authenticated transaction owner', async () => {
  await inRoleTransaction('api', undefined, async (client) => {
    expect(
      (
        await client.query('SELECT knowledge.cancel_capacity_reservation($1) AS status', [
          randomUUID(),
        ])
      ).rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})

it('cannot cancel another tenant operation or change its debt', async () => {
  await withCapacityFixture(async (fixture) => {
    const operationId = await addCapacityUpload(fixture)
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, { ...capacityInput(fixture), operationId }),
    )
    const before = await cancellationState(fixture, operationId)
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => cancelCapacityReservation(transaction, operationId),
        fixture.owners[1],
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await cancellationState(fixture, operationId)).toEqual(before)
  })
})

it.each([
  "UPDATE knowledge.kb_reservations SET state = 'released', closed_at = now() WHERE owner_id = $1",
  'UPDATE knowledge.kb_quotas SET reserved_files = 0, reserved_bytes = 0, reserved_chunks = 0 WHERE owner_id = $1',
  'UPDATE knowledge.kb_documents SET generation = generation + 1 WHERE owner_id = $1',
  "UPDATE knowledge.kb_operations SET phase = 'cancelled' WHERE owner_id = $1",
])('does not grant API direct cancellation writes: %s', async (statement) => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      await expect(client.query(statement, [fixture.owners[0]])).rejects.toMatchObject({
        code: '42501',
      })
    })
  })
})

it.each(['queued', 'indexing', 'publishing'] as const)(
  'cannot reopen a cancelled operation into %s',
  async (phase) => {
    await withCapacityFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      )
      // worker已无phase列UPDATE权限(worker-phase-lock.sql)，改由bootstrap验证底层门。
      await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
        await expect(
          client.query(
            'UPDATE knowledge.kb_operations SET phase = $3 WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id, phase],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'kb_operation_cancelled' })
      })
    })
  },
)

it.each(['sourceUnits', 'chunks', 'chunkSources', 'embeddings'] as const)(
  'refuses late %s writes after logical release',
  async (kind) => {
    await withCapacityFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      )
      const content = {
        sourceUnits: [
          {
            id: randomUUID(),
            ordinal: 1,
            type: 'paragraph',
            text: 'synthetic',
            textHash: Buffer.alloc(32, 1),
            locator: {},
            coverage: {},
            warnings: [],
          },
        ],
        chunks: [
          {
            id: randomUUID(),
            ordinal: 1,
            text: 'synthetic',
            textHash: Buffer.alloc(32, 1),
            tokenCount: 1,
            searchVector: '',
          },
        ],
        chunkSources: [
          {
            chunkId: fixture.id,
            spanNo: 1,
            sourceUnitId: fixture.id,
            startCp: 0,
            endCp: 1,
            mapping: {},
          },
        ],
        embeddings: [
          {
            chunkId: fixture.id,
            embedding: JSON.stringify([1, ...Array<number>(1023).fill(0)]),
            embeddedTextHash: Buffer.alloc(32, 1),
          },
        ],
      }
      await inRoleTransaction('worker', fixture.owners[0], async (client) => {
        await expect(
          writeBuildContent(
            client,
            { ownerId: fixture.owners[0], buildId: fixture.id },
            { [kind]: content[kind] },
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_current_attempt' })
      })
    })
  },
)
