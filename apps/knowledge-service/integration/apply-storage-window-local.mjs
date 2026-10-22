import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'storage-window',
  'knowledge.close_storage_window(uuid,timestamp with time zone,timestamp with time zone,text)',
  [
    'immutable-facts', 'build-content', 'build-lifecycle', 'build-publish',
    'capacity-reserve', 'replacement-reserve', 'capacity-cancel',
    'capacity-cancel-publish', 'capacity-cancel-worker', 'capacity-retry',
    'capacity-publish', 'worker-lock-order', 'worker-phase-lock',
    'operation-attempt-binding', 'operation-attempt-fence', 'deletion-tombstone',
    'operation-fail', 'operation-rebind', 'build-gc',
  ],
  ['drizzle/0003_storage_window.sql'],
)
