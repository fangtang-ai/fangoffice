# 方塘Office

**方塘Office — 开箱即用的 AI 办公套件（基于开源 GenOffice 项目定制的内部商业版本）。**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[公司官网](https://fang-tang.cn) · [隐私说明](PRIVACY.md)

方塘Office 是一套面向企业内部部署的 AI 办公套件，覆盖 macOS、Windows 与
Linux。它以真实 Microsoft Office 格式为核心 —— Word（`.docx`）、Excel
（`.xlsx`）、PowerPoint（`.pptx`）—— 同时支持编辑 PDF 与
Markdown：文字处理、电子表格、演示文稿、PDF 编辑器和 Markdown 编辑器，
以一个 Electron 外壳（shell）承载全部编辑器，共享同一套引擎层。

## Features

- **Real PDF editing** — retype text and edit images in the page itself, original fonts preserved.
- **Local PDF → Word / PowerPoint / Excel conversion** — turn a PDF into an editable `.docx`, `.pptx`, or `.xlsx` entirely on your machine: no cloud, no upload.
- **Scanned PDFs too** — on macOS and Windows scanned pages are read with the system OCR, so they convert to editable text.
- **Microsoft Word–compatible, byte-preserving `.docx` editing** — only what you touched changes; Word never notices.
- **Word-faithful pagination** — page breaks land where Word puts them.
- **Excel-compatible spreadsheets** — in-house engine with a Rust `.xlsx` sidecar, own charts, pivot tables, slicers.
- **PowerPoint-compatible presentations** — in-house `.pptx` engine with masters, layouts, smart guides, non-destructive crop.
- **Markdown to Word, fully local** — the same OOXML engine, no Pandoc, no cloud.
- **AI that edits documents** — block-level edits with snapshots and diffs, document-aware agents.
- **内置生成技能（built-in skills）** — 每个编辑器的 AI 对话窗口可一键选用内置文档生成技能（周报、会议纪要、合同、工作汇报、数据分析报表等），由内置提示词 playbook 驱动。
- **内置 MCP 服务器** — 通过部署配置文件接入企业内部 MCP 工具，AI 技能可直接调用内部系统能力。
- **AI 部署即配置** — IT 通过 `fangtang-defaults.json` 预配置企业大模型接入点（OpenAI 兼容网关、Claude、GLM、DeepSeek 等），员工开箱即用，无需注册任何账号。
- **Light / dark / system themes.**
- **macOS, Windows, Linux.**

## Apps

| App             | Product        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs`     | **方塘Office Docs**     | `.docx` word processor. Byte-preserving round trip: only dirty paragraphs are regenerated (paragraph patch), everything else in the original file is kept byte-for-byte, so opening and saving never breaks layout in Word. Paginated view whose line metrics reproduce the original document's layout, tracked changes, comments, styles, equations, ink.                                                                                                               |
| `apps/sheets`   | **方塘Office Sheets**   | `.xlsx` spreadsheet. UI built on the open-source [Univer](https://github.com/dream-num/univer) core (Apache-2.0) with a large layer of in-house extensions; `.xlsx` import/export runs through an in-house Rust sidecar (calamine + IronCalc), charts are rendered in-house (Konva), plus pivot tables, slicers, conditional formatting, and formula tracing.                                                                                                         |
| `apps/slides`   | **方塘Office Slides**   | `.pptx` presentations. In-house `.pptx` parse/render/edit engine with masters, charts, cropping, ink, and text shaping (HarfBuzz metrics).                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/pdf`      | **方塘Office PDF**      | `.pdf` viewer/editor on [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) + [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT): annotations, forms, outlines, stamps, signatures, page operations, and printing support. True text editing — paragraph selection with in-block reflow, alignment restoration, original-font preservation — and content-stream image insert/edit, all rewriting page content streams through [PDFium](https://pdfium.googlesource.com/pdfium/) wasm (BSD-3-Clause) with subset-embedded fonts. Converts PDFs into editable Word, PowerPoint, and Excel files fully locally (`packages/pdf2docx`), with OCR support for scanned pages (system OCR on macOS and Windows). |
| `apps/markdown` | **方塘Office Markdown** | `.md` / `.markdown` editor: Tiptap block editor over plain Markdown files — headings, lists, tables, images, code blocks — saved back as plain Markdown, hosted in shell tabs.                                                                                                                                                                                                                                                                                                                                        |
| `apps/shell`    | **方塘Office**          | The suite shell: home screen, tabbed hosting of the five editors, light/dark/system theme.                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every app embeds the same AI panel: block-granular AI editing with version
snapshots and diffs in docs, a tool-calling agent over workbook/slide/PDF
state in the others.

**AI backends — company endpoint out of the box, BYOK for everything else.**
There is no account system: IT preconfigures the company LLM endpoint in
`resources/fangtang-defaults.json` (or via `FANGTANG_AI_*` environment
variables), and every AI panel works immediately. Employees can switch to any
built-in provider in Settings → AI Model: Claude, OpenAI, Gemini, DeepSeek,
Kimi, GLM, Qwen, Doubao, MiniMax, Grok, Mistral, OpenRouter, OpenCode Zen/Go,
or any OpenAI-compatible endpoint (base URL + key) — local model servers
included.

**Built-in generation skills.** Each app's AI chat window carries a 技能
(skills) picker with curated Chinese business playbooks — 周报 / 会议纪要 /
合同 / 通知公告 for Docs, 工作汇报 / 营销方案 / 培训课件 for Slides, 数据分析
报表 / 财务报表模板 for Sheets, 技术文档 / README for Markdown, 总结摘要 for
PDF. Administrators can enable/disable presets per app in Settings → 技能.

**Built-in MCP servers.** Administrators register internal tool servers in
`resources/fangtang-mcp.json` (stdio or streamable HTTP). Tools from servers
marked `alwaysAvailable` join every chat; otherwise a preset skill declares
the servers it uses via `mcpServers`, and those tools join the conversation
only while that skill is selected.

## Engine packages

All pure TypeScript, no Electron dependency, unit-tested (except the UI kit):

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/pdf2docx` — local PDF → DOCX conversion: PDFium character-level
  extraction, pure-geometry layout analysis, rebuild through `docx-engine`;
  the same analysis drives the PDF app's PowerPoint and Excel exports.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` — provider abstraction and streaming for the model
  backends.
- `packages/ai-search` — web/image search tools (Serper / Tavily /
  DuckDuckGo).
- `packages/mcp-bridge` — MCP client bridge (stdio + streamable HTTP) that
  exposes built-in MCP tools to the agent.
- `packages/i18n`, `packages/ui`, `packages/project-store`,
  `packages/electron-utils` — shared i18n core, React UI kit, recent-files
  store, and Electron main-process helpers.

## Development

```bash
npm install
npm run fixtures     # generate test .docx fixtures
npm test             # engine + app unit tests (docs/sheets/slides need no display)
npm run typecheck    # tsc --noEmit across every workspace
npm run dev          # all five editors + shell against Vite dev servers
npm run dev:docs     # a single app (same pattern works per workspace)
npm run dist:mac     # package macOS dmg (regenerates third-party notices)
npm run dist:win     # package Windows nsis installer
npm run dist:linux   # package Linux AppImage + deb + rpm
```

The sheets app additionally needs a Rust toolchain for its xlsx sidecar
(`cargo` on PATH); `npm run build -w @genoffice/sheets` compiles it
automatically.

## 部署配置指南（IT）

应用启动时读取三类配置：**环境变量**、**出厂配置文件**（随安装包内置）、**用户级覆盖**（每台机器的 userData 目录）。所有密钥严禁写入本仓库——仓库里的模板只含空值，真实值通过环境变量、`.local.json` 或 userData 注入。

### 1. 文件位置

| 场景 | 位置 |
| --- | --- |
| 仓库（开发/构建源） | `apps/shell/resources/`（提交空模板；`*.local.json` 已被 .gitignore 忽略） |
| 安装后（Windows） | `安装目录\resources\` |
| 安装后（macOS） | `方塘Office.app/Contents/Resources/` |
| 用户级覆盖（无需管理员/重打包） | `userData/fangtang-mcp.json`、`userData/presets/<app>/*.md` |

读取优先级：

- **AI 端点**：环境变量 `FANGTANG_AI_*`（逐字段） > `fangtang-defaults.local.json` > `fangtang-defaults.json`
- **搜索 key**：环境变量 `SERPER_API_KEY` / `TAVILY_API_KEY` > 配置文件对应字段
- **MCP 服务器**：`userData/fangtang-mcp.json` 同名服务器整体覆盖内置配置；所有字符串字段支持 `${VAR}` 环境变量展开
- **技能**：`userData/presets/<app>/*.md` 按 id 覆盖内置；某应用目录存在任意 `.md` 时整体替换该应用内置技能

### 2. 环境变量

| 变量 | 作用 |
| --- | --- |
| `FANGTANG_AI_PROVIDER` | 覆盖出厂 provider（`custom`/`anthropic`/`gemini`/`deepseek`/`openai`/`kimi`/`glm`/`qwen`/`doubao`/`minimax`/`xai`/`mistral`/`openrouter`/`opencode-zen`/`opencode-go`） |
| `FANGTANG_AI_BASE_URL` | 覆盖端点地址（`custom` 必填，其他 provider 可用于区域镜像） |
| `FANGTANG_AI_API_KEY` | 覆盖 API Key |
| `FANGTANG_AI_MODEL` | 覆盖默认模型 |
| `SERPER_API_KEY` | 联网/图片搜索用 Serper（Google 结果，推荐） |
| `TAVILY_API_KEY` | 联网搜索用 Tavily；两者都不配时回退免 key DuckDuckGo |
| `FANGTANG_UPDATE_URL` | 自动更新源（HTTPS 前缀）；不设则关闭自动更新 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 主进程出网代理（访问境外 LLM/搜索 API 时需要） |
| `FANGTANG_USER_DATA` | （开发调试）指定独立的 userData 目录 |
| `FANGTANG_LANG` | （开发调试）强制 UI 语言 |

Windows 批量设置示例（登录脚本 / setx）：

```bat
setx FANGTANG_AI_PROVIDER "custom"
setx FANGTANG_AI_BASE_URL "https://llm-gateway.company.internal/compatible-mode/v1"
setx FANGTANG_AI_API_KEY "sk-xxxx"
setx FANGTANG_AI_MODEL "qwen3.8-max"
setx SERPER_API_KEY "xxxxxxxx"
```

macOS/Linux（launchd / systemd / shell profile）同名变量，按各环境标准方式设置即可。

### 3. `fangtang-defaults.json`（出厂 AI 端点）

仓库模板只含空值。IT 有两种注入方式——**方式 A（推荐）**：只设环境变量，文件保持空模板；**方式 B**：编辑安装目录里的 `fangtang-defaults.json`（或同目录放 `fangtang-defaults.local.json`，该文件优先且不入库），完整示例：

```json
{
  "provider": "custom",
  "baseUrl": "https://llm-gateway.company.internal/compatible-mode/v1",
  "apiKey": "sk-xxxx",
  "model": "qwen3.8-max",
  "maxOutputTokens": 32768,
  "serperApiKey": "xxxxxxxx",
  "tavilyApiKey": ""
}
```

字段说明：`provider` 见上表（`custom` = 任意 OpenAI 兼容接口，必须配 `baseUrl`；其余 provider 有官方默认端点，`baseUrl` 留空即可）；`maxOutputTokens` 为单轮输出上限（缺省 32768，推理模型建议保持默认以上）。**⚠️ 密钥不要写进仓库里的模板文件**——本机调试可用 `.local.json`（不入库），员工机器用环境变量。

### 4. `fangtang-mcp.json`（内置 MCP 服务器）

每个服务器一个键；支持 `stdio`（本地命令）与 `http`（远程流式 HTTP）。`${VAR}` 会被启动时的进程环境变量替换（未知变量展开为空），密钥通过环境注入：

```json
{
  "mcpServers": {
    "wiki": {
      "transport": "http",
      "url": "https://wiki.internal.company.cn/mcp",
      "headers": { "Authorization": "Bearer ${MCP_WIKI_TOKEN}" },
      "alwaysAvailable": true,
      "timeoutMs": 30000
    },
    "erp": {
      "transport": "stdio",
      "command": "C:\\it\\erp-mcp\\erp-mcp.exe",
      "args": ["--mode", "cli", "--token", "${ERP_TOKEN}"],
      "env": { "ERP_BASE": "https://erp.internal.company.cn" },
      "enabled": true
    }
  }
}
```

字段说明：`enabled: false` 停用；`alwaysAvailable: true` 时该服务器工具进入所有 AI 会话，否则仅当所选技能的 `mcpServers` 声明引用时进入；`timeoutMs` 为单次工具调用超时（缺省 30000）。IT 设置 `MCP_WIKI_TOKEN`、`ERP_TOKEN` 等环境变量即可完成鉴权注入。

### 5. 内置生成技能（presets）

每个技能一个 markdown 文件，按编辑器应用分目录：`presets/<app>/<技能>.md`（`docs` / `sheets` / `slides` / `pdf` / `markdown`）。可选 frontmatter 携带元数据，其余正文为所选技能注入 AI 对话 system prompt 的执行手册（playbook）：

```markdown
---
id: docs-fangtang-gongwen
name: 方塘公文写作
nameEn: FangTang official-document writing
description: 党政机关公文/总结/述职/讲话稿写作
mcpServers: erp, wiki        # 可选：该技能可调用的内置 MCP 服务器
---

<执行手册：角色、结构、文风与交互规则>
```

无 frontmatter 时，文件名（去 `.md`）即 id 与显示名。某应用目录存在任意 `.md` 文件时整体替换该应用内置技能；`userData/presets/<app>/*.md` 按 id 覆盖/新增，无需重打包。各应用的启用/停用开关在 设置 → 技能。

## FAQ

**Is 方塘Office free?**
The upstream project is open-source under the Apache-2.0 license. This fork
is prepared for internal business deployment — see LICENSE.

**Can 方塘Office open Microsoft Word, Excel, and PowerPoint files?**
Yes. 方塘Office opens and saves native `.docx`, `.xlsx`, and `.pptx` files.
Saving is byte-preserving: parts of the file you didn't touch are written
back byte-for-byte, so documents keep working in Microsoft Office.

**Does 方塘Office work offline?**
Document editing is fully local — files never leave your machine to be
opened, edited, or saved. The AI features need a network connection to the
configured model endpoint (or a local model server).

**Can 方塘Office edit PDF files?**
Yes — real PDF text and image editing that rewrites the page content stream
with the original fonts preserved, not cover-up annotations.

**Can 方塘Office convert PDF to Word, Excel, or PowerPoint?**
Yes — 方塘Office converts PDFs into editable `.docx`, `.xlsx`, and `.pptx`
files entirely on-device: PDFium character-level extraction plus
geometry-based layout analysis, no cloud service, no upload. Scanned pages are
covered too — on macOS and Windows the system OCR reads them, so they convert
to editable text rather than a page image.

**Which AI models can I use?**
Any built-in provider (Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Qwen,
Doubao, MiniMax, Grok, Mistral, OpenRouter, OpenCode Zen/Go) or any
OpenAI-compatible endpoint — including local model servers. The company
endpoint arrives preconfigured.

**Does 方塘Office collect any data?**
No. This build ships without analytics keys and the telemetry client stays a
no-op.

## Security

See [SECURITY.md](SECURITY.md) for the process security posture (renderer
sandboxing, IPC validation, external-link gating) and the threat models for
AI-generated content.

## Acknowledgements

方塘Office (and upstream GenOffice) would not be possible without these
open-source projects:

- [Electron](https://www.electronjs.org/) — the desktop runtime for every app.
- [Univer](https://github.com/dream-num/univer) (Apache-2.0) — the spreadsheet
  UI core that Sheets extends.
- [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause, bundled via
  [@embedpdf/pdfium](https://github.com/embedpdf/embed-pdf-viewer)) — the
  content-stream engine behind true PDF text and image editing.
- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and
  [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) — PDF rendering and
  document assembly.
- [Tiptap](https://tiptap.dev/) / [ProseMirror](https://prosemirror.net/) —
  the block editors in Docs and Markdown.
- [Konva](https://konvajs.org/) — canvas rendering for Slides and Sheets
  charts.
- [HarfBuzz](https://github.com/harfbuzz/harfbuzz) (wasm) — text-shaping
  metrics for complex scripts.
- [calamine](https://github.com/tafia/calamine) and
  [IronCalc](https://github.com/ironcalc/IronCalc) — the read and calc layers
  of the Rust xlsx sidecar.
- [Model Context Protocol](https://modelcontextprotocol.io) SDK — MCP client
  transports for the built-in tool bridge.
- Liberation, Carlito, Caladea, and Noto CJK fonts (OFL/Apache-2.0) — bundled
  document fonts.

## Third-party notices

`npm run notices` regenerates the bundled third-party license summary
(`tools/gen-third-party-notices.mjs`); all runtime dependencies are
MIT/Apache-2.0/BSD-3-Clause/OFL, and the bundled fonts (Liberation, Carlito,
Caladea, Noto CJK subsets) are OFL/Apache.

## License

This fork inherits the upstream [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for enterprise modules and is
covered by the [GenOffice Enterprise License](ee/LICENSE). The GenOffice name
is a trademark of Mainfunc, Inc. — this distribution is branded 方塘Office.
