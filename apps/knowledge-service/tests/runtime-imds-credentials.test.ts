import { expect, it } from 'vitest'
import { createKnowledgeImdsCredentialSource } from '../src/runtime'

// ECS IMDS(v1)短期STS凭证源：端点/时钟注入可测，凭证必须来自真实回包。

const CREDENTIALS = {
  AccessKeyId: 'STS-ak',
  AccessKeySecret: 'STS-sk',
  SecurityToken: 'STS-token',
  Expiration: '2026-10-22T16:00:00Z',
}

function stubFetch(handlers: Array<(url: string) => Response | Promise<Response>>) {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (url) => {
    const urlText = String(url)
    calls.push(urlText)
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]
    return handler(urlText)
  }
  return { fetch, calls }
}

it('discovers the role name and caches credentials until the renewal window', async () => {
  let now = 0
  const { fetch, calls } = stubFetch([
    () => new Response('epoch-fangtang1-ecs-role\n', { status: 200 }),
    () => new Response(JSON.stringify(CREDENTIALS), { status: 200 }),
  ])
  const source = createKnowledgeImdsCredentialSource({ fetch, now: () => now })
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: '2026-10-22T16:00:00Z',
  })
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: '2026-10-22T16:00:00Z',
  })
  expect(calls).toEqual([
    'http://100.100.100.100/latest/meta-data/ram/security-credentials/',
    'http://100.100.100.100/latest/meta-data/ram/security-credentials/epoch-fangtang1-ecs-role',
  ])
  now = 10_000
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: '2026-10-22T16:00:00Z',
  })
  expect(calls).toHaveLength(2)
})

it('refreshes inside the renewal window and shares one inflight refresh', async () => {
  let now = 0
  const { fetch, calls } = stubFetch([
    () => new Response('epoch-fangtang1-ecs-role', { status: 200 }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return new Response(
        JSON.stringify({ ...CREDENTIALS, Expiration: new Date(90_000).toISOString() }),
        { status: 200 },
      )
    },
    () => new Response('epoch-fangtang1-ecs-role', { status: 200 }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return new Response(
        JSON.stringify({ ...CREDENTIALS, AccessKeyId: 'STS-ak2', Expiration: new Date(190_000).toISOString() }),
        { status: 200 },
      )
    },
  ])
  const source = createKnowledgeImdsCredentialSource({ fetch, now: () => now })
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: new Date(90_000).toISOString(),
  })
  now = 40_000
  const [first, second] = await Promise.all([source.get(), source.get()])
  expect(first).toEqual(second)
  expect(first.accessKeyId).toBe('STS-ak2')
  expect(calls).toHaveLength(4)
})

it('denies malformed payloads without caching and recovers on the next refresh', async () => {
  let now = 0
  const { fetch, calls } = stubFetch([
    () => new Response('epoch-fangtang1-ecs-role', { status: 200 }),
    () => new Response(JSON.stringify({ ...CREDENTIALS, SecurityToken: '' }), { status: 200 }),
    () => new Response('epoch-fangtang1-ecs-role', { status: 200 }),
    () => new Response(JSON.stringify(CREDENTIALS), { status: 200 }),
  ])
  const source = createKnowledgeImdsCredentialSource({ fetch, now: () => now })
  await expect(source.get()).rejects.toThrow('SERVICE_UNAVAILABLE')
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: '2026-10-22T16:00:00Z',
  })
  expect(calls).toHaveLength(4)
})

it('denies an already expired payload', async () => {
  let now = 1_000
  const { fetch } = stubFetch([
    () => new Response('epoch-fangtang1-ecs-role', { status: 200 }),
    () => new Response(JSON.stringify({ ...CREDENTIALS, Expiration: new Date(0).toISOString() }), { status: 200 }),
  ])
  const source = createKnowledgeImdsCredentialSource({ fetch, now: () => now })
  await expect(source.get()).rejects.toThrow('SERVICE_UNAVAILABLE')
})

it('denies fetch failures as SERVICE_UNAVAILABLE', async () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new Error('network down')
  }
  const source = createKnowledgeImdsCredentialSource({ fetch, now: () => 0 })
  await expect(source.get()).rejects.toThrow('SERVICE_UNAVAILABLE')
})

it('honors an explicit role name and skips discovery', async () => {
  const { fetch, calls } = stubFetch([
    () => new Response(JSON.stringify(CREDENTIALS), { status: 200 }),
  ])
  const source = createKnowledgeImdsCredentialSource({
    fetch,
    now: () => 0,
    roleName: 'epoch-fangtang1-ecs-role',
  })
  await expect(source.get()).resolves.toEqual({
    accessKeyId: 'STS-ak',
    accessKeySecret: 'STS-sk',
    securityToken: 'STS-token',
    expiresAt: '2026-10-22T16:00:00Z',
  })
  expect(calls).toEqual([
    'http://100.100.100.100/latest/meta-data/ram/security-credentials/epoch-fangtang1-ecs-role',
  ])
})