import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'capacity-publish',
  'knowledge.publish_reserved_build(text,uuid,uuid,uuid,uuid,uuid)',
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
  ],
)
