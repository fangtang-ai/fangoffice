import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate('operation-attempt-fence', 'knowledge.has_current_build_attempt(text,uuid)', [
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
  'operation-attempt-binding',
])
