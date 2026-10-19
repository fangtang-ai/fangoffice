import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'worker-lock-order',
  'knowledge.seal_locked_build(text,uuid,jsonb,timestamptz)',
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
  ],
)
