# Local knowledge acceptance — 2026-10-19

## Accepted scope

| Tasks | Local deliverable                                                                                | Status                                                             |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A1–A4 | Shared runtime contracts, locators, quantities and commercial snapshots                          | Locally accepted                                                   |
| A5–A7 | Account-bound desktop client, pure authorization/admission policies and workspace wiring         | Locally accepted                                                   |
| B1    | Independent API/worker entries, explicit configuration, JWT/JWKS and read-only connection probes | Synthetic/local acceptance only                                    |
| B2    | 16-table schema, generated artifacts and real local constraints                                  | Locally accepted on the marked isolated cluster                    |
| B3    | Restricted local roles, RLS/FORCE and trusted pool transactions                                  | Local security slice accepted; lifecycle gates open                |
| B4    | Fixed pg-boss protocol, role statement surface and worker reference envelope                     | Local slices accepted; hosted consumer not connected               |
| B5    | Persistent capacity/physical-budget reservation, conversion and release                          | In progress; admission, cancellation, retry and publication slices |
| B6    | Claim, controlled content writes, seal and active-pointer publication                            | Local slices accepted; monetary-budget/queue-attempt binding open  |
| B7    | Independent deletion intent, tombstones and recovery replay                                      | Not implemented                                                    |
| E3    | Strict UTF-8 TXT DocIR and bounded worker execution                                              | Locally accepted                                                   |
| F3–F4 | Markdown and DOCX DocIR                                                                          | Locally accepted                                                   |
| F5    | Text PDF DocIR                                                                                   | Locally accepted                                                   |
| F6    | XLSX workbook inspection and source-bound selection snapshots                                    | Locally accepted                                                   |
| F7    | Simple XLSX DocIR consuming the confirmed F6 snapshot                                            | Locally accepted                                                   |
| J1    | Pinned CI candidate, hashed installable artifact and repository-external clean installation      | In progress; hosted CI not executed                                |

F6 exposes `inspectKnowledgeXlsxWorkbook` and `freezeKnowledgeXlsxSelection`.
Inspection reports visibility, declared/observed dimensions, hidden rows/columns,
formula counts, date system and unsupported features. Selection records the
source hash, explicit hidden-content choice and sheet ranges with a deterministic
snapshot hash. F7 now consumes that snapshot for selected XLSX DocIR. Neither
the parser nor preflight constitutes a functioning cloud import UI or end-to-end product.

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

The latest cumulative checkpoint below passes 851 offline and 586 real-database
cases on each actual Node 25.8.1 and minimum Node 22.13.0 runtime (1,437 per
runtime). Earlier checkpoint counts in this document are historical, not the
current total. No full-repository or hosted-CI acceptance is claimed.

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
cases; complete dual-runtime verification is recorded after the runs finish.

This closes the verified worker lifecycle lock-order slice, not all B6.
Durable current queue-attempt/Receipt and website monetary-budget binding,
atomic queue settlement, external consumers, failed/superseded convergence,
physical GC and independent B7 deletion/recovery remain open. Existing uncommitted
retry/publication work is preserved; no commit, push or deployment is authorized.

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

Detailed local planning and per-task acceptance notes remain outside Git under
`.planning/` and `tmp/`; this document preserves the non-sensitive acceptance summary.
