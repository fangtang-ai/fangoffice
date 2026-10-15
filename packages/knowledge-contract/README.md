# 私人知识库共享契约（A2 / A3 / A4）

`@genoffice/knowledge-contract` 是 HTTP、主进程 IPC 与知识服务共用的纯 TypeScript
运行时契约；DTO 类型由同一份解析定义推导，不另维护手写接口。
不依赖 Electron、数据库、云 SDK 或额外运行库。

A6 的容量准入复用本包 `parseKnowledgeCapacity` / `KnowledgeCapacity`，与 Quota
共用同一份非负 int64 解码定义；这只是容量结构，不是预留/授权或收费结论。

## 公开接缝

| 接缝                                                                                          | 用途                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `parseKnowledgeSpaceInput` / `parseKnowledgeDocumentInput`                                    | 标题、标签、事实/风格/模板用途             |
| `parseKnowledgeSpaceTarget` / `parseKnowledgeDocumentTarget`                                  | 空间与资料父范围                           |
| `parseKnowledgeVersionTarget` / `parseKnowledgeBuildTarget` / `parseKnowledgeOperationTarget` | 精确读取目标                               |
| `parseKnowledgeMutationTarget`                                                                | 资料目标与必填条件 `expectedGeneration`    |
| `parseKnowledgeScope`                                                                         | 显式、有界空间或资料选择                   |
| `parseKnowledgePagination` / `parseKnowledgePage`                                             | 同一分页输入与逐项校验的响应               |
| `parseKnowledgeSpace` / `parseKnowledgeDocument` / `parseKnowledgeVersion`                    | 空间、活动/期望指针、原文元数据            |
| `parseKnowledgeBuild` / `parseKnowledgeOperation`                                             | 构建封存与操作产品阶段，各自独立           |
| `parseKnowledgeQuota`                                                                         | 容量/预留/物理预算快照，不是余额或准入结论 |
| `parseKnowledgeError` / `KnowledgeContractError`                                              | 有界业务错误与脱敏校验错误                 |

解析器拒绝所有未知字段，而不是静默丢弃；包括 owner、ownerId、owner_id、userId、
token、任意 URL、对象 key 和供应商错误体。客户端不能指定授权 owner。

## 固定约定

- UUID 是规范小写、非 nil 的 RFC 变体；新知识对象由服务端生成 UUIDv7，队列等
  既有 UUID 不强制换版本。ID 格式合法不是权限凭证。
- 标题最多 200 个 UTF-16 code unit；标签最多 20 个、每个最多 50 个且不重复。
  用途为 facts/style/template，不赋予资料指令权。
- scope 只接受 `{ kind: 'spaces', spaceIds }` 或 `{ kind: 'documents', documents }`，
  数量为 1–50。同一资料不能借不同 space 重复出现；这不是商业免费额度。
- 分页默认 20、范围 1–100；IPC 接受整数，HTTP query 接受规范数字字符串。
  cursor 为末条 UUID，首请求省略或 null；响应必填 nextCursor，末页为 null。
  响应不得超过请求 limit，不含重复项目、上一 cursor 或未授权 total。
- generation、大小/容量是非负 int64 十进制字符串，不转换成 JS number；版本序号
  从 1 起。带单位 quantity 中 bytes/tokens 使用 int64，byte_ms 使用 numeric(38,0)。
- 时间为规范 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`，拒绝不存在的日期；hash 为 SHA-256
  的 64 位小写十六进制表达。
- Document 不造整体 ready 状态；active 的 version/build 成对存在，首版为 null，
  替换保留旧 active；desired 独立。删除后两组指针均为 null。
- Build 状态 building/sealed/invalidated/purged 不等于已发布；sealed 必须有 manifest
  hash，building 不得冒充封存。实际 manifest 和数据库发布门禁后续实现。
- 入库阶段 queued/parsing/indexing/publishing/ready 必须有 target version；删除用
  deleting/deleted，不伪造 ready；只有 failed 携带脱敏 error。
- 缺政策用 `policyRevision: null`、`limits: null` 明示；降级后的存量 active 超 limit
  仍是合法快照，新任务准入留 A6，不能借此伪造免费额度。

## 目标一致性不是鉴权

单条读取把**完整、已解析的请求 target**传给响应解析器，防止历史版本、build 或
operation 被同父范围的另一条替换。列表可传父范围，实际 owner/父子/scope 仍由服务端核验。

```ts
import { parseKnowledgeVersion, parseKnowledgeVersionTarget } from '@genoffice/knowledge-contract'

const target = parseKnowledgeVersionTarget(requestPayload)
const version = parseKnowledgeVersion(responsePayload, target)
```

requestPayload/responsePayload 是调用方输入，不是此包的网络功能。A2/A3 只验证协议结构
和上下文一致性；JWT/RLS/真实归属/准入留 A6/B，HTTP/IPC 接线留 A5，计量事件/回执/
礼包和用户选择留 A4，根脚本/构建接线留 A7。根 Vitest projects 通配可发现此包，但根 npm test /
typecheck 显式链暂不包含它，不声称上传、写作、收费或线上云服务已实现。

## A3：安全单位与原文字符范围

`parseKnowledgeQuantity` 返回带 unit 的判别联合；value 始终是规范非负十进制字符串。
bytes/tokens 最大为 9223372036854775807；byte_ms 最多 38 位，不受 int64 上限误限。
拒绝 number、原生 BigInt、前导零、指数、小数及未定义单位，不进行费用或 GiB·天浮点换算。

`parseKnowledgeCodePointRange` 使用 `{ unit: 'unicode_code_point', origin: 0, start, end }`，
满足 `0 <= start < end <= 2147483647`。`sliceKnowledgeCodePoints` 按 code point 定位，再用
对应 UTF-16 边界切片，不拆开非 BMP 字符、不静默截断越界引用，也不把组合字素当一个 code point。
实现只扫描到 end，不展开整个源字符串成数组；不做规范化或清洗，清洗映射另行保存。

```ts
import { parseKnowledgeQuantity, sliceKnowledgeCodePoints } from '@genoffice/knowledge-contract'

const amount = parseKnowledgeQuantity({ unit: 'byte_ms', value: '9223372036854775808' })
const excerpt = sliceKnowledgeCodePoints('甲😀乙', {
  unit: 'unicode_code_point',
  origin: 0,
  start: 1,
  end: 2,
})
```

## A3：五格式 locator

`parseKnowledgeLocator(input, context)` 返回按 format 判别的联合，公共字段为
schemaVersion: 1、原始文件 sourceHash、提取单元 textHash 和 code-point span。
context 必须由调用方从可信源元数据取得，包含 format/sourceHash/textHash/textCodePointLength；
解析器核对这些绑定及 span 上界，但**不计算 hash、不验证权限，也不证明原文件存在**。

| 格式   | 物理/结构约定                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------ |
| PDF    | physicalPage 从 1 起，blockIndex/spanIndex 从 0 起；不把印刷页名当物理页                         |
| DOCX   | headingPath/blockIndex 与可空 table；表格 row/column 从 1 起，tableIndex 从 0 起；不接受固定页码 |
| MD/TXT | headingPath 与 1-based、inclusive 的 lines，独立于 0-based 半开 code-point span                  |
| XLSX   | 稳定 sheetId、原始 sheetName、1900/1904 dateSystem、1-based inclusive 行列及严格匹配的 A1        |

标题路径至多 32 层、每层 200 个 UTF-16 code unit；索引/字符位置限制在有界 integer。
XLSX 范围使用物理网格上界 1048576 行/16384 列（XFD）；这是坐标合法性，不是导入额度。
A1 仅用规范大写，无 `$` 或 sheet 前缀，单格写 `A1` 而非 `A1:A1`；sheet 标识单独保存。
稀疏源不展开空网格；公式执行、raw/display/type、合并表头及日期数值解释留实际解析任务。

PDF geometry 在不可靠时为 null，bbox 也可独立为 null；不捏造坐标。
已知 geometry 使用旋转后的显示页尺寸、top-left 原点、pt 单位，rotation 为 0/90/180/270；
bbox 必须非空且落在页内。坐标/尺寸安全上界为 10000000 pt，尺寸必须大于零；
该上界是本契约技术护栏，不是 PDF 规范或已通过真实解析的声明。

## A3：结构覆盖与警告

`parseKnowledgeCoverage(input, context)` 核对 format/sourceHash/parserRevision，区分
document/selection 范围。unit 只能是对应格式的 page/block/line/cell，不能拿 hit/chunk
命中数冒充覆盖。计数有界，已知时 `expectedUnits = completedUnits + missingUnits`；
excludedUnits 指请求范围之外的排除量，不参与这个等式。

- complete 需非空、期望已知、无缺失且无已报告的阻断警告；只表示声明范围的结构提取完整。
- partial 需确实处理过部分单元，并有缺失、未知总量或阻断警告；failed 无完成单元且有阻断警告。
- unknown 只用于期望/缺失数量未知且尚无完成单元；未知计数用 null，不能伪装成 0。
- document 不得夹带排除量；selection 的排除量可为 null，但非零/未知时需明确排除警告。
- warnings 最多 100 项，用封闭 code 和可空 0-based 目标 unitOrdinal，不接收原始错误体或 severity。
  重复 code/ordinal、已知范围外 ordinal 及格式不适用的警告均拒绝。
- 漏页、乱码、OCR_REQUIRED、表格不完整、公式缓存缺失等已报告警告阻止 complete；
  FORMULA_CACHE_STALE 保留为非阻断警告，不代表公式刚被重算或事实正确。

这些只是声明一致性检查，不从原文件计算实际覆盖，也不能发现调用方完全隐瞒的警告；
实际解析、权限/父子/来源状态、发布门禁及引用真实性仍由后续服务/解析/引用任务验证。

## A4：计量、回执、预算与礼包

| 公开接缝                                        | 输入与约束                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `parseKnowledgeMeteringEvent(input, previous?)` | storage/embedding判别；更正必须提供可信前一事件，核对主体、attempt/profile及引用，不把估算/实际/更正当作相加样本 |
| `parseKnowledgeSettlementSnapshot(input)`       | 固定knowledge_base、settlementKey、价目/单位/数量，覆盖最多1000个唯一事件ID或带sequence/hash的存储窗口           |
| `parseKnowledgeBillingReceipt(input, expected)` | 对照调用方冻结的完整结算快照；pending/reconciling为null资金，confirmed状态需网站receipt与确认时间                |
| `parseKnowledgeBudget(input, context)`          | scope/用途/策略/价目/确认引用匹配；估算不冒充预占，显式数量/整数分上限及有效期，用户重建的授权预算需确认引用     |
| `parseKnowledgePromoGrant(input, context)`      | 仅knowledge_base/new_user_grant/promotional；新发必须有显式资格/策略，已领取只接受同账号原礼包快照的精确重放     |

计量usage为已知quantity或`source: unknown, quantity: null`，不能用0代替未知。
storage仅接受byte_ms，embedding仅接受tokens；调用意图与超时不确定状态不得报告已知用量，
未调用的缓存只允许reconciled/0且不进入客户收费；失败/未完成证据阶段/平台重建不能声明客户结算。
query使用runId/callId而不造文件build，资料加工绑定space/document/operation/version/build。
profile由不可变indexProfileId引用，本包不查询供应商配置或发起实际调用。

更正必须使用新ID/eventKey并指向前一事实，不能改冻结的主体范围、attempt、profile或已知价目。
这是单次输入/引用一致性检查，**不查询最新更正链、不阻止数据库分叉/重复，也不执行有效usage归集**；
调用前持久化intent、自动重试不重复向客户收费、outbox和对账仍由D组实现。
窗口hash只是格式和快照绑定，不计算真实事件集合、水位完整性或byte-time积分。

回执整数分使用非负int64十进制字符串，不足分余数使用`0`或`0.xxx`规范字符串，
最多18位小数、无尾随0且小于1分；超精度拒绝而非静默舍入。18位是协议技术护栏，不是生产售价。
已结算/释放的预占分项必须守恒；未结算不能报已扣，释放不能混入扣款或改余数。
本包不实现价格乘法、跨窗口余数累计、钱包、资金幂等或跨库原子性，这些仍需C/D组验收。

预算context中的scope/策略/价目、now及确认引用必须来自服务端已验证状态，
有效预占需调用方与网站核验，不能把一个格式合法的reservationId称为资金已授权。
预算不设隐藏180秒TTL，不创建或续期预占，也不相信客户端余额/模型Token自报。

礼包context中的existingGrant必须由调用方按当前可信账号查询；礼包版本只是快照，不构成新的领取资格键。
原礼包即使策略改版、资格变化或已经到期，也只能作为历史事实原样重放，不代表重新入账。
新发金额必须与显式策略一致；无策略/资格未知拒绝，不预置生产免费金额。
非空有效期必须有公开expiryRulesRevision且尚未到期，不能隐藏到期；实际披露与财务唯一键由网站C组负责。

## A4：待确认与受控选择

`parseKnowledgeConfirmation(input)`只接受needs_confirmation，包含run/scope/manifest、
策略和期限以及1–10组冲突候选。每组保留主体/指标/单位/时期/条件对齐、双方摘录/出处/版本/hash；
私人一侧只能是facts，不用style/template或模型记忆充当事实。单段摘录至多2000个UTF-16 code unit，
不带默认来源、原始供应商响应或owner，不实现冲突发现或安全预览渲染。

`parseKnowledgeDecision(input, context)`允许use_mcp/use_private/keep_both或明确cancel。
受控context必须由调用方生成`channel: user_action`，不能从renderer/HTTP/模型payload透传；
输入中的userConfirmed/rememberChoice等自证或全局偏好字段拒绝。
确认需绑定当前run/scope/策略、旧manifest、双方原始及当前证据快照，采用新manifest且不能原地覆盖；
过期/版本或hash变化/证据缺失拒绝继续。取消输出cancelled/null manifest，可在过期后执行，不能用于生成。

**这些解析器不证明人类真的点击过确认，也不验证owner、证据真实性、签名、manifest存在或持久化幂等。**
可信主进程/服务派发、账号切换撤销、实际新manifest创建、可await的继续/插入门禁分别留A5/H5；
不得给模型暴露自造user_action上下文的确认工具。决定不退还已经发生的AI/MCP/Embedding消费，
本包没有任何消费撤销或资金操作能力。

## 验证

```powershell
D:\SmallTools\RTK\rtk.exe npm run test --workspace @genoffice/knowledge-contract
D:\SmallTools\RTK\rtk.exe npm run typecheck --workspace @genoffice/knowledge-contract
```

用例只用合成 ID、元数据和显式 synthetic policy，不请求网络、不读真实资料、
不连接数据库或调用收费模型。
