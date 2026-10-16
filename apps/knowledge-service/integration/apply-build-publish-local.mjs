import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate('build-publish', 'knowledge.guard_document_publish()', [
  'immutable-facts',
  'build-content',
  'build-lifecycle',
])
