import type { KnowledgeTextFailure } from './errors'
import type { KnowledgeTextDocument } from './text-document'
import type { KnowledgeMarkdownDocument } from './markdown-document'

export type KnowledgeWorkerResult<T> =
  { ok: true; document: T } | { ok: false; reason: KnowledgeTextFailure }

export type KnowledgeTextWorkerResult = KnowledgeWorkerResult<KnowledgeTextDocument>
export type KnowledgeMarkdownWorkerResult = KnowledgeWorkerResult<KnowledgeMarkdownDocument>
