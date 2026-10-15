# Knowledge service (A6 policies / B1 runtime)

The API and worker now have independent Node entry points. Business tables, RLS,
queue processing, uploads, model calls and billing are not implemented. Local
tests use synthetic keys, fake database pools and loopback HTTP only; no deployed
service or real database integration has been validated.

## B1 runtime

Build with `npm run build:knowledge` from the repository root. Start the API with
`npm run start:api -w @genoffice/knowledge-service`, or the independent worker with
`npm run start:worker -w @genoffice/knowledge-service`. These start commands connect
to the configured database and must only be used after the corresponding resource
approval. Neither process imports the website application or runs migrations.

The outputs are `dist/api.mjs`, `dist/worker.mjs` and `dist/build-meta.json` inside
this workspace. They target Node >=22.12.0, bundle JOSE/shared contracts, and retain
the pinned `pg` runtime dependency. They are not self-contained deployment images;
J1 owns release packaging, CI and migration/rollback orchestration. Desktop builds
do not import these entries or include service credentials.

Required settings (no fallback to `DATABASE_URL`, `PGHOST`, `PGUSER` or website config):

| Setting                                                           | Purpose                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `KNOWLEDGE_DATABASE_NAME`                                         | Dedicated approved database name                                                                  |
| `KNOWLEDGE_API_DATABASE_ROLE`, `KNOWLEDGE_API_DATABASE_URL`       | API session role and matching PostgreSQL DSN                                                      |
| `KNOWLEDGE_WORKER_DATABASE_ROLE`, `KNOWLEDGE_WORKER_DATABASE_URL` | Worker session role and matching DSN; not required by the API                                     |
| `KNOWLEDGE_AUTH_ISSUER`, `KNOWLEDGE_AUTH_AUDIENCE`                | API-only pinned issuer and existing logical API resource                                          |
| `KNOWLEDGE_AUTH_REQUIRED_SCOPES`                                  | Optional space-delimited deployment permissions; no knowledge-specific scope is presumed to exist |
| `KNOWLEDGE_ENVIRONMENT`                                           | Defaults to `production`; the sole exception is explicit `isolated_test`                          |
| `KNOWLEDGE_API_HOST`, `KNOWLEDGE_API_PORT`                        | API-only; defaults `127.0.0.1:4180`                                                               |

Production database connections require verified TLS. DSN query parameters,
embedded options, missing passwords and database/role mismatches are rejected.
`isolated_test` permits non-TLS PG only on loopback, loopback HTTP issuers and an
ephemeral API port (`0`); it never permits a public listener or a remote database.
`NODE_ENV=test` does not activate these exceptions.

Before listening, a read-only catalog probe validates the actual database,
current/session role and absence of superuser, BYPASSRLS, role/database creation
or replication privileges. This is not B3's full grants/membership/RLS audit.
Only this probe runs in B1; no DDL, transaction or model request is executed.

Authentication accepts only RS256 signatures, pinned issuer/resource audience,
nonempty subject, explicit `exp`/`iat`, valid `nbf` and configured scopes. Owner is
derived solely from verified `sub`; token `jku` cannot change the key endpoint.
JWKS uses the configured issuer's fixed `/jwks`, a shared bounded cache, no
redirects/forwarded credentials, a 256 KiB body limit and a total fetch/body
deadline. Expiry is checked again after key lookup. A disconnected caller cannot
cancel another caller's shared lookup. Identity does not confer product rights.

Routes: `GET /healthz` (liveness), `GET /readyz` (database readiness), and authenticated
`GET /api/knowledge/status`. Business routes return `NOT_FOUND`, not fake lists or
successful task results. Body-bearing requests, unsupported methods and duplicate
Authorization headers are rejected. No CORS, cookie or private diagnostic is exposed.

Connections, headers and receive times are bounded. Idle PG errors fail the
process closed; shutdown drains once with a hard deadline. The worker currently
performs sequential read-only health probes while waiting for B4 queue work.
SIGINT/SIGTERM cancel startup or close the running process; failed cleanup remains
a failure, not a successful stop. Runtime configuration/driver errors are sanitized.

## 公开接缝与可信输入

- `createKnowledgePrincipal(identity, authority, now)`：调用者必须先由认证 adapter
  验证签名、固定 issuer/audience、到期及所需权限，才传入可信身份；纯策略再检查
  域/权限/时效并从 subject 派生 owner。不是 JWT 验签器，不接受 HTTP body 自证。
  principal 冻结且登记在进程内 WeakSet，复制/JSON 伪造不能用于后续策略。
- `authorizeKnowledgeTarget(principal, target, facts, scope, mode, now)`：请求 target/scope
  用共享契约解析；facts 必须来自可信的 owner+父键读取，不是客户端提交的对象。
  逐层检查空间/资料/版本/build/operation 归属、真实父范围与精确目标；缺失、跨户和
  伪造关系不泄漏资源。活动证据核对当前指针及封存状态，历史用途必须显式选择，
  被删除/清除的资料不能因 history 模式恢复可读。
- `createKnowledgeAdmissionPolicy(environment?)`：默认 production，提供 `capacity`
  和 `budget` 两个独立纯门禁；`internal_test` 策略仅能在显式 isolated_test 模式下使用。
  测试 adapter 和合成额度/资金事实只在 `tests/`，没有缺配置免费放行。

`maintenance` 仅检查对象归属/范围，允许查询冻结或删除过程中的管理目标；它不是
读取私人原文、发布、删除或收费的完整授权。scope 必须来自本次服务端批准的范围，
不能让模型把范围扩大后自批。存量读取/导出/删除的权益与保留策略留后续产品链路。

## 容量与预算

`capacity(principal, quotaFacts, policy, projection, now)`：quota/policy 来自可信读取；
projection 中被替换容量必须由服务端从当前 base 得到，不能采用请求自报的抵扣。

- 复用共享 `parseKnowledgeCapacity`、Quota、Quantity 校验；所有容量用十进制
  int64 字符串与 BigInt 运算，不经浮点。
- 每维预留 `max(new - old, 0)`，再检查 active + 全部 reserved + 新增不超 limit；
  不提前借出负增量，不修改输入快照。
- 权益降级后只允许经验证各维均不增的整改替换；仍必须满足独立物理空间硬上限。
  旧版/失败对象的物理债务在真正 GC 确认之前不得从可信快照扣除。
- 缺政策/限额、错 owner/产品/revision、冻结/关闭和过期/未来快照均不放行新任务。

`budget(principal, policy, budget, requirement, websiteReservation, now)`：requirement
来自服务端范围/用途/确认及数量规划，预占事实必须由可信网站 adapter 核验，
不是请求里的“已付款”或一个布尔 verified 标志。

- 只接受仍有效的 authorized 预算与 held 预占，逐项绑定 owner、knowledge_base、
  budget/reservation ID、scope、用途、policy/tariff revision、确认、期限和金额。
- 单位与数量不超过预算硬上限；存储 byte_ms 和向量化 tokens 分开。
  estimated 不是已授权，user_rebuild 必须具有同一个受控确认引用。
- isolated_test 不放松上述预算检查，仅允许显式合成来源；生产不能使用此来源。

这些函数不构成原子预留、分布式锁、资金扣费、人类动作证明或永久能力令牌。
实际调用、批次继续和发布前必须重新核验；同旧版并发替换信用、唯一 operation
预留、generation/base/profile 匹配及跨库资金幂等由 B/C/D 组在真实隔离环境验收。

## 验证

`npm run test -w @genoffice/knowledge-service` 与
`npm run typecheck -w @genoffice/knowledge-service`；根目录
`npm run test:knowledge` / `npm run typecheck:knowledge` 聚合三个知识 workspace。
The B1 dependency installation uses pinned JOSE/pg and disables install scripts.
Tests never read user documents, connect to a real database or call a model.
