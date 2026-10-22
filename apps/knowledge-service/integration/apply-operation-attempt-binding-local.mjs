import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'operation-attempt-binding',
  'knowledge.bind_operation_attempt(text,uuid,uuid,uuid,integer,uuid)',
  [
    'immutable-facts',
    'build-content',
    'build-lifecycle',
    'build-publish',
    'capacity-reserve',
    'replacement-reserve',
    'capacity-cancel',
    'capacity-cancel-publish',
    'capacity-cancel-worker',
    'capacity-retry',
    'capacity-publish',
    'worker-lock-order',
    'worker-phase-lock',
  ],
  ['drizzle/0002_operation_attempt_binding.sql'],
)
