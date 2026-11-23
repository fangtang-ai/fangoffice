import { createKnowledgeClient, type KnowledgeClientOptions } from '@genoffice/knowledge-client'
import { getAccountKnowledgeAccess } from './auth'

export function createAccountKnowledgeClient(options?: KnowledgeClientOptions) {
  return createKnowledgeClient(getAccountKnowledgeAccess(), options)
}
