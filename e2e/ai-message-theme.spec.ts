import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.use({ channel: 'chrome', viewport: { width: 640, height: 360 } })

const themes = [
  { name: 'light', theme: 'light', system: 'dark' },
  { name: 'dark', theme: 'dark', system: 'light' },
  { name: 'system-light', theme: null, system: 'light' },
  { name: 'system-dark', theme: null, system: 'dark' },
] as const

function rgb(color: string) {
  const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  if (!channels) throw new Error(`Expected an opaque RGB color, got ${color}`)
  return { red: Number(channels[1]), green: Number(channels[2]), blue: Number(channels[3]) }
}

function luminance(color: string) {
  const { red, green, blue } = rgb(color)
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

for (const module of ['docs', 'sheets', 'slides', 'pdf', 'markdown']) {
  for (const theme of themes) {
    test(`${module} ${theme.name}: user messages stand out from AI text`, async ({
      page,
    }, testInfo) => {
      await page.route('**/*', (route) => route.abort())
      await page.emulateMedia({ colorScheme: theme.system })
      const [tokens, styles] = await Promise.all([
        readFile(resolve('packages/ui/src/tokens.css'), 'utf8'),
        readFile(resolve(`apps/${module}/src/renderer/styles.css`), 'utf8'),
      ])
      await page.setContent(`<!doctype html><html${theme.theme ? ` data-theme="${theme.theme}"` : ''}>
        <body><main style="background:var(--color-bg-page);padding:24px;width:360px">
          <section style="display:flex;flex-direction:column;gap:20px">
            <div class="ai-msg ai-msg-user">帮我写一份项目周报</div>
            <div class="ai-msg ai-msg-assistant">好的，以下是为你整理的项目周报。</div>
          </section>
        </main></body></html>`)
      await page.addStyleTag({ content: `${tokens}\n${styles}` })
      const user = await page.locator('.ai-msg-user').evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor,
          text: style.color,
          border: style.borderTopColor,
          borderStyle: style.borderTopStyle,
          alignment: style.alignSelf,
        }
      })
      const assistant = await page.locator('.ai-msg-assistant').evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, borderStyle: style.borderTopStyle }
      })
      expect(user.borderStyle).toBe('solid')
      expect(user.border).not.toBe(user.background)
      const background = rgb(user.background)
      expect(background.blue - background.red).toBeGreaterThan(15)
      const contrast =
        (Math.max(luminance(user.text), luminance(user.background)) + 0.05) /
        (Math.min(luminance(user.text), luminance(user.background)) + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      expect(user.alignment).toBe('flex-end')
      expect(assistant.background).toBe('rgba(0, 0, 0, 0)')
      expect(assistant.borderStyle).toBe('none')
      await expect(page.locator('.ai-msg-user')).toBeVisible()
      if (module === 'docs' && theme.theme) {
        await page.screenshot({ path: testInfo.outputPath(`user-message-${theme.name}.png`) })
      }
    })
  }
}
