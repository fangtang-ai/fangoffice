# Local knowledge acceptance — 2026-10-21

This document records local engineering evidence, not cloud or user acceptance.
See [READINESS.md](READINESS.md) for the audited end-to-end gaps and next delivery gates.

## Metadata read HTTP and empty-space tombstones — 2026-10-21

The account client's `listSpaces`, `listDocuments` and `getDocument` now traverse
real local HTTP and the restricted owner-bound API role. Acceptance covers UUID
paging/end pages, active/desired pointers, frozen visibility, parent matching,
owner isolation even with identical IDs, strict query/auth/body/method gates and
storage/credential-free DTOs. Document, space and account deletion hide metadata.

Real Red→Green also fixes NULL space tombstone timestamps when no live child
enters the document loop. The separate `deletion-empty-space` increment preserves
accepted SQL/receipts and changes neither schema nor ACL. Active/frozen empty
spaces and repeated deletion are regression-tested. Local replay is refused
before DDL with its receipt unchanged; the temporary SQL probe is removed.

Final validation: Node 25 passes all 85 knowledge offline files / 1,154 tests
and 8 targeted database files / 23 tests. Node 22.13.0 passes 3 runtime files /
47 tests and the 2 metadata HTTP database files / 11 tests. The three knowledge
typechecks and changed-file strict no-any lint pass. All 32 prerequisite artifact
hashes and the new increment match its receipt; the deployed function body
differs from the original only by the clock line, with owner/ACL/security intact.
The isolated cluster is restored to its initial stopped state; the existing
PostgreSQL service remains running. No full database or Electron regression ran.

This is local engineering acceptance only: no cloud/OSS/model/financial operation,
hosted completion, desktop UI, deployment or commit. E1/E2/B7 and the knowledge
product remain incomplete; READINESS names the next local completion-HTTP slice.

## Accepted scope

| Tasks | Local deliverable                                                                                | Status                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A1–A4 | Shared runtime contracts, locators, quantities and commercial snapshots                          | Locally accepted                                                                                                     |
| A5–A7 | Account-bound desktop client, pure authorization/admission policies and workspace wiring         | Locally accepted                                                                                                     |
| B1    | Independent API/worker entries, explicit configuration, JWT/JWKS and read-only connection probes | Synthetic/local acceptance only                                                                                      |
| B2    | 16-table schema, generated artifacts and real local constraints                                  | Locally accepted on the marked isolated cluster                                                                      |
| B3    | Restricted local roles, RLS/FORCE and trusted pool transactions                                  | Local security slice accepted; lifecycle gates open                                                                  |
| B4    | Fixed pg-boss adapter, consumer and separate one-shot maintenance command                        | Locally accepted; production target/scheduler remain gated                                                           |
| B5    | Persistent capacity/physical-budget reservation, conversion and release                          | In progress; admission, cancellation, retry and publication slices                                                   |
| B6    | Claim, controlled content writes, seal and active-pointer publication                            | Local current-attempt and atomic queued-publication slices accepted; website budget/embedding settlement intent open |
| B7    | Independent deletion intent, tombstones and recovery replay                                      | In progress; local journal/replay, tombstone, HTTP, freeze and build GC slices accepted                              |
| D1    | Exact daily storage byte-time, frozen watermarks/hash and lossless GiB-day conversion            | Locally accepted on the marked isolated cluster; monetary settlement remains separate                                |
| D2    | Durable embedding attempt intents, unknown/actual costs and append-only effective corrections    | Locally accepted; customer settlement and real provider calls remain separate                                        |
| E1    | Owner-scoped preparation, HTTP/account client, scoped OSS V4 forms and explicit Blob transfer    | In progress; local synthetic object transfer accepted, real private bucket/RAM/STS acceptance open                   |
| E2    | TXT/Markdown verification, conditional source copy, immutable Version and atomic queue admission | In progress; local OSS adapter and atomic completion accepted; hosted storage/completion HTTP remain open            |
| E3    | Strict UTF-8 TXT DocIR and bounded worker execution                                              | Locally accepted                                                                                                     |
| F3–F4 | Markdown and DOCX DocIR                                                                          | Locally accepted                                                                                                     |
| F5    | Text PDF DocIR                                                                                   | Locally accepted                                                                                                     |
| F6    | XLSX workbook inspection and source-bound selection snapshots                                    | Locally accepted                                                                                                     |
| F7    | Simple XLSX DocIR consuming the confirmed F6 snapshot                                            | Locally accepted                                                                                                     |
| J1    | Pinned CI candidate, hashed installable artifact and repository-external clean installation      | In progress; hosted CI not executed                                                                                  |

F6 exposes `inspectKnowledgeXlsxWorkbook` and `freezeKnowledgeXlsxSelection`.
Inspection reports visibility, declared/observed dimensions, hidden rows/columns,
formula counts, date system and unsupported features. Selection records the
source hash, explicit hidden-content choice and sheet ranges with a deterministic
snapshot hash. F7 now consumes that snapshot for selected XLSX DocIR. Neither
the parser nor preflight constitutes a functioning cloud import UI or end-to-end product.

## E1 HTTP and account-client preparation — 2026-10-20 (pre-authorization checkpoint)

The existing account-bound client now exposes fixed `createSpace`,
`createDocument` and `prepareUpload` JSON actions. Authenticated PUT metadata
and POST upload preparation endpoints use the previously applied API-only
entries and owner-scoped short transactions. No SQL, migration, receipt,
dependency or role permission changes in this slice.

Declarations and responses use strict shared contracts and exact decimal
int64 strings. Upload preparation requires an explicit positive server byte
limit. Malformed/oversized/encoded bodies and injected owner/object fields
are rejected before a transaction; owner, generation and quota refusals keep
stable HTTP/shared diagnostics. Account-token refresh preserves the original
JSON snapshot and idempotency key; account changes cannot replay under a new user.

Real HTTP through the existing account client and restricted PostgreSQL API
role creates metadata and one committed uploading operation. Same-key replay
with a new candidate operation ID retains the original operation/deadline.
Cross-owner access, quota, generation, missing policy and pre-transaction input
refusals pass. No Version, ready result, object path or upload capability is
returned: `prepared` is explicitly not fixed-object authorization.

Node 25.8.1 validation is targeted: 199 offline cases (58 contract, 65 client,
62 service including independent build/install smoke, 14 Shell account cases)
and six database files / 25 cases pass. The new contract/client/real-HTTP tests
and zero-limit configuration guard were observed failing before implementation.
The new env-template whitelist/population was corrected after build smoke
detected the mismatch. Three knowledge typechecks, Shell typecheck, strict
no-explicit-any lint, touched-file formatting and diff checks pass. No full
service/database, dual-Node, desktop UI or hosted acceptance rerun is claimed.

E1 remains in progress: real fixed-object authorization is still open, followed
by E2 streaming verification/Version/queue admission and E4 ingestion. C1–C6
and D3/D4 financial authority remains separate. The existing marked synthetic
cluster was initially stopped, started only for these checks, then restored to
stopped; the existing PostgreSQL service remains running. No customer funds,
real files/models, cloud operations, commits, pushes or deployments occur.

## E1 OSS V4 authorization and object transfer — 2026-10-20

The production API now has a separate authenticated `/uploads/authorization`
POST action using the same strict declaration. It replays/rechecks the current
owner session and commits its short transaction before creating the form grant.
Its optional configuration requires a dedicated bucket/region, explicit disabled
versioning, complete short-lived STS credentials and an unexpired canonical UTC
deadline. The worker receives none of this configuration. No SDK/dependency,
SQL/migration/receipt or permission change is made.

The V4 policy pins one persisted staging object, exact declared bytes, private
ACL, forbid-overwrite, Content-Type, STS scope and 204 result. The service's
conservative file cap is 5,000,000,000 bytes. The grant lasts at most five minutes
and never exceeds the original session or credential expiry minus 60 seconds.
Real bucket privacy, versioning and RAM state are not established by a config
string and remain subject to approved resource acceptance. Already issued forms
cannot be instantly revoked by a PostgreSQL tombstone.

The existing account client gains `authorizeUpload` and explicit-Blob
`uploadFile`. It validates the scoped OSS HTTPS destination, body size, parent
and immutable form fields. Only form fields/file reach the object endpoint;
there is no account Bearer/Cookie/header reuse, redirect, object-401 account
refresh or automatic retry. Logout/account change cancels transfer and discards
late acknowledgment. File-backed Blob inputs can avoid full-memory buffering.

Public runtime/client tests were observed failing before their entries were
implemented. A fixed signing vector was computed with an independent Python
standard-library reference, then frozen as a literal. Real restricted-role HTTP
authorization verifies original operation/object/deadline replay, owner isolation,
frozen-owner refusal and missing-signer refusal before a transaction. An explicit
synthetic OSS HTTP target verifies the signature/policy, receives real multipart
bytes, rejects overwrite and observes no account credentials. No actual OSS,
real credentials/files, models, money or cloud resource is used.

`uploaded_to_staging` is only an object acknowledgment. Operation stays uploading
with no target Version; E2 streaming MIME/size/hash verification, immutable
Version and transactional queue admission remain open, followed by E4 and its
original C/D financial dependencies. This batch does not claim real-OSS or
end-to-end TXT acceptance; E1 remains in progress.

## E2 text staging stream verification — 2026-10-20

The public `verifyKnowledgeTextUpload` runtime entry consumes a server-prepared
upload and a trusted object-reader response, outside the database transaction.
It pins the staging key, opaque ETag, format and original deadline before I/O.
Explicit positive byte and time limits are required; provider length must match
the exact bigint declaration. This is not a new HTTP completion endpoint or a
production OSS reader, and caller-supplied object metadata is not authoritative.

One streaming pass counts actual bytes, hashes original bytes including a BOM,
and strictly decodes UTF-8 across chunk boundaries without retaining the file.
It refuses binary control characters, PDF signatures, invalid/truncated UTF-8,
empty text, incomplete/excess bodies, mismatched hashes, encoded representations
and inconsistent object metadata. Only TXT and Markdown are supported here;
PDF/OOXML verification fails closed rather than relying on a suffix or ZIP magic.
Cancellation, stalled reads, the original session deadline and the total time
budget destroy the source stream. Errors and abort reasons are sanitized.

The missing public entry was observed failing before implementation. Further
real failing cases covered stalled session expiry, mutable adapter metadata,
invalid completion time and a delayed timer callback. Frozen identity and EOF
clock checks close those gaps. The new integration seam uses the existing
restricted API and account client to upload synthetic bytes over HTTP, replays
the persisted preparation, then reads the real local HTTP object stream. A
same-length tampered body is refused. Restricted SQL confirms no Version is
created and Operation remains uploading after successful verification.

Node 25.8.1 validation: all three knowledge offline suites pass 77 files /
1,049 cases (contract 420, client 73, service 556, including 60 text-verification
cases and independent build/install smoke). Eight targeted database files /
29 cases pass. Actual Node 22.13.0 passes four targeted files / 63 cases,
covering text verification and the existing OSS signer. Three knowledge
typechecks, strict no-explicit-any lint, changed-file formatting and diff checks
pass. This is not a full database, dual-Node full-suite, desktop or hosted run.

`verified_staging` is not completed upload, immutable source storage, queue
admission or readiness. E2 still needs an approved object reader/conditional
immutable copy and a short, owner/generation/tombstone/deadline-rechecking
completion transaction that creates Version and queues work atomically. An
ETag is not a content hash; never re-fetch a mutable key and assume these bytes
are unchanged. E4 and the original financial dependencies remain open.

No dependency, SQL, migration, permission or application receipt changes in
this slice. No actual OSS, real documents/models, customer funds, commit, push
or deployment is used. The marked synthetic cluster was initially running at
PID 8116 and remains running; the existing PostgreSQL service is untouched.

## E2 conditional text-source preservation — 2026-10-21

The public `saveKnowledgeTextUpload` runtime entry verifies staging bytes, pins
the server preparation and derives a deterministic originals key from the owner
digest, document and upload operation. Its trusted fixed-bucket adapter receives
the exact source ETag, destination non-overwrite, private ACL and metadata-replace
requirements. Both successful copy and target-exists replay read back and fully
verify actual target bytes. A matching metadata hash or copy acknowledgment is
not sufficient, and same-length target corruption is rejected without overwrite.
The existing streaming verifier is reused; its public staging behavior remains
unchanged. No production OSS reader/copy adapter or completion route is added.

The missing entry was observed Red before implementation. Seven further failing
cases exposed reset total deadlines, hanging non-cooperative copy/read adapters,
unsanitized adapter domain errors and target reads started after copy cancellation
or expiry. Shared deadline checks and bounded I/O close those gaps; late read
streams are destroyed. Two invalid timeout classification cases also went Red
before correction. Adapter errors and abort reasons remain sanitized.

Three new loopback HTTP cases exercise real staging/target response streams,
conditional-copy headers, a changed source revision, repeated non-overwriting
copies, corrupted existing target refusal and lost-ACK recovery. Unknown copy
outcomes leave possible orphan objects rather than deleting or overwriting them.
Cancellation cannot undo an already-issued external copy. The tests use only
synthetic objects; they do not substitute for real OSS/RAM/versioning acceptance.

Node 25.8.1 knowledge offline suites pass 80 files / 1,080 cases: contract 420,
client 73 and service 587, including 31 new source-preservation cases and the
independent build/install smoke. Actual Node 22.13.0 passes six targeted text
verification/preservation files / 91 cases. Three knowledge typechecks, strict
no-explicit-any lint and changed-file formatting/diff checks pass. No database
suite is rerun in this slice; prior database counts are historical, not new proof.

`stored_source` is not Version creation, transactional queue admission or ready.
E2 remains in progress: production storage integration and the short completion
transaction must still recheck owner, generation, tombstones and expiry, create
Version and enqueue atomically. E4 and the original financial gates remain open.
No SQL, migrations, dependencies, grants or application receipts change. No
database administration, actual OSS, user files, models, funds, commit, push or
deployment is performed in this slice.

## E2 OSS text-source adapter — 2026-10-21 (local checkpoint)

The public `createKnowledgeOssSourceStore` seam now supplies fixed-bucket signed
GET and conditional CopyObject using the existing STS configuration and native
fetch. No dependency, schema, SQL, grants or applied receipts change. Signing was
checked against the official OSS Go V4 implementation and independently worked
Python GET/PUT vectors. Requests sign all copy/security headers, fix the HTTPS
origin and refuse redirects; the caller's signal covers headers and body.

Public tests first observed the missing entry/copy and then construction-time
configuration validation, late-cancelled-stream and redirected-response failures.
The minimal adapter turns those failures green without weakening the upstream
stream verifier or completion transaction. Additional cases verify malformed and
versioned/partial/compressed metadata, exact conflict codes, a 200 embedded Error,
bounded XML/DTD refusal, stalled acknowledgment cleanup, pinned settings, STS
expiry, unrestricted keys and sanitized transport errors. These are local adapter
checks, not claims of previously observed production defects.

Synthetic loopback HTTP sends the real signed GET/PUT headers and object bytes
through this adapter and `saveKnowledgeTextUpload`. Original/replay byte hashes
match, an existing corrupted target is rejected without overwrite, and a real
source-ETag race prevents target reading. This does not exercise Alibaba's remote
service or certify a bucket policy. Versioning must be truly disabled, not
suspended; the local configuration declaration is not a cloud-state probe.

Node 25.8.1 passes 85 knowledge offline files / 1,154 cases (contract 420,
client 73, service 661), including independent build/install smoke. Actual minimum
Node 22.13.0 passes 11 directly related files / 165 cases. The four new adapter
files contain 46 cases. Three knowledge typechecks and strict no-explicit-any
lint on the nine affected code files pass. No database suite is rerun or database
started for this object-only slice; previous database evidence is historical.

Completion HTTP remains separate: the current preparation seam refuses queued
replays, while completion needs the original bound declaration and trusted
chunk/physical-byte projections. This checkpoint does not fabricate an uploading
phase, accept client capacity authority or bypass those remaining contracts.
The deployable API is not automatically enabled by exporting this adapter. Real
OSS resources, customer financial authority and E4 remain gated; E2 stays in
progress. No real files, cloud resources, funds, models, commit, push or deployment
are used.

## E2 immutable Version and transactional queue admission — 2026-10-21

The public `completeKnowledgeUpload` entry consumes trusted preparation and
verified `stored_source` facts inside the existing owner-bound short transaction.
Its independent `0006`/`upload-completion` increment adds paired first-job
references to Operation and two API-only, tenant-bound definer entries. They
retain the existing lock order, RLS and immutable-fact protections; no direct
Version INSERT or completion-column UPDATE grant is added.

Persisted declaration hash, source path/bytes/format, owner and parent state,
generation, tombstones and actual expiry are rechecked after locking. All retained
staging debt participates in physical admission. Immutable Version, desired
pointer, logical/physical capacity and the matching reference-only pg-boss job
commit on one connection or roll back together. Exact replay preserves IDs
without duplicate capacity or work, including after session expiry, queue
retention and native backup/restore. Changed facts, cancellation, deletion,
quota refusal and missing queue cannot create partial committed work.

The missing public entry and real SQL seam were observed Red in the interrupted
implementation before the increment was applied. This continuation preserves
those applied bytes/receipts and validates the candidate rather than replaying
or rewriting its migration. Additional retention, expired-ACK, deletion and
restore checks extend evidence for existing behavior; they are not claimed as
newly observed production defects. The inherited test-fixture literal-widening
type errors are fixed without `any` or weakening the production input type.

A further real restricted-API regression exposed a committed orphan job when a
caller caught the final capacity refusal and then committed its outer
transaction. The runtime now brackets the completion write set in a native
savepoint and locally rolls it back on refusal. The observed Red turns Green;
both handled-refusal commit and retry in the same transaction leave no abandoned
job. This does not relax the existing transaction-poison rule for SQL failures.
Deletion checks use a genuinely published fixture with a consistent storage
event chain, rather than bypassing the tombstone's ledger-consistency gate.

Actual Node 25.8.1 and minimum Node 22.13.0 each pass 81 knowledge offline files /
1,108 cases (contract 420, client 73, service 615), including the independent
build/install smoke. Both runtimes pass the seven completion/atomicity/deletion/
concurrency/recovery database files / 37 cases. Three knowledge typechecks,
strict no-explicit-any lint on the 16 affected code files, 22-file formatting,
Drizzle check and diff checks pass. An expanded service-directory lint also finds
the pre-existing unused `accessToken` import in `runtime-startup-replay.test.ts`;
that unrelated file is not changed or described as a clean whole-service lint.

The frozen Node 25 full database run covers 82 files / 836 cases: 834 pass and
two existing `build-races.test.ts` cases time out in bootstrap trigger-cleanup
table locking, not in completion. All 14 cases in that file pass on an isolated
rerun without code or timeout changes. This is recorded as an intermittent full-
suite cleanup failure, not misreported as an entirely green single full run.

The queued envelope contains only owner/operation/future-build/future-receipt
references. No BillingReceipt, Build, model call or customer charge is fabricated;
real worker claim still refuses the absent receipt. Production OSS adapter,
completion HTTP wiring, financial authorization and E4 remain open. E2 remains
in progress rather than claiming an end-to-end TXT or ready result.

Only the existing marked native `127.0.0.1:55432` cluster and synthetic fixtures
are used. No prior applied SQL/receipt is rewritten; no dependency, real OSS,
model, customer funds, commit, push or deployment is introduced. The cluster is
restored to its pre-interruption stopped state after validation; the existing
PostgreSQL service remains running.

## Reproduction

Run from the repository root:

```sh
npm run test:knowledge
npm run typecheck:knowledge
npm run db:generate -w @genoffice/knowledge-service
npm run db:check -w @genoffice/knowledge-service
npm run test -w @genoffice/electron-utils
npm run typecheck -w @genoffice/electron-utils
npm run test -w @genoffice/shell
npm run typecheck -w @genoffice/shell
npm run build:knowledge
npm run build -w @genoffice/shell
npm run format:check
```

An earlier cumulative checkpoint below passed 851 offline and 586 real-database
cases on each actual Node 25.8.1 and minimum Node 22.13.0 runtime (1,437 per
runtime). These counts are historical; the dated E2 sections describe the current
scope and validation. No full-repository or hosted-CI acceptance is claimed.

The earlier parser/schema checkpoint uses Windows with Node 25.8.1 and npm 11.19.1.
Knowledge tests: 53 files / 771 cases (contract 409, client 60, service 302).
Electron utilities: 13 files / 136 cases. Shell: 27 files / 284 cases.
All five workspace typechecks, changed-file formatting and strict no-explicit-any
lint on the affected sources/tests pass. The affected-workspace total is 1,191
cases. F7 adds 38 XLSX parser cases and extends the existing build test to read
a synthetic XLSX from `dist/parser.mjs` in an independent Node process. Service
build passes; the earlier Shell build acceptance is preserved, not rerun for this
schema-only slice. These are affected-workspace results, not a claim that
the entire repository test chain was executed.

The earlier F6 closeout corrects root workspace-script coverage, removes two unused values,
formats the parser additions and makes the CI artifact list cover every file in
the build manifest, including `markdown-worker.mjs`. Generated `.build/` test
bundles are ignored rather than included in source commits.

F7 verifies source/selection hash binding, raw and displayed values, inherited
styles, formula-cache warnings, date systems, sparse physical locators, merged
anchors, full hidden-content filtering and fail-not-truncate limits. Its XML
dependency is pinned to the already installed `fast-xml-parser` 5.10.1; the
workspace manifest and lock agree, with no unrelated dependency upgrades.

J1's local compatibility slice aligns the service engine, build target and CI to
Node 22.13.0 via `apps/knowledge-service/.node-version`, which is included in the
source hash. An official Windows Node archive is SHA256-checked before execution.
The actual Node 22.13.0 executable passes the 47-file / 758-case knowledge suites,
all three knowledge typechecks and the service build. The build smoke additionally
parses a synthetic text PDF from the bundled parser in an independent process.
This is local minimum-version compatibility, not hosted CI or release acceptance.

The installable-candidate slice adds a standalone `deployment/package.json` and
lockfile, copied to `dist/` after version/engine/dependency checks. `pg` stays pinned
to 8.23.1; its 14 installed runtime packages match the existing repository lock,
with no dependency upgrade. Both installation inputs are source-hashed and
artifact-hashed; the current candidate has 13 explicitly allowed CI files.
The build test copies only that candidate to a fresh OS temporary directory outside
the repository, runs `npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund`,
and exercises TXT/Markdown workers and XLSX/PDF parsing in independent processes.
Neither source-tree dependencies nor development packages are needed at runtime.
API/worker entries reject missing configuration even with unrelated business
database variables set. This passes on actual Node 22.13.0 and local Node 25.8.1;
the temporary directory is removed asynchronously after checking its real path.

J1's offline operations slice adds `check-config.mjs`, separate blank API/worker
environment examples and `OPERATIONS.md`. All 11 primary artifacts are hashed;
the remaining two files are build metadata and the manifest. The preflight bundle
has no external imports and uses only the existing pure parser. Synthetic child
processes verify valid role-only configuration, sanitized invalid arguments and
missing configuration, native `--env-file` loading, unfilled/swapped-role examples,
inherited-variable precedence and missing-file failure on both tested Node versions.
The examples contain no credentials; real secret files stay outside the repository
and artifact directory. The runbook defines approval, migration-entry requirements
and stop/recovery checks without inventing a migration command or claiming a real
injection/rollback rehearsal. Hosted CI, schema/queue and R1–R6 gates remain open.

## B2 offline schema candidate (historical slice)

The 16 `knowledge` tables are declared in `src/schema/index.ts`, with an independent
credential-free `drizzle.config.ts`. Fixed development tools (ORM 0.45.2 / Kit
0.31.10) generate `drizzle/0000_knowledge_base.sql`, its snapshot and journal.
The candidate includes schema creation and 30 NO ACTION foreign keys; profiles,
owner/parent relationships, nullable lifecycle pointers, source/chunk/vector
separation, reservation/evidence boundaries and metering/receipt shapes are
reviewed through public table configuration and generated artifacts.

Six new test files add 13 cases, including a fresh repository-external generation
that must match SQL and snapshot metadata, valid non-partial FK targets, schema
creation and serializable bigint defaults. The reviewed metering FK additionally
binds operation and build together so different rebuild operations of the same
document/version cannot be mixed. Normal generation reports no schema changes;
Kit check passes. These are static/offline assertions, not executed constraint,
RLS, publication, immutability, fault or performance tests.

Actual Node 22.13.0 also passes the current 53-file / 771-case knowledge suites,
all three knowledge typechecks, the service build and Kit check. Local Node
25.8.1 additionally passes electron-utils 136 and Shell 284 cases, all five related
typechecks and strict no-explicit-any lint. Runtime clean-install/build smoke
remains green: schema/Drizzle/SQL are not shipped in the 13-file runtime candidate,
and its deployment lock remains unchanged. See [SCHEMA.md](SCHEMA.md) for review
decisions and the real-database prerequisites.

## B3 offline security candidate (historical slice)

All 15 tenant tables now enable RLS with owner-equality USING/WITH CHECK in both
permissive access and restrictive guard policies. The same unapplied migration,
snapshot and journal are regenerated together. `security/force-rls.sql` supplies
15 explicit FORCE statements separately; it is not applied, journaled or shipped
in the runtime. Profiles remain ownerless and require separately reviewed grants.

The runtime transaction adapter binds only a genuine unexpired principal on one
checked-out client using parameterized transaction-local set_config. The verified
B1 database exposes it through a health-gated transaction method. Synthetic tests
cover rollback/commit and dirty checkout, forged/expired identity, stale handles,
caught failed/unawaited statements, checked-out client errors, rollback failure
and ambiguous commit eviction. No automatic retry or queue adapter is introduced.

Both actual Node 25.8.1 and 22.13.0 pass all 56-file / 803-case knowledge suites,
the three knowledge typechecks, service build and offline schema checks. This
adds 32 cases over B2, including database health failure while awaiting checkout.
The repository-external clean-install/runtime smoke remains green with the same
13-file artifact layout and deployment dependencies. Local Node 25.8.1 also passes
electron-utils 136 and Shell 284 cases (1,223 related cases total), all five related
typechecks and strict no-explicit-any lint. No full-repository test run is claimed.

The proposed role matrix and immutable/seal/GC gate checklist are documented in
[security/README.md](security/README.md). No actual role/GRANT or lifecycle trigger
is provisioned. Public schema/artifact assertions and fake clients cannot prove
real cross-owner/FORCE/role/pool/locking behavior. B3 remains in progress, with
the R2 connection/execution approval and real isolated-database tests still open.

## B2/B3 real local acceptance — 2026-10-16

The user approved a disposable native PostgreSQL cluster in `tmp`, with no
Docker or existing business database operations. The only target is
`127.0.0.1:55432`, `knowledge_isolated`, using an independent PostgreSQL 18.2
runtime copy and locally built pgvector 0.8.7. SCRAM credentials and instance,
migration and recovery receipts remain ignored local artifacts.

The explicit `test:database` suite passes 7 files / 109 cases. These are additional
to the default offline knowledge suites, not fake-pool substitutes:

- Atomic generated SQL + FORCE + restricted local grants, exact artifact hashes,
  refusal to overwrite an existing schema, 16-table membership and vector(1024).
- Four real roles, 15 populated tenant tables, owner A/B/missing/empty, FORCE
  against the table owner, cross-owner writes and restrictive-policy enforcement.
- Runtime DDL/TEMP/TRUNCATE/elevation/profile/lifecycle/financial-fact writes
  denied; only API space metadata is writable, while worker/GC remain read-only.
- Real parent FKs, pointer/quantity/hash/offset checks and vector dimensions;
  genuine pool reuse, rollback, expiry, contamination, disconnection and timeout.
- Native custom-format backup/restore into a fresh marked database, comparing
  16 data fingerprints, ownership, RLS/FORCE, 30 policies and column grants;
  restored runtime credentials still enforce tenant isolation.

Both actual Node 25.8.1 and minimum Node 22.13.0 pass the 803 default knowledge
cases plus 109 real database cases (912 per runtime), three knowledge typechecks
and service build. Local Node 25.8.1 additionally passes electron-utils 136 and
Shell 284 cases, for 1,332 related cases, with all five related typechecks.
Strict no-explicit-any lint, changed-file formatting and generated-artifact
consistency checks pass. No full-repository or hosted CI run is claimed.

Native stop/restart and the three post-restart environment checks pass. The
disposable instance is stopped at handoff, port 55432 is not listening and the
existing PostgreSQL Windows service remains running. Ignored local receipts
record artifact hashes, recovery fingerprints and lifecycle results.

Commit-reply loss is a labeled deterministic injection after a real COMMIT.
It proves eviction and no automatic callback replay, not real network recovery
or a business operation's idempotent reconciliation. No lifecycle race, queue,
external deletion-intent log, website settlement or cloud PITR is inferred.

From the repository root, start only the recognized disposable cluster with
`tmp/knowledge-pg-isolated/manage.ps1 -Action start`, then run
`npm run test:database -w @genoffice/knowledge-service`. The one-time
`db:apply:local` command requires a fresh recognized schema and deliberately
fails on replay. Default `test` and service startup never connect or migrate
implicitly. See [security/README.md](security/README.md) for remaining gates.

## B3 immutable-facts local acceptance — 2026-10-16

The same approved marked native PostgreSQL cluster now has a separate
`security/immutable-facts.sql` increment. The original generated candidate,
FORCE and grants remain byte-for-byte unchanged. The explicit local-only
`db:apply:immutable:local` entry verifies instance identity, baseline hashes and
table ownership/RLS/FORCE, then creates one invoker function and four triggers
atomically, with PUBLIC EXECUTE revoked and a separate ignored hash receipt.
Replay is refused without overwriting either receipt. No runtime grant expands.

The real suite passes 9 files / 206 cases, including 97 new cases. Coverage adds
every profile/original/metering/request-snapshot fact column, DELETE rejection,
unchanged NULL/binary values, allowlisted retention/delivery/reconciliation fields,
mixed-write rollback and default protection for future columns. Temporary narrow
UPDATE grants prove all three runtime roles still hit the trigger without function
EXECUTE; transaction rollback removes the grants and restores original write denial.
Replica-setting and self-reported bypass flags do not bypass the gate. A failed
incremental SQL batch and a failed privileged synthetic cleanup restore the accepted
guards. New BEFORE guards precede owner-reassignment RLS WITH CHECK; protected
tables expect exact `23514/kb_immutable_facts`, while cross-owner INSERT remains
an exact `42501` even under a permissive test policy.

Native backup/restore now additionally compares function definitions, owner/ACL
and all four trigger definitions/enabled states. A real fact rewrite in the
restored marked database is rejected. This does not prove lifecycle-state-machine
correctness, authorized INSERT, seal/publication/GC races, evidence sealing,
business idempotency, website settlement or cloud PITR. Retention/GC and receipt
response fields are only excluded from fact comparison; no new lifecycle or
financial authority is inferred. Future deletion paths still need approval.

Both actual Node 25.8.1 and minimum Node 22.13.0 pass 803 default knowledge cases
plus 206 real database cases (1,009 per runtime), all three knowledge typechecks,
the service build and Kit artifact check. Node 25 additionally passes electron-utils
136 and Shell 284 cases (1,429 related cases total), their two typechecks, strict
service no-explicit-any lint, changed-file formatting and whitespace checks.
No full-repository or hosted CI run is claimed; deployment dependencies and the
13-file runtime artifact layout remain unchanged.

The first Node 22 default-parallel service run had one existing HTTP disconnect
test fail during its 100 ms shutdown allowance. That unchanged seven-case file
passes independently, and all 334 service cases pass with `--maxWorkers=2`.
This records a transient acceptance limitation, not a fix to unrelated HTTP code.

Native stop/restart preserves the gates: all 15 environment/immutable-security
checks pass after restart. The final handoff leaves the isolated cluster stopped,
port 55432 unbound and its postmaster PID file absent; the existing PostgreSQL
Windows service remains running. No Docker, business database, cloud, private
document, paid model, deployment or commit operation is performed.

## B3/B6 building-content freeze prerequisite — 2026-10-16

The same marked native cluster now has the separate `security/build-content.sql`
increment: two new invoker functions and six triggers, with no PUBLIC/runtime
EXECUTE grants, no runtime write expansion and no rewrite of accepted artifacts.
The local-only `db:apply:content:local` entry chains original and immutable-facts
receipts through the shared atomic gate runner; replay and failed DDL leave
accepted receipts/trigger identities unchanged.

The real suite passes 13 files / 305 cases, adding 99 cases. Source units, chunks,
mappings and embeddings accept only INSERT into building/live, unsealed parents
held FOR SHARE; content UPDATE/DELETE and mutation through UPSERT are denied.
Build identity freezes job/retry/generation/target/profile/parser facts, while
sealed snapshot/hash/count/time cannot change after invalidation. Closed states
cannot reopen; direct Build deletion is denied. Failed insertion batches roll
back all their rows. No runtime cleanup bypass is added.

Fourteen real multi-session races observe actual blocking PIDs. Writers block
non-key seal/invalidation/GC state updates; waiting writers recheck the committed
closed state and reject, or proceed when the close rolls back. Shared writers do
not serialize each other; a real lock timeout inserts nothing. Runtime-role tests
show invoker row locks require a parent UPDATE-column privilege, temporarily add
only one count-column grant with INSERT, prove the closure gate remains effective
and roll the grants back. Runtime roles still lack those writes afterward.

Native backup/restore now compares all three function definitions/owner/ACL and
ten trigger definitions/enabled states, then rejects an actual late content INSERT
in the restored marked database. Exact earlier-trigger errors replace old RLS
diagnostic assumptions; they are not misreported as RLS WITH CHECK execution.
The source-offset CHECK test uses INSERT so content immutability cannot mask it.

This slice is not complete B3/B6. It does not implement current document-generation
or queue-attempt/heartbeat checks, budget admission, initial manifest/graph/hash/
offset/vector/coverage validation, valid seal/publication entries, quota exchange,
metering/settlement atomicity or authorized GC/deletion. Recorded fence values
being immutable is not proof that the current operation/attempt is still valid.

Actual Node 25.8.1 and minimum Node 22.13.0 each pass 803 offline knowledge cases
and 305 real database cases (1,108 per runtime), three knowledge typechecks, the
service build and Kit check. Both service regressions use `--maxWorkers=2`, retaining
the previously recorded 100 ms HTTP shutdown-test limitation without changing that
unrelated test. Node 25 also passes electron-utils 136 and Shell 284 cases, for
1,528 related cases total, plus their two typechecks and strict service lint.
Formatting/whitespace checks pass; the 13-file runtime layout and deployment
dependencies stay unchanged. No full-repository or hosted CI run is claimed.

After native stop/restart, 13 environment/build-security checks pass. The final
isolated instance is stopped, port 55432 is unbound and its PID file is absent;
the existing PostgreSQL service remains running. No Docker, existing business
database, website, cloud, private document, paid model, commit or deployment is used.

## B4 pg-boss queue local acceptance — 2026-10-16

The same marked native cluster gained a fixed `pgboss` schema from
`security/queue-pgboss.sql`, applied only through the local maintenance entry
`npm run db:apply:queue:local` (workspace `@genoffice/knowledge-service`).
pg-boss 12.37.1 is pinned from the approved local npm cache; its maintenance
functions are `pg_catalog`-only and it is configured with `createSchema: false`,
`migrate: false` against the verified fixed schema (12.37 partitioned storage
plus the six CHECK constraints restored from 12.37.1 source, and RLS on
`job`/`job_common` guarded by maintenance-role helpers).

Statement-surface evidence: the API role may only INSERT into `pgboss.job`;
the worker role may INSERT and UPDATE only the columns its claim/fail paths
use; the maintenance entry owns the remaining statements. `integration/queue.test.ts`
passes 7/7 (fixed schema, role grants, send/claim/retry/dead-letter behavior on
the real queue). No Docker, existing business database, website, cloud, private
document, paid model, commit or deployment is used.

## B4 queue-envelope local slice — 2026-10-16

`src/runtime/queue-envelope.ts`, exported through `src/runtime/index.ts`, parses
reference-only payloads (`ownerId`, `operationId`, `buildId`, `receiptId`).
`resolveQueueBuild` binds owner, build, operation, job and retry count to the
stored build identity under RLS. A missing or mismatched reference returns
NOT_FOUND; a visible sealed build, non-queued operation or non-pending receipt
is forbidden. Receipt lookup currently verifies owner, existence and pending
status, not the future billing/admission snapshot association.

The checkpoint adds a real restricted-worker regression for a well-formed but
wrong operation UUID: it failed before the query bound `operationId`, then
passed with the binding. `integration/queue-envelope.test.ts` passes 8/8.
This is a B4/B6 supporting slice, not the original B5 capacity-reservation task.

## B6 build-lifecycle local slice — 2026-10-16

`src/runtime/build-lifecycle.ts` exposes `claimBuild`, `writeBuildContent`,
`sealBuild` and `publishBuild` through the public runtime entry. Callers use
`withKnowledgeTransaction`; the standalone worker still performs health probes,
not hosted queue consumption.

`security/build-lifecycle.sql` installs the claim and seal triggers. Claiming
INSERTs a new build identity, not a new operation; the operation's owner,
document, target version, generation and phase must match. Controlled content
INSERTs name the granted columns explicitly. The earlier `build-content.sql`
guard locks the building/live parent FOR SHARE and makes all four derived
content tables append-only; seal/publication use conflicting build row locks.

The seal trigger requires a manifest object and a non-null seal timestamp,
hashes the supplied JSONB manifest representation and computes source-unit,
chunk and embedding counts from stored rows. The caller currently supplies
the timestamp and manifest; the database does not reconstruct a content-digest
manifest or prove coverage/hash/vector completeness. Sealed snapshots cannot
be rewritten and late content writes fail. These are local lifecycle guards,
not full B6 acceptance.

## B6 publication-gate local slice — 2026-10-16

`security/build-publish.sql` (maintenance entry `db:apply:publish:local`)
installs `guard_document_publish`. Publication moves the active pointer to the
existing desired version/operation, increments generation exactly once and
checks live/sealed/non-purged build facts, current generation/profile and active
owner/space state. Shape failures use 23514 `kb_document_publish_gate`.

The worker has column-level UPDATE only on `active_version_id`,
`active_build_id` and `generation`, plus operation `phase`. It cannot set the
admission-side desired columns or document business columns. `publishBuild`
re-checks the facts inside the worker transaction, advances the operation to
publishing, flips the pointer and marks ready. Database errors are mapped at
the transaction boundary. A runtime export regression protects the public
publication entry.

The real queue-driven test covers claim → write → seal → publish. Lifecycle
and security cases cover duplicate/stale publication, missing desired pair,
unsealed build, frozen owner, retired profile and role/shape denials. Native
backup/restore fingerprints include 13 triggers and 6 functions. Tests still
set desired pointers through an explicit bootstrap fixture. The initial-capacity
slice below tests restricted admission separately; full budget admission, quota
conversion, storage events and settlement intent atomicity remain unimplemented.

## Checkpoint verification — 2026-10-16

On actual Node 25.8.1 and 22.13.0, the checkpoint passes 804 offline knowledge tests
(contract 409, client 60, service 335) and 335 explicit real-database tests
across 16 files on each runtime. The operation-reference regression and runtime publication
export each failed before their minimal fixes and pass afterward. All three
knowledge typechecks, strict no-explicit-any lint, formatting and diff checks
pass. The generated schema and applied security SQL are unchanged; temporary
gate-removal probes are excluded from the repository.

## Task numbering and remaining prerequisites

The original task IDs stay fixed: B5 is capacity/physical-budget reservation,
conversion and release; B6 is build lifecycle plus atomic publication, quota and
metering intent; B7 is independent deletion intent, tombstones and recovery
replay. Earlier local notes called the queue-envelope slice B5 and publication
B7. Those labels are historical slice names, not completion of the original
tasks; applied SQL and receipt hashes are deliberately not rewritten.

Original B5 now has initial and replacement capacity/admission slices below;
conversion/release and physical-debt confirmation remain open. Original B6's
budget/metering integration and original B7's deletion/recovery contract remain
open. No hosted consumer, cloud resource, object upload, paid model, billing or
release is accepted by these local tests.

## B5 initial-capacity/admission local slice — 2026-10-16

`src/runtime/capacity.ts`, exported through the public runtime entry, calls the
narrow API-only `knowledge.reserve_initial_capacity` function inside a trusted
transaction. `security/capacity-reserve.sql` is a separate increment applied via
`db:apply:capacity:local`; accepted baseline SQL and receipt hashes are preserved.
The definer is the non-superuser/non-BYPASSRLS FORCE-RLS migrator with a fixed
`pg_catalog, pg_temp` search path, row security on and no PUBLIC EXECUTE. Worker/GC
cannot invoke it and API gains no direct quota/reservation/desired-pointer writes.

Only queued initial uploads with verified live originals, generation zero and
no active build are accepted. Owner and original bytes come from database facts;
chunk and physical-byte projections must be trusted service inputs. Quota →
Space → Document → Operation → Reservation locking serializes capacity decisions.
File/byte/chunk and independent physical limits include outstanding debt; sums
use numeric before comparison to avoid bigint overflow. Counters, a held
reservation and desired version/operation are written atomically.

Forty-seven new real-database cases cover atomic admission, exact/changed replay,
transaction rollback, last-capacity competition, rollback unblocking, concurrent
duplicate convergence, active/physical debt, all limits, bigint overflow, frozen
or deleted state, stale generation, original retention/GC state, cross-owner
hiding, invalid inputs, expired/closed reservations, privilege restrictions,
accepted SQL hashes and migration replay refusal. Races observe actual blocking
PIDs, not timing guesses. Recovery now compares 13 triggers and 7 functions and
executes capacity admission with a real restored API login.

Actual Node 25.8.1 and minimum Node 22.13.0 each pass 804 offline knowledge tests
and 382 real-database tests across 21 files (1,186 checks per runtime). Both pass
all three knowledge typechecks, service build and Drizzle offline check. Strict
no-explicit-any lint, formatting and diff checks also pass. The existing SQL and
accepted receipts remain unchanged; only the new capacity increment is added.

This initial-upload checkpoint is not complete original B5/B6 acceptance: exactly-once
conversion/release, expiry recovery, physical GC acknowledgement and atomic
publication/metering intent remain open. There is no HTTP upload/admission route,
hosted consumer, cloud access, real document upload, paid model or website money
in this slice. Original B7's independent deletion protocol remains unimplemented.

## B5 replacement-capacity/admission local slice — 2026-10-16

The first real API test failed with missing `reserve_replacement_capacity` before
the SQL implementation; the public runtime transaction likewise failed before
its export/implementation. The schema consistency test failed before the new
increment was generated. All three seams pass after their minimal implementations.

The generator adds `drizzle/0001_capacity_projection.sql`, its snapshot and one
journal entry. Existing applied SQL and the original snapshot remain unchanged.
The full projected chunks are persisted separately from positive-delta chunks,
with a CHECK requiring a nonnegative projection for base-bound reservations.
This rejects changed requests even when both normalize to zero incremental chunks.
`db:apply:replacement:local` atomically applies the generated ALTER and the narrow
`security/replacement-reserve.sql` function, hashing both in one new receipt.

The public `reserveReplacementCapacity` shares bounded request validation with
initial admission. The API-only definer remains a non-superuser/non-BYPASSRLS
FORCE-RLS migrator. Quota → Space → Document → Operation/Reservation → Build locks
bind credit to the current sealed/live base and document generation. A second
held reservation for the document cannot reuse that credit, even if the old
operation is terminal or its held reservation expired. Quota admission reserves
only positive byte/chunk deltas and full new physical cost; active debt stays put.
All-dimension non-growth remediation may pass downgraded logical limits, but never
physical limits or corrupted active-base counters.

Fifty-seven real replacement tests cover normalized/full projection replay,
transaction rollback, limits/debt/overflow, downgrade remediation, stale/frozen/
GC facts, repeated base credit, privilege restrictions, CHECK/hash/replay guards
and six actual lock-wait cases. Restore compares 13 triggers and 8 functions and
calls both admission functions with a real restored API login. Actual Node
25.8.1 and minimum Node 22.13.0 each pass 804 offline knowledge tests plus 439
real-database tests across 26 files (1,243 per runtime). Both pass all three
knowledge typechecks, service build and Drizzle check. Strict no-explicit-any
lint, formatting and diff checks pass; the original applied SQL, snapshot and
receipt hashes are unchanged.

This is not complete B5/B6: reservation conversion must share publication's
base/generation/attempt/budget/metering transaction; logical release must revoke
intent and fence writers before capacity is reused; physical debt waits for GC
acknowledgement. No standalone counter adjustment, public upload route, hosted
consumer, real document, paid model, website billing, deployment or commit is
part of this slice. Independent B7 deletion intent remains open.

## B5 controlled cancellation local slice — 2026-10-19

Checkpoint `ba94306` commits the initial/replacement admission work after this
session independently passes its 804 offline and 439 real-database checks. No
local configuration, credentials, receipts, backups or planning files enter Git.

The first real API cancellation test fails before the SQL entry exists; the
public runtime likewise fails before its export/implementation. The new
`cancelCapacityReservation(transaction, operationId)` invokes an API-only
FORCE-RLS definer. Quota → Space → Document → Operation/Reservation → ordered
Build locks bind cancellation to the current desired pair, generation and base.
It atomically invalidates all existing attempts, closes the held logical
reservation, cancels the operation, clears desired and advances generation once.
Logical counters subtract exact held amounts, never clamp underflow. Old active
version/build and active capacity remain unchanged. Full physical reserved and
accounted debt remain until a separately authorized GC acknowledgement.

Expired held debt and frozen owner/space state do not prevent explicit cleanup.
An exact repeated cancellation returns replay without decrementing counters or
clearing a newer intent. Stale generation/base, withdrawn intent, already applied
reservation, insufficient counters and publishing/ready operations fail closed.
A cancelled operation cannot reopen. Claim INSERT now holds an operation SHARE
lock and rechecks phase after waits; content writers retain their existing Build
SHARE lock, so cancellation waits for committed writers and invalidates their
attempts before freed logical capacity becomes visible.

Apply all three explicit local-only increments in order:

```sh
npm run db:apply:cancellation:local -w @genoffice/knowledge-service
npm run db:apply:cancellation-publish:local -w @genoffice/knowledge-service
npm run db:apply:cancellation-worker:local -w @genoffice/knowledge-service
```

Each uses the existing instance/identity/hash/ownership gate and a separate receipt.
The first increment exposed an ambiguous PL/pgSQL row-variable/table-alias name;
the second extracts cancellation facts and corrects the publication
guard without rewriting any applied SQL or receipt. The intermediate state
denies cancellation rather than committing a partial release. The third grants
worker EXECUTE on that read-only invoker query because PostgreSQL checks its
permission even when ordinary publication will not use the cancellation branch.
It exposes no rows beyond the worker's existing RLS/SELECT view; API/GC remain
unable to call it. All three increments are required. Original publication
conditions remain enforced; generation-only
cancellation is restricted to the narrow definer with released reservation and
closed writers, not a caller-set GUC. No new runtime table-write grant is added.

Coverage includes API/runtime cancellation and replay, replacement preservation,
transaction rollback, expired/frozen debt, stale and terminal denials, cross-owner
hiding, direct-write and EXECUTE restrictions, four late content surfaces, and
actual lock waits for duplicate commit/rollback, both claim directions, a content
writer and physical-budget competition. Restore must preserve 15 triggers and
12 functions and exercise both initial/replacement cancellation with a restored
API login, retaining physical debt.

Actual Node 25.8.1 and minimum Node 22.13.0 each pass 818 offline knowledge cases
and all 479 real-database cases across 30 files (1,297 checks per runtime). The
cancellation slice adds 14 offline and 40 real-database cases, including seven
observed lock-wait races. Both runtimes pass the three knowledge typechecks,
service build and Drizzle check. Strict no-explicit-any lint, changed-file
formatting and diff checks pass. Every accepted SQL/receipt hash stays intact;
only the three new cancellation supplements extend the chain. The local cluster
is stopped again at handoff, matching its initial state. No full-repository,
hosted CI, deployment or real-user acceptance is claimed.

This is still not complete B5/B6/F1 acceptance. Conversion and successful
publication must share base/generation/attempt/budget/metering intent. Failed or
superseded operations, queued-job settlement, GC accounting and HTTP cancellation
remain outside this slice. Initial admission still requires generation zero;
the separate capacity-retry entry is accepted in the following slice, not as an
HTTP re-upload or operation-creation protocol.
Independent B7 deletion/recovery and cloud/website billing remain unimplemented.

## B5 explicit capacity retry after cancellation — 2026-10-19

`reserveRetryCapacity` and API-only `knowledge.reserve_retry_capacity` add a
separate capacity entry for a new verified/queued upload at the current positive
document generation. The previous generation must retain a cancelled upload,
closed released reservation and no building/sealed attempts. The new original
must belong to the new operation; neither the old operation nor its reservation
is reopened. Active pointers, competing held debt and unrelated desired intent
prevent admission. Generation-zero initial admission remains unchanged; retained
active replacement retries use the existing replacement entry and base credit.

Quota → Space → Document → Operation/Reservation locking serializes retry with
all previous admission/cancellation paths. Full logical capacity is reserved
again, with the full chunk projection stored; every old physical reserved or
accounted byte remains charged. Numeric budget checks, owner/space/policy/source
checks and post-wait expiry checks fail closed. Exact replay does not charge
again, changed inputs conflict, and a later transaction failure rolls back all
new counters, reservation and desired pointers. Old cancellation replay cannot
erase a new intent. Repeated explicit cancel/retry remains generation-safe, and
a new worker can claim/write while old or recancelled attempts stay fenced.

Apply `npm run db:apply:retry:local -w @genoffice/knowledge-service` only after
all three cancellation supplements, only on the recognized disposable local
instance. The new supplement and receipt extend the complete accepted
identity/ownership/hash chain without modifying any prior SQL/receipt or adding
runtime table-write permissions. Migration replay is refused. Native backup and
restore must preserve 15 triggers and 13 functions and exercise retry, exact
replay and cancellation through a restored restricted API login.

This slice adds 20 offline and 60 real-database cases, including eight observed
blocking-PID races: duplicate retry commit/rollback, predecessor cancellation
commit/rollback, current retry cancellation, old cancellation replay, expiry
after waiting and physical-budget contention. Actual Node 25.8.1 and minimum
Node 22.13.0 each pass all 838 offline knowledge cases and 539 real-database cases
across 36 database files (1,377 checks per runtime). Both runtimes pass the three
knowledge typechecks, service build and Drizzle check. Service source/tests/
integration strict no-explicit-any lint, changed-file formatting and diff checks
pass. Every accepted historical SQL/receipt hash remains intact. The marked local
cluster is stopped again at handoff, restoring its initial state; no full-repo,
hosted CI, cloud deployment or real-user acceptance is claimed.

This does not complete B5/B6/F1. Creating/idempotently accepting new operations,
HTTP retry/re-upload, failed/superseded operation recovery, queue settlement,
successful-publication conversion with budget/metering intent, physical GC,
independent B7 deletion/recovery and cloud/website billing remain unimplemented.

## B5/B6 atomic capacity publication — 2026-10-19

`publishBuild` now uses only the worker-only `publish_reserved_build` function.
The new `capacity-publish` supplement revokes the historical worker UPDATE grants
on active-version/build/generation; API/GC/PUBLIC cannot call the new function.
The old document trigger remains enforced but is not a runtime publication bypass.
This section supersedes the historical direct-worker publication path above.

Quota → Space → Document → Operation/Reservation → sorted Build locking matches
admission/cancellation. The function checks current desired/base/generation,
active owner/space/profile, verified retained original, sealed/live winner,
held reservation, logical projections, physical debt and storage-event continuity.
Actual-minus-base logical usage, reservation closure, active pointers, cleared
desired, generation and operation-ready state commit together. A pending immutable
platform storage event receives the next owner sequence and before/after bytes in
that same transaction. It is not a website authorization, paid embedding event,
customer charge or measured disk usage. Only the consumed physical projection
moves to accounted debt; old and cancelled physical debt remains held/accounted.

Exact winner replay changes nothing, even after another document publishes.
Changed winner/identity, cancelled/expired intent, stale state, over-limit facts,
broken history, event collisions and sequence overflow cannot partially publish.
Later transaction failure rolls all changes back. Tests include grow/shrink
replacement, projected-versus-actual chunks, retry with cancelled physical debt,
ordered multi-document publication, restricted-role security, hash-chain integrity
and migration replay refusal. Seven observed lock-wait races cover duplicate
publication, cancellation in both directions with commit/rollback, and expiry
after waiting. Native backup/restore preserves 15 triggers and 14 functions and
exercises real restored worker publication/replay and direct-write denial.

Apply `npm run db:apply:capacity-publish:local -w @genoffice/knowledge-service`
only after all accepted cancellation/retry supplements, on the recognized
disposable local cluster. No applied SQL, migration or historical receipt changes;
the new supplement and receipt extend the existing chain.

Full B5/B6/F1 remains incomplete. Durable website monetary-budget/current
queue-attempt binding, atomic queue settlement, full writer lifecycle locking,
failed/superseded recovery, physical GC and independent B7 deletion/recovery are
not implemented by this supplement. The local platform event does not authorize
customer billing or hosted deployment.

This slice adds 13 offline and 47 real-database cases, including seven observed
lock-wait races. Actual Node 25.8.1 and minimum Node 22.13.0 each pass all 851
offline knowledge cases and all 586 real-database cases across 40 database files
(1,437 checks per runtime). Both runtimes pass the three knowledge typechecks,
service build and Drizzle check. After the real-queue example separates build
preparation from the fresh publication transaction, that delivery case is
rechecked on both runtimes; these repeats are not additional unique cases.
Strict no-explicit-any lint over service source/tests/integration, changed-file
formatting and diff checks pass. The interrupted synthetic fixture is removed
only after exact ID/profile/state verification through existing transactional
cleanup. The marked local cluster is safely stopped: 55432 has no listener and
its postmaster.pid is absent; the unrelated PostgreSQL Windows service remains
Running. All historical SQL/migration receipts are intact. Changes remain in the
working tree, with no commit, push, Docker operation, cloud access or deployment.

## B6 worker lifecycle lock order — 2026-10-19

A real worker claim → seal → publish transaction racing cancellation reproduced
PostgreSQL `40P01`: the worker held Operation before requesting Quota, while
cancellation held Quota before requesting Operation. This is now a passing
restricted-role regression, not a mocked ordering assertion or timing guess.

Two independent increments extend the accepted identity/hash chain in order:
`worker-lock-order` after `capacity-publish`, then `worker-phase-lock`.
The first introduces owner-bound lifecycle-lock and seal functions, replaces
claim/content locking and removes direct worker Build UPDATE. A second Red
test caught the remaining direct Operation-phase UPDATE bypass; the second
increment revokes it and adjusts claim validation without changing any already
applied SQL or receipt. Both increments are required for this acceptance.

Worker claim/content/seal now take Quota → Space → Document → Operation →
Reservation → sorted Build locks. Preparation and publication can share a short
transaction without reversing cancellation's parent-lock order. The first owner
lock uses the strongest required mode, avoiding a later SHARE-to-UPDATE upgrade.
Same-owner lifecycle writes intentionally serialize; parsing, models and external
I/O belong outside these transactions, with bounded committed content batches.
No throughput benchmark or hosted-consumer acceptance is implied.

`sealBuild` calls only `seal_locked_build`; its counts and manifest hash still
come from the existing seal trigger. The new definers use the non-superuser/
NOBYPASSRLS migrator, fixed search path, `row_security=on` and transaction-bound
owner. API/GC/PUBLIC cannot execute either function. No runtime role has direct
Build UPDATE or Operation-phase UPDATE, and no new base-table write grant is added.

New cases cover claim/content/seal followed by publication while cancellation
waits, content/seal waiting behind cancellation commit and rollback, two worker
seals, whole seal/publication rollback, cross-owner hiding, malformed manifests,
direct-write denial, exact hash chains and replay refusal without changed receipts.
Eight races observe blocking PIDs. Native restore now preserves 15 triggers and
16 functions and exercises restricted worker seal → publish → replay together,
plus direct Build/phase write denial. The slice adds 10 offline and 31 real-DB
cases. Dual-runtime verification is complete: actual Node 25.8.1 and minimum
Node 22.13.0 each pass all 38-file / 392-case offline and 43-file / 617-case
real-database suites (1009 cases per runtime); service `tsc --noEmit` is clean;
new `apply-*.mjs` and `security/*.sql` files carry no credentials or secrets.
The slice is committed as `40d5b2c` (44 files, +3602/−270, single batch because
the retry, publication and lock-order slices share runtime, fixtures and docs,
so intermediate commits could not stay green); nothing is pushed or deployed.

This closes the verified worker lifecycle lock-order slice, not all B6.
Durable current queue-attempt/Receipt and website monetary-budget binding,
atomic queue settlement, external consumers, failed/superseded convergence,
physical GC and independent B7 deletion/recovery remain open.

## B6 durable current-attempt binding — 2026-10-19/20

Recovery of the interrupted slice found that `operation-attempt-binding` was
already applied locally at 16:24:31, despite the pending-looking worktree and
duplicate package script. Replaying it is neither necessary nor allowed.
The duplicate script is removed; commands use the knowledge-service workspace.
The original SQL, generated 0002 migration and accepted receipt are unchanged.

Real restricted-role Red tests reproduced acceptance of a nonexistent Build,
an absent Receipt and unbound envelope resolution. An independent immutable
`operation-attempt-fence` supplement extends the accepted identity/hash chain.
It validates real owner-bound Build and pending Receipt facts under the common
parent locks, rejects competing jobs for one Operation and fences content/seal/
publication. The overwritten fact-based cancellation branch and original
publication metadata-shape check are restored. No runtime table-write grants
are added; the binding definer remains non-superuser/NOBYPASSRLS and FORCE-RLS
scoped. Local same-attempt replay does not mutate the durable binding.

Synthetic fixtures explicitly bind before resolution or publication; no runtime
null-binding compatibility path remains. An old unbound build is retained only
as an adversarial late-publication fixture, not as another valid worker claim.
New cases cover durable replay, malformed/cross-owner identity, pending Receipt,
different-job claim races, content/seal refusal, stale publication, rollback,
gate hashes/replay refusal and native restore.

On October 20, three additional restricted-worker Red cases reproduced rejection
of valid uppercase job, Build and Receipt UUID references as `FORBIDDEN`.
`resolveQueueBuild` now compares the four durable binding components using typed
UUID/integer equality in its existing database query, not incoming UUID text.
Only a true predicate is accepted; null and mismatched bindings still fail closed,
owner text remains unchanged, and no migration or runtime privilege is added.
The three cases and the 40-case binding/security/race/envelope/restore subset pass.

Final frozen-source verification is complete: actual Node 25.8.1 and minimum
Node 22.13.0 each pass 409 contract, 60 client and 402 service offline cases,
plus all 46-file / 652-case real-database suites: 1523 cases per runtime.
Both runtimes pass all three knowledge-workspace type checks, service build and
Drizzle check. Strict no-explicit-any lint, formatting and diff checks pass.
The native restore retains 15 triggers and 18 functions. These are local
synthetic checks, not whole-repository, hosted CI or product-release acceptance.

This closes only local current-attempt fencing. Website budget authorization,
Receipt settlement concurrency, current pg-boss lease validation, explicit
takeover after failed/expired attempts, atomic queue settlement, hosted consumers,
physical GC and independent B7 deletion/recovery remain open. The October 19
continuation inherited a running marked cluster. October 20 verification found
the cluster stopped, started only that marked synthetic instance and restored it
to stopped afterward; its PID file is absent and the existing PostgreSQL service
remains running. No commit, push, deployment, real document or monetary call is made.

## Unverified boundaries

- Only the marked disposable local database is accepted; cloud/database deployment,
  retention/GC state transitions, object upload, billing and model calls are not validated.
  Queue-driven lifecycle writes are validated only on the B6 local slices (claim,
  controlled content writes, effective seal, publication); hosted queue consumers and
  scheduled maintenance are not.
- No private document, production credential, deployment or installer is used.
- R1 and R3–R6 remain outstanding; R2 permits offline generation and this exact local
  cluster with synthetic fixtures, not other targets or existing business databases.
- J1 is a local candidate, not completed deployment or hosted Linux/Windows CI acceptance.
- Minimum Node 22.13.0 and repository-external clean installation pass local Windows
  checks; hosted Linux/Windows execution, production patch selection, configured
  deployment, migration/rollback and release acceptance remain unverified.
- F7 has local synthetic acceptance only; the end-to-end product and F8 remain unfinished.

## B4 transaction adapter and worker consumer — 2026-10-20

`createKnowledgeQueue` uses the fixed pg-boss 12.37.1 statement surface without
starting its scheduler, migrations or supervision. Enqueue, heartbeat, complete
and fail can use the caller's transaction. Claim references include both job id
and retry count; zero affected attempts are rejected rather than reported as a
successful heartbeat or settlement. Queue payloads contain references only.

The bounded sequential consumer is available through the public runtime and
the optional `queue` handler of `startKnowledgeWorker`. It uses the verified
worker pool, aborts a handler after lost renewal or shutdown, never completes
an aborted attempt, and stops heartbeats even if a handler ignores cancellation.
Polling failures fail the service and close the pool; invalid queue setup also
cleans up the database. Failure output is a stable error code only.

Real restricted-role tests cover transaction rollback of enqueue and settlement,
retry fencing, actual consumption, lease-loss cancellation, worker-lifetime
consumption and a handler's own transactional completion without double settlement.
The runnable package keeps the 13-file inventory and now locks `pg` 8.23.1 and
`pg-boss` 12.37.1 as external dependencies. Its repository-external offline clean
installation and parser/entry smoke checks pass.

This batch passes 68 targeted offline cases in eight files and 22 real local
queue/envelope cases in three files on Node 25.8.1, plus service typecheck,
strict no-explicit-any lint, formatting and diff checks. The build and clean
installation are included in that targeted verification. No duplicate dual-Node
or full database regression is claimed for this batch.

This closes the local B4 adapter/consumer batch, not all of B4 or B6. The shipped
CLI has no E4 document handler and remains health-only. Privileged maintenance,
expired-attempt recovery, business publication/financial settlement and actual
TXT ingestion remain unfinished. No applied SQL, role grants or local receipts
are changed; no cloud, private document, model or financial operation is used.

## B4 independent maintenance — 2026-10-20

The separate `maintenance.mjs` entry validates only its own dedicated role/URL and
one explicit existing queue. It runs a single pinned pg-boss supervision pass;
schema creation, migration, scheduler, registration, stats partitions, persisted
warnings, vacuum monitoring and reindex are disabled. It also performs pg-boss
instance-retention housekeeping, so it deliberately requires maintenance rights
that API and worker roles do not receive. No role grants or applied SQL change.

Real synthetic queues verify timeout and heartbeat expiry recovery, isolation of
another queue, rejection of the old attempt after retry claim, and rejection of
maintenance under both API and worker identities. Test-only timestamps are moved
back on those synthetic queue rows to model an already crashed process; the
recovery and fencing themselves execute real database statements. An actual
built maintenance child process succeeds and exits under the existing isolated
migrator identity. Configuration has eight focused refusal/identity cases.

The installable candidate is now 15 files (13 primary hashes plus two metadata
files), adding the maintenance command and blank role-specific template to the
existing inventory. Repository-external offline installation, three-role
configuration checks, parser smoke and unconfigured command refusal pass.

Final targeted verification passes 76 offline cases and a 27-case real queue
combination, followed by one additional real lock-race case (28 distinct real
cases in total). The maintenance file's six cases all pass. The lock-race test
observes completion and heartbeat waiting on real sessions; after completion
wins, the delayed heartbeat is rejected instead of renewing a completed attempt.
Service typecheck, strict no-explicit-any lint, formatting and diff checks pass.

B4 is locally accepted, not production deployment or full ingestion acceptance.
Host scheduling and production maintenance identity still require the applicable
resource/operational approval. E4 remains responsible for its document handler;
knowledge-operation failure/expiry, rebinding and financial settlement remain
B5/B6, not something queue-level expiry recovery can replace.

Detailed local planning and per-task acceptance notes remain outside Git under
`.planning/` and `tmp/`; this document preserves the non-sensitive acceptance summary.

## B7 deletion tombstone and applier — 2026-10-20

The independent deletion supplement adds `knowledge.apply_deletion_intent` as a
separate atomic SQL increment (`db:apply:deletion-tombstone:local`) with its own
local receipt. The function verifies the journaled intent (id, owner, scope)
against the transaction identity, resolves owner/space/document scopes in a
deterministic lock order, and tombstones each published document in the same
transaction as its reservation release: logical files/bytes/chunks return to
zero while `physical_accounted_bytes` and the physical debt stay untouched, the
metering chain appends one closing event with a fresh sequence, and the document
advances generation. Replays converge: an already-applied intent is detected via
its tombstone fact and returns `REPLAY` without re-releasing or re-billing;
unknown scopes return `DELETED` without creating facts.

The runtime applier `createKnowledgeDeletionApplier` binds a verified principal
to the pool and re-parses the intent at the trust boundary; `deleteKnowledgeScope`
keeps the journal-first protocol (append is confirmed before apply, and failures
after confirmation never report success or compensate). Restricted-role tests
verify a published document's tombstone counts and metering events, idempotent
replay, unknown-scope no-op, journal-intent retention across database
unavailability with later convergence, and that a worker cannot clear the delete
fact (a revive update is rejected and the tombstone stays intact). The recovery
fingerprint now counts 19 functions.

This closes the local deletion-intent/tombstone/applier slice of B7, not B7:
no HTTP deletion route, boot-time journal replay wiring, physical GC, freeze
semantics, window metering (D1) or recovery-drill replay (I1) are accepted, and
no hosted consumer, cloud resource, billing or deployment is used. No existing
applied SQL or receipt hash is rewritten; the tombstone supplement keeps its own
receipt.

## B5 failure convergence and stale sweep — 2026-10-20

The failure supplement adds `knowledge.fail_current_build_attempt`,
`knowledge.has_failed_reservation` and `knowledge.expire_owner_stale_operations`
as a separate atomic SQL increment (`db:apply:operation-fail:local`) with its
own local receipt; no applied SQL, migration or historical receipt hash
changes. `fail_current_build_attempt` is worker-only: it re-parses the owner
at the trust boundary and re-verifies the attempt binding, then converges with
the same shape as controlled cancellation — the held reservation becomes
`released`/`closed` with quota reclamation, every `building`/`sealed` build of
the operation is invalidated, the operation lands `failed` with the reported
error code, and generation is left untouched so retry admission keeps using
`expected_generation = current - 1`. Physical accounted bytes and the physical
debt are preserved for GC settlement. Same-attempt replays return `REPLAY`; a
different error code or a cross-owner request returns `FORBIDDEN`. The
publish/cancel gates are re-armed: a worker upload-session failure may
converge from the `draft`/`reserved`/`failed` phases, and later updates
require a prior `failed` phase.

`expire_owner_stale_operations` sweeps one bounded pass: uploader sessions
past `upload_expires_at` converge to `UPLOAD_EXPIRED`; operations with no
bound attempt whose reservation has expired converge to
`RESERVATION_EXPIRED`. Both release the reservation, keep every physical byte
and the physical debt, and never touch bound attempts — queue settlement owns
those. Replays converge nothing. The runtime applier
`createKnowledgeFailureApplier` binds a verified principal and re-parses
intent at the trust boundary; `failBuildAttempt` maps `REPLAY`/`FORBIDDEN`,
`expireStaleOperations` verifies that a second sweep converges nothing.
Integration tests cover SQL convergence, replay, forbidden shapes,
whole-build invalidation on conflict, the runtime applier, sweep behavior
(upload expiry, unbound reservation expiry, bound attempts skipped, future
expiries skipped) and poisoned-owner rejection. The recovery fingerprint went
19 → 22 functions (23 after the rebind supplement).

## B6 queue retry rebind local slice — 2026-10-20

The queue retry rebind supplement adds `knowledge.rebind_operation_attempt`
as a separate atomic SQL increment (`db:apply:operation-rebind:local`) with its
own local receipt. The function re-verifies the current attempt binding at the
trust boundary, takes the established build-lifecycle lock order, and accepts
only the legal re-delivery shape: same job, `retry_count` exactly one above the
still-frozen `building`/`live` abandoned attempt, and a local pending receipt
from the same owner. Stale claims (same attempt, retry jumps, job swaps, sealed
or invalidated old attempts, settled receipts) return `FORBIDDEN`; an already
current binding returns `REPLAYED`. The swap itself is a single guarded UPDATE
on `kb_operations` (job/retry/build/receipt columns) re-checked against the
operation phase and generation; the abandoned build row stays frozen — the
re-armed `guard_build_cancel_fence` accepts only the legitimate retry claim,
`kb_build_current_attempt` rejects inserts or seals under the stale attempt,
and the swap itself never invalidates a build row or advances generation
(retry admission stays with the caller's `expected_generation` check).

`guard_build_cancel_fence` is re-armed so a worker claim on the retry attempt
is accepted while every other stale claim stays rejected; the frozen abandoned
attempt cannot insert or seal content (`kb_build_current_attempt` rejects it
and cross-owner facts stay hidden). Restricted-role integration tests verify
the rebind transition, idempotent replay, forbidden shapes, fence acceptance
of the legitimate retry claim, and publish-gate binding checks. The recovery
fingerprint now counts 23 functions.

This closes the local queue-retry rebind slice of B6, not B6: real lease
windows, site budget accounting and queue settlement (D1 metering intents)
remain open, and no hosted consumer, cloud resource, billing or deployment is
used. No existing applied SQL or receipt hash is rewritten; the rebind
supplement keeps its own receipt.

## B7 HTTP deletion route and boot-time replay — 2026-10-20

The HTTP supplement wires `DELETE /api/knowledge/deletions` into the bounded
knowledge API: requests are method-gated (`Allow: DELETE`), body-capped at
4 KiB, parsed at the trust boundary (malformed JSON or unknown scopes map to
400 without touching the database or the journal), and authenticated before
any data access. `deleteKnowledgeScope` keeps the journal-first protocol:
a database failure after journal confirmation leaves the intent pending and
never reports success. The journal directory is created by the service; a
missing configured directory denies `NOT_CONFIGURED` instead of silently
serving.

Boot-time replay is wired into `startKnowledgeApi`: before the listener
accepts requests, the persisted journal is replayed per intent with a
short-lived replay principal built from the intent's own owner, and any
non-converging intent refuses readiness. The clock that authenticates
principals is threaded from the authentication options through the handler
into `deleteKnowledgeScope` and `withKnowledgeTransaction` (via a new
optional clock on `KnowledgeDatabase.transaction`), so deterministic offline
tokens behave like production.

The replay trust boundary now refuses to converge an intent whose owner does
not match the applier principal (`SERVICE_UNAVAILABLE`, intent stays
pending): a stranger replay can no longer tombstone someone else's document
or clear the journal — the tombstone SQL scopes every cursor by the
transaction owner, so a mismatched replay resolves zero facts and used to be
miscounted as convergence. Restricted-role integration tests cover the
confirmed-delete happy path (journal record before database convergence,
tombstone counts), malformed-scope rejection without database access,
boot-time replay convergence from a reopened journal, stranger refusal with
pending retention, and method gating after authentication. Offline 44
files/425 tests and database 53 files/686 tests are green; the recovery
fingerprint stays at 23 functions, and no new SQL increment, receipt or hash
is introduced.

This closes the HTTP-route/boot-replay slice of B7, not B7: physical GC,
freeze semantics, window metering (D1) and recovery-drill replay (I1) remain
open, and no hosted consumer, cloud resource, billing or deployment is used.

## B7 physical build GC — 2026-10-20

`security/build-gc.sql` adds `knowledge.collect_purged_build(requested_owner,
requested_build, requested_time)`, a SECURITY DEFINER maintenance entry
granted only to `knowledge_gc` (worker/api/public stay denied with 42501).
The function re-verifies the lock order used by admission and cancellation
(Quota→Space→Document→Operation→Reservation→Build) with a defensive replay
guard on `gc_state = 'purged'`, and only converges builds whose operation
has reached a terminal phase (`ready`/`failed`/`cancelled`/`deleted`) and
that are no longer the live build of an undeleted document. Orphaned held
reservations are released defensively before ledgering. The physical debt
is cleared on the matching ledger column: reservations converted by
publication (`applied`) subtract from `physical_accounted_bytes`, while
failed/cancelled/tombstoned/expired reservations subtract from
`physical_reserved_bytes`. The build row is sealed to `purged` with
`purged_at` under the one-way `guard_build_state` trigger, and the deletion
protocol facts (`kb_documents.deleted_at`, delete operations) plus
version/source `gc_state` are left untouched for later object-level
reconciliation slices.

The runtime supplement `createKnowledgeGcApplier(pool).collectPurgedBuild`
runs the call on a dedicated connection (the transaction-scoped owner
binding happens inside the SQL function), maps every non-converging status
through `deny` (`INVALID_REQUEST`/`NOT_FOUND`/`FORBIDDEN`, anything else
`SERVICE_UNAVAILABLE`) and treats `REPLAY` as an already-settled historical
replay. Restricted-role integration tests cover the published-debt path
after the deletion protocol (accounted 16→0 with idempotent replay and
tombstone facts preserved), the failed-debt path (physical reserve 16→0
without touching accounted), refusal for the actively serving build and for
operations still converging, role denials for worker/api, unknown-owner
`NOT_FOUND` without ledger changes, and the runtime applier's
PURGED/REPLAY/NOT_FOUND mapping. Offline 44 files/425 tests and database 54
files/694 tests are green; the recovery fingerprint moves to 24 functions
with 15 triggers unchanged, and the deletion-protocol/tombstone SQL, prior
receipts and hashes are untouched.

This closes the physical-GC slice of B7, not B7: freeze semantics, window
metering (D1) and recovery-drill replay (I1) remain open, and no hosted
consumer, cloud resource, billing or deployment is used.

## B6 atomic real-queue publication — 2026-10-20

`publishQueuedBuild(transaction, queueName, job, envelope)` joins the existing
publication protocol to the real pg-boss attempt on the caller's trusted worker
transaction. It reconstructs immutable Build identity and the durable current
job/retry/Receipt binding instead of accepting publication fields from the job.
It takes the established Quota → Space → Document → Operation → Reservation
→ Build locks before locking the queue row. After that lock has been acquired,
it checks the actual active retry, expiry and heartbeat against
`clock_timestamp()`, and reparses and compares the persisted reference-only
envelope. UUID references compare by value, while owner text remains exact.

The attempt-aware pg-boss completion must affect exactly one row before the
existing publication function runs. Queue completion, document CAS, quota
conversion and the storage event use one connection and one transaction.
Errors must propagate to `withKnowledgeTransaction`; a caller must never catch a
failed publication inside the transaction and then commit. An expired task is
rejected even if maintenance has not yet changed its `active` state. A real
queue-row lock-wait test proves the expiry check runs after the wait, not against
the transaction's starting clock or a pre-lock snapshot.

The adapter uses only the already-authorized shared `pgboss.job_common` table
from the pinned 12.37.1 installation. Other partitions fail closed; there is no
new migration, role grant, receipt, dependency or automatic maintenance command.
The new real-database cases cover successful publication, uppercase UUIDs,
attempt/heartbeat expiry, persisted-envelope mismatch, stale retry, wrong queue,
rollback on reservation rejection, rollback after publication, and a real
queue-row lock wait. All 58 real-database cases across five directly related
queue/publication files pass, including the 10 new cases; 35 offline cases across
four consumer/worker/transaction files also pass. Service typecheck, strict
no-explicit-any lint, touched-file formatting and `git diff --check` pass. There
is no dual-Node or full-suite rerun; the historical 695-test full-suite result
is not a new full-suite run.

This closes the real-queue final-publication slice, not B6. The low-level
`publishBuild` remains a knowledge-domain primitive; E4 must use
`publishQueuedBuild` rather than treating a local pending Receipt as monetary
authority. Website budget/renewal, embedding settlement intent, authenticated
website reconciliation and a real TXT ingestion handler remain unaccepted. No
customer charge, model call, hosted deployment or cloud resource is used.

## I1 deletion journal replay into restored database — 2026-10-20

The recovery drill (`integration/recovery.test.ts`) now covers the
independent deletion journal on top of the physical restore. A deletion
intent is appended to a fresh file journal after the backup is taken and
`knowledge_isolated_restore` is rebuilt from it, so the backup predates the
intent and the restored database still sees the document alive. The journal
is then replayed through the real boot-time path —
`replayKnowledgeDeletionJournal` with `createKnowledgeReplayPrincipal` and
`applyKnowledgeDeletionIntent` inside a `knowledge_api` transaction on the
restored database — and converges `DELETED`: the document carries
`deleted_at` and the owner quota reports zero active and zero reserved
files/bytes. A second replay of the same journal converges idempotently
(`REPLAY` → `DELETED`) without resurrecting the document or adding a single
metering event, proving the file journal alone is a sufficient trust anchor
when the database rolls back. `recovery-receipt.json` gains
`deletionJournalReplay: true`.

typecheck fixes along the way: the freeze-matrix status helper now asserts
its row shape explicitly (`KnowledgeTransaction.query` returns
`unknown[]`), and the replay applier binds the runtime pool to a const so
the closure keeps the narrowing. The full database suite is green at 55
files/695 tests (freeze matrix included); the offline suite is untouched.
This closes the deletion-journal replay slice of I1, not I1: the restore
manifest for PG/OSS objects, account-cancellation journal replay,
stale-attempt invalidation and isolation drills remain open, and no hosted
consumer, cloud resource, billing or deployment is used.

## D1 exact storage windows — 2026-10-20

The existing independent `storage-window` SQL supplement and generated
`0003_storage_window` partial unique index are now connected through the public
`closeStorageWindow(transaction, request)` runtime entry. It returns a shared-
contract-validated persisted observation and an exact GiB-day integer quotient
with its byte-millisecond remainder. Neither quantity passes through `Number`.
The applied SQL, migration and their receipt hashes remain unchanged.

Windows are half-open Asia/Shanghai calendar days stored as UTC instants. The
Quota-first lock serializes closure with publication, replacement and deletion.
Only the first capacity-change day can open the chain; subsequent days must be
contiguous, including unchanged and zero-capacity days. Sequence, before/after
capacity, watermark and event-set hash are frozen. Invalid, future, skipped,
conflicting or late-fact windows fail closed, as does a day with more than
10,000 capacity changes. A day is integrated from events rather than repeatedly
scanning files or rounding individual spans.

Real publication/deletion and replacement/deletion cases verify that logical
storage stops at the tombstone while physical debt remains. COMMIT/ROLLBACK
lock-wait cases observe actual blocking sessions. Worker-only execution,
owner isolation, frozen/closed-owner accrual, immutable observations, replay,
transaction rollback, uppercase UUIDs and large exact quantities pass. The
native backup now contains a closed window; the restricted restored worker
replays that exact observation and advances the next watermark without
duplication. Recovery fingerprints contain 25 functions and 15 triggers.

Validation on Node 25.8.1: 8 directly related database files / 41 tests pass;
the full service offline suite passes 45 files / 444 tests, including the
latest-increment SQL/snapshot regeneration and independent build/install smoke.
Service typecheck, strict no-explicit-any lint, touched-file formatting,
Drizzle check and diff checks pass. This is not a full database, dual-Node,
desktop, hosted or financial acceptance run.

The tariff revision must come from trusted server-side configuration; this
entry does not authenticate a website price or authorize spending. A pending
customer-attributed observation is not a customer charge, and GiB-day remainder
is not website money. C1–C6 and D2–D4 still provide product, budget, embedding,
outbox and receipt/settlement authority. There is no automatic daily scheduler,
real model call, cloud resource, customer charge, commit, push or deployment.

## D2 embedding attempts and effective usage — 2026-10-20

The interrupted D2 slice is complete locally. The original query-intent SQL
test first failed before the independent `0004_embedding_attempt` indexes and
worker-only `record_embedding_event` supplement were applied atomically. A
second real failing test preceded the public `recordEmbeddingIntent`,
`recordEmbeddingResult` and `readEmbeddingAttempt` runtime entries. No previous
SQL or application receipt is rewritten, and no runtime role gains direct
metering writes. There is no new dependency or provider call.

Intent commits are observable across transactions before any provider response.
An intent-only interruption remains unknown; result interruption rolls back.
Cache no-call is reconciled zero, timeout is unknown NULL, and failed/completed
calls retain their observed cost. Query run/call and all three document/rebuild
purposes preserve profile/subject identity. Late costs survive tombstones,
frozen owners and profile withdrawal while new intents are rejected. Values
above 2^53 round-trip exactly as text, and malformed, estimated, fractional,
negative, nonfinite or overflowing quantities are refused.

Append-only corrections replace the effective usage leaf rather than adding
to it. Historical replays remain exact after later corrections; conflicting
IDs/outcomes, unrelated predecessors, intent corrections, correction branches
and attempts to revise proven no-call results are refused. Real two-session
lock waits cover committed/rolled-back duplicate intents and competing
corrections. RLS owner isolation, fixed definer configuration, PUBLIC/API/GC
denial, immutable facts and increment receipt/replay checks pass.

The native backup includes a corrected attempt and an interrupted intent.
The restricted restored worker reads the same effective leaf, replays original
intent/result/correction without duplication and records unknown usage for the
interrupted intent. Existing storage-window recovery remains green. Recovery
fingerprints now contain 26 functions and 15 triggers.

Validation on Node 25.8.1: 10 directly related database files / 61 tests pass,
including 7 embedding files / 36 tests, native recovery and adjacent storage/
current-attempt regression. The full service offline suite passes 46 files /
469 tests, including latest-increment SQL/snapshot regeneration and isolated
build/install smoke. Service typecheck, strict no-explicit-any lint, touched
formatting, Drizzle check and diff checks pass. This is not a full database,
dual-Node, desktop or hosted acceptance run.

D2 only records platform attempt costs with completion `none`. C5/C6 and D3/D4
still govern customer budgets, logical charging, outbox and receipts; no real
funds, models or documents are used. The marked local cluster remains at its
original running PID 13128, and the existing PostgreSQL service stays running.
No commit, push or deployment is performed; E4 TXT ingestion is still open.

## E1 metadata and fixed-object upload preparation — 2026-10-20 (pre-HTTP checkpoint)

C1's R3 financial schema/migration authority is still unapproved. The companion
website branch was inspected read-only and remains clean; no website database
command, product-constant-only shortcut, financial entity or migration is
changed. Work continues on the E1 local preparation seam explicitly allowed
by the original task list, without treating it as an E4 or financial bypass.

A real failing public-runtime test preceded the three API-only metadata and
upload preparation entries. Generated `0005_upload_preparation` adds only the
owner/still-keyed-operation partial index; it and the independent narrow SQL
supplement were applied atomically to the existing marked synthetic cluster.
All previous SQL and receipts remain unchanged. No dependencies or direct
document/operation writes are added.

Private spaces/documents and an uploading operation persist atomically, with
no Version, active pointer or ready result. Strict metadata validation rejects
owner/bucket injection. Same metadata replays; changed metadata/parent, missing
owner, inactive state, tombstones and wrong generation fail closed. Upload
request hashes, object key and 15-minute deadline are server-generated.
Same-key replay keeps the original operation/key/expiry, not a new lease.

Admission checks file/byte limits, an explicit server per-file limit, aggregate
pending declarations and the physical budget. Failed/cancelled/expired staging
metadata retains physical debt until actual cleanup is proven. The indexed
scan has a 1,001-row bound and rejects incomplete/excess prior metadata. Real
two-session COMMIT/ROLLBACK waits verify duplicate sessions and a competing
upload's capacity recheck. Interrupted metadata/session/pointer changes roll
back together. API-only execution, RLS and receipt/hash/replay checks pass.

Native backup/restore replays the prepared upload using a new candidate ID
without changing the original session/object/deadline. Existing storage and
embedding recovery stays green; fingerprints now contain 29 functions and 15
triggers. Node 25.8.1 validation: 8 targeted database files / 32 tests pass,
including 5 upload files / 22 tests, recovery, failure and deletion regression.
Four directly related offline files / 37 tests pass across targeted runs,
including SQL/snapshot regeneration, isolated build/install and existing HTTP
behavior. Typecheck, strict no-explicit-any lint, formatting, Drizzle check and
diff checks pass. No full-service, full-database or dual-Node rerun is claimed.

At this earlier checkpoint, HTTP/account-client wiring and real fixed-object
authorization were not delivered; see the newer E1 HTTP section for the former.
E2 streaming MIME/size/hash verification,
immutable Version and transactional queue admission are not implemented.
There is no signed upload URL, object transfer, real file/model call, customer
charge, commit, push or deployment. The marked cluster remains at its original
running PID 13128; the existing PostgreSQL service also remains running.
