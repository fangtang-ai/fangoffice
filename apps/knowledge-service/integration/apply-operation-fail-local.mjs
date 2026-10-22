import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'operation-fail',
  'knowledge.fail_current_build_attempt(uuid,uuid,integer,text)',
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
    'operation-attempt-binding',
    'operation-attempt-fence',
    'deletion-tombstone',
  ],
)