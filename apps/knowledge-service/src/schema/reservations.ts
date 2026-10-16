import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { kbBuilds } from './builds'
import { counter, instant, knowledge, nonnegative, timestamps } from './common'
import { kbOperations } from './operations'

export const kbReservations = knowledge
  .table(
    'kb_reservations',
    {
      ownerId: text('owner_id').notNull(),
      operationId: uuid('operation_id').notNull(),
      documentId: uuid('document_id').notNull(),
      baseVersionId: uuid('base_version_id'),
      baseBuildId: uuid('base_build_id'),
      expectedGeneration: counter('expected_generation').notNull(),
      reservedFiles: counter('reserved_files').notNull(),
      reservedBytes: counter('reserved_bytes').notNull(),
      reservedChunks: counter('reserved_chunks').notNull(),
      physicalReservedBytes: counter('physical_reserved_bytes').notNull(),
      state: text('state').notNull().default('held'),
      expiresAt: instant('expires_at').notNull(),
      closedAt: instant('closed_at'),
      ...timestamps(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.operationId] }),
      foreignKey({
        name: 'kb_reservations_operation_fk',
        columns: [table.ownerId, table.documentId, table.operationId],
        foreignColumns: [kbOperations.ownerId, kbOperations.documentId, kbOperations.id],
      }),
      foreignKey({
        name: 'kb_reservations_base_fk',
        columns: [table.ownerId, table.documentId, table.baseVersionId, table.baseBuildId],
        foreignColumns: [kbBuilds.ownerId, kbBuilds.documentId, kbBuilds.versionId, kbBuilds.id],
      }),
      check(
        'kb_reservations_base_check',
        sql`(${table.baseVersionId} IS NULL) = (${table.baseBuildId} IS NULL)`,
      ),
      check(
        'kb_reservations_state_check',
        sql`${table.state} IN ('held', 'applied', 'released') AND ((${table.state} = 'held') = (${table.closedAt} IS NULL))`,
      ),
      nonnegative(
        'kb_reservations_counts_check',
        table.expectedGeneration,
        table.reservedFiles,
        table.reservedBytes,
        table.reservedChunks,
        table.physicalReservedBytes,
      ),
      index('kb_reservations_held_idx')
        .on(table.expiresAt, table.ownerId, table.operationId)
        .where(sql`${table.state} = 'held'`),
    ],
  )
  .enableRLS()
