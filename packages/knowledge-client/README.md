# 知识库主进程客户端（A5）

`@genoffice/knowledge-client` 只提供固定动作，不提供通用 fetch、任意 URL、
owner 参数或 renderer token 接口；仅由主进程的可信账号 adapter 创建。
它只依赖共享契约，无 Electron、服务端、数据库或云 SDK 运行依赖。

## 入口与动作

Shell 的 `createAccountKnowledgeClient()` 惰性工厂复用现有账号会话及刷新合并，
不在启动时发请求；目前不注册管理 UI/IPC，也不宣称知识路由已部署。
每个账号 adapter 固定读取一次部署配置，避免请求边界反复同步读盘；部署配置
变化时重建工厂，不将配置热加载引入在途请求。

| 动作                                      | 固定 GET 路径（相对 `/api/knowledge`）                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `listSpaces(page?, options?)`             | `/spaces`                                                            |
| `listDocuments(space, page?, options?)`   | `/spaces/:space/documents`                                           |
| `getDocument(target, options?)`           | `/spaces/:space/documents/:document`                                 |
| `listVersions(document, page?, options?)` | `/spaces/:space/documents/:document/versions`                        |
| `getVersion(target, options?)`            | `/spaces/:space/documents/:document/versions/:version`               |
| `getBuild(target, options?)`              | `/spaces/:space/documents/:document/versions/:version/builds/:build` |
| `getOperation(target, options?)`          | `/spaces/:space/documents/:document/operations/:operation`           |
| `getQuota(options?)`                      | `/quota`                                                             |

目标、分页及响应均经共享运行时契约校验；历史对象必须精确匹配完整请求目标，
不以另一条合法 DTO 或当前版本代替。

E1新增三个固定JSON写动作，沿用同一账号会话和取消/刷新边界：

| 动作                                           | 方法与固定路径（相对 `/api/knowledge`）           |
| ---------------------------------------------- | ------------------------------------------------- |
| `createSpace(target, metadata, options?)`      | `PUT /spaces/:space`                              |
| `createDocument(target, metadata, options?)`   | `PUT /spaces/:space/documents/:document`          |
| `prepareUpload(target, declaration, options?)` | `POST /spaces/:space/documents/:document/uploads` |

资源UUID由调用方生成后保留，重复创建须metadata一致；上传声明包括
`operationId/idempotencyKey/expectedGeneration/declaredBytes/format`，generation和bytes
为精确十进制字符串。保留同一幂等键重试，不能每次生成新键。认证刷新只重发同一
JSON快照，网络或5xx不自动重发；切换账号则丢弃迟到结果，不跨账号重试。
`prepareUpload`只返回`uploading`操作及`preparation.status: prepared`、原期限和大小，
不包含对象key、签名链接或ready承诺；不使用账号Bearer上传对象。真实固定对象授权、
文件传输与完成上传是独立接缝，不能把此动作当上传完成。

## E1固定对象授权与上传

- `authorizeUpload(target, declaration, options?)`：固定POST到上述资料的
  `/uploads/authorization`，返回经契约校验的OSS V4表单能力；重放保留原对象与会话期限。
- `uploadFile(target, declaration, explicitlySelectedBlob, options?)`：先校验Blob精确大小，
  再取得表单并发送文件；可传Node异步`openAsBlob`产生的文件支持Blob，不需要整份读入内存。
- 对象目标仅允许规范OSS HTTPS桶主机，表单固定private/forbid-overwrite及操作key。
  该请求绝不复用账号transport/Authorization/Cookie，也不手设multipart边界、跟随重定向，
  或为OSS的401刷新账号token；换号/退出/取消/超时停止在途请求并丢弃迟到结果。
- 只接受对象端204，并返回`transfer.status: uploaded_to_staging`；Operation仍为uploading。
  没有自动完成上传、Version、入队或ready结果。网络歧义或重复对象409不等于相同文件，
  需要后续E2服务端流式核验，不自动覆盖或把重发当成功。
- 真实OSS部署/桶权限/凭据尚未验收；上述路径已用合成对象HTTP端与真实隔离数据库验证，
  不代表真实资料、模型或客户收费已获授权。

## 配置与会话边界

- 显式 `account.knowledgeApiBase` / `FANGTANG_KNOWLEDGE_API_BASE` 缺失时报
  `knowledge:not-configured`，不回退 MCP，也不从账号 origin 猜测已部署。
- 账号 base 只能是 origin，知识 base 必须是同源固定 `/api/knowledge`，仅规范化
  末尾斜线；拒绝原始路径绕行、用户信息、query、fragment 和其他协议/目标。
- 默认 HTTPS；Shell 仅在未打包且显式
  `FANGTANG_ALLOW_LOOPBACK_ACCOUNT_API=1` 时允许本机 HTTP loopback。
- 每次请求绑定 user/session/signal；读取 token、刷新、读取响应及发布结果前复核。
  401 只刷新一次，保留原绑定；无网络或 5xx 自动重试，不转发错误体或底层异常。
- fetch 使用 `credentials: omit`、`redirect: error`，并防御 adapter 返回重定向、
  更换响应 URL；账号 Bearer 不用于对象上传目标。
- `options.signal` 取消单次请求，`close()` 取消当前客户端；两者不取消账号层共享刷新。
  整体取消竞速覆盖挂起 token/fetch/JSON；丢弃迟到结果并尽力释放响应 body。
- 默认整体超时 30 秒；构造参数 `timeoutMs` 允许 1–300000 毫秒，成功或失败均清理
  timer 和请求监听。关闭后的客户端不可重新使用。

## 验证与限制

`npm run test -w @genoffice/knowledge-client` 与
`npm run typecheck -w @genoffice/knowledge-client`。

测试使用 `.invalid` 域名、合成账号/DTO 与拦截的 fetch；没有真实网络或配置读取。
会话边界测试不等于服务端 JWT、owner/RLS、持久预占、真实上传或收费已验证。
