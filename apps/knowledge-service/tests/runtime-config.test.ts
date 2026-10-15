import { expect, it } from 'vitest'
import { parseKnowledgeRuntimeConfig } from '../src/runtime'

import { environment } from './runtime-fixtures'

it('uses an explicit dedicated API target and pinned issuer/JWKS without generic database fallback', () => {
  const config = parseKnowledgeRuntimeConfig(
    {
      ...environment,
      DATABASE_URL: 'postgresql://business.invalid/business',
      PGDATABASE: 'business',
      PGUSER: 'postgres',
    },
    'api',
  )
  expect(config.role).toBe('api')
  expect(config.database).toMatchObject({
    host: 'db.invalid',
    port: 5432,
    database: 'knowledge_synthetic',
    user: 'knowledge_api',
    password: 'synthetic-pass',
    ssl: { rejectUnauthorized: true },
    max: 4,
  })
  if (config.role !== 'api') throw new Error('expected API configuration')
  expect(config.auth).toEqual({
    issuer: 'https://issuer.invalid/oidc',
    audience: 'https://account.invalid',
    requiredPermissions: ['knowledge:access'],
    jwksUrl: 'https://issuer.invalid/oidc/jwks',
  })
  expect(config.listen).toEqual({ host: '127.0.0.1', port: 4180 })
})

it('keeps the worker identity separate and does not require API authentication or HTTP settings', () => {
  const config = parseKnowledgeRuntimeConfig(
    {
      KNOWLEDGE_DATABASE_NAME: environment.KNOWLEDGE_DATABASE_NAME,
      KNOWLEDGE_WORKER_DATABASE_ROLE: environment.KNOWLEDGE_WORKER_DATABASE_ROLE,
      KNOWLEDGE_WORKER_DATABASE_URL: environment.KNOWLEDGE_WORKER_DATABASE_URL,
    },
    'worker',
  )
  expect(config.database.user).toBe('knowledge_worker')
  expect(config.role).toBe('worker')
  expect(config).not.toHaveProperty('auth')
  expect(config).not.toHaveProperty('listen')
})

it.each([
  'KNOWLEDGE_DATABASE_NAME',
  'KNOWLEDGE_API_DATABASE_URL',
  'KNOWLEDGE_API_DATABASE_ROLE',
  'KNOWLEDGE_AUTH_ISSUER',
  'KNOWLEDGE_AUTH_AUDIENCE',
] as const)('refuses missing %s even if generic business configuration is present', (key) => {
  expect(() =>
    parseKnowledgeRuntimeConfig(
      {
        ...environment,
        [key]: '',
        DATABASE_URL: 'postgresql://business.invalid/business',
        PGHOST: 'business.invalid',
      },
      'api',
    ),
  ).toThrow('NOT_CONFIGURED')
})

it.each([
  'postgresql://knowledge_api:synthetic-pass@db.invalid/business',
  'postgresql://postgres:synthetic-pass@db.invalid/knowledge_synthetic',
  'postgresql://knowledge_api@db.invalid/knowledge_synthetic',
  'postgresql://knowledge_api:synthetic-pass@db.invalid/knowledge_synthetic?options=-c%20role%3Dpostgres',
  'postgresql://knowledge_api:synthetic-pass@db.invalid/knowledge_synthetic#fragment',
  'file:///knowledge_synthetic',
])('rejects an ambiguous, mismatched or unsafe dedicated DSN without leaking it', (url) => {
  expect(() =>
    parseKnowledgeRuntimeConfig({ ...environment, KNOWLEDGE_API_DATABASE_URL: url }, 'api'),
  ).toThrow('NOT_CONFIGURED')
})

it.each([
  'http://issuer.invalid/oidc',
  'https://user:synthetic-pass@issuer.invalid/oidc',
  'https://issuer.invalid/oidc?tenant=other',
  'https://issuer.invalid/oidc#fragment',
])('refuses unsafe issuers: %s', (issuer) => {
  expect(() =>
    parseKnowledgeRuntimeConfig({ ...environment, KNOWLEDGE_AUTH_ISSUER: issuer }, 'api'),
  ).toThrow('NOT_CONFIGURED')
})

it('allows transport exceptions only in explicit loopback-isolated mode', () => {
  const local = {
    ...environment,
    KNOWLEDGE_ENVIRONMENT: 'isolated_test',
    KNOWLEDGE_API_DATABASE_URL:
      'postgresql://knowledge_api:synthetic-pass@127.0.0.1:5432/knowledge_synthetic',
    KNOWLEDGE_AUTH_ISSUER: 'http://127.0.0.1:4567/oidc',
    KNOWLEDGE_API_PORT: '0',
  }
  expect(parseKnowledgeRuntimeConfig(local, 'api').database.ssl).toBe(false)
  expect(() =>
    parseKnowledgeRuntimeConfig(
      { ...local, KNOWLEDGE_API_DATABASE_URL: environment.KNOWLEDGE_API_DATABASE_URL },
      'api',
    ),
  ).toThrow('NOT_CONFIGURED')
  expect(() =>
    parseKnowledgeRuntimeConfig({ ...local, KNOWLEDGE_API_HOST: '0.0.0.0' }, 'api'),
  ).toThrow('NOT_CONFIGURED')
  expect(() =>
    parseKnowledgeRuntimeConfig({ ...local, KNOWLEDGE_ENVIRONMENT: 'production' }, 'api'),
  ).toThrow('NOT_CONFIGURED')
})

it.each([
  { KNOWLEDGE_API_PORT: '65536' },
  { KNOWLEDGE_API_PORT: '0' },
  { KNOWLEDGE_API_PORT: '04180' },
  { KNOWLEDGE_ENVIRONMENT: 'development' },
  { KNOWLEDGE_AUTH_REQUIRED_SCOPES: 'knowledge:access knowledge:access' },
  { KNOWLEDGE_AUTH_REQUIRED_SCOPES: 'knowledge:access\nforged' },
])('rejects malformed startup settings instead of silently picking defaults', (overrides) => {
  expect(() => parseKnowledgeRuntimeConfig({ ...environment, ...overrides }, 'api')).toThrow(
    'NOT_CONFIGURED',
  )
})
