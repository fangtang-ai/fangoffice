import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'capacity-retry',
  'knowledge.reserve_retry_capacity(uuid,bigint,bigint,timestamptz)',
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
  ],
)
