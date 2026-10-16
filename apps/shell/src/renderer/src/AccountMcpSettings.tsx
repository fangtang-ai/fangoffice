import { useEffect, useState } from 'react'
import { useI18n } from './locale'
import type { AccountApi } from './use-account'
import { accountMcpInsufficientBalance } from './use-account'

export function useFangtangMcpSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let changed = false
    const unsubscribe = window.aiOffice.onFangtangMcpEnabledChanged((value) => {
      changed = true
      setEnabled(value)
      setFailed(false)
    })
    void window.aiOffice
      .getFangtangMcpEnabled()
      .then((value) => {
        if (alive && !changed) setEnabled(value)
      })
      .catch(() => {
        if (alive && !changed) setFailed(true)
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const save = async (value: boolean) => {
    if (saving || enabled === null) return
    setSaving(true)
    setFailed(false)
    try {
      setEnabled(await window.aiOffice.setFangtangMcpEnabled(value))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return { enabled, saving, failed, save }
}

export function AccountMcpSettings({ account }: { account: AccountApi }) {
  const { t } = useI18n()
  const setting = useFangtangMcpSetting()
  return (
    <>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('accountMcpEnabled')}</div>
            <div className="set-field-desc">{t('accountMcpDesc')}</div>
            {!account.loggedIn && <div className="set-field-desc">{t('accountMcpLoginHint')}</div>}
          </div>
        </div>
        <button
          className="set-switch"
          role="switch"
          aria-label={t('accountMcpEnabled')}
          aria-checked={setting.enabled === true}
          disabled={setting.enabled === null || setting.saving}
          onClick={() => void setting.save(!setting.enabled)}
        />
      </div>
      {setting.failed && (
        <p className="set-ai-note" role="alert">
          {t('accountMcpSettingFailed')}
        </p>
      )}
      <McpBalanceNotice account={account} enabled={setting.enabled} />
    </>
  )
}

function McpBalanceNotice({
  account,
  enabled,
  home = false,
}: {
  account: AccountApi
  enabled: boolean | null
  home?: boolean
}) {
  const { t } = useI18n()
  if (enabled !== true || !account.loggedIn || !accountMcpInsufficientBalance(account.usage))
    return null
  return (
    <div className={home ? 'low-balance-banner' : 'set-mcp-warning'} role="status">
      <span>{t('accountMcpInsufficient')}</span>
      <button
        className={home ? 'low-balance-btn' : 'set-btn'}
        onClick={() => account.recharge('policy_mcp')}
      >
        {t('accountRecharge')}
      </button>
    </div>
  )
}

export function AccountMcpBalanceBanner({ account }: { account: AccountApi }) {
  const { enabled } = useFangtangMcpSetting()
  return <McpBalanceNotice account={account} enabled={enabled} home />
}
