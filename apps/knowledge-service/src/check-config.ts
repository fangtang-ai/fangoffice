import { deny } from './errors'
import { parseKnowledgeRuntimeConfig } from './runtime/config'

try {
  const role = process.argv[2]
  if (process.argv.length !== 3 || (role !== 'api' && role !== 'worker')) deny('NOT_CONFIGURED')
  parseKnowledgeRuntimeConfig(process.env, role)
  console.info(`knowledge-${role} configuration valid`)
} catch {
  console.error('NOT_CONFIGURED')
  process.exitCode = 1
}
