import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'embedding-attempt',
  'knowledge.record_embedding_event(uuid,uuid,text,text,numeric,uuid,uuid,uuid,uuid,uuid,text)',
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
    'build-gc',
    'storage-window',
  ],
  ['drizzle/0004_embedding_attempt.sql'],
)
