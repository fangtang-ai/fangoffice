import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountView } from '../../shared/home-api'
import type {
  KnowledgeDocumentDeletion,
  KnowledgeDocumentTarget,
  KnowledgeDocuments,
  KnowledgeFailureCode,
  KnowledgeOperation,
  KnowledgeOperationTarget,
  KnowledgeQuota,
  KnowledgeSearch,
  KnowledgeSearchHit,
  KnowledgeSourceUnit,
  KnowledgeSpaces,
} from '../../shared/knowledge-api'

type DocumentDeletion = KnowledgeDocumentTarget & {
  title: string
  phase: KnowledgeDocumentDeletion['phase'] | 'unknown'
}

export function useKnowledge(session: AccountView | null) {
  const epoch = useRef(0)
  const [spaces, setSpaces] = useState<KnowledgeSpaces>({ items: [], nextCursor: null })
  const [documents, setDocuments] = useState<KnowledgeDocuments>({ items: [], nextCursor: null })
  const [quota, setQuota] = useState<KnowledgeQuota | null>(null)
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [error, setError] = useState<KnowledgeFailureCode | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [operation, setOperation] = useState<KnowledgeOperation | null>(null)
  const [documentTick, setDocumentTick] = useState(0)
  const [searchHits, setSearchHits] = useState<KnowledgeSearch['hits']>([])
  const [source, setSource] = useState<KnowledgeSourceUnit | null>(null)
  const [deletion, setDeletion] = useState<DocumentDeletion | null>(null)

  const refresh = useCallback(async () => {
    if (!session?.loggedIn) return
    const generation = epoch.current
    setLoading(true)
    setError(null)
    try {
      const [spaceResult, quotaResult] = await Promise.all([
        window.aiOffice.knowledge.listSpaces(),
        window.aiOffice.knowledge.getQuota(),
      ])
      if (generation !== epoch.current) return
      if (spaceResult.ok) {
        setSpaces(spaceResult.value)
        setSelectedSpaceId((previous) =>
          spaceResult.value.items.some((space) => space.id === previous)
            ? previous
            : (spaceResult.value.items[0]?.id ?? null),
        )
      } else setError(spaceResult.code)
      if (quotaResult.ok) setQuota(quotaResult.value)
      else {
        setQuota(null)
        setError(quotaResult.code)
      }
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setLoading(false)
    }
  }, [session])

  useEffect(() => {
    epoch.current += 1
    setSpaces({ items: [], nextCursor: null })
    setDocuments({ items: [], nextCursor: null })
    setQuota(null)
    setError(null)
    setSelectedSpaceId(null)
    setWorking(false)
    setOperation(null)
    setSearchHits([])
    setSource(null)
    setDeletion(null)
    void refresh()
    // Invalidate callbacks before clearing state so old-account or unmounted responses cannot refill it.
    return () => {
      epoch.current += 1
    }
  }, [refresh])

  useEffect(() => {
    let alive = true
    setDocuments({ items: [], nextCursor: null })
    // Search hits and source details expire when the active space changes.
    setSearchHits([])
    setSource(null)
    if (!selectedSpaceId || !session?.loggedIn) return
    const generation = epoch.current
    void window.aiOffice.knowledge
      .listDocuments(selectedSpaceId)
      .then((result) => {
        if (!alive || generation !== epoch.current) return
        if (result.ok) setDocuments(result.value)
        else setError(result.code)
      })
      .catch(() => {
        if (alive && generation === epoch.current) setError('knowledge:request-failed')
      })
    return () => {
      alive = false
    }
  }, [selectedSpaceId, session, documentTick])

  const selectSpace = (spaceId: string | null) => {
    setSelectedSpaceId(spaceId)
    setOperation(null)
  }

  const upload = async () => {
    if (working || loading || !selectedSpaceId) return
    const generation = epoch.current
    setWorking(true)
    setError(null)
    try {
      const result = await window.aiOffice.knowledge.uploadText(selectedSpaceId)
      if (generation !== epoch.current) return
      if (!result.ok) setError(result.code)
      else if (result.value) {
        setOperation(result.value.operation)
        setDocumentTick((value) => value + 1)
        await refresh()
      }
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }

  const refreshAll = () => {
    setDocumentTick((value) => value + 1)
    return refresh()
  }

  const removeDocument = async (target: KnowledgeDocumentTarget & { title: string }) => {
    if (working || loading) return
    if (
      deletion &&
      deletion.phase !== 'deleted' &&
      (deletion.spaceId !== target.spaceId || deletion.documentId !== target.documentId)
    )
      return
    const generation = epoch.current
    setWorking(true)
    setError(null)
    const reconcile = (phase: DocumentDeletion['phase']) => {
      setDeletion({ ...target, phase })
      setSearchHits((previous) =>
        previous.filter(
          (hit) => hit.spaceId !== target.spaceId || hit.documentId !== target.documentId,
        ),
      )
      setSource((previous) =>
        previous?.spaceId === target.spaceId && previous.documentId === target.documentId
          ? null
          : previous,
      )
      setOperation((previous) =>
        previous?.spaceId === target.spaceId && previous.documentId === target.documentId
          ? null
          : previous,
      )
      if (phase === 'deleted')
        setDocuments((previous) => ({
          ...previous,
          items: previous.items.filter(
            (document) => document.spaceId !== target.spaceId || document.id !== target.documentId,
          ),
        }))
      return refreshAll()
    }
    try {
      const result = await window.aiOffice.knowledge.deleteDocument({
        spaceId: target.spaceId,
        documentId: target.documentId,
      })
      if (generation !== epoch.current) return
      if (!result.ok) {
        await reconcile('unknown')
        if (generation === epoch.current) setError(result.code)
      } else if (result.value) await reconcile(result.value.phase)
    } catch {
      if (generation === epoch.current) {
        await reconcile('unknown')
        if (generation === epoch.current) setError('knowledge:request-failed')
      }
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }

  const createSpace = async (title: string) => {
    if (working || loading || !title.trim()) return false
    const generation = epoch.current
    setWorking(true)
    setError(null)
    try {
      const result = await window.aiOffice.knowledge.createSpace(title.trim())
      if (generation !== epoch.current) return false
      if (!result.ok) {
        setError(result.code)
        return false
      }
      setSpaces((previous) => ({
        ...previous,
        items: [...previous.items.filter((item) => item.id !== result.value.id), result.value],
      }))
      selectSpace(result.value.id)
      return true
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
      return false
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }

  const inspect = async (target: KnowledgeOperationTarget) => {
    if (working) return
    const generation = epoch.current
    setWorking(true)
    setError(null)
    try {
      const result = await window.aiOffice.knowledge.getOperation(target)
      if (generation !== epoch.current) return
      if (!result.ok) setError(result.code)
      else {
        setOperation(result.value)
        if (result.value.phase === 'ready') setDocumentTick((value) => value + 1)
      }
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }
  const loadMoreDocuments = async () => {
    if (working || loading || !documents.nextCursor || !selectedSpaceId) return
    const generation = epoch.current
    setWorking(true)
    try {
      const result = await window.aiOffice.knowledge.listDocuments(selectedSpaceId, {
        cursor: documents.nextCursor,
      })
      if (generation !== epoch.current) return
      if (!result.ok) setError(result.code)
      else
        setDocuments((previous) => ({
          nextCursor: result.value.nextCursor,
          items: [
            ...new Map(
              [...previous.items, ...result.value.items].map((item) => [item.id, item]),
            ).values(),
          ],
        }))
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }
  const loadMoreSpaces = async () => {
    if (working || loading || !spaces.nextCursor) return
    const generation = epoch.current
    setWorking(true)
    try {
      const result = await window.aiOffice.knowledge.listSpaces({ cursor: spaces.nextCursor })
      if (generation !== epoch.current) return
      if (!result.ok) setError(result.code)
      else
        setSpaces((previous) => ({
          nextCursor: result.value.nextCursor,
          items: [
            ...new Map(
              [...previous.items, ...result.value.items].map((item) => [item.id, item]),
            ).values(),
          ],
        }))
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }
  const search = async (query: string) => {
    if (working || loading || !selectedSpaceId || !query.trim()) return
    const generation = epoch.current
    setWorking(true)
    setError(null)
    setSource(null)
    try {
      const result = await window.aiOffice.knowledge.search({
        spaceId: selectedSpaceId,
        query: query.trim(),
      })
      if (generation !== epoch.current) return
      if (!result.ok) {
        setError(result.code)
        setSearchHits([])
      } else setSearchHits(result.value.hits)
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }

  const showSource = async (hit: KnowledgeSearchHit, sourceUnitId: string) => {
    if (working) return
    const generation = epoch.current
    setWorking(true)
    setError(null)
    try {
      const result = await window.aiOffice.knowledge.getSourceUnit({
        spaceId: hit.spaceId,
        documentId: hit.documentId,
        versionId: hit.versionId,
        buildId: hit.buildId,
        sourceUnitId,
      })
      if (generation !== epoch.current) return
      if (!result.ok) setError(result.code)
      else setSource(result.value)
    } catch {
      if (generation === epoch.current) setError('knowledge:request-failed')
    } finally {
      if (generation === epoch.current) setWorking(false)
    }
  }

  return {
    spaces,
    documents,
    quota,
    selectedSpaceId,
    selectSpace,
    error,
    loading,
    working,
    operation,
    searchHits,
    source,
    deletion,
    removeDocument,
    upload,
    createSpace,
    inspect,
    search,
    showSource,
    loadMoreDocuments,
    loadMoreSpaces,
    refresh: refreshAll,
  }
}
