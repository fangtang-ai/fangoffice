import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'capacity-reserve',
  'knowledge.reserve_initial_capacity(uuid,bigint,bigint,timestamp with time zone)',
  ['immutable-facts', 'build-content', 'build-lifecycle', 'build-publish'],
)
