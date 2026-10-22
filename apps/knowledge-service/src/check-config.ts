import { deny } from './errors'
import { parseKnowledgeRuntimeConfig } from './runtime/config'
import { parseKnowledgeMaintenanceConfig } from './runtime/maintenance-config'
import { parseKnowledgeMigrateConfig } from './runtime/migrate'

try {
  const role = process.argv[2]
  if (
    process.argv.length !== 3 ||
    (role !== 'api' && role !== 'worker' && role !== 'maintenance' && role !== 'migrate')
  )
    deny('NOT_CONFIGURED')
  if (role === 'maintenance') parseKnowledgeMaintenanceConfig(process.env)
  else if (role === 'migrate') parseKnowledgeMigrateConfig(process.env, [])
  else parseKnowledgeRuntimeConfig(process.env, role)
  console.info(`knowledge-${role} configuration valid`)
} catch {
  console.error('NOT_CONFIGURED')
  process.exitCode = 1
}
