import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PgBoss } from 'pg-boss'
import { applyLocalGate } from './local-gate.mjs'
import { localDirectory, openLocalDatabase } from './local-database.ts'

// 独立维护入口：先由 pg-boss 自身以 knowledge_migrator 身份安装/迁移 pgboss
// 模式（所有权因此落在维护面，运行时角色不参与），再通过 local-gate 套上
// 只覆盖运行时语句面的授权边界。整个文件只在标记过的本机隔离集群上工作。

const { pool: admin, settings } = await openLocalDatabase('bootstrap')
try {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'bootstrap-receipt.json'), 'utf8'),
  )
  const identity = await admin.query(
    'SELECT system_identifier::text AS identifier FROM pg_control_system()',
  )
  if (
    receipt.instanceId !== settings.instanceId ||
    receipt.systemIdentifier !== identity.rows[0]?.identifier
  )
    throw new Error('Refusing an unrelated cluster')
} finally {
  await admin.end()
}

const { pool: migrator } = await openLocalDatabase('migrator')
let boss
try {
  boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (text, values) => migrator.query(text, values) },
    createSchema: true,
    migrate: true,
    // 只做模式安装/迁移与队列创建，不武装维护定时器、调度器或监听。
    supervise: false,
    schedule: false,
  })
  await boss.start()
  await boss.createQueue('b4_validate')
} finally {
  await boss?.stop().catch(() => {})
  await migrator.end()
}

await applyLocalGate('queue-pgboss', 'pgboss.guard_queue_access()', [
  'immutable-facts',
  'build-content',
])
console.log('Installed fixed pg-boss schema, validation queue and restricted runtime grants.')
