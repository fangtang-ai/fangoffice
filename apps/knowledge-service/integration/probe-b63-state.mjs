import { openLocalDatabase } from './local-database.ts'

const { pool } = await openLocalDatabase('migrator')
try {
  const cols = await pool.query(
    `SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'knowledge' AND table_name = 'kb_operations'
        AND column_name IN ('current_job_id','current_retry_count','current_build_id','current_receipt_id')
      ORDER BY column_name`,
  )
  console.log(
    'binding columns:',
    cols.rows.map((r) => r.column_name),
  )
  const fn = await pool.query(
    `SELECT pg_get_functiondef('knowledge.guard_document_publish()'::regprocedure)::text AS def`,
  )
  const def = fn.rows[0]?.def ?? ''
  console.log('publish gate has binding check:', def.includes('has_current_build_attempt'))
  console.log('publish gate retains cancellation:', def.includes('has_cancelled_reservation'))
  console.log(
    'publish gate mentions gate constraint name:',
    def.includes('kb_document_publish_gate'),
  )
  const check = await pool.query(
    `SELECT conname::text FROM pg_constraint
      WHERE conrelid = 'knowledge.kb_operations'::regclass
        AND conname = 'kb_operations_current_binding_check'`,
  )
  console.log('binding check constraint:', check.rows.length)
} finally {
  await pool.end()
}
