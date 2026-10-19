import { expect, it } from 'vitest'
import { reserveInitialCapacity } from '../src/runtime'
import {
  capacityInput,
  capacityState,
  capacityTransaction,
  withCapacityFixture,
} from './capacity-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('cancels the current upload and releases only its logical reservation atomically', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    expect(
      (
        await capacityTransaction(fixture, (transaction) =>
          transaction.query('SELECT knowledge.cancel_capacity_reservation($1) AS status', [
            fixture.id,
          ]),
        )
      ).rows,
    ).toEqual([{ status: 'CANCELLED' }])
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            `SELECT document.generation::text AS generation, operation.phase,
                    reservation.state, reservation.closed_at IS NOT NULL AS closed,
                    build.status AS build_status
               FROM knowledge.kb_documents document
               JOIN knowledge.kb_operations operation ON operation.owner_id = document.owner_id
                 AND operation.id = $2
               JOIN knowledge.kb_reservations reservation ON reservation.owner_id = operation.owner_id
                 AND reservation.operation_id = operation.id
               JOIN knowledge.kb_builds build ON build.owner_id = operation.owner_id
                 AND build.operation_id = operation.id
              WHERE document.owner_id = $1 AND document.id = $2`,
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([
        {
          generation: '1',
          phase: 'cancelled',
          state: 'released',
          closed: true,
          build_status: 'invalidated',
        },
      ])
    })
    expect(await capacityState(fixture)).toEqual({
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: '16',
      reservations: 1,
      desired: null,
    })
  })
})
