import { KnowledgePolicyError } from './errors'
import { migrateKnowledgeDatabase, parseKnowledgeMigrateConfig } from './runtime/migrate'

// 独立生产迁移入口：绝不接入 api/worker/maintenance 命令面或任何启动/巡检路径（OPERATIONS.md）。
try {
  const config = parseKnowledgeMigrateConfig(process.env, process.argv.slice(2))
  const outcome = await migrateKnowledgeDatabase(config)
  console.info(
    `knowledge-migrate complete revision=${outcome.revision} applied=${outcome.applied.length}`,
  )
} catch (error) {
  // 失败即停：只打印稳定码，证据保留在回执目录；绝不静默重试或换库重试。
  console.error(error instanceof KnowledgePolicyError ? error.code : 'MIGRATION_FAILED')
  process.exitCode = 1
}