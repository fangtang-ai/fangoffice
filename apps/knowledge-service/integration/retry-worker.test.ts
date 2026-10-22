import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  claimBuild,
  reserveRetryCapacity,
  writeBuildContent,
} from '../src/runtime'
import { capacityInput, capacityTransaction } from './capacity-fixtures'
import { cancellationState } from './cancellation-fixtures'
import { withRetryFixture } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('allows a fresh retry worker at the new generation while old and recancelled attempts stay fenced', async () => {
  await withRetryFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveRetryCapacity(transaction, {
        ...capacityInput(fixture),
        operationId: fixture.retryId,
      }),
    )
    const options = {
      indexProfileId: fixture.profileId,
      parserRevision: 'synthetic',
      parserSnapshot: {},
    }
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await expect(
        claimBuild(
          client,
          { id: randomUUID(), retryCount: 0 },
          {
            ownerId: fixture.owners[0],
            operationId: fixture.id,
            buildId: randomUUID(),
            receiptId: fixture.id,
          },
          options,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
    const buildId = randomUUID()
    const context = await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      const build = await claimBuild(
        client,
        { id: randomUUID(), retryCount: 0 },
        {
          ownerId: fixture.owners[0],
          operationId: fixture.retryId,
          buildId,
          receiptId: fixture.id,
        },
        options,
      )
      await writeBuildContent(client, build, {
        chunks: [
          {
            id: randomUUID(),
            ordinal: 0,
            text: 'retry content',
            textHash: Buffer.alloc(32, 1),
            tokenCount: 2,
            searchVector: '',
          },
        ],
      })
      expect(
        (
          await client.query(
            'SELECT expected_generation::text AS generation FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], buildId],
          )
        ).rows,
      ).toEqual([{ generation: '1' }])
      await client.query('COMMIT')
      return build
    })
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.retryId),
    )
    expect((await cancellationState(fixture, fixture.retryId)).builds).toEqual([
      { id: buildId, status: 'invalidated', gc_state: 'live' },
    ])
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await expect(
        writeBuildContent(client, context, {
          chunks: [
            {
              id: randomUUID(),
              ordinal: 1,
              text: 'late retry content',
              textHash: Buffer.alloc(32, 1),
              tokenCount: 2,
              searchVector: '',
            },
          ],
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_current_attempt' })
    })
  })
})
