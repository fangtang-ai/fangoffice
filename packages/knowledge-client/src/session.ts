import { KnowledgeClientError } from './errors'
import type { KnowledgeAccountAccess, KnowledgeAccountBinding } from './types'

export function bindAccount(access: KnowledgeAccountAccess) {
  try {
    return access.bind()
  } catch {
    throw new KnowledgeClientError('knowledge:account-required')
  }
}

export function assertBinding(access: KnowledgeAccountAccess, binding: KnowledgeAccountBinding) {
  if (binding.signal.aborted || !access.isCurrent(binding))
    throw new KnowledgeClientError('knowledge:account-changed')
}

export async function readToken(
  access: KnowledgeAccountAccess,
  binding: KnowledgeAccountBinding,
  rejected?: string,
) {
  assertBinding(access, binding)
  try {
    const token = await access.token(binding, rejected)
    assertBinding(access, binding)
    if (typeof token !== 'string' || !token || /[\s\p{Cc}]/u.test(token))
      throw new KnowledgeClientError('knowledge:account-required')
    return token
  } catch {
    assertBinding(access, binding)
    throw new KnowledgeClientError('knowledge:account-required')
  }
}
