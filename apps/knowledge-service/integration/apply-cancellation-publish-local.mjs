import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'capacity-cancel-publish',
  'knowledge.has_cancelled_reservation(text,uuid,uuid,uuid,bigint)',
  [
    'immutable-facts',
    'build-content',
    'build-lifecycle',
    'build-publish',
    'capacity-reserve',
    'replacement-reserve',
    'capacity-cancel',
  ],
)
