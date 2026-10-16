import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { kbBillingReceipts, kbMeteringEvents } from '../src/schema'
import { checksOf, foreignKeysOf, primaryColumns } from './schema-fixtures'

it('keeps exact metering quantities, unknown usage and optional query subjects distinct', () => {
  expect(primaryColumns(kbMeteringEvents)).toEqual(['owner_id', 'id'])
  expect(kbMeteringEvents.quantity.getSQLType()).toBe('numeric(38, 0)')
  expect(kbMeteringEvents.quantity.notNull).toBe(false)
  expect(kbMeteringEvents.operationId.notNull).toBe(false)
  expect(checksOf(kbMeteringEvents).kb_metering_events_quantity_check).toMatch(
    /unknown.*quantity.*IS NULL.*quantity.*IS NOT NULL/,
  )
  expect(checksOf(kbMeteringEvents).kb_metering_events_subject_check).toMatch(
    /operation.*operation_id.*IS NOT NULL.*query.*operation_id.*IS NULL/,
  )
  expect(foreignKeysOf(kbMeteringEvents).kb_metering_events_build_fk).toMatchObject({
    columns: ['owner_id', 'document_id', 'version_id', 'operation_id', 'build_id'],
    target: 'kb_builds',
    foreignColumns: ['owner_id', 'document_id', 'version_id', 'operation_id', 'id'],
  })
  expect(foreignKeysOf(kbMeteringEvents).kb_metering_events_supersedes_fk).toMatchObject({
    columns: ['owner_id', 'supersedes_event_id'],
    target: 'kb_metering_events',
    foreignColumns: ['owner_id', 'id'],
  })
  expect(
    getTableConfig(kbMeteringEvents).uniqueConstraints.map((key) =>
      key.columns.map((column) => column.name),
    ),
  ).toContainEqual(['owner_id', 'logical_event_key'])
})

it('persists only product-bound settlement snapshots and website receipts, never a second balance', () => {
  expect(primaryColumns(kbBillingReceipts)).toEqual(['owner_id', 'id'])
  expect(
    getTableConfig(kbBillingReceipts).uniqueConstraints.map((key) =>
      key.columns.map((column) => column.name),
    ),
  ).toContainEqual(['owner_id', 'settlement_key'])
  expect(checksOf(kbBillingReceipts).kb_billing_receipts_product_check).toMatch(/knowledge_base/)
  expect(checksOf(kbBillingReceipts).kb_billing_receipts_confirmation_check).toMatch(
    /pending.*reconciling.*site_receipt_id.*IS NULL.*site_receipt_id.*IS NOT NULL/,
  )
  expect(
    getTableConfig(kbBillingReceipts)
      .columns.map((column) => column.name)
      .join(' '),
  ).not.toMatch(/balance|wallet|password|secret/)
  expect(
    getTableConfig(kbMeteringEvents).indexes.find(
      (index) => index.config.name === 'kb_metering_events_delivery_idx',
    )?.config.where,
  ).toBeDefined()
})
