import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { verifyKnowledgeTextUpload } from '../src/runtime'
import { ossUploadNow } from './oss-upload-fixtures'
import {
  textUploadInput,
  verificationOptions,
  verificationPolicy,
} from './upload-verification-fixtures'

it('expires a stalled object read at the original session deadline and destroys its stream', async () => {
  const input = textUploadInput([Buffer.from('test')])
  input.prepared.staging.expiresAt = new Date(ossUploadNow + 20).toISOString()
  input.object.body = new Readable({ read() {} })
  const startedAt = Date.now()
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, {
      now: () => ossUploadNow + Date.now() - startedAt,
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(input.object.body.destroyed).toBe(true)
})

it('binds the result to metadata snapshotted before streaming, not a mutable adapter response', async () => {
  const input = textUploadInput([Buffer.from('test')])
  const key = input.object.key
  input.object.body = Readable.from(
    (async function* () {
      yield Buffer.from('te')
      input.object.etag = '"changed-revision"'
      input.object.key = 'staging/forged/object'
      input.prepared.staging.key = 'staging/forged/object'
      input.prepared.staging.format = 'pdf'
      yield Buffer.from('st')
    })(),
  )
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).resolves.toMatchObject({ key, etag: '"synthetic-object-revision"', format: 'txt' })
})

it('cancels an already aborted or stalled read without exposing the abort reason', async () => {
  for (const preAborted of [true, false]) {
    const input = textUploadInput([Buffer.from('test')])
    input.object.body = new Readable({ read() {} })
    const controller = new AbortController()
    if (preAborted) controller.abort(new Error('synthetic-private-reason'))
    const pending = verifyKnowledgeTextUpload(input, verificationPolicy, {
      ...verificationOptions,
      signal: controller.signal,
    })
    if (!preAborted) controller.abort(new Error('synthetic-private-reason'))
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' })
    expect(input.object.body.destroyed).toBe(true)
  }
})

it('bounds an unresponsive object read even when its upload session remains valid', async () => {
  const input = textUploadInput([Buffer.from('test')])
  input.object.body = new Readable({ read() {} })
  await expect(
    verifyKnowledgeTextUpload(input, { ...verificationPolicy, timeoutMs: 20 }, verificationOptions),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(input.object.body.destroyed).toBe(true)
})

it('rechecks the original deadline after the complete stream finishes', async () => {
  const input = textUploadInput([Buffer.from('test')])
  let calls = 0
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, {
      now: () => (calls++ === 0 ? ossUploadNow : Date.parse(input.prepared.staging.expiresAt)),
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
})

it('does not verify an object when the completion clock is invalid', async () => {
  const input = textUploadInput([Buffer.from('test')])
  let calls = 0
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, {
      now: () => (calls++ === 0 ? ossUploadNow : Number.NaN),
    }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})

it('enforces the total verification time even before a delayed timer callback runs', async () => {
  const input = textUploadInput([Buffer.from('test')])
  let calls = 0
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, {
      now: () => (calls++ === 0 ? ossUploadNow : ossUploadNow + verificationPolicy.timeoutMs),
    }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})
