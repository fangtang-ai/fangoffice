import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'build-gc',
  'knowledge.collect_purged_build(text,uuid,timestamp with time zone)',
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
    'operation-rebind',
  ],
)