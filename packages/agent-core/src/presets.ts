import type { PresetSkillDef } from './preset'

/**
 * Cross-app feature toggles persisted in userData/ai-features.json (shared by
 * the shell settings pane and every editor's AI panel; channels
 * ai:get-features / ai:set-features).
 */
export interface AiFeatures {
  /** preset ids hidden from the chat picker (Settings → 技能) */
  disabledPresets?: string[]
}

/**
 * Compiled-in generation skills (内置技能), one catalog for every editor app.
 * The chat picker filters by `app`; the shell settings pane lists them all.
 * Playbooks are written in Chinese (the primary deployment locale) and lean
 * on each app's own agent tools — they constrain structure and style, never
 * invent new tool semantics.
 *
 * Docs presets are not compiled in: they load from markdown files
 * (resources/presets/docs/*.md, IT-editable; see composePresetCatalog).
 */
export const BUILTIN_PRESETS: readonly PresetSkillDef[] = [

  // ── Slides (方塘Office Slides, .pptx) ───────────────────────────────
  {
    id: 'slides-work-report',
    app: 'slides',
    name: '工作汇报',
    nameEn: 'Work report deck',
    description: '生成管理层汇报演示：成果量化、进展清晰、结论先行。',
    descriptionEn: 'Management-facing report deck with quantified results.',
    systemPrompt: `生成工作汇报演示时遵循：
1. 页面结构：封面（标题+汇报人+日期）→ 目录/摘要 → 核心成果页（KPI 用大数字呈现）→ 分项进展页（每页一个主题，结论作为页标题）→ 问题与求助页 → 下一步计划页 → 结尾页。
2. 每页内容服务于一个结论：页标题写判断句（如“Q3 营收完成年度目标的 82%”），正文只给支撑证据。
3. 数字必须来自用户材料，不得编造；缺失的数据用占位并注明。
4. 风格克制专业：深色或单色强调色，每页要点不超过 5 条，避免大段文字。
使用 plan_deck/generate_deck 工具驱动整套生成，图片优先用 image_search 的真实图片。`,
  },
  {
    id: 'slides-marketing-plan',
    app: 'slides',
    name: '营销方案',
    nameEn: 'Marketing plan deck',
    description: '生成营销方案演示：目标人群、策略、渠道与预算一目了然。',
    descriptionEn: 'Marketing plan deck: audience, strategy, channels, budget.',
    systemPrompt: `生成营销方案演示时遵循：
1. 页面结构：封面 → 项目背景与目标（量化目标）→ 目标人群画像 → 核心策略与卖点（一页一个核心信息）→ 渠道与执行排期 → 预算分配（可用图表）→ 效果衡量指标（KPI）→ 结尾页。
2. 卖点表达遵循“用户利益优先”：先说用户得到什么，再说功能支撑。
3. 预算与排期必须基于用户给定的数字或比例；未给出时给出建议结构并用占位标注待定数值。
4. 视觉：营销场景可适度使用大图与色块对比（image_search 找真实图片），但每页保留足够留白。
使用 plan_deck/generate_deck 驱动整套生成。`,
  },
  {
    id: 'slides-training',
    app: 'slides',
    name: '培训课件',
    nameEn: 'Training courseware',
    description: '生成结构化培训课件：目标、讲解、示例、练习与小结。',
    descriptionEn: 'Structured training deck with examples and exercises.',
    systemPrompt: `生成培训课件时遵循：
1. 页面结构：封面 → 培训目标（学完能做什么）→ 内容分章节（每章“讲解页 + 示例页”）→ 练习/思考题页 → 要点小结页 → Q&A 结尾页。
2. 讲解页一次只讲一个概念，用分步列表；示例页给出具体、可操作的示范（真实场景优先）。
3. 语言面向学员：多用主动句和“你/你们”，避免堆砌术语；术语首次出现给出通俗解释。
4. 内容必须基于用户提供的材料或通用的准确知识，不确定的专业内容标注“建议由讲师补充”。
使用 plan_deck/generate_deck 驱动整套生成。`,
  },

  // ── Sheets (方塘Office Sheets, .xlsx) ───────────────────────────────
  {
    id: 'sheets-data-analysis',
    app: 'sheets',
    name: '数据分析报表',
    nameEn: 'Data analysis report',
    description: '构建规范的数据分析报表：原始数据、指标计算与结论分表呈现。',
    descriptionEn: 'Structured analysis workbook: data, metrics and findings.',
    systemPrompt: `构建数据分析报表时遵循：
1. 工作簿结构：分三个工作表——“原始数据”（仅粘贴/录入数据，不加公式）、“分析计算”（指标、汇总，全部用公式引用原始数据，不写死数值）、“结论摘要”（关键发现与建议，3-5 条）。
2. 指标计算优先使用 SUMIF/SUMIFS/COUNTIF/AVERAGEIFS/透视口径的公式；表头加粗并冻结首行；金额类列使用千分位或货币格式。
3. 所有数值必须可追溯到原始数据；用户材料没有的数据不得编造，需要用户补充的以醒目的“【待填】”标注。
4. 结论必须引用具体数字，避免“有所提升”这类模糊表述。
优先使用 propose_operations 工具落地批量修改，并用 read_range 核对结果。`,
  },
  {
    id: 'sheets-finance-report',
    app: 'sheets',
    name: '财务报表模板',
    nameEn: 'Financial statement template',
    description: '搭建财务报表模板：收入成本、利润与预算对比，公式联动。',
    descriptionEn: 'Finance template with revenue/cost, profit and budget links.',
    systemPrompt: `搭建财务报表模板时遵循：
1. 工作簿结构：“参数假设”（汇率、税率、增长率等可调参数集中在此）、“月度明细”（12 个月列 + 合计列）、“汇总报表”（收入、成本、费用、利润的结构化报表，全部用公式引用明细与参数）。
2. 公式规范：合计用 SUM；利润 = 收入 − 成本 − 费用，勾稽关系必须成立；引用参数假设时用单元格绝对引用。
3. 格式规范：金额列千分位、负数红色或括号；表头加粗填充浅灰；百分比一位小数；冻结窗格。
4. 所有数字除用户给定外一律用公式驱动或留 0，不硬编码；在“参数假设”表首行注明“修改本表参数即可全表联动”。
使用 propose_operations 落地批量修改，并用 read_range 核对勾稽关系。`,
  },

  // ── PDF (方塘Office PDF) ───────────────────────────────────────────
  {
    id: 'pdf-summary',
    app: 'pdf',
    name: '总结摘要',
    nameEn: 'Summary & digest',
    description: '通读当前 PDF 并产出结构化摘要：要点、数据与待办。',
    descriptionEn: 'Read the PDF and produce a structured digest.',
    systemPrompt: `针对当前 PDF 生成总结摘要时遵循：
1. 先用 search_text/read_pages 通读全文再总结，引用结论时标注页码，格式 [p.N](pdfnav://page/N)。
2. 输出结构：一句话概述 → 核心要点（3-7 条，每条独立成立）→ 关键数据/名单/日期（列表）→ 需要阅读者注意或行动的事项。
3. 只总结文档真实内容，不做外部推测；文档中相互矛盾之处要指出。
4. 摘要直接以文本回复输出（PDF 场景默认不改动原文档）；用户明确要求写入批注时才使用 markup_text。`,
  },

  // ── Markdown (方塘Office Markdown) ─────────────────────────────────
  {
    id: 'markdown-tech-doc',
    app: 'markdown',
    name: '技术文档',
    nameEn: 'Technical documentation',
    description: '生成结构清晰的技术文档：概述、安装、用法、FAQ。',
    descriptionEn: 'Clear technical docs: overview, install, usage, FAQ.',
    systemPrompt: `生成技术文档时遵循：
1. 文档结构：一级标题（项目/主题名）→ 概述（一段话说清是什么、解决什么问题）→ 安装/前置条件 → 快速开始（最小可运行示例）→ 配置/用法详解（小节+代码块）→ 常见问题 FAQ → 参考链接。
2. 代码块标注语言；命令可复制执行；每个示例先给目的再给代码。
3. 语言简洁准确，避免营销词汇；版本号、路径等细节缺失时用占位并注明假设。
使用块级工具（insert_content/replace_blocks）落盘内容，保持 Markdown 语法合法。`,
  },
  {
    id: 'markdown-readme',
    app: 'markdown',
    name: '项目 README',
    nameEn: 'Project README',
    description: '生成标准开源风格 README：简介、特性、安装、使用、许可。',
    descriptionEn: 'Standard README: intro, features, install, usage, license.',
    systemPrompt: `生成项目 README 时遵循：
1. 结构：项目名 + 一句话简介 → Badges（可选）→ 特性列表（6 条以内，每条一行）→ 安装 → 快速上手（最小示例）→ 目录结构说明（可选）→ 配置项（表格）→ 开发/测试命令 → License。
2. 首屏三行内让读者明白项目是什么；命令统一放在可复制的代码块里。
3. 项目信息（名称、仓库、许可证）缺失时用占位并提醒补充，不编造链接。
使用块级工具（insert_content/replace_blocks）落盘内容。`,
  },
]

/** presets offered in one app's chat window, catalog order */
export function presetsForApp(app: string): PresetSkillDef[] {
  return BUILTIN_PRESETS.filter((preset) => preset.app === app)
}

/** Structural shape of a file-loaded preset (mirrors PresetFileDef in @genoffice/electron-utils). */
export interface PresetFileInput {
  app: string
  id: string
  name: string
  nameEn?: string
  description?: string
  descriptionEn?: string
  mcpServers?: string[]
  systemPrompt: string
}

function toDef(file: PresetFileInput): PresetSkillDef {
  return {
    id: file.id,
    app: file.app,
    name: file.name,
    ...(file.nameEn ? { nameEn: file.nameEn } : {}),
    ...(file.description ? { description: file.description } : {}),
    ...(file.descriptionEn ? { descriptionEn: file.descriptionEn } : {}),
    ...(file.mcpServers?.length ? { mcpServers: file.mcpServers } : {}),
    systemPrompt: file.systemPrompt,
  }
}

/**
 * Effective catalog = compiled-in presets with file-provided presets overlaid:
 * for each app, ANY file presets (bundled + userData merged by id) replace the
 * compiled-in entries wholesale, so updating presets is a pure file operation
 * (drop .md files into presets/<app>/, no code change).
 */
export function composePresetCatalog(
  builtin: readonly PresetSkillDef[],
  files: readonly PresetFileInput[],
): PresetSkillDef[] {
  const fileApps = new Set(files.map((f) => f.app))
  const out: PresetSkillDef[] = []
  for (const preset of builtin) {
    if (!fileApps.has(preset.app)) out.push(preset)
  }
  out.push(...files.map(toDef))
  return out
}
