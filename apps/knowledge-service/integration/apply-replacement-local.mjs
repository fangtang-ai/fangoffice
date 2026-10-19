import { applyLocalGate } from './local-gate.mjs'

await applyLocalGate(
  'replacement-reserve',
  'knowledge.reserve_replacement_capacity(uuid,bigint,bigint,timestamp with time zone)',
  ['immutable-facts', 'build-content', 'build-lifecycle', 'build-publish', 'capacity-reserve'],
  ['drizzle/0001_capacity_projection.sql'],
)
