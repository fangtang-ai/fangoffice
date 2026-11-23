import { useState } from 'react'
import type { AccountUsage, AccountView } from '../../shared/home-api'
import type { KnowledgeSearchHit } from '../../shared/knowledge-api'
import { KnowledgeWallet } from './KnowledgeWallet'
import { useI18n } from './locale'
import { knowledgeOperationText, knowledgeText } from './knowledge-text'
import { useKnowledge } from './use-knowledge'
import './knowledge.css'

function KnowledgeHit({
  hit,
  working,
  text,
  onShowSource,
}: {
  hit: KnowledgeSearchHit
  working: boolean
  text: ReturnType<typeof knowledgeText>
  onShowSource: (hit: KnowledgeSearchHit, sourceUnitId: string) => Promise<void>
}) {
  const [sourceUnitId, setSourceUnitId] = useState(hit.sources[0].sourceUnitId)
  const snippet = Array.from(hit.snippet.text)
  return (
    <li className="knowledge-search-hit">
      <span>{hit.title}</span>
      <span>{hit.snippet.text}</span>
      {hit.sources.length > 1 && (
        <label>
          {text.sourcePart}
          <select
            data-source-select
            value={sourceUnitId}
            disabled={working}
            onChange={(event) => setSourceUnitId(event.target.value)}
          >
            {hit.sources.map((source, index) => {
              const start = Math.max(0, source.startCp - hit.snippet.startCp)
              const end = Math.max(start, Math.min(source.endCp - hit.snippet.startCp, start + 48))
              return (
                <option key={source.sourceUnitId} value={source.sourceUnitId}>
                  {index + 1}: {snippet.slice(start, end).join('').trim()}
                </option>
              )
            })}
          </select>
        </label>
      )}
      <button
        className="btn btn-secondary"
        data-action="source"
        disabled={working}
        onClick={() => void onShowSource(hit, sourceUnitId)}
      >
        {text.viewSource}
      </button>
    </li>
  )
}

export function KnowledgePanel({
  session,
  onLogin,
  usage,
  onRefreshAccount,
}: {
  session: AccountView | null
  onLogin: () => void
  usage: AccountUsage | null
  onRefreshAccount: () => void
}) {
  const { lang } = useI18n()
  const text = knowledgeText(lang)
  const knowledge = useKnowledge(session)
  const [spaceTitle, setSpaceTitle] = useState('')
  const [query, setQuery] = useState('')
  if (!session?.loggedIn)
    return (
      <section className="knowledge-panel">
        <h1>{text.title}</h1>
        <p>{text.login}</p>
        <button className="btn btn-secondary" onClick={onLogin}>
          {text.signIn}
        </button>
      </section>
    )
  const configured =
    knowledge.quota?.ownerState === 'active' &&
    knowledge.quota.activeIndexProfileId !== null &&
    knowledge.quota.limits !== null
  const space = knowledge.spaces.items.find((item) => item.id === knowledge.selectedSpaceId)
  const pendingDeletion = knowledge.deletion?.phase !== 'deleted' ? knowledge.deletion : null
  return (
    <section className="knowledge-panel" aria-label={text.title}>
      <header>
        <div>
          <h1>{text.title}</h1>
          <p>{text.description}</p>
        </div>
        <button
          className="btn btn-secondary"
          disabled={knowledge.loading || knowledge.working}
          onClick={() => {
            onRefreshAccount()
            void knowledge.refresh()
          }}
        >
          {text.refresh}
        </button>
      </header>
      <KnowledgeWallet usage={usage} language={lang} />
      {knowledge.error && (
        <p role="alert">
          {['NOT_CONFIGURED', 'knowledge:not-configured'].includes(knowledge.error)
            ? text.notConfigured
            : `${text.failed} (${knowledge.error})`}
        </p>
      )}
      {knowledge.quota && !configured && (
        <p role="status">
          {knowledge.quota.ownerState === 'active' ? text.notConfigured : text.readOnly}
        </p>
      )}
      {knowledge.loading && <p role="status">{text.loading}</p>}
      <div className="knowledge-toolbar">
        <label>
          {text.space}
          <select
            value={knowledge.selectedSpaceId ?? ''}
            disabled={knowledge.working || knowledge.loading}
            onChange={(event) => knowledge.selectSpace(event.target.value || null)}
          >
            {knowledge.spaces.items.length === 0 && <option value="">{text.emptySpaces}</option>}
            {knowledge.spaces.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {knowledge.spaces.nextCursor && (
          <button
            className="btn btn-secondary"
            data-action="more-spaces"
            disabled={knowledge.working || knowledge.loading}
            onClick={() => void knowledge.loadMoreSpaces()}
          >
            {text.moreSpaces}
          </button>
        )}
        <button
          className="btn btn-secondary"
          data-action="upload"
          disabled={
            !configured || space?.state !== 'active' || knowledge.working || knowledge.loading
          }
          onClick={() => void knowledge.upload()}
        >
          {knowledge.working ? text.working : text.upload}
        </button>
      </div>
      <form
        className="knowledge-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          if (!configured || knowledge.loading) return
          void knowledge.createSpace(spaceTitle).then((created) => {
            if (created) setSpaceTitle('')
          })
        }}
      >
        <label>
          {text.spaceTitle}
          <input
            name="space-title"
            maxLength={200}
            value={spaceTitle}
            disabled={knowledge.working || knowledge.loading || !configured}
            onChange={(event) => setSpaceTitle(event.target.value)}
          />
        </label>
        <button
          className="btn btn-secondary"
          type="submit"
          disabled={!configured || knowledge.working || knowledge.loading || !spaceTitle.trim()}
        >
          {text.create}
        </button>
      </form>
      <form
        className="knowledge-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          void knowledge.search(query)
        }}
      >
        <label>
          {text.search}
          <input
            name="search-query"
            maxLength={1024}
            value={query}
            disabled={knowledge.working || knowledge.loading}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="btn btn-secondary"
          type="submit"
          data-action="search"
          disabled={!configured || knowledge.working || knowledge.loading || !query.trim()}
        >
          {text.search}
        </button>
      </form>
      <ul className="knowledge-documents">
        {knowledge.searchHits.map((hit) => (
          <KnowledgeHit
            key={hit.chunkId}
            hit={hit}
            working={knowledge.working}
            text={text}
            onShowSource={knowledge.showSource}
          />
        ))}
      </ul>
      {knowledge.source && (
        <pre data-source aria-label={text.viewSource}>
          {knowledge.source.text}
        </pre>
      )}
      {knowledge.quota?.limits && (
        <p>
          {text.quota} — {text.files}: {knowledge.quota.active.files} /{' '}
          {knowledge.quota.limits.files}; {text.bytes}: {knowledge.quota.active.bytes} /{' '}
          {knowledge.quota.limits.bytes}; {text.reserved}: {knowledge.quota.reserved.bytes} B
        </p>
      )}
      {knowledge.operation && (
        <div data-operation role="status">
          <strong>{text.progress}: </strong>
          {knowledgeOperationText(knowledge.operation.phase, lang)}
          {knowledge.operation.error && <span> ({knowledge.operation.error.code})</span>}
          <button
            className="btn btn-secondary"
            disabled={knowledge.working}
            onClick={() => {
              const operation = knowledge.operation
              if (operation)
                void knowledge.inspect({
                  spaceId: operation.spaceId,
                  documentId: operation.documentId,
                  operationId: operation.id,
                })
            }}
          >
            {text.inspect}
          </button>
        </div>
      )}
      {knowledge.deletion && (
        <div data-deletion role="status">
          <strong>{knowledge.deletion.title}: </strong>
          <span>
            {knowledge.deletion.phase === 'deleted'
              ? text.deleted
              : knowledge.deletion.phase === 'deleting'
                ? text.deleting
                : text.deletionUnknown}
          </span>
          <p>{text.deletionNote}</p>
          {pendingDeletion && (
            <button
              className="btn btn-secondary"
              data-action="confirm-deletion"
              disabled={knowledge.working || knowledge.loading}
              onClick={() => void knowledge.removeDocument(pendingDeletion)}
            >
              {text.confirmDeletion}
            </button>
          )}
        </div>
      )}
      <ul className="knowledge-documents">
        {knowledge.documents.items.map((document) => (
          <li key={document.id}>
            <span>{document.title}</span>
            <span>
              {pendingDeletion?.spaceId === document.spaceId &&
              pendingDeletion.documentId === document.id
                ? text.deletionPending
                : document.active
                  ? text.ready
                  : text.pending}
            </span>
            <button
              className="btn btn-secondary"
              data-action="delete-document"
              disabled={
                knowledge.working ||
                knowledge.loading ||
                Boolean(
                  pendingDeletion &&
                  (pendingDeletion.spaceId !== document.spaceId ||
                    pendingDeletion.documentId !== document.id),
                )
              }
              onClick={() =>
                void knowledge.removeDocument({
                  spaceId: document.spaceId,
                  documentId: document.id,
                  title: document.title,
                })
              }
            >
              {text.deleteDocument}
            </button>
            {document.desired && (
              <button
                className="btn btn-secondary"
                data-action="inspect"
                disabled={knowledge.working}
                onClick={() => {
                  if (document.desired)
                    void knowledge.inspect({
                      spaceId: document.spaceId,
                      documentId: document.id,
                      operationId: document.desired.operationId,
                    })
                }}
              >
                {text.inspect}
              </button>
            )}
          </li>
        ))}
      </ul>
      {knowledge.documents.nextCursor && (
        <button
          className="btn btn-secondary"
          data-action="more-documents"
          disabled={knowledge.working || knowledge.loading}
          onClick={() => void knowledge.loadMoreDocuments()}
        >
          {text.moreDocuments}
        </button>
      )}
      {!knowledge.loading && knowledge.documents.items.length === 0 && <p>{text.emptyDocuments}</p>}
    </section>
  )
}
