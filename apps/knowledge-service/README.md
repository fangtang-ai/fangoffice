# Knowledge service (policies, isolated runtime and local data-domain slices)

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
exit code. The runtime still ships the same 13 files with `pg` as its only external
dependency; no Drizzle tool, table definition or migration is imported by the API,
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

The code-only candidate contains six `.mjs` entries (`api`, `worker`, `check-config`,
`parser`, `text-worker` and `markdown-worker`), `package.json`, `package-lock.json`,
`api.env.example`, `worker.env.example`, `OPERATIONS.md`, `build-meta.json` and
`build-manifest.json` in `dist/`. It requires Node >=22.13.0,
bundles the parser dependencies and JOSE/shared contracts, and retains pinned `pg`
as its only external package. The installation manifest and lock in `deployment/`
must match the service version, engines and `pg` dependency before building.
Installation files, templates and the runbook are included in the source and
artifact hashes and the CI upload allowlist. Desktop builds do not import these entries or include service
credentials. These files are a runtime candidate, not a deployment image or approval.

To reproduce an installation, copy only those 13 files to a new directory outside
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

## 验证

`npm run test -w @genoffice/knowledge-service` 与
`npm run typecheck -w @genoffice/knowledge-service`；根目录
`npm run test:knowledge` / `npm run typecheck:knowledge` 聚合三个知识 workspace。
The B1 dependency installation uses pinned JOSE/pg and disables install scripts.
Default tests never read user documents, connect to a real database or call a
model. Only `test:database` connects to the marked disposable local cluster.
