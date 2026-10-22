import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'operation-rebind',
  'knowledge.rebind_operation_attempt(text,uuid,uuid,uuid,integer,uuid)',
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
    'operation-fail',
  ],
)