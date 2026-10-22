import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { parseQueueEnvelope, resolveQueueBuild } from '../src/runtime/queue-envelope'
import {
  bindOperationAttempt,
  claimBuild,
  publishBuild,
  sealBuild,
  writeBuildContent,
} from '../src/runtime'
import {
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
  type CapacityFixture,
} from './capacity-fixtures'
import {
  publicationState,
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const envelopeFor = (fixture: CapacityFixture) => ({
  ownerId: fixture.owners[0],
  operationId: fixture.id,
  buildId: fixture.id,
  receiptId: fixture.id,
})

const jobFor = (fixture: CapacityFixture) => ({ id: fixture.id, retryCount: 0 })

it('rejects a worker binding to a nonexistent build without changing the operation', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      const result = await client.query(
        'SELECT knowledge.bind_operation_attempt($1, $2, $3, $4, $5, $6) AS status',
        [fixture.owners[0], fixture.id, randomUUID(), fixture.id, 0, fixture.id],
      )
      expect(result.rows).toEqual([{ status: 'NOT_FOUND' }])
      const operation = await client.query(
        'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1 AND id = $2',
        [fixture.owners[0], fixture.id],
      )
      expect(operation.rows).toEqual([{ current_build_id: null }])
    })
  })
})

it('persists a verified binding across worker transactions and replays it without changing facts', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(
      fixture,
      (transaction) => bindOperationAttempt(transaction, jobFor(fixture), envelopeFor(fixture)),
      fixture.owners[0],
      'worker',
    )
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      const before = await client.query(
        'SELECT to_jsonb(o) AS fact FROM knowledge.kb_operations o WHERE owner_id = $1 AND id = $2',
        [fixture.owners[0], fixture.id],
      )
      await bindOperationAttempt(client, jobFor(fixture), envelopeFor(fixture))
      expect(
        (
          await client.query(
            'SELECT to_jsonb(o) AS fact FROM knowledge.kb_operations o WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual(before.rows)
      await expect(
        resolveQueueBuild(client, jobFor(fixture), envelopeFor(fixture)),
      ).resolves.toMatchObject({
        buildId: fixture.id,
        operationId: fixture.id,
        ownerId: fixture.owners[0],
        receiptStatus: 'pending',
      })
    })
  })
})

it.each(['job', 'build', 'receipt'] as const)(
  'resolves the same bound attempt when its %s UUID uses uppercase input',
  async (component) => {
    await withCapacityFixture(async (fixture) => {
      const envelope = parseQueueEnvelope({
        ...envelopeFor(fixture),
        buildId: component === 'build' ? fixture.id.toUpperCase() : fixture.id,
        receiptId: component === 'receipt' ? fixture.id.toUpperCase() : fixture.id,
      })
      await expect(
        capacityTransaction(
          fixture,
          async (transaction) => {
            await bindOperationAttempt(transaction, jobFor(fixture), envelopeFor(fixture))
            return resolveQueueBuild(
              transaction,
              { id: component === 'job' ? fixture.id.toUpperCase() : fixture.id, retryCount: 0 },
              envelope,
            )
          },
          fixture.owners[0],
          'worker',
        ),
      ).resolves.toMatchObject({
        ownerId: fixture.owners[0],
        buildId: fixture.id,
        operationId: fixture.id,
        receiptStatus: 'pending',
      })
    })
  },
)

it('rejects a second job claiming the same operation even with a different build ID', async () => {
  await withCapacityFixture(async (fixture) => {
    const options = {
      indexProfileId: fixture.profileId,
      parserRevision: 'synthetic',
      parserSnapshot: {},
    }
    const first = await capacityTransaction(
      fixture,
      (transaction) =>
        claimBuild(
          transaction,
          { id: randomUUID(), retryCount: 0 },
          { ...envelopeFor(fixture), buildId: randomUUID() },
          options,
        ),
      fixture.owners[0],
      'worker',
    )
    await expect(
      capacityTransaction(
        fixture,
        (transaction) =>
          claimBuild(
            transaction,
            { id: randomUUID(), retryCount: 0 },
            { ...envelopeFor(fixture), buildId: randomUUID() },
            options,
          ),
        fixture.owners[0],
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ current_build_id: first.buildId }])
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM knowledge.kb_builds WHERE owner_id = $1',
            [fixture.owners[0]],
          )
        ).rows,
      ).toEqual([{ count: 2 }])
    })
  })
})

it.each(['content', 'seal'] as const)(
  'rejects unbound %s but permits it after verified binding',
  async (entry) => {
    await withCapacityFixture(async (fixture) => {
      await inRoleTransaction('worker', fixture.owners[0], async (client) => {
        const context = { ownerId: fixture.owners[0], buildId: fixture.id }
        const work = () =>
          entry === 'seal'
            ? sealBuild(client, context, {})
            : writeBuildContent(client, context, {
                sourceUnits: [
                  {
                    id: randomUUID(),
                    ordinal: 1,
                    type: 'paragraph',
                    text: 'Synthetic',
                    textHash: Buffer.alloc(32, 1),
                    locator: {},
                    coverage: {},
                    warnings: [],
                  },
                ],
              })
        await client.query('SAVEPOINT unbound')
        await expect(work()).rejects.toMatchObject({
          code: entry === 'seal' ? 'FORBIDDEN' : '23514',
        })
        await client.query('ROLLBACK TO SAVEPOINT unbound')
        await bindOperationAttempt(client, jobFor(fixture), envelopeFor(fixture))
        await expect(work()).resolves.toBeUndefined()
      })
    })
  },
)

it.each(['job', 'retry', 'receipt'] as const)(
  'rejects an incorrect %s component at binding',
  async (component) => {
    await withCapacityFixture(async (fixture) => {
      await inRoleTransaction('worker', fixture.owners[0], async (client) => {
        await expect(
          bindOperationAttempt(
            client,
            {
              id: component === 'job' ? randomUUID() : fixture.id,
              retryCount: component === 'retry' ? 1 : 0,
            },
            {
              ...envelopeFor(fixture),
              receiptId: component === 'receipt' ? randomUUID() : fixture.id,
            },
          ),
        ).rejects.toMatchObject({ code: component === 'receipt' ? 'NOT_FOUND' : 'FORBIDDEN' })
      })
    })
  },
)

it('rejects a receipt that is already settled', async () => {
  await withCapacityFixture(async (fixture) => {
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_billing_receipts SET status = 'settled', site_receipt_id = $2, confirmed_at = now(), site_amounts = '{}' WHERE owner_id = $1`,
      [randomUUID()],
    )
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await expect(
        bindOperationAttempt(client, jobFor(fixture), envelopeFor(fixture)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })
})

it.each(['job', 'retry', 'receipt'] as const)(
  'rejects publication after the durable %s fact is superseded',
  async (component) => {
    await withPublicationFixture(async (fixture) => {
      const assignment =
        component === 'job'
          ? 'current_job_id = gen_random_uuid()'
          : component === 'retry'
            ? 'current_retry_count = current_retry_count + 1'
            : 'current_receipt_id = gen_random_uuid()'
      await changeCapacityFixture(
        fixture,
        `UPDATE knowledge.kb_operations SET ${assignment} WHERE owner_id = $1`,
      )
      const before = await publicationState(fixture)
      await expect(
        publicationTransaction(fixture, (transaction) =>
          publishBuild(transaction, fixture.context),
        ),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(await publicationState(fixture)).toEqual(before)
    })
  },
)

it('rolls back the build and binding together after a later SQL failure', async () => {
  await withCapacityFixture(async (fixture) => {
    const buildId = randomUUID()
    await expect(
      capacityTransaction(
        fixture,
        async (transaction) => {
          await claimBuild(
            transaction,
            { id: randomUUID(), retryCount: 0 },
            { ...envelopeFor(fixture), buildId },
            { indexProfileId: fixture.profileId, parserRevision: 'synthetic', parserSnapshot: {} },
          )
          await transaction.query('SELECT 1 / 0')
        },
        fixture.owners[0],
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ current_build_id: null }])
      expect(
        (
          await client.query('SELECT id FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2', [
            fixture.owners[0],
            buildId,
          ])
        ).rows,
      ).toEqual([])
    })
  })
})

it('rejects publication if the bound receipt is settled after sealing', async () => {
  await withPublicationFixture(async (fixture) => {
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_billing_receipts SET status = 'settled', site_receipt_id = $2,
        confirmed_at = now(), site_amounts = '{}' WHERE owner_id = $1`,
      [randomUUID()],
    )
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context)),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await publicationState(fixture)).toEqual(before)
  })
})

it('rejects a worker binding to an absent receipt', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      const result = await client.query(
        'SELECT knowledge.bind_operation_attempt($1, $2, $2, $2, 0, $3) AS status',
        [fixture.owners[0], fixture.id, randomUUID()],
      )
      expect(result.rows).toEqual([{ status: 'NOT_FOUND' }])
    })
  })
})

it('does not resolve an unbound build as the current queue attempt', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await expect(
        resolveQueueBuild(
          client,
          { id: fixture.id, retryCount: 0 },
          {
            ownerId: fixture.owners[0],
            operationId: fixture.id,
            buildId: fixture.id,
            receiptId: fixture.id,
          },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })
})
