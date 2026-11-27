import type { KnowledgeQuota } from '../../shared/knowledge-api'

export function knowledgeSpaceUsage(quota: KnowledgeQuota) {
  if (!quota.limits) return null
  const total = BigInt(quota.limits.bytes)
  const used = BigInt(quota.active.bytes)
  const reserved = BigInt(quota.reserved.bytes)
  const occupied = used + reserved
  const percent = (amount: bigint) =>
    total === 0n
      ? amount > 0n
        ? 100
        : 0
      : Number(((amount > total ? total : amount) * 1000n) / total) / 10
  const usedPercent = percent(used)
  return {
    total,
    used,
    reserved,
    remaining: total > occupied ? total - occupied : 0n,
    occupiedPercent: percent(occupied),
    usedPercent,
    reservedPercent: percent(occupied) - usedPercent,
    overLimit: occupied > total,
  }
}

export function formatKnowledgeSpaceBytes(bytes: bigint, language: string) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let unit = 1n
  let index = 0
  while (index < units.length - 1 && bytes >= unit * 1024n) {
    unit *= 1024n
    index += 1
  }
  const value = Number((bytes * 100n + unit / 2n) / unit) / 100
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value)} ${units[index]}`
}

export function KnowledgeSpaceUsage({
  quota,
  language,
}: {
  quota: KnowledgeQuota
  language: string
}) {
  const usage = knowledgeSpaceUsage(quota)
  if (!usage) return null
  const en = !language.startsWith('zh')
  const format = (bytes: bigint) => formatKnowledgeSpaceBytes(bytes, language)
  const labels = en
    ? {
        title: 'Storage usage',
        used: 'Used',
        reserved: 'Indexing hold',
        remaining: 'Available',
        total: 'Total storage',
        files: 'Documents',
        occupied: 'Occupied',
      }
    : {
        title: '空间使用情况',
        used: '已用空间',
        reserved: '入库中预占',
        remaining: '剩余可用',
        total: '空间总额',
        files: '当前资料',
        occupied: '已占用',
      }
  const values = [
    [labels.used, usage.used, 'used'],
    [labels.reserved, usage.reserved, 'reserved'],
    [labels.remaining, usage.remaining, 'remaining'],
  ] as const
  const valueText = values.map(([label, bytes]) => `${label} ${format(bytes)}`).join('，')
  return (
    <section className="knowledge-space-usage" aria-label={labels.title}>
      <header>
        <h2>{labels.title}</h2>
        <span>
          {labels.occupied} {usage.occupiedPercent.toFixed(1)}%
        </span>
      </header>
      <div
        className="knowledge-space-track"
        role="progressbar"
        aria-label={labels.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.occupiedPercent}
        aria-valuetext={`${valueText}，${labels.total} ${format(usage.total)}`}
      >
        <span className="knowledge-space-used" style={{ width: `${usage.usedPercent}%` }} />
        <span className="knowledge-space-reserved" style={{ width: `${usage.reservedPercent}%` }} />
      </div>
      <dl>
        {values.map(([label, bytes, kind]) => (
          <div key={kind}>
            <dt>
              <span className={`knowledge-space-dot ${kind}`} />
              {label}
            </dt>
            <dd>{format(bytes)}</dd>
          </div>
        ))}
      </dl>
      <p>
        {labels.total} {format(usage.total)} · {labels.files}{' '}
        {new Intl.NumberFormat(language).format(BigInt(quota.active.files))}
        {en ? '' : ' 份'}
      </p>
      <p className="knowledge-space-note">
        {en
          ? 'Indexing holds temporarily occupy storage. Deleting a document frees its used space without changing purchased capacity.'
          : '入库中的预占空间暂不可用。删除资料会释放已用空间，已购总容量不减少。'}
      </p>
      {usage.overLimit && (
        <p role="status" className="knowledge-space-warning">
          {en
            ? 'Used and reserved storage exceed capacity. Remove documents or expand storage before uploading.'
            : '已用与预占空间超过当前配额，请清理资料或扩容后再入库。'}
        </p>
      )}
    </section>
  )
}
