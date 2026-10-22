import { setTimeout as delay } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { saveKnowledgeTextUpload } from '../src/runtime'
import { KnowledgePolicyError } from '../src/errors'
import { ossUploadNow } from './oss-upload-fixtures'
import { sourceStoreFixture } from './upload-source-fixtures'
import { verificationOptions, verificationPolicy } from './upload-verification-fixtures'

it('uses one total deadline across copy and target decoding even before timer callbacks', async () => {
  const fixture = sourceStoreFixture()
  let current = ossUploadNow
  fixture.copy.mockImplementation(async () => {
    current += 700
    return 'copied'
  })
  fixture.target.body = Readable.from(
    (async function* () {
      current += 400
      yield Buffer.from('test')
    })(),
  )
  await expect(
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, { now: () => current }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(fixture.target.body.destroyed).toBe(true)
})

it('bounds copy I/O even when the adapter ignores AbortSignal', async () => {
  const fixture = sourceStoreFixture()
  fixture.copy.mockImplementation(() => new Promise(() => {}))
  const outcome = await Promise.race([
    saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      { ...verificationPolicy, timeoutMs: 20 },
      verificationOptions,
    ).then(
      () => 'unexpected_success',
      (error: unknown) => error,
    ),
    delay(250, 'hung'),
  ])
  expect(outcome).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(fixture.read).not.toHaveBeenCalled()
})

it('bounds target open I/O and destroys a late returned stream', async () => {
  const fixture = sourceStoreFixture()
  let resolveRead: ((value: typeof fixture.target) => void) | undefined
  fixture.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve
      }),
  )
  const outcome = await Promise.race([
    saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      { ...verificationPolicy, timeoutMs: 20 },
      verificationOptions,
    ).then(
      () => 'unexpected_success',
      (error: unknown) => error,
    ),
    delay(250, 'hung'),
  ])
  resolveRead?.(fixture.target)
  await delay(0)
  expect(outcome).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(fixture.target.body.destroyed).toBe(true)
})

it.each(['copy', 'read'] as const)('sanitizes errors thrown by the %s adapter', async (step) => {
  const fixture = sourceStoreFixture()
  fixture[step].mockRejectedValue(new KnowledgePolicyError('NOT_FOUND'))
  await expect(
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' })
})

it('does not begin target I/O after copy consumed the original session deadline', async () => {
  const fixture = sourceStoreFixture()
  let current = ossUploadNow
  fixture.copy.mockImplementation(async () => {
    current = Date.parse(fixture.input.prepared.staging.expiresAt)
    return 'copied'
  })
  await expect(
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, { now: () => current }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(fixture.read).not.toHaveBeenCalled()
})

it('does not begin target I/O if the caller cancels during copy', async () => {
  const fixture = sourceStoreFixture()
  const controller = new AbortController()
  fixture.copy.mockImplementation(async () => {
    controller.abort('private-reason')
    return 'copied'
  })
  await expect(
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, {
      ...verificationOptions,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' })
  expect(fixture.read).not.toHaveBeenCalled()
})

it('stops a non-cooperative copy promptly on caller cancellation without leaking its reason', async () => {
  const fixture = sourceStoreFixture()
  const controller = new AbortController()
  fixture.copy.mockImplementation(() => {
    controller.abort('private-provider-reason')
    return new Promise(() => {})
  })
  const outcome = await Promise.race([
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, {
      ...verificationOptions,
      signal: controller.signal,
    }).then(
      () => 'unexpected_success',
      (error: unknown) => error,
    ),
    delay(250, 'hung'),
  ])
  expect(outcome).toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' })
  expect(fixture.read).not.toHaveBeenCalled()
})

it('does not consume or copy an upload already cancelled by the caller', async () => {
  const fixture = sourceStoreFixture()
  const controller = new AbortController()
  controller.abort('private-reason')
  await expect(
    saveKnowledgeTextUpload(fixture.input, fixture, verificationPolicy, {
      ...verificationOptions,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(fixture.copy).not.toHaveBeenCalled()
  expect(fixture.read).not.toHaveBeenCalled()
  expect(fixture.input.object.body.destroyed).toBe(true)
})
