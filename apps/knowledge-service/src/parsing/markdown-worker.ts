import { parentPort, workerData } from 'node:worker_threads'
import { KnowledgeTextError, rejectText } from './errors'
import { parseKnowledgeMarkdownDocument } from './markdown-document'
import type { KnowledgeMarkdownWorkerResult } from './worker-message'

if (!parentPort) rejectText('WORKER_FAILED')
let result: KnowledgeMarkdownWorkerResult
try {
  const request: unknown = workerData
  if (typeof request !== 'object' || !request || !('input' in request) || !('limits' in request))
    rejectText('INVALID_REQUEST')
  result = { ok: true, document: parseKnowledgeMarkdownDocument(request.input, request.limits) }
} catch (error) {
  result = {
    ok: false,
    reason: error instanceof KnowledgeTextError ? error.reason : 'WORKER_FAILED',
  }
}
parentPort.postMessage(result)
parentPort.close()
