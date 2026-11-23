import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.use({ channel: 'chrome' })

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 960, height: 600 },
]) {
  for (const showBanner of [false, true]) {
    test(`knowledge scroll stays inside the panel at ${viewport.width}x${viewport.height}, banner=${showBanner}`, async ({
      page,
    }, testInfo) => {
      await page.route('**/*', (route) => route.abort())
      await page.setViewportSize(viewport)
      const styles = await Promise.all(
        [
          'packages/ui/src/tokens.css',
          'apps/shell/src/renderer/src/home.css',
          'apps/shell/src/renderer/src/tabbar.css',
          'apps/shell/src/renderer/src/knowledge.css',
        ].map((path) => readFile(resolve(path), 'utf8')),
      )
      const documents = Array.from(
        { length: 24 },
        (_, index) => `<li>
          <span>验证资料-${index + 1}.docx</span>
          <span>已入库</span>
          <button class="btn btn-secondary">删除资料</button>
        </li>`,
      ).join('')
      await page.setContent(`<!doctype html><html lang="zh-CN"><body>
        <div id="root"><div class="app-frame">
          <div class="tab-bar"><div class="tab-item tab-home active">方塘Office</div></div>
          <div class="app-frame-content"><div class="home">
            <aside class="sidebar">
              <nav class="sidebar-nav"><button class="nav-item active">知识库</button></nav>
              <div data-account style="margin-top:auto">测试账号</div>
            </aside>
            <div class="home-main">
              ${showBanner ? '<div class="low-balance-banner"><span class="low-balance-text">余额提醒</span></div>' : ''}
              <section class="knowledge-panel" aria-label="云端知识库">
                <header><div><h1>云端知识库</h1><p>管理你的知识资料</p></div><button>刷新</button></header>
                <section class="knowledge-wallet"><h2>知识资金</h2><p>余额、预留与可用资金</p></section>
                <div class="knowledge-toolbar"><label>知识空间<select><option>测试空间</option></select></label><button>上传资料</button></div>
                <form class="knowledge-toolbar"><label>空间名称<input></label><button>新建空间</button></form>
                <form class="knowledge-toolbar"><label>检索<input></label><button>检索</button></form>
                <p>已用 / 上限 — 资料：24 / 100</p>
                <ul class="knowledge-documents">${documents}</ul>
              </section>
            </div>
          </div></div>
        </div></div>
      </body></html>`)
      await page.addStyleTag({ content: styles.join('\n') })
      const panel = page.getByRole('region', { name: '云端知识库' })
      const chrome = page.locator('.tab-bar, .sidebar, [data-account]')
      const originalBounds = await chrome.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON()),
      )
      const pageSize = await page.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
      }))
      await page.screenshot({ path: testInfo.outputPath('knowledge-before-scroll.png') })
      expect(pageSize.height).toBeLessThanOrEqual(viewport.height)
      expect(pageSize.width).toBeLessThanOrEqual(viewport.width)

      await panel.hover()
      await page.mouse.wheel(0, 10_000)
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await expect(panel.locator('li').last()).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0)
      expect(
        await chrome.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().toJSON()),
        ),
      ).toEqual(originalBounds)
      if (showBanner) await expect(page.locator('.low-balance-banner')).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath('knowledge-after-scroll.png') })

      await page.mouse.wheel(0, -10_000)
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(0)
      await expect(panel.getByRole('heading', { name: '云端知识库' })).toBeInViewport()
    })
  }
}
