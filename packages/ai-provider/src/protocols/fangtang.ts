import type { AgentMessage } from '@genoffice/agent-core'
import { aiFetch } from '../fetch'
import { httpBodyDetail } from '../http-error'
import type { AiChatResponse, AiProviderConfig } from '../types'
import { createStreamWatchdog, type StreamWatchdog } from '../watchdog'
import { creditsNoticeText, sseErrorText, sseLines, type StreamCallbacks } from './shared'
import { AiCreditsError } from './shared'

/**
 * 方塘站点计费代理（POST /api/office/ai/chat）：一条私有的 SSE 契约——
 * {type:'meta',requestId,model} → {type:'delta',content}* → {type:'usage',…}
 * → {type:'charge',amountFen,…} → {type:'done',requestId}；失败时是
 * {type:'error',code,message}。登录用户的 Logto access token 就是 apiKey，
 * 站点按额度扣费；meta/usage/charge 是计费记账，对编辑器会话没有意义，
 * 不透传。
 */

/** the proxy only carries plain chat text; stringify anything odd (tool results) */
function stringifyContent(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** site contract: capability + flat message list (system folded in first) */
function siteMessages(system: string, messages: AgentMessage[]): Array<{ role: string; content: string }> {
  const out = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: stringifyContent(m.text) })
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: stringifyContent(m.text) })
    else for (const r of m.results) out.push({ role: 'tool', content: stringifyContent(r.output) })
  }
  return out
}

/**
 * The site reports money problems two ways: before the SSE starts (HTTP 400,
 * {message:'余额不足'}) and in-band as a typed error event. Both surface as
 * AiCreditsError so the apps show the localized top-up hint (errorCode
 * 'credits') instead of a generic failure; a wrapped upstream quota notice
 * rides through creditsNoticeText.
 */
function fangtangError(code: unknown, message: unknown, fallback: string): Error {
  const text = sseErrorText(message, fallback)
  const balance =
    (typeof code === 'string' && /^(credits?|insufficient)/i.test(code)) ||
    /余额不足|insufficient/i.test(text) ||
    creditsNoticeText(message) !== null
  return balance ? new AiCreditsError(text) : new Error(text)
}

export async function streamFangtang(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  cb: StreamCallbacks,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(() => fangtangTurn(baseUrl, config, system, messages, cb, wd))
}

async function fangtangTurn(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  cb: StreamCallbacks,
  wd: StreamWatchdog,
): Promise<void> {
  const onBytes = () => {
    wd.touch()
    cb.onActivity?.()
  }
  // one id per call: the site replays a settled charge record instead of
  // double-billing when the same key is retried, so it must survive any
  // later retry of THIS request — generated here, once.
  const idempotencyKey = crypto.randomUUID()
  const response = await aiFetch(baseUrl.replace(/\/+$/, ''), {
    method: 'POST',
    signal: wd.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      capability: 'chat',
      messages: siteMessages(system, messages),
    }),
  })
  // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
  onBytes()
  if (!response.ok || !response.body) {
    const bodyText = await response.text()
    let code: unknown
    let message: unknown
    try {
      ;({ code, message } = JSON.parse(bodyText) as { code?: unknown; message?: unknown })
    } catch {
      /* not JSON — httpBodyDetail handles markup/plain text */
    }
    throw fangtangError(code, message, `HTTP ${response.status}: ${httpBodyDetail(bodyText)}`)
  }
  let emitted = false
  let sawDone = false
  for await (const line of sseLines(response.body, onBytes)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    let event: { type?: unknown; content?: unknown; code?: unknown; message?: unknown }
    try {
      event = JSON.parse(payload)
    } catch {
      continue // truncated frame / comment keep-alive: skip, don't kill the turn
    }
    switch (event.type) {
      case 'delta':
        if (typeof event.content === 'string' && event.content) {
          emitted = true
          cb.onDelta(event.content)
        }
        break
      case 'done':
        sawDone = true
        break
      case 'error':
        throw fangtangError(event.code, event.message, '方塘 AI 请求失败')
      default:
        break // meta / usage / charge: billing bookkeeping, nothing to stream
    }
  }
  if (!emitted && !sawDone) throw new Error('方塘 AI returned no content (empty stream)')
}

/** one-shot (non-tool) chat over the billing proxy: fold the SSE deltas into a reply */
export async function chatFangtang(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  user: string,
): Promise<AiChatResponse> {
  let content = ''
  try {
    await streamFangtang(baseUrl, config, system, [{ role: 'user', text: user }], {
      onDelta: (text) => {
        content += text
      },
      onToolCall: () => undefined,
      signal: new AbortController().signal,
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!content) return { ok: false, error: '方塘 AI returned an empty response' }
  return { ok: true, content }
}
