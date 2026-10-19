import { expect, it } from 'vitest'
import { reserveInitialCapacity } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { addCapacityUpload, capacityInput, capacityState } from './capacity-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'

it('serializes competing uploads and rejects the waiter after the last capacity is committed', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    const operationId = await addCapacityUpload(fixture)
    await expect(reserveInitialCapacity(writer, capacityInput(fixture))).resolves.toEqual({
      replayed: false,
    })
    const waiting = reserveInitialCapacity(waiter, { ...capacityInput(fixture), operationId }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '16',
      reservations: 1,
      desired: fixture.id,
    })
    const rejected = await observer.query(
      'SELECT desired_operation_id FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2',
      [fixture.owners[0], fixture.otherDocumentId],
    )
    expect(rejected.rows).toEqual([{ desired_operation_id: null }])
  })
})

it('lets the waiting upload use capacity only after the earlier reservation rolls back', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    const operationId = await addCapacityUpload(fixture)
    await reserveInitialCapacity(writer, capacityInput(fixture))
    const waiting = reserveInitialCapacity(waiter, { ...capacityInput(fixture), operationId }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('ROLLBACK')
    await expect(waiting).resolves.toEqual({ result: { replayed: false } })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '16',
      reservations: 1,
      desired: null,
    })
    expect(
      (
        await observer.query(
          'SELECT desired_operation_id FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2',
          [fixture.owners[0], fixture.otherDocumentId],
        )
      ).rows,
    ).toEqual([{ desired_operation_id: operationId }])
  })
})

it('converges concurrent copies of one operation to a single held reservation', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await reserveInitialCapacity(writer, capacityInput(fixture))
    const waiting = reserveInitialCapacity(waiter, capacityInput(fixture)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toEqual({ result: { replayed: true } })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '16',
      reservations: 1,
      desired: fixture.id,
    })
  })
})
