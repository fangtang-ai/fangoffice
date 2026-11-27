import { useEffect, useState } from 'react'
import type { KnowledgeExpansionPack } from '../../shared/knowledge-packages'

export function KnowledgeExpansionPacks({ language }: { language: string }) {
  const en = language.startsWith('en')
  const [packs, setPacks] = useState<KnowledgeExpansionPack[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [revision, setRevision] = useState(0)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    let active = true
    setState('loading')
    void window.aiOffice
      .getKnowledgeExpansionPacks()
      .then((rows) => {
        if (active) {
          setPacks(rows)
          setState('ready')
        }
      })
      .catch(() => {
        if (active) setState('error')
      })
    return () => {
      active = false
    }
  }, [revision])
  const open = async () => {
    setOpenFailed(false)
    try {
      await window.aiOffice.openRecharge('knowledge_base')
    } catch {
      setOpenFailed(true)
    }
  }
  return (
    <section
      className="knowledge-wallet knowledge-expansion"
      aria-label={en ? 'Knowledge storage packs' : '知识库永久扩容套餐'}
    >
      <header>
        <h2>{en ? 'Knowledge storage packs' : '知识库永久扩容套餐'}</h2>
        <button
          className="btn btn-secondary"
          disabled={state === 'loading'}
          onClick={() => setRevision((value) => value + 1)}
        >
          {en ? 'Refresh plans' : '刷新套餐'}
        </button>
      </header>
      <p>
        {en
          ? 'Pay once for permanent storage. Repeated purchases add capacity. Ingestion, updates and search are included. Maximum file size: 20 MB. AI answers use Office AI separately.'
          : '一次购买，永久增加空间；重复购买可叠加。包含入库、更新和检索，单文件最高 20 MB。AI 问答另使用 Office AI 余额。'}
      </p>
      {state === 'loading' && (
        <p role="status">{en ? 'Loading current plans…' : '正在读取当前上架套餐…'}</p>
      )}
      {state === 'error' && (
        <p role="status">
          {en
            ? 'Plans could not be loaded. Refresh or view them on the website.'
            : '套餐暂时无法读取，请刷新或到网站查看。'}
        </p>
      )}
      {state === 'ready' && packs.length === 0 && (
        <p role="status">
          {en ? 'No storage packs are currently on sale.' : '当前暂无上架扩容包。'}
        </p>
      )}
      {state === 'ready' && (
        <ul className="knowledge-expansion-packs">
          {packs.map((pack) => (
            <li key={pack.id}>
              <h3>{pack.name}</h3>
              <strong>
                {new Intl.NumberFormat(language, { style: 'currency', currency: 'CNY' }).format(
                  pack.priceFen / 100,
                )}
              </strong>
              <p>
                {en ? 'Adds ' : '新增 '}
                {pack.storageMiB % 1024 === 0
                  ? `${pack.storageMiB / 1024} GB`
                  : `${pack.storageMiB} MB`}
                {en ? ' permanent storage' : ' 永久空间'}
              </p>
              <span>{en ? 'One-time purchase · Permanent' : '一次购买 · 永久有效'}</span>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-secondary" onClick={() => void open()}>
        {en ? 'Choose a storage pack on the website' : '前往网站选择扩容包'}
      </button>
      {openFailed && (
        <p role="alert">
          {en
            ? 'Could not open the storage plans page.'
            : '暂时无法打开知识库套餐页面，请稍后重试。'}
        </p>
      )}
      <p>
        {en
          ? 'Knowledge storage is separate from Office AI, Fangtang MCP and the web writing assistant subscription.'
          : '知识库空间与 Office AI、方塘MCP、方塘写作助手订阅分别计算，不互通。'}
      </p>
    </section>
  )
}
