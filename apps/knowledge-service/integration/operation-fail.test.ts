import { expect, it } from 'vitest'
import { createKnowledgePrincipal } from '../src/identity'
import {
  bindOperationAttempt,
  createKnowledgeFailureApplier,
  reserveInitialCapacity,
  reserveRetryCapacity,
} from '../src/runtime'
import {
  capacityInput,
  capacityState,
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
  type CapacityFixture,
} from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { addFollowupUpload } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const envelopeFor = (fixture: CapacityFixture) => ({
  ownerId: fixture.owners[0],
  operationId: fixture.id,
  buildId: fixture.id,
  receiptId: fixture.id,
})

const jobFor = (fixture: CapacityFixture) => ({ id: fixture.id, retryCount: 0 })

const bindCurrentAttempt = (fixture: CapacityFixture) =>
  capacityTransaction(
    fixture,
    (transaction) => bindOperationAttempt(transaction, jobFor(fixture), envelopeFor(fixture)),
    fixture.owners[0],
    'worker',
  )

const failAsWorker = (
  fixture: CapacityFixture,
  buildId: string,
  jobId: string,
  retryCount: number,
  errorCode: string,
) =>
  capacityTransaction(
    fixture,
    (transaction) =>
      transaction.query('SELECT knowledge.fail_current_build_attempt($1, $2, $3, $4) AS status', [
        buildId,
        jobId,
        retryCount,
        errorCode,
      ]),
    fixture.owners[0],
    'worker',
  )

const sweepCount = (fixture: CapacityFixture) =>
  capacityTransaction(
    fixture,
    (transaction) =>
      transaction.query('SELECT knowledge.expire_owner_stale_operations() AS converged'),
    fixture.owners[0],
    'worker',
  )

const failureFacts = (fixture: CapacityFixture) =>
  inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{
      generation: string
      desired: string | null
      phase: string
      error_code: string | null
      current_build: string | null
      current_receipt: string | null
      state: string
      closed: boolean
      reservation_files: string
      reservation_bytes: string
      reservation_chunks: string
      reservation_physical: string
      files: string
      bytes: string
      chunks: string
      physical: string
      accounted: string
      build_status: string | null
      build_gc_state: string | null
      build_purged: boolean | null
    }>(
      `SELECT document.generation::text AS generation,
              document.desired_operation_id::text AS desired,
              operation.phase, operation.error_code,
              operation.current_build_id::text AS current_build,
              operation.current_receipt_id::text AS current_receipt,
              reservation.state, reservation.closed_at IS NOT NULL AS closed,
              reservation.reserved_files::text AS reservation_files,
              reservation.reserved_bytes::text AS reservation_bytes,
              reservation.reserved_chunks::text AS reservation_chunks,
              reservation.physical_reserved_bytes::text AS reservation_physical,
              quota.reserved_files::text AS files, quota.reserved_bytes::text AS bytes,
              quota.reserved_chunks::text AS chunks, quota.physical_reserved_bytes::text AS physical,
              quota.physical_accounted_bytes::text AS accounted,
              build.status AS build_status, build.gc_state AS build_gc_state,
              build.purged_at IS NOT NULL AS build_purged
         FROM knowledge.kb_operations operation
         JOIN knowledge.kb_documents document ON document.owner_id = operation.owner_id
           AND document.id = operation.document_id
         JOIN knowledge.kb_quotas quota ON quota.owner_id = operation.owner_id
         JOIN knowledge.kb_reservations reservation ON reservation.owner_id = operation.owner_id
           AND reservation.operation_id = operation.id
         LEFT JOIN knowledge.kb_builds build ON build.owner_id = operation.owner_id
           AND build.operation_id = operation.id
        WHERE operation.owner_id = $1 AND operation.id = $2`,
      [fixture.owners[0], fixture.id],
    )
    if (!rows[0]) throw new Error('Missing synthetic failure facts')
    return rows[0]
  })

it('converges the bound attempt on failure and keeps every physical fact untouched', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await bindCurrentAttempt(fixture)
    expect((await failAsWorker(fixture, fixture.id, fixture.id, 0, 'BUILD_TIMEOUT')).rows).toEqual([
      { status: 'FAILED' },
    ])
    expect(await failureFacts(fixture)).toEqual({
      generation: '1',
      desired: null,
      phase: 'failed',
      error_code: 'BUILD_TIMEOUT',
      current_build: fixture.id,
      current_receipt: fixture.id,
      state: 'released',
      closed: true,
      reservation_files: '1',
      reservation_bytes: '4',
      reservation_chunks: '1',
      reservation_physical: '16',
      files: '0',
      bytes: '0',
      chunks: '0',
      // 物理GC确认：物理欠账与物理预留字节全部保留，由GC统一清算。
      physical: '16',
      accounted: '0',
      build_status: 'invalidated',
      build_gc_state: 'live',
      build_purged: false,
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

it('replays an already converged failure without changing any fact', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await bindCurrentAttempt(fixture)
    await failAsWorker(fixture, fixture.id, fixture.id, 0, 'BUILD_TIMEOUT')
    expect((await failAsWorker(fixture, fixture.id, fixture.id, 0, 'BUILD_TIMEOUT')).rows).toEqual([
      { status: 'REPLAY' },
    ])
    expect((await failureFacts(fixture)).generation).toBe('1')
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

it('rejects stale, unbound and malformed failure reports without changing facts', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    // 未绑定attempt：worker不得凭空宣告失败。
    expect((await failAsWorker(fixture, fixture.id, fixture.id, 0, 'BUILD_TIMEOUT')).rows).toEqual([
      { status: 'FORBIDDEN' },
    ])
    await bindCurrentAttempt(fixture)
    // 陈旧attempt：job/retry与绑定事实不一致。
    expect((await failAsWorker(fixture, fixture.id, fixture.id, 1, 'BUILD_TIMEOUT')).rows).toEqual([
      { status: 'FORBIDDEN' },
    ])
    expect(
      (await failAsWorker(fixture, fixture.id, '9f8f7f6f-5f4f-3f2f-1f0f-efdfcfcfaf9f', 0, 'BUILD_TIMEOUT'))
        .rows,
    ).toEqual([{ status: 'FORBIDDEN' }])
    // 非法errorCode：空白或超长。
    expect((await failAsWorker(fixture, fixture.id, fixture.id, 0, '   ')).rows).toEqual([
      { status: 'INVALID_REQUEST' },
    ])
    expect(
      (await failAsWorker(fixture, fixture.id, fixture.id, 0, 'x'.repeat(65))).rows,
    ).toEqual([{ status: 'INVALID_REQUEST' }])
    const facts = await failureFacts(fixture)
    expect(facts.phase).toBe('queued')
    expect(facts.state).toBe('held')
    expect(facts.files).toBe('1')
  })
})

it('denies the failure entry to non-worker roles', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      await expect(
        client.query('SELECT knowledge.fail_current_build_attempt($1, $2, $3, $4) AS status', [
          fixture.id,
          fixture.id,
          0,
          'BUILD_TIMEOUT',
        ]),
      ).rejects.toThrow()
    })
  })
})

it('admits an explicit retry upload after failure without discounting old physical debt', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await bindCurrentAttempt(fixture)
    await failAsWorker(fixture, fixture.id, fixture.id, 0, 'BUILD_TIMEOUT')
    const retryId = await addFollowupUpload(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveRetryCapacity(transaction, {
          operationId: retryId,
          chunks: 1n,
          physicalBytes: 16n,
          expiresAt: new Date(fixture.expiresAt),
        }),
      ),
    ).resolves.toEqual({ replayed: false })
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      // 旧失败代物理负债(16)不抵扣，重试准入全额重新占额。
      physical: '32',
      reservations: 2,
      desired: retryId,
    })
  })
})

it('exposes failure convergence and stale sweep through the runtime applier', async () => {
  await withCapacityFixture(async (fixture) => {
    const { pool } = await openLocalDatabase('worker')
    try {
      const now = Date.now()
      const principal = createKnowledgePrincipal(
        {
          issuer: 'https://synthetic.invalid',
          audiences: ['local-knowledge'],
          subject: fixture.owners[0],
          expiresAt: now + 60000,
          permissions: [],
        },
        { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' },
        now,
      )
      const applier = createKnowledgeFailureApplier(pool, principal)
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await bindCurrentAttempt(fixture)
      await expect(
        applier.failBuildAttempt(fixture.id, fixture.id, 0, 'BUILD_TIMEOUT'),
      ).resolves.toBe('FAILED')
      await expect(
        applier.failBuildAttempt(fixture.id, fixture.id, 0, 'BUILD_TIMEOUT'),
      ).resolves.toBe('REPLAY')
      // 失败换绑闭环：显式重试准入后，预留过期位由扫描收敛一次，重放为0。
      const retryId = await addFollowupUpload(fixture)
      await capacityTransaction(fixture, (transaction) =>
        reserveRetryCapacity(transaction, {
          operationId: retryId,
          chunks: 1n,
          physicalBytes: 16n,
          expiresAt: new Date(fixture.expiresAt),
        }),
      )
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_reservations SET expires_at = now() - interval \'1 minute\' WHERE owner_id = $1 AND operation_id = $2',
        [retryId],
      )
      await expect(applier.expireStaleOperations()).resolves.toBe(1)
      await expect(applier.expireStaleOperations()).resolves.toBe(0)
    } finally {
      await pool.end()
    }
  })
})

it('sweeps an expired uploading operation without releasing any physical byte', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_operations SET phase = 'uploading',
          upload_expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND id = $2`,
      [fixture.id],
    )
    expect((await sweepCount(fixture)).rows).toEqual([{ converged: 1 }])
    expect(await failureFacts(fixture)).toEqual({
      generation: '1',
      desired: null,
      phase: 'failed',
      error_code: 'UPLOAD_EXPIRED',
      current_build: null,
      current_receipt: null,
      state: 'released',
      closed: true,
      reservation_files: '1',
      reservation_bytes: '4',
      reservation_chunks: '1',
      reservation_physical: '16',
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: '16',
      accounted: '0',
      build_status: 'invalidated',
      build_gc_state: 'live',
      build_purged: false,
    })
  })
})

it('sweeps an expired unbound reservation but skips bound attempts and future expiries', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    // 未来过期：不收敛。
    expect((await sweepCount(fixture)).rows).toEqual([{ converged: 0 }])
    // 预留过期但attempt已绑定：留给队列结算，扫描不越权。
    await bindCurrentAttempt(fixture)
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_reservations SET expires_at = now() - interval '1 minute'
         WHERE owner_id = $1 AND operation_id = $2`,
      [fixture.id],
    )
    expect((await sweepCount(fixture)).rows).toEqual([{ converged: 0 }])
    const bound = await failureFacts(fixture)
    expect(bound.phase).toBe('queued')
    expect(bound.state).toBe('held')
    // 未绑定attempt的过期预留：收敛一次，重放为0。
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_operations SET current_build_id = NULL, current_job_id = NULL,
          current_retry_count = NULL, current_receipt_id = NULL WHERE owner_id = $1 AND id = $2`,
      [fixture.id],
    )
    expect((await sweepCount(fixture)).rows).toEqual([{ converged: 1 }])
    const swept = await failureFacts(fixture)
    expect(swept.phase).toBe('failed')
    expect(swept.error_code).toBe('RESERVATION_EXPIRED')
    expect(swept.physical).toBe('16')
    expect(swept.reservation_physical).toBe('16')
  })
})