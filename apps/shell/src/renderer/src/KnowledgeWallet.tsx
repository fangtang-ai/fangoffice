import type { AccountUsage } from '../../shared/home-api'
import { knowledgeText } from './knowledge-text'

function amountText(value: unknown) {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(value) ? value : null
}

function readWallet(usage: AccountUsage | null) {
  const value = usage?.knowledge
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const wallet = value as Record<string, unknown>
  const balance = amountText(wallet.balanceCny)
  const reserved = amountText(wallet.reservedCny)
  const available = amountText(wallet.availableCny)
  const queryReserve = amountText(wallet.queryReserveCny)
  if (
    wallet.product !== 'knowledge_base' ||
    typeof wallet.available !== 'boolean' ||
    (wallet.walletStatus !== 'opened' && wallet.walletStatus !== 'not_opened') ||
    balance === null ||
    reserved === null ||
    available === null ||
    (wallet.available &&
      (wallet.unavailableReason !== null || queryReserve === null || queryReserve === '0.00')) ||
    (!wallet.available &&
      wallet.unavailableReason !== 'not_configured' &&
      wallet.unavailableReason !== 'access_denied')
  )
    return null
  return {
    balance,
    reserved,
    available,
    queryReserve,
    enabled: wallet.available,
    opened: wallet.walletStatus === 'opened',
  }
}

export function KnowledgeWallet({
  usage,
  language,
}: {
  usage: AccountUsage | null
  language: string
}) {
  const text = knowledgeText(language)
  const wallet = readWallet(usage)
  const insufficient =
    wallet?.enabled &&
    wallet.queryReserve !== null &&
    BigInt(wallet.available.replace('.', '')) < BigInt(wallet.queryReserve.replace('.', ''))
  return (
    <aside className="knowledge-wallet" data-knowledge-wallet aria-label={text.walletTitle}>
      <h2>{text.walletTitle}</h2>
      {!wallet ? (
        <p role="status">{text.walletUnknown}</p>
      ) : (
        <>
          <p role="status">{wallet.enabled ? text.walletConfigured : text.walletDisabled}</p>
          {!wallet.opened && <p>{text.walletNotOpened}</p>}
          <dl>
            <div>
              <dt>{text.walletBalance}</dt>
              <dd>¥{wallet.balance}</dd>
            </div>
            <div>
              <dt>{text.walletReserved}</dt>
              <dd>¥{wallet.reserved}</dd>
            </div>
            <div>
              <dt>{text.walletAvailable}</dt>
              <dd>¥{wallet.available}</dd>
            </div>
            {wallet.enabled && wallet.queryReserve !== null && (
              <div>
                <dt>{text.walletQueryReserve}</dt>
                <dd>¥{wallet.queryReserve}</dd>
              </div>
            )}
          </dl>
          {insufficient && <p role="status">{text.walletInsufficient}</p>}
        </>
      )}
      <p>{text.walletNote}</p>
    </aside>
  )
}
