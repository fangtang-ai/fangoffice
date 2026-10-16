import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate('build-lifecycle', 'knowledge.guard_build_seal()', [
  'immutable-facts',
  'build-content',
])
