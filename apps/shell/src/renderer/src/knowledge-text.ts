import type { KnowledgeOperation } from '../../shared/knowledge-api'

const zh = {
  title: '云端知识库',
  login: '登录后查看云端知识库',
  signIn: '登录',
  description:
    '支持 TXT / Markdown（UTF-8）、DOCX 和文字 PDF，单文件最多 8 MiB；扫描 PDF 暂不支持 OCR。入库完成后可检索来源。',
  notConfigured: '知识库权益或服务尚未配置，请联系管理员完成开通。',
  failed: '知识库请求未完成，请重试。',
  refresh: '刷新',
  loading: '正在读取…',
  space: '知识空间',
  emptySpaces: '暂无知识空间',
  emptyDocuments: '此空间暂无资料',
  upload: '上传资料',
  pending: '尚未入库',
  ready: '已入库',
  working: '处理中…',
  progress: '入库进度',
  quota: '已用 / 上限',
  files: '资料',
  bytes: '字节',
  reserved: '已预留',
  create: '新建空间',
  spaceTitle: '空间名称',
  inspect: '刷新进度',
  search: '检索',
  viewSource: '查看来源',
  sourcePart: '来源片段',
  deleteDocument: '删除资料',
  confirmDeletion: '确认删除结果',
  deleting: '正在删除，尚未确认完成。',
  deleted: '已删除（逻辑删除已确认）。',
  deletionUnknown: '删除结果未确认，可能已受理；请刷新或确认原删除意图，不要当作尚未删除。',
  deletionPending: '删除待确认',
  deletionNote: '不代表物理文件已清除或费用已退款。',
  readOnly: '当前账号不能创建空间或上传资料；仍可查看或删除已有资料。',
  moreDocuments: '加载更多资料',
  moreSpaces: '加载更多空间',
  walletTitle: '知识资金',
  walletUnknown: '暂未获取知识资金状态，不使用 AI/MCP 余额替代。',
  walletConfigured: '知识预算已配置；不代表云端服务实时可用。',
  walletDisabled: '知识预算尚未开通或配置不完整，请联系管理员。',
  walletNotOpened: '知识钱包尚未开户；查看账户不会自动开户。',
  walletBalance: '总余额',
  walletReserved: '预占款',
  walletAvailable: '可用余额',
  walletQueryReserve: '单次查询预留上限',
  walletInsufficient: '知识可用余额不足以预留一次查询，请查看知识库充值页。',
  walletRecharge: '知识库明细与充值',
  walletRechargeFailed: '暂时无法打开充值页，请稍后重试。',
  walletNote:
    '知识资金不与 AI/MCP 互通；预占不等于已收费。文档入库按块数另行预留，容量与服务状态分别校验。',
}
const en = {
  title: 'Cloud knowledge',
  login: 'Sign in to view cloud knowledge',
  signIn: 'Sign in',
  description:
    'Upload UTF-8 TXT / Markdown, DOCX or text-based PDF (up to 8 MiB per file). Scanned PDFs require OCR, which is not supported yet. Search becomes available after indexing.',
  notConfigured: 'Knowledge access or service is not configured. Contact your administrator.',
  failed: 'The knowledge request did not complete. Please retry.',
  refresh: 'Refresh',
  loading: 'Loading…',
  space: 'Knowledge space',
  emptySpaces: 'No knowledge spaces yet',
  emptyDocuments: 'No documents in this space',
  upload: 'Upload document',
  pending: 'Not indexed',
  ready: 'Indexed',
  working: 'Working…',
  progress: 'Processing status',
  quota: 'Used / limit',
  files: 'Files',
  bytes: 'Bytes',
  reserved: 'Reserved',
  create: 'Create space',
  spaceTitle: 'Space name',
  inspect: 'Refresh status',
  search: 'Search',
  viewSource: 'View source',
  sourcePart: 'Source passage',
  deleteDocument: 'Delete document',
  confirmDeletion: 'Confirm deletion result',
  deleting: 'Deletion is pending; completion is not confirmed.',
  deleted: 'Deleted (logical deletion confirmed).',
  deletionUnknown:
    'Deletion is unconfirmed and may have been accepted. Refresh or confirm the original intent; do not assume it never started.',
  deletionPending: 'Deletion unconfirmed',
  deletionNote: 'This does not confirm physical file cleanup or a refund.',
  readOnly:
    'Creating spaces and uploading files are disabled. Existing documents can still be viewed or deleted.',
  moreDocuments: 'Load more documents',
  moreSpaces: 'Load more spaces',
  walletTitle: 'Knowledge funds',
  walletRecharge: 'Knowledge usage and recharge',
  walletRechargeFailed: 'Could not open recharge. Please try again.',
  walletUnknown: 'Knowledge funds are not available yet. AI/MCP balances are not a substitute.',
  walletConfigured:
    'Knowledge budget is configured; this is not a live cloud-service health check.',
  walletDisabled:
    'Knowledge budget is not enabled or fully configured. Contact your administrator.',
  walletNotOpened: 'The knowledge wallet has not been opened. Viewing an account does not open it.',
  walletBalance: 'Total balance',
  walletReserved: 'Held funds',
  walletAvailable: 'Available funds',
  walletQueryReserve: 'Maximum hold per query',
  walletInsufficient:
    'Available knowledge funds cannot cover one query hold. Contact your administrator.',
  walletNote:
    'Knowledge funds are separate from AI/MCP. Holds are not charges. Document holds depend on chunk count; capacity and service status are checked separately.',
} satisfies Record<keyof typeof zh, string>

export function knowledgeText(language: string) {
  return language.startsWith('zh') ? zh : en
}

const phases = {
  uploading: ['正在上传', 'Uploading'],
  queued: ['等待处理', 'Queued'],
  parsing: ['正在解析', 'Parsing'],
  indexing: ['正在建立索引', 'Indexing'],
  publishing: ['正在发布', 'Publishing'],
  ready: ['已入库', 'Indexed'],
  failed: ['入库失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
  deleting: ['正在删除', 'Deleting'],
  deleted: ['已删除', 'Deleted'],
} satisfies Record<KnowledgeOperation['phase'], [string, string]>

export function knowledgeOperationText(phase: KnowledgeOperation['phase'], language: string) {
  return phases[phase][language.startsWith('zh') ? 0 : 1]
}
