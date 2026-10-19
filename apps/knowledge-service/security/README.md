# B3 local security review — 2026-10-16

R2 now permits one disposable native cluster under `tmp/knowledge-pg-isolated`,
on `127.0.0.1:55432`, without Docker or existing business databases. The candidate,
FORCE supplement and restricted local grants have been applied there. Real roles,
all 15 populated tenant-table boundaries, transactions and recovery are tested.
B3 remains in progress: four-table fact immutability and build/content freezing
and claim/seal/publication guards are implemented locally, but complete sealing
validation, budget admission, deletion/GC protocols and production privileges remain open.
No cloud/deployment/private-document/financial approval is
implied by local success.

## Executed local slice

`local-grants.sql` is explicitly local-only. Runtime roles are non-owning,
NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB/NOREPLICATION with no memberships.
They can read the 16 enumerated tables; RLS applies to the 15 owner-bearing tables.
API additionally inserts only space owner/id/title and updates only title/time.
This baseline gives worker/GC no writes; later explicit supplements grant the
worker controlled content, seal and publication columns, as detailed below.
All runtime roles lack DDL, TEMP, TRUNCATE,
trigger/RLS disabling, profile writes, original/content/lifecycle/receipt/metering
mutation and elevation paths. PUBLIC rights on the isolated postgres/template1
databases are revoked; this never changes the existing PostgreSQL service.

The original 109 explicit database tests include real login, owner A/B/missing/empty on
every populated tenant table, FORCE on the table-owning migrator, cross-owner
INSERT/UPDATE/DELETE, owner reassignment, rollback-only permissive-policy widening,
cross-owner/same-owner wrong-parent FKs and constraint SQLSTATEs. Real pool tests
cover COMMIT/ROLLBACK identity reset, dirty checkout eviction, swallowed errors,
expiry, backend termination and row-lock timeout. Commit-reply loss is a clearly
labeled deterministic injection after a genuine COMMIT, not a real network
failure or proof of business idempotency. There is no automatic callback replay.

Native pg_dump/pg_restore into a fresh marked database verifies all 16 data
fingerprints, ownership, flags, 30 policies, column grants and runtime RLS.
This does not validate external deletion intents, outbox/queue/financial recovery
or production PITR. See `../integration/` and the local recovery receipt.

## Executed immutable-facts supplement

`immutable-facts.sql` is a separate, explicit increment; it does not rewrite the
accepted generated migration, FORCE supplement or grants. The local-only
`db:apply:immutable:local` entry verifies the marked cluster's system identifier,
baseline artifact hashes and table ownership/RLS/FORCE, serializes its application
and rejects replay. Function creation, PUBLIC EXECUTE revocation and all four
BEFORE UPDATE/DELETE row triggers share one migration-role transaction. A separate
ignored receipt records the baseline and increment hashes. No startup path runs it.

The shared function is SECURITY INVOKER, with `search_path = pg_catalog`, no runtime
EXECUTE grant, no elevated queries and no session-controlled bypass. It compares
old/new rows after excluding only the following mutable columns; newly added
columns are protected by default. Unchanged values, including NULLs, are allowed.
All four tables reject DELETE with SQLSTATE `23514`, constraint `kb_immutable_facts`.

| Table                 | Mutable columns (not additional SQL grants)                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `kb_index_profiles`   | None                                                                                                            |
| `kb_versions`         | `retain_until`, `gc_state`, `purged_at`                                                                         |
| `kb_metering_events`  | `delivery_state`, `delivery_attempts`, `next_attempt_at`, `delivered_at`                                        |
| `kb_billing_receipts` | `status`, `site_receipt_id`, `confirmed_at`, `site_amounts`, `reconciled_at`, `next_reconcile_at`, `updated_at` |

This is a fact gate, not an INSERT, seal, publication, retention-state-machine or
financial gate. Receipt response amounts remain website reconciliation transport;
the settlement request snapshot/hash/tariff stay frozen. Runtime roles still cannot
write these tables. A future authorized retention/GC deletion path needs separate
review; this default denial neither chooses a retention period nor promises
permanent storage. Trusted migration owners/superusers can change DDL and are not
made untrusted by these triggers.

The immutable-facts slice raised the suite to 206 real cases, adding 97. Its SQL tests cover
every fact column, deletion, legal mutable fields, mixed-write
rollback and future-column protection. Transaction-local temporary grants prove
the triggers execute for API/worker/GC even without function EXECUTE; the grants
are rolled back and the original write denial is rechecked. Replication-setting
bypass is denied. A failed SQL increment and a failed privileged fixture cleanup
restore the original guards transactionally. Synthetic cleanup alone may temporarily
disable exactly the named guards under bootstrap within its cleanup transaction;
it restores them before commit and exposes no runtime bypass.

Native backup/restore compares function definitions/owner/ACL and all four trigger
definitions/enabled states, then rejects an actual original-fact rewrite in the
restored marked database. This is local synthetic recovery, not cloud PITR or
financial reconciliation. Owner reassignment on protected tables is rejected by
the BEFORE trigger before RLS WITH CHECK; cross-owner INSERT still proves the
restrictive policy rejects the write even with a permissive test policy.

## Executed building-content supplement

`build-content.sql` adds two invoker functions and six triggers. The explicit
`db:apply:content:local` entry uses the shared local gate runner, verifies the
original and immutable-facts hash receipts, applies the new artifact atomically
and records a separate receipt. Neither accepted SQL nor runtime grants change.
All functions keep a catalog-only search path and no PUBLIC/runtime EXECUTE grant.

- SourceUnit, Chunk, ChunkSources and Embedding accept only INSERT when the exact
  owner/build parent is building/live and has no seal/manifest. The row trigger
  takes Build FOR SHARE, not KEY SHARE, until the writer's transaction ends.
- All four content tables reject UPDATE, DELETE and mutation through UPSERT,
  even while building. Retries use separate builds; no runtime cleanup bypass is
  introduced. A bad later row rolls the entire insertion batch back.
- Build ownership/target/operation/job/retry/generation/profile/parser/schema/time
  facts are frozen by the existing immutable-facts function. Future columns freeze
  by default. Building counts may change; after sealed_at is set, the snapshot,
  hash, counts and seal time cannot change, even after invalidation.
- Closed/invalidated/purged builds cannot become building again; invalidated/purged
  builds cannot be relabeled sealed, and GC pending/purged cannot return to live.
  Build DELETE is denied until a separate authorized GC path exists.

Fourteen real multi-session tests observe `pg_blocking_pids`, rather than guessing
with sleeps. Writers prevent even non-key state UPDATE until they end; waiting
writers read the committed sealed/invalidated/pending/purged state and reject.
Rolling back a close lets the writer proceed. Independent writers share the parent
without serializing; a real lock timeout leaves no inserted row. Future seal/GC
validation entries still must take FOR UPDATE before validating the frozen set.

These are database write/freeze prerequisites, **not a complete lifecycle API**.
They freeze recorded generation/attempt identifiers but do not verify the current
document intent, queue claim/heartbeat/attempt or budget. Initial seal still has
only existing shape checks, not complete graph/hash/offset/vector/coverage checks.
There is no new publication or deletion authorization, queue integration or quota
protocol. B3/B6 stay incomplete; runtime roles remain read-only except API space
metadata. Invoker FOR SHARE additionally requires UPDATE on at least one Build
column: real tests first prove rejection without it, then grant one count column
temporarily, verify closure enforcement and roll all grants back. This is not a
production grant recommendation.

The complete real suite has 305 cases, 99 new in this slice. RLS error precedence
is explicit: protected Build owner changes fail the fact guard; child INSERT with
an invisible parent fails the writable gate; child owner updates fail the append-only
gate. Cross-owner reads/updates/deletes still see no rows and restrictive policies
remain installed; these earlier trigger errors are not labeled RLS WITH CHECK proof.
The offset CHECK test now uses INSERT so the append-only guard cannot mask it.

Native backup/restore compares all three functions and ten trigger definitions,
owners/ACL/enabled states, then rejects a real late content INSERT in the restored
marked database. Failed gate DDL restores original trigger identities. Privileged
synthetic fixture cleanup suspends only explicitly allowlisted table/trigger pairs
in one transaction and restores them before commit. No broad disable, runtime
bypass, business database, cloud or Docker action is involved.

## Tenant policy candidate

All 15 owner-bearing tables enable RLS and declare two `FOR ALL TO public`
policies, with the same owner equality in both `USING` and `WITH CHECK`:

```sql
owner_id = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))
```

`owner_access` is permissive; `owner_guard` is restrictive, so an additional
permissive policy must not widen the owner boundary. Absent/empty identity does
not match any non-null owner. `TO public` names a policy audience, **not a SQL
privilege grant**. `kb_index_profiles` has no tenant owner/policy and must be
read-only to runtime roles through separately reviewed grants.

The generated SQL/snapshot/journal express ENABLE and the policies. Kit 0.31.10 /
ORM 0.45.2 do not represent FORCE in this schema declaration, so `force-rls.sql`
is an explicit, separate supplement for exactly those 15 tables. It is not in
the generated journal or shipped in the runtime package. The local migration
entry explicitly applies and hashes it alongside generated SQL and local grants.
An approved migration entry must account for both artifacts and inspect actual
`pg_class.relrowsecurity`, `relforcerowsecurity`, policies and effective grants.

FORCE subjects a table owner to RLS; it does not constrain superusers or
BYPASSRLS. RLS does not protect TRUNCATE or replace SQL privileges, composite
parent FKs, freeze/tombstone checks, lifecycle gates or current authorization.

## Trusted transaction boundary

`database.transaction(principal, work)` requires the independently verified,
healthy B1 database. `withKnowledgeTransaction(pool, principal, work)` is the
lower-level adapter used by it; its pool must already be a dedicated approved
connection pool, not a request-selected DSN or a website pool.

- Validate the genuine, frozen principal before and after checkout, after owner
  binding, before each query and before commit. Spreading the object cannot
  reproduce the authentication adapter's WeakSet membership.
- Acquire one client; reject/evict any pre-existing session owner rather than
  resetting contamination and pretending it did not occur. Begin an explicit
  READ COMMITTED transaction and bind the verified subject using parameterized
  `set_config(..., true)`. Never construct a transaction from `pool.query`.
- Only expose a query handle during the callback. Await every statement; pending
  or caught failed queries forbid COMMIT. Returning or retaining the handle
  does not keep it usable after the callback/transaction ends.
- Roll back failed work; evict failed-BEGIN, failed-rollback, still-pending or
  broken connections. Handle checked-out client error events as well as B1's
  idle-pool errors. A failed COMMIT is ambiguous and always evicts the client.
- Sanitize driver diagnostics to SERVICE_UNAVAILABLE and preserve policy error
  codes. Do not automatically retry: ambiguous commit needs the operation's
  idempotency/reconciliation protocol, not an unconditional callback replay.

The callback is **trusted server SQL**, not a SQL sandbox. Never pass request
SQL, transaction control, session settings, SET ROLE or unreviewed functions to
it. A custom setting is not a database-verifiable JWT: a process holding the
runtime credential can select an owner. Worker identities must be reconstructed
from trusted persisted ownership, not arbitrary job/request payload fields.
Model, object-store and billing network calls stay outside short DB transactions.
Queue same-client integration, timeouts, retry and lifecycle locking remain B4–B6.

## Proposed responsibility matrix (not applied grants)

Outside the approved local slice, role names, memberships and exact
column/function grants still need approval.
Do not turn this table into broad `GRANT ALL ON ALL TABLES` or shared credentials.

| Responsibility | Intended access                                                                                                                       | Must not receive                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Migration      | Own/review schema, policies, approved lifecycle gates and DDL                                                                         | Runtime process credential exposure                                                           |
| API            | Owner-scoped reads, metadata/operation admission, verified version registration, evidence snapshots and controlled lifecycle requests | Arbitrary derived-content writes, profile mutation, GC bypass or unrestricted publication     |
| Worker         | Claimed-task inputs, isolated building content insertion and controlled seal/publication                                              | Owner/original mutation, deletion markers, arbitrary active-pointer changes or DDL            |
| GC             | Approved metadata scheduling and controlled cleanup of non-active, reclaimable products                                               | Active/unsealed content rewriting, clearing deletion facts or bypassing owner/retention gates |

API/worker/GC must be non-owners, non-superusers and NOBYPASSRLS, with no
CREATEROLE/CREATEDB/REPLICATION, TRUNCATE, trigger-disabling, schema creation or
membership/SET ROLE path to elevated privileges. Profile writes belong to a
separately approved configuration/migration path. pg-boss maintenance privileges
are reviewed separately; `migrate: false` is not evidence of least privilege.
Cross-owner queue/GC discovery must use a specifically reviewed, bounded control
path, not a permissive tenant policy or a blanket BYPASSRLS service credential.

## Remaining lifecycle gates

These are still execution prerequisites beyond the fact supplement:

1. Add authorized INSERT and retention/GC state-transition gates around the now
   immutable Version original facts and Profile configuration. Do not grant broad
   writes or interpret the mutable-column allowlist as lifecycle authorization.
2. Complete valid generation/queue-attempt and budget admission around the
   executed claim/content/seal gates (B6 below). Writers already take Build FOR
   SHARE; future seal/invalidate/GC validation entries take FOR UPDATE,
   **not FOR KEY SHARE**.
3. Validate counts, source graph/offsets, hashes, vectors/profile and coverage
   before initial sealing. Late INSERT, content UPDATE/DELETE and sealed-fact
   rewrites are guarded by the B6 gates; a seal protocol that validates vector
   and coverage quality beyond the database-recomputed facts is still open.
4. Protect frozen evidence snapshots and add delivery/reconciliation lifecycle
   authorization around the now immutable metering facts and settlement requests.
   GC cannot clear tombstones or independent deletion-intent facts.

Follow the approved Quota → sorted Space/Document → Operation/Reservation → Build
→ queue-attempt lock order, including budget-updating batches. Any privileged
function/trigger requires reviewed EXECUTE grants, qualified objects, safe
search_path and owner/fence checks; naming it SECURITY DEFINER is not a solution.

## Full real-database acceptance checklist

- Approve target, server/vector versions and dimension, actual role identities,
  grants, network, command scope, migration/recovery entry and synthetic fixtures.
  Do not use the website database, private documents or paid model calls.
- Inspect effective role attributes/memberships, ownership/default privileges,
  schema/function rights, all 15 RLS+FORCE flags and policies. Prove runtime roles
  cannot DDL, TRUNCATE, disable triggers or escalate; prove profile writes fail.
- With real API/worker/GC credentials, attempt cross-owner SELECT/INSERT/UPDATE/
  DELETE, owner reassignment, same-owner wrong parent and absent/empty identity.
  Include a test-only permissive policy to prove the restrictive guard still wins.
- Reuse actual pool connections A→B after COMMIT and ROLLBACK; verify the setting
  is absent/empty outside the transaction. Exercise dirty checkout, expiry,
  disconnect, failed rollback, ambiguous commit and role/session tampering.
- Using separate real sessions, race batch writes against seal/GC/publication,
  obsolete generation/queue attempts and deletion/freeze. Verify protected facts
  and snapshots cannot mutate, only eligible GC succeeds, and failure rolls back
  pointer/quota/metering/queue changes together. This also depends on B4–B7.

Default tests inspect public table configuration/generated artifacts and use
synthetic clients. Only the separate `test:database` entry executes the approved
local PostgreSQL slice described above; lifecycle races still remain open.
Reference contracts: PostgreSQL 18 row security and configuration functions,
Drizzle pgPolicy/enableRLS (installed 0.45.2 declarations), and node-postgres
transactions/client release. Confirm the actual server version before execution.

## Executed pg-boss queue slice — B4 (2026-10-16)

The queue driver is validated on the flagged isolated cluster only. The new
maintenance entry `npm run db:apply:queue:local`
(integration/apply-queue-local.mjs) first installs the fixed pg-boss 12.37.1
schema under the knowledge_migrator credential (createSchema+migrate, no
supervise/schedule timers), creates the `b4_validate` validation queue, then
applies security/queue-pgboss.sql through the shared gate runner with
immutable-facts and build-content as prerequisites and a replay probe
(`pgboss.guard_queue_access()`). It never touches the knowledge runtime grants.

Fixed-schema facts: pg-boss 12.37 replaces the flat `pgboss.job` with partitioned
storage (`job` parent + `job_common` for non-partitioned queues) and 12.37.1
adds six CHECK constraints, a runtime queue-table-properties function and
RLS-protected maintenance functions; a suite test pins the exact build.

Statement surface proven by tests: runtime roles see only `job_common` and
`queue` reads plus writes on `job_common` (api: INSERT; worker:
INSERT/UPDATE/DELETE) and INSERT on the partitioned parent `job` — required
because fail()'s dead-letter CTE references the parent even when `dead_letter`
is NULL. All pg-boss functions are SECURITY INVOKER, so table grants are the
real boundary; api cannot claim (UPDATE denied, 42501 proven). Every pgboss
table owner stays knowledge_migrator; migrate:false is not relied upon.

Queue behavior proven on real credentials: a `transactional` send() joins the
caller's knowledge transaction (same pg_backend_pid), rolls back with it, and
withKnowledgeTransaction maps non-policy failures to SERVICE_UNAVAILABLE;
committed rows are consumed in the same session. Settlements are keyed by
(id, retryCount): stale complete/touch affects 0 rows, retryLimit > 0 reactivates
through `retry` with a 1s retry-delay floor, retryLimit 0 is terminal `failed`
with output `{value:{message},retryCount}` and state history. work() on
supervise:false/schedule:false instances auto-settles — handler return completes,
handler throw fails (budget 0 → terminal) — without touching maintenance tables.

Results: integration/queue.test.ts 7/7; full local database suite 14 files,
312/312; service typecheck clean.

Integration decision: bind PgBoss to the existing runtime pools with
`schema:'pgboss'`, `db:{executeSql}`, `createSchema:false`, `migrate:false`,
`supervise:false`, `schedule:false`; schema installation stays in the dedicated
maintenance entry and roles follow security/queue-pgboss.sql.

## Executed B4/B6 supporting slices — 2026-10-16

The queue envelope and build/publication guards are local sub-slices of the
original B4/B6 tasks. Original B5 remains capacity reservation/conversion/release;
original B7 remains independent deletion intent/tombstones/recovery replay.
Historical B5/B7 labels in applied SQL do not renumber those tasks.

`resolveQueueBuild` binds owner/build/operation/job/retry identity under RLS.
Its checkpoint regression first demonstrated acceptance of a mismatched
operation UUID and now verifies NOT_FOUND through a real worker transaction.
Receipt validation currently checks the same owner, existence and pending state;
billing snapshot association belongs to the future admission/settlement path.

`security/build-lifecycle.sql` (entry `db:apply:build-lifecycle:local`) installs
claim/seal gates. Claim INSERTs a fresh build row matching the existing operation.
Explicit content INSERT column lists match worker grants; `build-content.sql`
locks a live building parent FOR SHARE and rejects UPDATE/DELETE of all four
content tables. The seal trigger hashes the supplied JSONB manifest and counts
stored units/chunks/embeddings; it requires but does not generate the seal time.
It does not independently validate complete coverage or content/embedding hashes.

`security/build-publish.sql` (entry `db:apply:publish:local`) installs
`guard_document_publish`. The worker receives only the three active-pointer
UPDATE columns and operation phase; desired-pointer and document business
columns remain ungranted. `publishBuild` in `src/runtime/build-lifecycle.ts`,
exported through `src/runtime/index.ts`, checks desired pair, generation,
sealed/live build, current profile and active owner/space before advancing phase
and flipping the pointer within the same transaction. Invalid SQL shapes fail
with 23514; forbidden columns fail with 42501.

Real pg-boss delivery covers claim/write/seal/publication. The recovery
fingerprint now checks 13 triggers and 8 functions. These tests are local-only;
the earlier publication fixtures still supply desired pointers through bootstrap,
while the B5 slice below exercises restricted initial-upload admission separately.
Full capacity reservation/conversion/release,
quota/metering atomicity, full seal validation, retention/GC state transitions
and independent deletion intent remain open. The standalone worker does not
consume hosted jobs. See `../ACCEPTANCE.md` for the current task mapping and
checkpoint validation; no migration or role grant is run on service startup.

## B5 initial-capacity local slice — 2026-10-16

`security/capacity-reserve.sql`, applied only by `db:apply:capacity:local`, chains
the accepted immutable/content/lifecycle/publication receipts. It adds one narrow
SECURITY DEFINER function owned by `knowledge_migrator`, which remains subject to
FORCE RLS, non-superuser and non-BYPASSRLS. The fixed search path is
`pg_catalog, pg_temp`, row security stays on, objects are schema-qualified and
PUBLIC EXECUTE is revoked. Only API receives EXECUTE; worker/GC do not. No runtime
role receives direct quota, reservation or desired-pointer writes.

The function derives owner and original bytes from trusted facts, locks
Quota → Space → Document → Operation → Reservation, checks initial-upload state
and active/reserved/physical limits, then atomically reserves counters and admits
the desired pair. Numeric sums avoid bigint overflow before denial. Replay must
match the held reservation exactly; expiry/closure never silently clears debt.
Real API connections cover last-capacity competition, rollback and duplicate
operation convergence using observed lock waits rather than timing guesses.
The native restore check also calls this function through a restored API login.

Chunk/physical projections remain trusted service inputs. Conversion/release,
expired-reservation recovery, authorized GC, website money,
and atomic publication/metering are not implemented. The function is not an
HTTP admission endpoint and does not complete original B5 or B6.

## B5 replacement-capacity local slice — 2026-10-16

`db:apply:replacement:local` verifies the entire accepted initial-admission chain
and atomically applies generated `drizzle/0001_capacity_projection.sql` plus
`security/replacement-reserve.sql`. Its receipt records both exact hashes;
previous SQL and receipts are not rewritten. The new full projected chunk field
is CHECK-protected for base-bound reservations, including when their positive
delta is zero. Schema regeneration starts from the accepted previous snapshot.

`knowledge.reserve_replacement_capacity` is API-only EXECUTE with the same
non-bypass FORCE-RLS migrator, fixed search path, row security and PUBLIC revoke
as initial admission. No direct write grant is added. Locking follows Quota →
Space → Document → Operation/Reservation → base Build, with originals held FOR
SHARE. It derives current base/bytes from locked facts, verifies generation and
queued replacement state and reserves positive bytes/chunks plus full physical
cost. Another held reservation for the document blocks a second base credit even
if its operation is terminal or its deadline expired.

Non-growth remediation may pass reduced logical limits, never the physical hard
limit. Numeric sums reject bigint overflow; exact replay compares the full chunk
projection, base, generation, physical amount, expiry and desired pair. Actual
lock waits cover duplicate convergence, rollback, changed projection, committed
quota debt, base invalidation and deadline expiry. The native restored API login
also exercises both capacity entries and the new projection column.

This is not the conversion/release protocol. No active bytes are reduced, no
physical debt is cleared and no metering or website settlement is invented.
Publication still needs same-transaction base/generation/attempt/budget checks,
reservation conversion and metering intent. Cancellation/expiry release must
first fence old intent and writers; it is not a standalone decrement endpoint.
