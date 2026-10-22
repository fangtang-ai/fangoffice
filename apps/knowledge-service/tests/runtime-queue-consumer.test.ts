import { afterEach, expect, it, vi } from 'vitest'
import {
  startKnowledgeQueueConsumer,
  type KnowledgeQueue,
  type KnowledgeQueueJob,
} from '../src/runtime'

afterEach(() => vi.useRealTimers())

function queueFixture(
  data: unknown = {
    ownerId: 'synthetic-owner',
    operationId: '11111111-1111-4111-8111-111111111111',
    buildId: '22222222-2222-4222-8222-222222222222',
    receiptId: '33333333-3333-4333-8333-333333333333',
  },
) {
  const job: KnowledgeQueueJob = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'synthetic_queue',
    data,
    retryCount: 0,
    expireInSeconds: 60,
    heartbeatSeconds: 10,
    signal: new AbortController().signal,
  }
  const queue = {
    enqueue: vi.fn<KnowledgeQueue['enqueue']>(),
    fetch: vi.fn<KnowledgeQueue['fetch']>().mockResolvedValue(null),
    heartbeat: vi.fn<KnowledgeQueue['heartbeat']>().mockResolvedValue(undefined),
    complete: vi.fn<KnowledgeQueue['complete']>().mockResolvedValue(undefined),
    fail: vi.fn<KnowledgeQueue['fail']>().mockResolvedValue(undefined),
  } satisfies KnowledgeQueue
  queue.fetch.mockResolvedValueOnce(job)
  return { queue, job }
}

it('stops renewing an aborted attempt even when its handler ignores cancellation', async () => {
  vi.useFakeTimers()
  const { queue } = queueFixture()
  let finish!: () => void
  const handle = vi.fn(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const consumer = startKnowledgeQueueConsumer(queue, handle, {
    heartbeatIntervalMs: 10,
    shutdownTimeoutMs: 20,
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(handle).toHaveBeenCalledOnce()
    const closed = expect(consumer.close()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(30)
    await closed
    const heartbeatCount = queue.heartbeat.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(queue.heartbeat).toHaveBeenCalledTimes(heartbeatCount)
  } finally {
    finish()
    await consumer.finished
  }
  expect(queue.complete).not.toHaveBeenCalled()
  expect(queue.fail).not.toHaveBeenCalled()
})

it.each([
  {
    data: { ownerId: 'synthetic-owner', rawText: 'synthetic-private-text' },
    code: 'INVALID_REQUEST',
  },
  { data: undefined, code: 'SERVICE_UNAVAILABLE' },
])(
  'settles only a stable error code and never stores handler diagnostics ($code)',
  async ({ data, code }) => {
    vi.useFakeTimers()
    const { queue, job } = queueFixture(data)
    const handle = vi.fn(async () => {
      throw new Error('synthetic-private-provider-secret')
    })
    const consumer = startKnowledgeQueueConsumer(queue, handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(queue.fail).toHaveBeenCalledExactlyOnceWith(job, code)
      expect(queue.complete).not.toHaveBeenCalled()
      expect(handle).toHaveBeenCalledTimes(code === 'INVALID_REQUEST' ? 0 : 1)
    } finally {
      await consumer.close()
    }
  },
)
