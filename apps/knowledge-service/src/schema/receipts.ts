import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { bytea, hashCheck, instant, knowledge, timestamps } from './common'
import { kbQuotas } from './control'

export const kbBillingReceipts = knowledge
  .table(
    'kb_billing_receipts',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      settlementKey: text('settlement_key').notNull(),
      product: text('product').notNull().default('knowledge_base'),
      dimension: text('dimension').notNull(),
      tariffRevision: text('tariff_revision').notNull(),
      settlementSnapshot: jsonb('settlement_snapshot').notNull(),
      snapshotHash: bytea('snapshot_hash').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
      status: text('status').notNull().default('pending'),
      siteReceiptId: uuid('site_receipt_id'),
      confirmedAt: instant('confirmed_at'),
      siteAmounts: jsonb('site_amounts'),
      reconciledAt: instant('reconciled_at'),
      nextReconcileAt: instant('next_reconcile_at').notNull().defaultNow(),
      ...timestamps(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      unique('kb_billing_receipts_settlement_unique').on(table.ownerId, table.settlementKey),
      foreignKey({
        name: 'kb_billing_receipts_owner_fk',
        columns: [table.ownerId],
        foreignColumns: [kbQuotas.ownerId],
      }),
      hashCheck('kb_billing_receipts_hash_check', table.snapshotHash),
      check('kb_billing_receipts_product_check', sql`${table.product} = 'knowledge_base'`),
      check(
        'kb_billing_receipts_key_check',
        sql`char_length(${table.settlementKey}) BETWEEN 1 AND 128 AND char_length(${table.tariffRevision}) BETWEEN 1 AND 128`,
      ),
      check(
        'kb_billing_receipts_status_check',
        sql`${table.status} IN ('pending', 'reconciling', 'reserved', 'settled', 'released') AND ${table.dimension} IN ('storage', 'embedding')`,
      ),
      check(
        'kb_billing_receipts_confirmation_check',
        sql`(${table.status} IN ('pending', 'reconciling') AND ${table.siteReceiptId} IS NULL AND ${table.confirmedAt} IS NULL AND ${table.siteAmounts} IS NULL) OR (${table.status} IN ('reserved', 'settled', 'released') AND ${table.siteReceiptId} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL AND ${table.siteAmounts} IS NOT NULL AND jsonb_typeof(${table.siteAmounts}) = 'object')`,
      ),
      check(
        'kb_billing_receipts_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.settlementSnapshot}) = 'object'`,
      ),
      index('kb_billing_receipts_reconcile_idx')
        .on(table.nextReconcileAt, table.ownerId, table.id)
        .where(sql`${table.status} IN ('pending', 'reconciling', 'reserved')`),
    ],
  )
  .enableRLS()
