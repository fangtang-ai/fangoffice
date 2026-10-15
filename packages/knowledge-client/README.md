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
不以另一条合法 DTO 或当前版本代替。上传/修改/删除及其幂等、条件代次留 D 组，
不临时制造未经契约固定的写入协议。

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
