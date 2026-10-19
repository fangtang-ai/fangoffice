import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate('capacity-cancel', 'knowledge.cancel_capacity_reservation(uuid)', [
  'immutable-facts',
  'build-content',
  'build-lifecycle',
  'build-publish',
  'capacity-reserve',
  'replacement-reserve',
])
