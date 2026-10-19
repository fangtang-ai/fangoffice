import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'worker-phase-lock',
  { role: 'knowledge_worker', table: 'knowledge.kb_operations', column: 'phase' },
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
  ],
)
