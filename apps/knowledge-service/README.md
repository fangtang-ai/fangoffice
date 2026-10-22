# Knowledge service (policies, isolated runtime and local data-domain slices)

For the end-to-end delivery status, cloud/model blockers and human-test milestones,
start with [READINESS.md](READINESS.md). Local acceptance below is not evidence of
a deployed, usable knowledge product.

The API and worker have independent Node entry points. The 16-table candidate,
owner RLS/FORCE, restricted local roles and trusted transactions have passed a
real, disposable Windows PostgreSQL 18.2 / pgvector 0.8.7 acceptance slice.
Four-table immutable facts and building-content/frozen-build gates also pass local
SQL, real lock-race and restore checks. The queue-driven claim/content/seal
lifecycle and the active-pointer publication gate are executed on the same
cluster. Initial-upload and replacement capacity admission are separate local slices.
Retention/GC state-transition gates, monetary-budget admission, uploads,
model calls and billing remain unfinished. No existing business database, private
document, Docker instance or
cloud deployment is used. Default tests remain offline; real database tests have
a separate, explicitly invoked local-only entry.

## Account-bound metadata reads (2026-10-21 local slice)

The existing account client now reaches authenticated, owner-scoped HTTP reads:

- `GET /api/knowledge/spaces`
- `GET /api/knowledge/spaces/:spaceId/documents`
- `GET /api/knowledge/spaces/:spaceId/documents/:documentId`

Lists accept only shared `limit` (1–100) and UUID `cursor` parameters, order by
UUID, and fetch one extra row to determine `nextCursor`. Invalid/duplicate/unknown
parameters, detail queries and body-bearing GET requests fail before a transaction.
The detail path retains PUT; unsupported methods advertise `Allow: GET, PUT`.
Frozen spaces remain readable; deleted/deleting parents and deleted children
are hidden. Wrong parents and foreign-only targets return NOT_FOUND; identical
UUIDs remain owner-scoped. DTOs contain metadata and active/desired references, not owner IDs, object
keys, credentials or source content. Responses are no-store, without CORS/cookies.

The separate `security/deletion-empty-space.sql` supplement also timestamps empty
space tombstones, including account-scope deletion. Its marked local-only apply
entry follows upload completion, preserves original artifacts/receipts and ACL,
and refuses replay. Progress/history, hosted completion and desktop UI remain open.

## B4 runtime queue consumer (2026-10-20 local slice)

`createKnowledgeQueue(transaction, name)` executes enqueue and attempt-fenced
settlement on the caller's connection, including rollback with its transaction.
`startKnowledgeWorker(config, { queue: { name, handle } })` connects the sequential
consumer to the verified worker pool and its service lifetime. Queue polling
failure stops the service; shutdown or lost heartbeat aborts the handler and
stops renewal without completing a lost attempt. Queue failure output contains
only a stable error code, not documents or provider diagnostics.

The handler receives reference-only `envelope`, claimed `job` and cancellation
`signal`. It must observe cancellation, revalidate the existing knowledge
owner/operation/build/receipt gates and use short transactions around database
work. This consumer does not authorize spending or implement E4 ingestion.
The shipped CLI still has no business handler and therefore remains health-only;
it does not silently consume and complete unprocessed documents. Independent
privileged queue maintenance is now an explicit one-shot `maintenance.mjs` command
using its own role/URL and `KNOWLEDGE_QUEUE_NAME`. It recovers queue-level expired
attempts without starting migrations, scheduling or reindexing. Knowledge-operation
failure settlement and replacement binding remain B5/B6 work, not queue recovery.
Neither adapter nor worker calls pg-boss `start`/`work` or performs DDL.

## Explicit local database acceptance

The approved target is only `tmp/knowledge-pg-isolated`, `127.0.0.1:55432`,
database `knowledge_isolated`. The cluster uses its own native runtime copy,
SCRAM credentials and an instance marker; local secrets are ignored by Git.
No environment DSN or external database target is accepted by this harness.

```sh
npm run db:apply:local -w @genoffice/knowledge-service
npm run db:apply:immutable:local -w @genoffice/knowledge-service
npm run db:apply:content:local -w @genoffice/knowledge-service
npm run db:apply:queue:local -w @genoffice/knowledge-service
npm run db:apply:build-lifecycle:local -w @genoffice/knowledge-service
npm run db:apply:publish:local -w @genoffice/knowledge-service
npm run db:apply:capacity:local -w @genoffice/knowledge-service
npm run db:apply:replacement:local -w @genoffice/knowledge-service
npm run db:apply:cancellation:local -w @genoffice/knowledge-service
npm run db:apply:cancellation-publish:local -w @genoffice/knowledge-service
npm run db:apply:cancellation-worker:local -w @genoffice/knowledge-service
npm run db:apply:retry:local -w @genoffice/knowledge-service
npm run db:apply:capacity-publish:local -w @genoffice/knowledge-service
npm run test:database -w @genoffice/knowledge-service
```

The first command requires the already initialized marked local cluster. It
applies the generated SQL, FORCE supplement and `security/local-grants.sql`
in one migration-role transaction, records hashes and refuses an existing schema.
The second command requires that accepted baseline. It verifies the marked
cluster, baseline hashes and table security, then atomically applies the separate
`security/immutable-facts.sql` supplement and records its own receipt. Both
commands refuse replay. The third command chains both accepted hash receipts and
applies `security/build-content.sql` in a separate atomic transaction; it likewise
refuses replay. None is a production migration runner or startup action.
The later queue, lifecycle, publication and capacity entries are likewise explicit local
increments with chained hash receipts; none is a startup action. Real tests cover
schema constraints, all 15 populated tenant tables, role
restrictions, pool identity/failure paths, four-table immutable facts and native
backup/restore including function/trigger definitions, ownership and privileges.
Recovery creates only `knowledge_isolated_restore` in the same isolated cluster,
refuses an existing target and removes it only after checking its task marker.

The baseline grants keep worker/GC read-only; later supplements grant worker
only controlled content INSERT, seal columns, operation phase and narrow
publication EXECUTE. The capacity-publication increment revokes the historical
worker active-pointer/generation UPDATE grants. Direct API writes remain limited to space metadata; narrow
capacity functions admit initial uploads/replacements without granting direct quota,
reservation or desired-pointer writes. Original writes, GC, metering and receipt
mutations are not directly enabled; the narrow publication function writes its
own immutable platform storage event in the publication transaction.
Local acceptance does not unlock cloud resources or R1/R3–R6.

The fact gate freezes all profile fields, verified-original facts, metering facts
and receipt request snapshots, and rejects row deletion. Only explicit version
retention/GC or metering/receipt delivery fields may change; their lifecycle
semantics still need separate gates. No runtime write grant is added. See
[security/README.md](security/README.md) for the exact allowlists and boundaries.

Source units, chunks, mappings and embeddings now accept only INSERT into a
building/live, unsealed parent locked against concurrent closure. The original
content gate uses FOR SHARE; the worker-lock slice below first acquires ordered
parent locks and the required Build lock. UPDATE/DELETE are denied, and
closed builds cannot reopen. Build identity is immutable; once sealed, its
manifest/hash/counts/seal time remain frozen even after invalidation. Fourteen
real multi-session races verify state changes wait for writers and waiting writers
recheck committed state. Later B4/B6 slices add queue identity and publication
guards, but complete sealing validation, full quota lifecycle, atomic
metering and authorized GC remain open. Original B5 is capacity reservation;
original B7 is independent deletion intent, not the publication slice. See
[ACCEPTANCE.md](ACCEPTANCE.md) for the stable task mapping and remaining gates.

## B5: initial-upload capacity reservation

`reserveInitialCapacity(transaction, input)` is exported from the runtime entry
and runs inside `withKnowledgeTransaction`. Its database entry
`knowledge.reserve_initial_capacity` accepts only a queued initial upload for a
generation-zero document without an active build. Owner and verified-original
bytes come from transaction/database facts; chunk and physical-byte projections
must come from trusted service planning, not an HTTP request body.

The owner quota row serializes admission before Space, Document, Operation and
Reservation locks. File/byte/chunk and separate physical limits include existing
active/reserved debt, with numeric sums to reject bigint overflow safely.
Quota counters, a held reservation and the desired version/operation pair are
written atomically. Exact replay does not reserve again; changed replay conflicts,
closed/expired reservations do not reopen, and later transaction failure rolls
all three writes back. Expiry alone never releases physical or logical debt.

The separate `security/capacity-reserve.sql` supplement grants API EXECUTE only;
its definer remains the non-superuser/non-BYPASSRLS FORCE-RLS migrator with a
fixed search path. Worker/GC cannot call it and no direct write grant is added.
The existing baseline SQL and receipts remain unchanged. There is no public
upload route yet, no reservation conversion/release, GC
acknowledgement or publication/metering atomicity in this slice.

### Replacement positive-delta admission

`reserveReplacementCapacity(transaction, input)` uses the same bounded
`CapacityReservationRequest`, but requires a queued replace operation with a
sealed/live active base at the expected document generation. The database derives
the base version/build and original bytes; callers supply the complete trusted
next chunk projection, not an incremental amount or client-supplied base credit.
Only `max(next - base, 0)` bytes/chunks are reserved; file delta is zero. Old
active capacity and physical debt are never subtracted during admission.

`drizzle/0001_capacity_projection.sql` adds a full `projected_chunks` snapshot and
requires it for reservations with a base. This distinguishes changed requests
whose chunk deltas both normalize to zero. The generated SQL and
`security/replacement-reserve.sql` apply atomically through
`db:apply:replacement:local`, with one receipt covering both artifacts; the
original baseline and applied SQL remain unchanged. Schema, snapshot and journal
are generated/reviewed together rather than editing an applied migration.

One held reservation per document may borrow base credit, including when an old
operation is terminal or its held reservation expired. Exact replay is idempotent;
different projections/base/desired facts conflict. All-dimension non-growth
remediation may pass downgraded logical limits but must still reserve full new
physical cost within the physical hard limit. Actual publication must recheck
base, generation, quota/budget and attempt and convert the reservation together
with metering; this entry does not implement that future transaction or release.

### Controlled cancellation and logical release

`cancelCapacityReservation(transaction, operationId)` uses the same trusted
transaction boundary. It cancels only the current held upload/replace intent:
Quota, Space/Document, Operation/Reservation and ordered Build locks serialize
intent withdrawal, generation advancement, attempt invalidation and exact logical
counter release in one commit. It preserves the old active version/build, active
capacity and all physical reserved/accounted bytes. An expired reservation must
still follow this protocol; frozen owner/space state does not strand cleanup.

Replay returns `{ replayed: true }` and never clears a newer desired pair or
subtracts a later reservation. Applied/stale/withdrawn intents and inconsistent
counters are refused. A database claim fence locks/rechecks the operation phase
after waits, content writers are drained under their parent Build lock, and
cancelled operations cannot reopen. API receives only narrow EXECUTE, not direct
quota, reservation, desired-pointer or operation-write permissions.

The local-only apply order is `db:apply:cancellation:local`,
`db:apply:cancellation-publish:local`, then `db:apply:cancellation-worker:local`;
each verifies the prior hash chain. The second corrects a PL/pgSQL alias collision.
The third grants worker EXECUTE on the read-only invoker facts query needed by
the publication trigger; RLS still restricts its view, with no API/GC EXECUTE or
new table-write permission. Applied artifacts never change. Apply all three,
never automatically at service startup.

This is not successful-publication conversion, physical GC acknowledgement,
external job/model cancellation or a website-funds release. There is no HTTP
cancellation endpoint yet. Initial admission remains generation-zero-only;
explicit capacity re-admission after cancellation uses the separate entry below.
See `ACCEPTANCE.md` for verified scope rather than treating this as full B5/B6/F1.

### Explicit capacity retry after cancellation

`reserveRetryCapacity(transaction, input)` accepts the same capacity request shape
as initial admission, but requires a **new**, already verified and queued upload
operation bound to the document's current positive generation. It does not reopen
the cancelled operation, reuse its original version or repurpose its reservation.
The immediately preceding generation must retain a cancelled upload, a closed
released reservation and no building/sealed attempts. Current active pointers,
another held reservation or an unrelated desired pair block admission.

The API-only `knowledge.reserve_retry_capacity` function takes the same
Quota → Space → Document → Operation/Reservation locks as admission/cancellation.
It rechecks facts after waits, reserves the full logical file/bytes/chunks again
and adds the new physical projection **on top of** all old reserved/accounted
debt. Expiry is checked again after lock waits. Exact replay changes no counters;
a changed request conflicts, and later transaction failure rolls back every write.
Old cancellation replay cannot withdraw the new desired pair. Another cancel and
fresh retry advances to the next generation without forgiving physical debt.

For a cancelled replacement with a retained active base, create a fresh queued
replacement at the current generation and use `reserveReplacementCapacity`;
the retry-upload entry cannot borrow replacement credit or alter active data.

After all three cancellation supplements, apply this independent increment only
on the recognized disposable local instance:

```sh
npm run db:apply:retry:local -w @genoffice/knowledge-service
```

The existing identity/ownership/hash gate verifies the entire cancellation chain,
adds a separate receipt and refuses replay. No old SQL/receipt or runtime
table-write privilege changes. This is capacity admission for existing synthetic
verified/queued operations, **not** an HTTP retry/re-upload flow, an operation
creation/idempotency endpoint, automatic retry of failed/superseded jobs, successful
publication conversion, metering, GC or website-funds settlement.

## B2: offline schema candidate

`src/schema/index.ts` declares 16 tables in `knowledge`, separately from the
runtime and the website application. The fixed development tools are Drizzle ORM
0.45.2 and Kit 0.31.10. `drizzle.config.ts` has only local schema/output settings:
no credentials, environment loader, database connection or automatic migration.

From the repository root, these commands only generate/check local files:

```sh
npm run db:generate -w @genoffice/knowledge-service
npm run db:check -w @genoffice/knowledge-service
```

Review `drizzle/0000_knowledge_base.sql`, `drizzle/meta/0000_snapshot.json` and
`drizzle/meta/_journal.json` together. The schema tests regenerate a fresh copy
outside the repository and compare SQL and snapshot metadata, not just the CLI
exit code. The runtime ships 15 files, including the independent maintenance command
and its blank configuration, with pinned `pg` and `pg-boss`
as external dependencies; no Drizzle tool, table definition or migration is imported by the API,
worker, parser or desktop entries.

This is **not executable deployment approval**. See
[SCHEMA.md](SCHEMA.md) for relation/NULL/precision decisions and the outstanding
remaining lifecycle, queue and deployment gates. The explicit local acceptance
above does not establish production readiness or a real model's dimension.

## B3: offline security candidate

All 15 tenant tables declare permissive access plus a restrictive owner guard,
using the same transaction-local identity for reads and writes. The generated
candidate includes ENABLE and policies; `security/force-rls.sql` is a separate
separately applied local supplement, not part of the generated journal.

The runtime exports `withKnowledgeTransaction`; the B1 database exposes
`transaction(principal, work)` only while verified and healthy. It binds a genuine
principal on one checked-out client, expires the query handle after work, rolls
back failed work and evicts unsafe connections. It does not accept request SQL,
invent worker identity, retry ambiguous commits or integrate the queue.

See [security/README.md](security/README.md) for the proposed API/worker/GC/migration
matrix, custom-setting trust boundary, immutable/seal/GC prerequisites and real
role/cross-owner/pool/concurrency checklist. Restricted roles and RLS are now
verified only in the approved local cluster. B3 remains in progress because
full lifecycle-aware grants, sealing validation and budget/deletion/authorized-GC
protocols are not complete.

## F7: selected XLSX DocIR

`parseKnowledgeXlsxDocument(input, policy)` is an offline, read-only parser exported
from `@genoffice/knowledge-service/parsing`. The input has exactly `bytes`,
`sourceHash`, `snapshot` and `snapshotHash`; the latter two are F6's frozen output.
The parser checks both hashes and reconstructs source-bound sheet names, ranges,
visibility and date system before accepting snapshot metadata. Hash equality is
integrity checking, not proof of human confirmation or ownership: the service
must supply the approved persisted snapshot, not trust an arbitrary HTTP body.

Output units represent physical rows with cell-level raw/value/display/type,
one-based coordinates, A1 locators and deterministic source/selection-bound IDs.
The first visible selected row is carried as `headers` with explicit
`headerSource: first_selected_row`; this is structural context, not a claim that
the parser inferred semantic headers, currencies or units. Original header text
such as `金额（元）` remains attached to each row. Merged anchors retain their
range; covered blank cells are not duplicated. An unavailable/out-of-range
anchor produces an incomplete-table warning, never an out-of-scope read.

- Shared/inline/rich strings preserve leading zeros, Unicode and SpreadsheetML
  escapes; booleans, blank cells and error values remain distinguishable.
- General values retain their exact numeric strings. A bounded simple-format
  subset handles fixed decimals, grouping, zero padding and percentages with
  BigInt decimal rounding rather than binary floating-point conversion.
  Explicit cell styles override custom row defaults, which override column defaults;
  untouched column metadata is cached only for encountered physical columns.
- Common dates use the workbook's 1900/1904 system. Date displays are explicitly
  marked `canonical_date`, not localized Excel screenshots. The fictitious
  1900-02-29 remains unknown; ISO date cells are validated separately.
- Formulas are never evaluated. Stored results have unknown freshness and a
  stale-cache warning; absent results remain unknown and make coverage partial
  or failed. Unsupported custom formats retain raw values with no invented display.
- Hidden rows/columns are re-read from complete worksheet metadata, not the
  preflight's capped display examples. Unselected sheets, ranges and headers
  never enter returned text or previews. Macros, links and unsupported drawing
  content produce explicit warnings and are not executed or followed.

Coverage has `scope: selection` and counts physical selected cells, not row units
or the entire workbook. Excluded cells and unknown results are reported. Empty
selections and malformed/contradictory coordinates are rejected, not silently
repaired or truncated. Preview text is escaped separately from source values.

All policy fields are required positive integers, bounded by these hard ceilings:

| Field                | Ceiling                                                  |
| -------------------- | -------------------------------------------------------- |
| `maxBytes`           | 20 MiB                                                   |
| `maxXmlBytes`        | 32 MiB aggregate declared XML/relationship bytes         |
| `maxSheets`          | 5 selected sheets                                        |
| `maxRowsPerSheet`    | 5,000 selected physical rows, including context rows     |
| `maxColumnsPerSheet` | 100 distinct selected physical columns                   |
| `maxCells`           | 50,000 emitted physical cells, including explicit blanks |
| `maxCodePoints`      | 4,194,304 emitted text code points                       |

Additional conservative bounds are 4,096 ZIP entries, 1,024 merged ranges per
sheet, 200,000 shared strings and 65,536 cell styles. Sparse coordinates do not
allocate an empty grid. DTD/entity declarations, invalid UTF-8, invalid XML,
duplicate package parts, missing references and overlapping merges are rejected.

This is not a new worker/queue/upload route, formula engine, model integration or
F8's cross-format publication/billing/RSS/deadline acceptance. Those boundaries
and the remaining J1 release gates stay outstanding.

## B1 runtime

Build with `npm run build:knowledge` from the repository root. Start the API with
`npm run start:api -w @genoffice/knowledge-service`, or the independent worker with
`npm run start:worker -w @genoffice/knowledge-service`. These start commands connect
to the configured database and must only be used after the corresponding resource
approval. Neither process imports the website application or runs migrations.

The code-only candidate contains seven `.mjs` entries (`api`, `worker`, `maintenance`, `check-config`,
`parser`, `text-worker` and `markdown-worker`), `package.json`, `package-lock.json`,
`api.env.example`, `worker.env.example`, `maintenance.env.example`, `OPERATIONS.md`, `build-meta.json` and
`build-manifest.json` in `dist/`. It requires Node >=22.13.0,
bundles the parser dependencies and JOSE/shared contracts, and retains pinned `pg`
and `pg-boss` as external packages. The installation manifest and lock in `deployment/`
must match the service version, engines and both fixed dependencies before building.
Installation files, templates and the runbook are included in the source and
artifact hashes and the CI upload allowlist. Desktop builds do not import these entries or include service
credentials. These files are a runtime candidate, not a deployment image or approval.

To reproduce an installation, copy only those 15 files to a new directory outside
the repository, then run from that directory:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

The automated build test adds `--offline` and uses the local npm cache, never the
repository's `node_modules`. A missing cache entry fails rather than downloading
packages. The installed candidate runs TXT/Markdown workers, XLSX/PDF parsers and
both service entries in independent processes; the service entries must fail with
`NOT_CONFIGURED` despite unrelated business database environment variables. No
database connection, migration or deployment is performed by this smoke test.
Starting a configured service remains subject to the separate resource approvals.

The new `check-config.mjs api|worker` entry reuses the pure configuration parser and
imports no database driver. From the candidate directory, an operator can preflight
trusted, externally stored role-specific configuration without opening connections:

```sh
node --env-file=/protected/knowledge-api.env check-config.mjs api
node --env-file=/protected/knowledge-worker.env check-config.mjs worker
```

Unfilled examples fail with `NOT_CONFIGURED`; success prints only the role and
configuration-valid message. It proves syntax, not database/JWKS connectivity,
grants/RLS, entitlements or migration compatibility. Node gives inherited variables
precedence and can apply `NODE_OPTIONS` from the file: use a dedicated environment
and only trusted operator-managed files, never an uploaded file. See
[deployment/OPERATIONS.md](deployment/OPERATIONS.md) for secret isolation, gated
launch and stop/recovery checks. No production migration runner is implemented;
the marked local B2 candidate and native recovery slice are accepted, not a
configured deployment or production recovery exercise.

The workspace `.node-version` pins the minimum compatibility target to `22.13.0`.
Production builds, worker test bundles and the knowledge CI read this same file;
it is also included in the build source hash. The service manifest and lock record
the corresponding minimum engine without changing the repository's desktop Node
baseline. CI artifact names use the actual setup-node version output.

Windows local validation runs the synthetic knowledge suites, typechecks and build
with an actual, SHA256-checked Node 22.13.0 executable, in addition to the installed
Node 25.8.1. The independent-process build smoke exercises TXT/Markdown workers,
selected XLSX and a synthetic text PDF from `dist/parser.mjs`; it does not only
set an esbuild target while running a newer Node. This minimum-compatibility pin
is not a production security patch recommendation. A repository-external clean
installation passes locally on both tested Node versions; hosted Linux/Windows CI,
production patch selection, migration/rollback and R6 release approval remain unverified.

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

## Atomic capacity publication (B5/B6 local slice)

`publishBuild(transaction, context)` now calls only the worker-only
`knowledge.publish_reserved_build` entry and returns `{ replayed }`.
Apply `db:apply:capacity-publish:local` after the entire accepted cancellation/
retry chain. The new function and privilege revocation are one atomic supplement;
accepted historical SQL and receipts are not rewritten. No runtime role can
directly update the document's active pointers or generation.

The function locks Quota → Space → Document → Operation/Reservation → Build,
rechecks current base/generation/profile, source retention, the held reservation
and logical/physical limits, then publishes and closes the reservation together.
After both worker-lock supplements below, claim/content/seal take the same
Quota-first locks before touching Build rows. Preparation and publication may
share one short `withKnowledgeTransaction`; separate short preparation and
publication transactions remain valid. Queue settlement is not yet atomic with
publication.
Logical totals use the sealed build's actual chunk count and verified bytes,
subtracting the retained active base once; unused projection is not active usage.
Only this reservation's physical projection moves from reserved to accounted;
old and cancelled physical debt remains charged until separately confirmed GC.

An immutable, ordered, pending `capacity_change` storage event shares the same
transaction. Exact winner replay cannot duplicate counters, events or generation
and cannot withdraw a later desired intent. The platform event is a storage
fact/outbox intent, not a website budget authorization or customer charge.
Transaction rollback undoes every change. This does not complete B5/B6:
persisted monetary-budget/current queue-attempt binding, atomic queue settlement,
failed/superseded recovery, physical GC and independent B7 deletion remain open.

## Worker lifecycle lock order (B6 local slice)

Apply `db:apply:worker-lock-order:local`, then `db:apply:worker-phase-lock:local`,
after capacity-publish on the marked disposable cluster. Both increments extend
the existing identity/hash chain; previously applied SQL and receipts do not change.
The second increment closes the remaining historical Operation-phase write grant;
both increments are required for this acceptance boundary.

Worker claim/content triggers and `sealBuild` now lock Quota → Space → Document
→ Operation → Reservation → sorted Build before mutating build facts.
`sealBuild` uses only `knowledge.seal_locked_build`; all runtime roles lose direct
Build UPDATE and Operation-phase UPDATE. Sealed counts/hash still come from the
existing database seal trigger. API/GC/PUBLIC cannot execute the worker lock/seal
functions; owner identity remains transaction-bound with FORCE RLS.

Same-owner lifecycle writes serialize for the duration of each short transaction,
including independent builds. Do parsing, embedding and all external I/O outside
these transactions; bound content batches rather than keeping an owner lock
through an entire document. Different owners do not share this row lock. This
deliberate correctness boundary avoids both reverse-order and lock-upgrade deadlocks;
it is not a claim of measured throughput or a complete queue/budget protocol.

## Durable current attempt (B6 local slice)

After both worker-lock increments, apply `operation-attempt-binding`, then
`operation-attempt-fence` through their local gate scripts. The first increment
adds the four nullable Operation binding columns; the second is required: it
validates real Build/Receipt facts, restores the cancellation branch overwritten
by the first increment, and enforces the binding for content, seal and publication.
Do not apply the first increment alone or edit accepted SQL/receipts. Existing
marked clusters with both receipts must not replay either migration.

For a new marked local cluster that has accepted the preceding chain, run from
the repository root with the explicit workspace:

```powershell
npm run db:apply:operation-attempt-binding:local -w @genoffice/knowledge-service
npm run db:apply:operation-attempt-fence:local -w @genoffice/knowledge-service
```

`claimBuild` inserts and binds the current job/retry/build/receipt in one worker
transaction. Different jobs cannot claim a second current build for the same
Operation. Direct binding uses the same parent lock order, reconstructs immutable
Build identity and verifies a same-owner pending Receipt. Only the same open
attempt can replay; no implicit takeover or rebinding is implemented.
`resolveQueueBuild` rejects unbound builds, including synthetic or pre-migration
rows; fixtures explicitly establish a valid binding before resolving them.
Content insertion and controlled seal reject an unbound or non-current build;
the publication trigger independently verifies the binding and pending Receipt.

Queue resolution compares the durable binding as database UUID/integer values,
not incoming UUID text. Uppercase UUID references identify the same bound attempt
and resolve to the canonical stored context; missing, different or null binding
components still fail closed. Owner identity remains exact text and is not normalized.

The Receipt association is a local fact, not website monetary-budget authority,
provider usage, a customer charge or atomic queue settlement. A trusted consumer
must still verify delivery ownership outside this local slice. Failed/expired/
superseded convergence, explicit retry takeover, hosted consumers, physical GC
and B7 deletion/recovery remain unaccepted; B5/B6 are not complete.

## Atomic queued publication (B6 local slice)

Use `publishQueuedBuild(transaction, queueName, job, envelope)` inside
`database.transaction(principal, ...)` for a real worker's final publication.
The helper reconstructs Build identity and the current attempt from trusted
rows, takes the existing knowledge lifecycle locks before the queue-row lock,
then checks the active retry, actual expiry/heartbeat and stored envelope.
It completes exactly one pg-boss attempt and runs the existing document,
capacity and storage-event publication on that same transaction. Propagate any
failure out of the callback so all of these effects roll back together.

The locked queue row and clock checks use the already-granted shared
`pgboss.job_common` table of pinned pg-boss 12.37.1; partitioned queues are not
supported by this runtime role and fail closed. No extra runtime grants or
migrations are needed. The lower-level `publishBuild` alone does not prove real
queue ownership. Neither helper supplies website budget authority, actual
embedding usage or customer settlement; these and the E4 ingestion handler
remain separate pending work. The default CLI still does not ingest TXT files.

## D1 exact storage windows (2026-10-20 local acceptance)

Call `closeStorageWindow(transaction, { windowId, startAt, endAt, tariffRevision })`
inside a trusted worker transaction. The SQL entry is worker-only and shares
the Quota-first lifecycle lock. Supply a complete Asia/Shanghai calendar day
and a tariff revision from trusted server configuration, not a client body.
Start with the first capacity-change day and then advance continuously.

The result contains `replayed`, a shared-contract-validated persisted `event`,
and `gibDays` with decimal-string `wholeDays`, `remainderByteMs` and
`byteMsPerGiBDay` (`92771293593600000`). Byte-time uses exact integers throughout;
keep the remainder rather than rounding each interval or converting to Number.
Unchanged days carry their opening capacity forward, and tombstones stop
logical storage independently of physical GC. Window watermarks and event-set
hashes are immutable; retries must retain the same ID, range and tariff.

The scan is capped at 10,000 capacity changes per day and rejects excess,
missing, out-of-order or late facts instead of inventing zero usage. Closure
and subsequent work roll back together if the transaction fails. The generated
index and SQL supplement have a separate local application receipt; never
rewrite an applied artifact. This runtime entry supplies metering facts, not
website budget authorization, customer settlement or a daily scheduler.

## D2 embedding attempt costs (2026-10-20 local acceptance)

Use `recordEmbeddingIntent(transaction, request)` in a short trusted worker
transaction and wait for that transaction to commit **before** contacting a
provider. Query intents carry a server-generated run/call pair and no document
build; document/rebuild intents reference the currently admitted, live build
and its active profile. Never accept these facts from an untrusted client body.

After the external call, use a separate worker transaction to call
`recordEmbeddingResult(transaction, request)`. Retain stable event/attempt IDs
when replaying a database result; a new actual provider attempt needs its own
attempt ID. Record missing usage as `source: 'unknown', quantity: null`, never
zero. A cache hit that avoids the provider uses `callState: 'not_called'` with
reconciled token value `'0'`. Known token values are canonical decimal strings
through signed-int64 maximum, including quantities larger than `Number` can
represent exactly. Estimated quantities are not accepted as actual cost.

Append a known correction with `supersedesEventId` instead of updating a fact.
`readEmbeddingAttempt(transaction, attemptId)` returns the original `intent`
and only the current `effective` result, or `null` if no result was recorded.
An interrupted intent therefore remains unresolved, not free. Branching
corrections conflict; exact historical replays remain idempotent. The indexed
read fetches at most three candidates and rejects inconsistent multiple leaves.

Results inherit their committed intent's subject, profile and purpose, even
after deletion, freezing or profile withdrawal, so incurred cost is not lost.
New intents remain fenced. Every D2 event is platform-paid with completion
`none`; this is not customer charging, website budget authority or permission
to retry an ambiguous external call. D3/D4 and C5/C6 supply those later gates.
No provider adapter, real model call or automatic reconciliation is enabled.

## E1 metadata and upload preparation (2026-10-20 pre-HTTP checkpoint)

`createKnowledgeSpace(transaction, resourceId, input)` and
`createKnowledgeDocument(transaction, target, input)` create owner-scoped
metadata through API-only SQL entries. Inputs use the existing strict shared
contract, including lowercase UUIDs. Owner/object-storage fields are not part
of metadata input. Reusing an ID requires the same metadata and parent;
conflicting data or deleted resources cannot be recreated by replay.

`prepareKnowledgeUpload(transaction, request, { maximumFileBytes })` prepares
an initial-upload operation for an empty document. The owner and quota policy
must already be provisioned by a trusted source. The per-file limit is explicit
server configuration, not a client option or a default free entitlement.
The SQL entry locks Quota, Space and Document in that order and checks active
states, generation, single-live operation, pending logical capacity and
platform physical budget before creating an `uploading` intent.

The internal result contains the persisted operation and a fixed opaque
`staging/<owner-sha256>/<operation-uuid>` key, exact declared maximum bytes,
declared format and server-issued 15-minute expiry. No caller chooses an
arbitrary key/bucket. A same-key replay preserves the original operation,
object and deadline, even if the service generated a new candidate operation
ID. Changed requests and expired/cancelled sessions conflict instead of
renewing their authorization. Neither Version nor a ready build is created.

Pending upload declarations count toward logical admission. All operations
still holding a staging key count toward physical admission, including failed,
expired and cancelled work; a state change is not proof an object was removed.
The staging partial index supports an owner-scoped scan capped at 1,001
metadata rows, failing closed on excess or missing declared sizes. Physical
accounting is conservative until the later object-GC protocol proves cleanup.

These are internal service entries, not a network upload feature. HTTP/client
wiring, private object authorization/transfer, completion-time streaming
MIME/size/hash verification, immutable Version creation and queue admission
remain E1/E2 work. Commit preparation before any object-provider I/O, never
hold this transaction across a network call, and never return its internal
staging key as an unrestricted client capability. The optional scoped OSS V4
form path below is separate from basic preparation. Real OSS resources remain
unaccepted; website financial changes remain gated by R3.

## E1 authenticated HTTP and account client (2026-10-20)

The API exposes these bounded JSON actions using the existing account JWT,
owner-scoped transaction and narrow SQL entries:

| Action                          | Method and path                                                     |
| ------------------------------- | ------------------------------------------------------------------- |
| Create/replay space metadata    | `PUT /api/knowledge/spaces/:spaceId`                                |
| Create/replay document metadata | `PUT /api/knowledge/spaces/:spaceId/documents/:documentId`          |
| Prepare/replay initial upload   | `POST /api/knowledge/spaces/:spaceId/documents/:documentId/uploads` |

Use `createSpace`, `createDocument` and `prepareUpload` on the existing
`@genoffice/knowledge-client`; the Shell's lazy account factory inherits them
without adding another login or exposing a renderer token. Keep resource IDs
and the upload idempotency key stable across retries. A new candidate operation
ID with the same declaration/key returns the original operation and deadline.

Upload JSON contains `operationId`, `idempotencyKey`, `expectedGeneration`,
`declaredBytes` and `format`. Counts are canonical signed-int64 decimal strings.
Set `KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES` to an explicit positive byte limit.
Omitting it disables upload preparation with `503 NOT_CONFIGURED`; a present
empty, zero or invalid value fails configuration. This limit is not a customer
entitlement: trusted owner/quota provisioning and financial approval stay separate.

Metadata/upload bodies require one `application/json` Content-Type, a positive
Content-Length no larger than 16 KiB and no content/transfer encoding. Invalid
UTF-8, malformed JSON and unknown fields are rejected before a transaction.
Responses carry no-store/nosniff and no CORS/cookie credentials. Authentication
failure is 401, missing owned resources 404, frozen scope 403, quota/generation
conflicts 409 and unavailable/unconfigured dependencies 503; only stable shared
error codes are returned. DELETE retains its separate 4 KiB journal protocol.

The response contains only the uploading operation and a `prepared` fact with
format, maximum bytes and original expiry. Internal staging keys are omitted.
This is a real HTTP-to-restricted-PostgreSQL preparation path, not fixed-object
authorization, a signed URL, actual file transfer, an immutable Version or E4
ingestion. There is no new dependency, SQL increment, automatic DDL or provider call.

## E1 scoped OSS V4 form and explicit file transfer (2026-10-20)

`POST /api/knowledge/spaces/:spaceId/documents/:documentId/uploads/authorization`
accepts the same declaration as preparation. It revalidates/replays the owner
session through the existing SQL and commits before signing. Missing, incomplete
or expired storage credentials never become a fabricated upload capability.
The basic `/uploads` action still returns no object key or transfer grant.

Enable this optional path only with all seven `KNOWLEDGE_UPLOAD_OSS_*` settings
in the commented API template: dedicated bucket, region, explicit
`VERSIONING=disabled`, short-lived STS AccessKey ID/secret/token and canonical
UTC credential expiry. No SDK, long-lived desktop key or credential refresh
service is introduced. Secrets are API-only; rotate them via the approved host
secret/restart process before expiry. Missing fields, unsupported bucket mode
or credentials with at most 60 seconds remaining fail configuration.

The server constructs the canonical HTTPS OSS bucket host and signs a V4 POST
policy for exactly one persisted staging key and exactly the declared file
bytes (conservatively capped at 5,000,000,000 bytes). Conditions pin the STS
scope, Content-Type, private ACL, forbid-overwrite and 204 result. Expiration is
the earliest of five minutes, the original session deadline and credential
expiry minus 60 seconds; replay never renews the original session. Verify the
real bucket is private, versioning is disabled and RAM permissions are narrow
before deployment: configuration is not proof of cloud resource state.

Use `client.authorizeUpload(target, declaration)` to inspect a scoped grant,
or `client.uploadFile(target, declaration, explicitlySelectedBlob)` to transfer.
The latter validates exact Blob size, preserves the account-bound cancellation
deadline and sends only form fields/file to the validated OSS HTTPS host, never
account Bearer/cookies. Native FormData places `file` last and creates its own
boundary. No redirect, account-token refresh or automatic retry occurs on the
object request; ambiguous/duplicate uploads require later server verification,
not overwriting or assuming a 409 means matching bytes. Large uploads can use
the existing client timeout option up to five minutes. A caller may supply a
file-backed Blob from Node's asynchronous `openAsBlob`, avoiding full buffering.

An object acknowledgment returns `uploaded_to_staging` while Operation remains
`uploading`. It does not create Version, queue work, verify content/MIME/hash or
publish a ready document. E2 must recheck ownership, generation, tombstones and
deadlines while streaming the actual object; existing signed capabilities are
not instantly revoked by a PostgreSQL tombstone. E1 real-OSS acceptance and
E2/E4 remain open. Local tests use an explicit synthetic object HTTP adapter
with synthetic STS material, not a production resource or cloud endorsement.

## E2 bounded text-object verification (2026-10-20)

`verifyKnowledgeTextUpload({ prepared, sourceHash, object }, policy, options)`
verifies a TXT/Markdown staging stream without buffering the whole file or
writing any database facts. Obtain `prepared` through the authenticated,
owner-scoped preparation transaction, commit, then read only that fixed object
through a trusted storage adapter. This helper is not an HTTP request parser
or an OSS reader: never accept a client's object key, ETag or stream metadata
as the trusted `object` response. Opening the storage request also needs its
own authorized, bounded network lifecycle.

The response supplies the exact key, opaque ETag, bigint Content-Length,
Content-Type, optional Content-Encoding and a Node `Readable` body. Policy
requires `maximumFileBytes` and an integer `timeoutMs` from 1 to 300,000;
options may supply a cancellation signal. Key/ETag/format/deadline are frozen
before consuming the stream. Neither object headers nor an expected client
hash can replace inspecting the actual bytes.

Actual size, raw-byte SHA-256, fatal UTF-8, binary controls and nonempty content
are checked in one bounded-memory pass. BOMs and split multi-byte sequences
are handled without changing the source hash. Binary/PDF text masquerades,
unsupported PDF/DOCX/XLSX, compressed representations, conflicting MIME and
invalid metadata fail closed. The stream is destroyed on success or refusal;
session expiry, cancellation and total verification timeout also cover stalled
reads. Storage errors and cancellation reasons never leak to the caller.

The result is only `verified_staging` with the fixed key/ETag, detected text MIME,
declared format, actual source bytes and verified hash. It neither creates
Version nor queues/publishes a Build. The conditional preservation entry below
retains these exact bytes; final E2 completion must still recheck authenticated
owner, generation, tombstones and expiry in a short database transaction.
Do not re-read a mutable key without an ETag condition and treat it as the
verified object. No completion route or real storage configuration is enabled
by this helper. Local tests use synthetic streams and the existing marked
isolated PostgreSQL/HTTP object adapter, not actual OSS or user files.

## E2 conditional text-source preservation (2026-10-21)

`saveKnowledgeTextUpload(input, store, policy, options)` first verifies the staging
stream, then derives `originals/<owner digest>/<document>/<upload operation>` from
the frozen server preparation. The target stays identical across retries. No
client-supplied destination key, bucket or copy capability is accepted here.

The trusted `KnowledgeSourceStore` adapter must use a fixed private bucket with
versioning disabled, enforce source ETag matching and destination non-overwrite,
and replace inherited metadata with the verified MIME and private ACL. It maps
only actual source-precondition failures to `source_changed` and actual target
existence to `exists`; timeouts, unknown failures and provider diagnostics must
not be misclassified as successful copies. The production OSS adapter and bucket
policy acceptance are not supplied by this slice.

Both `copied` and `exists` require opening the actual target stream and rechecking
its exact key, size, encoding, MIME, raw-byte SHA-256 and complete UTF-8 text.
Target metadata hashes and copy acknowledgments are not accepted as proof. Source
changes refuse the copy; existing targets are never overwritten, including after
a lost acknowledgment. Failed attempts leave possible orphan objects for later
authorized reconciliation, not an unsafe compensating delete.

One total deadline covers staging verification, copy, target opening and byte
verification. Caller cancellation, session expiry and synchronous completion
checks stop further steps. Even a non-cooperative adapter cannot hang the caller;
late returned read streams are destroyed. An already-issued external copy may
still finish after cancellation, so cancellation does not prove object absence.

`stored_source` means only that this fixed target's actual bytes passed local
verification. It is not a Version, queue admission, readiness, an HTTP completion
response or a transferable client authorization. All object I/O stays outside
database transactions. The separate completion transaction below now creates
Version and enqueues atomically after rechecking the persisted owner, generation,
tombstones and deadline. Real object integration, E2/E4 and C/D financial
dependencies remain open. Preservation tests use synthetic streams and loopback HTTP only.

## E2 OSS text-source adapter (2026-10-21 local checkpoint)

`createKnowledgeOssSourceStore(config, { now?, fetch? })` implements the trusted
`KnowledgeSourceStore` seam for the existing OSS STS configuration. Production
uses native fetch and a fixed HTTPS virtual-host endpoint derived from the
validated bucket/region, with no configurable origin. Pass only server-derived
staging/original keys and an explicit caller signal; key shape checks do not
replace the owner's database authorization. Configuration is pinned at creation,
and each request rechecks the STS safety deadline before signing.

GET and conditional PUT use header-based OSS V4 signing, including the bucket
in the canonical URI and all OSS security/copy headers. GET exposes a stream,
not a buffered document. It requests identity encoding and refuses redirects,
partial/compressed responses, malformed size/ETag and unexpected version IDs or
object types. Late responses after cancellation are cancelled before exposing
their streams. Provider/transport diagnostics never become public error text.

Copy binds the source ETag and destination owner/operation, sets forbid-overwrite,
private ACL, verified text MIME and replacement metadata. It consumes at most
16 KiB of strict UTF-8 acknowledgment XML and refuses DTD/entity declarations.
A 200 response needs a valid CopyObjectResult; an embedded Error or arbitrary
409/412 is not success. Only FileAlreadyExists/409 and PreconditionFailed/412
map to the existing replay/conflict outcomes. Feed the adapter to
`saveKnowledgeTextUpload`; that function still reads and hashes actual target
bytes after both a copy acknowledgment and an existing-target response.

This local checkpoint tests signed traffic against a synthetic loopback object
server, not a real OSS bucket. Declaring versioning disabled is not a cloud
verification: enabled **or suspended** versioning invalidates non-overwrite
assumptions. Actual bucket versioning/private policy, RAM/STS scopes and hosted
acceptance remain separately gated. No objects are deleted or retried blindly.

The adapter is exported for server use, but no completion HTTP route or automatic
API enablement is added. That route still needs a declaration-bound persisted
replay protocol and a trusted chunk/physical-byte projection. Preparation refuses
already-queued operations, so inventing an uploading phase or accepting client
capacity values is not a valid shortcut. All object I/O must remain outside the
short completion transaction; E2/E4 and financial authorization remain open.

## E2 immutable Version and transactional admission (2026-10-21)

`completeKnowledgeUpload(transaction, { prepared, stored, capacity }, policy)`
accepts only the trusted preparation and `stored_source` result, never raw client
object metadata. Run it inside the existing owner-bound
`withKnowledgeTransaction`. Policy requires an explicit private bucket, an
already-created queue and a positive file limit; capacity contains trusted chunk
and physical-byte projections and its reservation deadline. Object/model I/O
does not occur inside this transaction.

The API-only completion locks follow Quota → Space → Document → Operation →
Reservation. They recheck persisted state, generation, session expiry and the
original declaration hash, bind the original key to the actual owner digest,
and retain all still-keyed staging debt in physical admission. Immutable Version,
desired pointer, capacity reservation and a real reference-only pg-boss job use
the same connection and commit or roll back together. No runtime role receives
direct Version INSERT or upload-job column UPDATE permission.

A native savepoint brackets the write set so a caller that handles a final
capacity refusal cannot accidentally commit an unbound job. It may retry inside
the same transaction without retaining the failed enqueue. Actual SQL errors
still poison the existing trusted transaction; they cannot be swallowed into a
successful commit by savepoint cleanup.

The independent `0006_upload_completion.sql` and `security/upload-completion.sql`
increment records the first queue/job binding in Operation. Identical replay
returns those committed IDs without another Version, reservation or job, even
after queue retention removes the old job or the upload session expires. Changed
source/capacity facts, cancellation, deletion and frozen parents remain refusals.
Unknown commit acknowledgment is resolved by replay, not by an unconditional
second enqueue. Existing applied SQL and receipts are not rewritten.

This is a local transaction slice, not a completion HTTP route, production OSS
adapter, executable paid ingestion or ready result. The job contains owner,
operation, future build and future receipt references only. No BillingReceipt,
Build, embedding call, customer charge or financial authorization is fabricated;
the unchanged worker claim still refuses a missing receipt. C/D financial gates
and E4 handler wiring remain required before a functioning TXT ingestion loop.

## 验证

`npm run test -w @genoffice/knowledge-service` 与
`npm run typecheck -w @genoffice/knowledge-service`；根目录
`npm run test:knowledge` / `npm run typecheck:knowledge` 聚合三个知识 workspace。
The B1 dependency installation uses pinned JOSE/pg and disables install scripts.
Default tests never read user documents, connect to a real database or call a
model. Only `test:database` connects to the marked disposable local cluster.
