import { expect, it } from 'vitest'
import * as runtime from '../src/runtime'

const environment = {
  KNOWLEDGE_DATABASE_NAME: 'knowledge_synthetic',
  KNOWLEDGE_MAINTENANCE_DATABASE_ROLE: 'knowledge_maintenance',
  KNOWLEDGE_MAINTENANCE_DATABASE_URL:
    'postgresql://knowledge_maintenance:synthetic-pass@db.invalid:5432/knowledge_synthetic',
  KNOWLEDGE_QUEUE_NAME: 'knowledge_ingest',
}

it('requires independent maintenance credentials and an explicit queue without API authentication', () => {
  const config = runtime.parseKnowledgeMaintenanceConfig(environment)
  expect(config).toMatchObject({
    role: 'maintenance',
    queueName: 'knowledge_ingest',
    database: { user: 'knowledge_maintenance' },
  })
  expect(config).not.toHaveProperty('auth')
  expect(config).not.toHaveProperty('listen')
})

it.each([
  {
    KNOWLEDGE_MAINTENANCE_DATABASE_URL: undefined,
    KNOWLEDGE_WORKER_DATABASE_URL: environment.KNOWLEDGE_MAINTENANCE_DATABASE_URL,
  },
  { KNOWLEDGE_MAINTENANCE_DATABASE_ROLE: undefined },
  { KNOWLEDGE_QUEUE_NAME: undefined },
  { KNOWLEDGE_QUEUE_NAME: '*' },
  { KNOWLEDGE_QUEUE_NAME: 'a; DROP SCHEMA pgboss' },
  { KNOWLEDGE_ENVIRONMENT: 'development' },
  {
    KNOWLEDGE_MAINTENANCE_DATABASE_URL:
      'postgresql://postgres:synthetic-secret@db.invalid/business',
  },
])(
  'refuses missing or unsafe maintenance scope without a generic or worker fallback',
  (overrides) => {
    expect(() =>
      runtime.parseKnowledgeMaintenanceConfig({
        ...environment,
        ...overrides,
        DATABASE_URL: environment.KNOWLEDGE_MAINTENANCE_DATABASE_URL,
      }),
    ).toThrow('NOT_CONFIGURED')
  },
)
