import { describe, expect, it } from 'vitest'
import { AiCreditsError } from '../src/protocols/shared'
import { throwIfCreditsNotice, throwSseError } from '../src/protocols/shared'

/** real-world gateway quota-rejection shapes (New API / one-api + Genspark) */
const QUOTA_BODIES = [
  // New API 403/429 JSON error body (zh)
  '{"error":{"message":"您的额度不足，请充值后重试","type":"new_api_error"}}',
  // New API in-stream SSE error event payload
  '{"error":{"message":"令牌额度已用尽","type":"one_api_error"}}',
  // English quota variants
  '{"error":{"message":"insufficient user quota. please recharge"}}',
  '{"error":{"message":"quota exceeded for this token"}}',
  // Genspark English credits notice (existing behavior, must keep working)
  '{"error":"Your Genspark credits have been exhausted. Visit https://www.genspark.ai/pricing"}',
]

const NON_QUOTA_ERRORS = [
  // must NOT match: unrelated gateway errors
  '{"error":{"message":"当前分组 default 下对于模型 gpt-4o 无可用渠道"}}',
  '{"error":{"message":"rate limit reached for requests"}}',
  '{"error":{"message":"upstream connect error"}}',
  '{"error":{"message":"额度查询成功，当前剩余充足"}}', // quota headroom notice — no exhaustion word, must not match
]

describe('credits notice classification', () => {
  for (const body of QUOTA_BODIES) {
    it(`classifies as AiCreditsError: ${body.slice(0, 60)}`, () => {
      expect(() => throwIfCreditsNotice(body)).toThrow(AiCreditsError)
      const payload = (JSON.parse(body) as { error: unknown }).error
      expect(() => throwSseError(payload, 'fallback')).toThrow(AiCreditsError)
    })
  }

  for (const body of NON_QUOTA_ERRORS) {
    it(`stays a generic error: ${body.slice(0, 60)}`, () => {
      expect(() => throwIfCreditsNotice(body)).not.toThrow(AiCreditsError)
      const payload = (JSON.parse(body) as { error: unknown }).error
      try {
        throwSseError(payload, 'fallback')
      } catch (err) {
        expect(err).not.toBeInstanceOf(AiCreditsError)
      }
    })
  }

  it('throwSseError keeps the sseErrorText fallback behavior', () => {
    expect(() => throwSseError(undefined, 'Model stream error')).toThrow('Model stream error')
    expect(() => throwSseError('plain string error', 'fallback')).toThrow('plain string error')
    expect(() => throwSseError({ code: 42 }, 'fallback')).toThrow('{"code":42}')
  })

  it('throwIfCreditsNotice ignores unparseable bodies', () => {
    expect(() => throwIfCreditsNotice('<html>gateway error page</html>')).not.toThrow()
  })

  it('the typed notice carries the original message text', () => {
    const body = '{"error":{"message":"您的额度不足，请充值后重试"}}'
    try {
      throwIfCreditsNotice(body)
      expect.unreachable()
    } catch (err) {
      expect((err as AiCreditsError).message).toBe('您的额度不足，请充值后重试')
    }
  })
})
