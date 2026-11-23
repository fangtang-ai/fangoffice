import { expect, it } from 'vitest'
import { KnowledgeClientError, resolveKnowledgeEndpoint } from '../src'

it('uses the explicitly configured same-origin knowledge root', () => {
  expect(
    resolveKnowledgeEndpoint({
      apiBase: 'https://account.invalid',
      knowledgeBase: 'https://account.invalid/api/knowledge',
    }).href,
  ).toBe('https://account.invalid/api/knowledge')
})

it('normalizes only the approved root trailing slash', () => {
  expect(
    resolveKnowledgeEndpoint({
      apiBase: 'https://account.invalid/',
      knowledgeBase: 'https://account.invalid/api/knowledge/',
    }).href,
  ).toBe('https://account.invalid/api/knowledge')
})

it.each(['127.0.0.1', '[::1]', 'localhost'])('allows explicit development loopback: %s', (host) => {
  expect(
    resolveKnowledgeEndpoint({
      apiBase: `http://${host}:4567`,
      knowledgeBase: `http://${host}:4567/api/knowledge`,
      allowLoopback: true,
    }).protocol,
  ).toBe('http:')
})

it.each([
  { apiBase: 'https://account.invalid', knowledgeBase: null },
  { apiBase: null, knowledgeBase: 'https://account.invalid/api/knowledge' },
  { apiBase: 'https://account.invalid', knowledgeBase: '' },
  { apiBase: 'https://account.invalid', knowledgeBase: 42 },
])('fails clearly when explicit deployment configuration is missing', (config) => {
  expect(() => resolveKnowledgeEndpoint(config)).toThrow('knowledge:not-configured')
})

it.each([
  { apiBase: 'https://account.invalid', knowledgeBase: 'https://outside.invalid/api/knowledge' },
  { apiBase: 'https://account.invalid', knowledgeBase: 'https://account.invalid/api/office/mcp' },
  {
    apiBase: 'https://account.invalid/api',
    knowledgeBase: 'https://account.invalid/api/knowledge',
  },
  {
    apiBase: 'https://account.invalid/x/..',
    knowledgeBase: 'https://account.invalid/api/knowledge',
  },
  {
    apiBase: 'https://account.invalid/%2e',
    knowledgeBase: 'https://account.invalid/api/knowledge',
  },
  {
    apiBase: 'https://account.invalid?query=1',
    knowledgeBase: 'https://account.invalid/api/knowledge',
  },
  {
    apiBase: 'https://user:secret@account.invalid',
    knowledgeBase: 'https://account.invalid/api/knowledge',
  },
  { apiBase: ' https://account.invalid', knowledgeBase: 'https://account.invalid/api/knowledge' },
  {
    apiBase: 'https://account.invalid',
    knowledgeBase: 'https://account.invalid/api/knowledge?x=1',
  },
  {
    apiBase: 'https://account.invalid',
    knowledgeBase: 'https://account.invalid/api/knowledge#fragment',
  },
  {
    apiBase: 'https://account.invalid',
    knowledgeBase: 'https://account.invalid/x/../api/knowledge',
  },
  {
    apiBase: 'http://account.invalid',
    knowledgeBase: 'http://account.invalid/api/knowledge',
    allowLoopback: true,
  },
  { apiBase: 'http://127.0.0.1', knowledgeBase: 'http://127.0.0.1/api/knowledge' },
  { apiBase: 'file:///tmp/account', knowledgeBase: 'file:///api/knowledge' },
])('rejects an unapproved endpoint without leaking its contents', (config) => {
  expect(() => resolveKnowledgeEndpoint(config)).toThrow(KnowledgeClientError)
  expect(() => resolveKnowledgeEndpoint(config)).toThrow('knowledge:untrusted-target')
})
