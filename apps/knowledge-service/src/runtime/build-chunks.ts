import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

import type { BuildChunkRow, BuildChunkSourceRow } from './build-lifecycle'

// 解析器 unit.id 是 64 位 hex（textHash 产物），uuid 列取其前 32 个 hex 位按 uuid 布局拼接。
export function knowledgeUnitUuid(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw knowledgeBuildChunkError('INVALID_REQUEST')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// 单元文本自带换行结尾（text-lines/markdown 均如此），块文本=逐字拼接，不引入合成分隔符。
// shortcut: 无本地分词器，token_count 恒 0，成本记账以 embedding usage 为准；接入 tokenizer 后升级。
export function createKnowledgeBuildChunkizer(
  chunkBudgetCodePoints: number,
  parserRevision: string,
): (document: {
  parserRevision: string
  coverage: { scope: 'document' | 'selection' }
  units: readonly { id: string; text: string; locator: unknown }[]
}) => { chunks: BuildChunkRow[]; chunkSources: BuildChunkSourceRow[] } {
  if (!Number.isInteger(chunkBudgetCodePoints) || chunkBudgetCodePoints < 2000) {
    throw knowledgeBuildChunkError('INVALID_REQUEST')
  }
  return (document) => {
    if (document.parserRevision !== parserRevision) throw knowledgeBuildChunkError('SOURCE_MISMATCH')
    if (document.coverage?.scope !== 'document') throw knowledgeBuildChunkError('INVALID_REQUEST')
    if (!Array.isArray(document.units) || document.units.length === 0) {
      throw knowledgeBuildChunkError('EMPTY_CONTENT')
    }
    const chunks: BuildChunkRow[] = []
    const chunkSources: BuildChunkSourceRow[] = []
    const pending: Omit<BuildChunkSourceRow, 'chunkId' | 'spanNo'>[] = []
    let chunkOrdinal = 0
    let chunkText = ''
    let chunkCp = 0
    const seal = () => {
      if (!chunkText) return
      const chunk: BuildChunkRow = {
        id: knowledgeUnitUuid(
          createHash('sha256').update(`${chunkOrdinal}\u0000${chunkText}`, 'utf8').digest('hex'),
        ),
        ordinal: chunkOrdinal,
        text: chunkText,
        textHash: Buffer.from(createHash('sha256').update(chunkText, 'utf8').digest('hex'), 'hex'),
        tokenCount: 0,
        searchVector: '',
      }
      chunks.push(chunk)
      pending.forEach((span, spanNo) => chunkSources.push({ chunkId: chunk.id, spanNo, ...span }))
      pending.length = 0
      chunkOrdinal += 1
      chunkText = ''
      chunkCp = 0
    }
    for (const unit of document.units) {
      if (typeof unit.text !== 'string' || typeof unit.id !== 'string') {
        throw knowledgeBuildChunkError('INVALID_REQUEST')
      }
      const unitCodePoints = [...unit.text].length
      if (unitCodePoints === 0) continue
      if (chunkCp > 0 && chunkCp + unitCodePoints > chunkBudgetCodePoints) seal()
      pending.push({
        sourceUnitId: knowledgeUnitUuid(unit.id),
        startCp: chunkCp,
        endCp: chunkCp + unitCodePoints,
        mapping: unit.locator,
      })
      chunkText += unit.text
      chunkCp += unitCodePoints
    }
    seal()
    if (chunks.length === 0) throw knowledgeBuildChunkError('EMPTY_CONTENT')
    return { chunks, chunkSources }
  }
}

function knowledgeBuildChunkError(code: 'INVALID_REQUEST' | 'SOURCE_MISMATCH' | 'EMPTY_CONTENT'): Error {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}