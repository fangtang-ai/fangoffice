export interface KnowledgeAccountBinding {
  userId: string
  sessionId: number
  signal: AbortSignal
}

export interface KnowledgeAccountAccess {
  apiBase(): string | null
  knowledgeBase(): string | null
  bind(): KnowledgeAccountBinding
  isCurrent(binding: KnowledgeAccountBinding): boolean
  token(binding: KnowledgeAccountBinding, rejectedToken?: string): Promise<string>
  allowLoopback?: boolean
}

export interface KnowledgeRequestOptions {
  signal?: AbortSignal
}

export interface KnowledgeClientOptions {
  timeoutMs?: number
}
