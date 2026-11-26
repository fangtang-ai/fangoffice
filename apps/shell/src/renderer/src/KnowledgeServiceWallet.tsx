function counter(value: unknown) {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) ? value : null
}
type ServiceGrant = { storageBytes: string; startsAt: string; permanent: true; active: boolean }
export function readKnowledgeServicePlan(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const plan = input as Record<string, unknown>
  const storageBytes = counter(plan.storageBytes)
  if (plan.managed !== true || storageBytes === null || !Array.isArray(plan.grants)) return null
  const grants: ServiceGrant[] = []
  for (const value of plan.grants) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    const bytes = counter(row.storageBytes)
    if (bytes === null || typeof row.startsAt !== 'string'
      || !Number.isFinite(Date.parse(row.startsAt))
      || row.permanent !== true || typeof row.active !== 'boolean') return null
    grants.push({ storageBytes: bytes, startsAt: row.startsAt, permanent: true, active: row.active })
  }
  const activeBytes = grants.filter(row => row.active).reduce((sum,row) => sum+BigInt(row.storageBytes),0n)
  if (activeBytes !== BigInt(storageBytes)) return null
  return { storageBytes, grants }
}
function space(bytes: string) {
  const amount = BigInt(bytes)
  if (amount % 1073741824n === 0n && amount > 0n) return `${amount / 1073741824n} GB`
  return `${Number(amount) / 1048576} MB`
}
export function KnowledgeServiceWallet({ input, language, onRecharge, failed }: {
  input: unknown; language: string; onRecharge: () => void; failed: boolean
}) {
  const plan = readKnowledgeServicePlan(input)
  const en = language.startsWith('en')
  return <aside className="knowledge-wallet" data-knowledge-service-plan>
    <h2>{en ? 'Permanent knowledge storage' : '知识库永久空间权益'}</h2>
    {!plan ? <p role="status">{en ? 'Service information unavailable. Refresh to retry.' : '空间服务权益暂不可用，请刷新重试。'}</p> : <>
      <p>{en ? 'Active plan storage: ' : '当前生效的套餐空间：'}{space(plan.storageBytes)}</p>
      <p>{en ? 'One purchase permanently adds storage. Repeated purchases add capacity. Ingestion, updates and search are included; AI answers use Office AI separately.'
        : '一次购买永久增加空间，重复购买容量叠加；包含入库、更新和检索，AI 问答另使用 Office AI 余额。'}</p>
      <ul>{plan.grants.map((grant,index) => <li key={index}>
        {space(grant.storageBytes)} · {new Date(grant.startsAt).toLocaleDateString(language)} · {en ? 'Permanent' : '永久有效'}
      </li>)}</ul>
      {!plan.grants.some(row => row.active) && <p role="status">{en ? 'Storage rights are not active or have been adjusted to zero. Existing sources remain viewable.' : '永久空间权益尚未生效或已被调整为零；已有原文仍可查看。'}</p>}
    </>}
    <button className="btn btn-secondary" onClick={onRecharge}>{en ? 'View storage expansion packs' : '查看永久扩容包'}</button>
    {failed && <p role="alert">{en ? 'Unable to open the service plans page.' : '服务套餐页面暂时无法打开。'}</p>}
  </aside>
}
