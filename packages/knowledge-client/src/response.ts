import { parseKnowledgeError } from '@genoffice/knowledge-contract'
import { KnowledgeClientError } from './errors'

export function cancelResponse(response: Response) {
  void response.body?.cancel().catch(() => undefined)
}

export async function parseResponse<Value>(response: Response, parse: (input: unknown) => Value) {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new KnowledgeClientError(
      response.ok ? 'knowledge:invalid-response' : 'knowledge:request-failed',
    )
  }
  if (!response.ok) {
    let problem
    try {
      problem = parseKnowledgeError(body)
    } catch {
      problem = undefined
    }
    throw new KnowledgeClientError('knowledge:request-failed', problem)
  }
  try {
    return parse(body)
  } catch {
    throw new KnowledgeClientError('knowledge:invalid-response')
  }
}
