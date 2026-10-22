# Knowledge runtime: configuration and recovery preparation

## Status and authorization

This is an offline J1 candidate, not a deployment or migration approval. R1 covers
resources, R2 knowledge database/schema commands, R3 website financial changes,
R4 privacy, R5 commercial policy and R6 release/stop/recovery authority. Record the
approved target, actors and command scope before any real operation. Do not infer
approval from a passing preflight or from this document.

There is no knowledge schema or migration runner in this candidate. The runtime
library supports an explicitly supplied queue handler, but the shipped worker
CLI does not yet wire an E4 ingestion handler and must not be treated as an
operational document consumer. Its locked external packages are `pg` 8.23.1 and
`pg-boss` 12.37.1; queue creation and privileged maintenance are not API/worker startup actions.
An explicit single-pass `maintenance.mjs` command is available with separate
maintenance credentials and one required queue name; it does not create schemas,
run migrations, register instances, schedule jobs or rebuild indexes.
Accepted local B2/B3/B4/B6 slices do not provide deployment or migration acceptance
for this runtime artifact. No production `migrate`, `down`, queue-maintenance or
restore command is supplied or implicitly run on startup.

## Optional OSS uploads

Optional E1 object transfer is code-enabled only after the complete API-only
`KNOWLEDGE_UPLOAD_OSS_*` block is configured. It uses short-lived STS credentials,
not a desktop credential or SDK-managed secret provider. Verify the approved
dedicated bucket's private access policy and **disabled versioning** before
enabling: OSS ignores forbid-overwrite for enabled/suspended versioning.
No real bucket/IAM verification is performed by this candidate. Never enable it
against an existing business/update bucket to work around missing resources.

Use a canonical UTC credential expiry and rotate/restart before the final
60-second safety margin. Partial/expired configuration fails preflight. Redact
the full policy/token/signature/form grant from logs and traces: the issued
capability is a bearer secret until its short expiration. It binds one key,
exact bytes, private ACL and no overwrite; the earlier PostgreSQL upload deadline
is never extended. A tombstone cannot instantly revoke an already issued form.
E2 must still revalidate and stream-check the object before immutable Version
creation/queue admission. An upload acknowledgment is not ready/searchable data.

## Candidate inventory

Copy only the explicit CI candidate files to a new versioned directory outside the
repository: seven `.mjs` files (`api`, `worker`, `maintenance`, `check-config`, `parser`, `text-worker`,
`markdown-worker`), two package files, three `.env.example` templates, this document,
`build-meta.json` and `build-manifest.json` (15 files total). Never copy a whole
deployment directory, a real environment file or a repository `node_modules`.

Check the manifest against the trusted release record and verify all 13 primary
artifact hashes before installing or executing them. Hashes detect changes, not
publisher authenticity. Installation uses the included lock:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

The local synthetic test additionally uses `--offline` and fails without cached
dependencies. It is not evidence of a production installation. Use the separately
approved supported Node patch; 22.13.0 is the minimum compatibility-test target,
not a production security recommendation.

## Role-specific configuration and secrets

The examples deliberately leave identity, database and credential settings blank;
unedited examples must fail. An operator copies each template to a separate
absolute path outside the repository and candidate directory, then fills it from
the approved secret/configuration store. Do not overwrite the shipped templates.
Give only the corresponding service identity access using OS ACLs/permissions;
do not mount the worker DSN into the API or the API DSN into the worker.

- Both roles use the approved dedicated knowledge database name, never a website
  database. Each DSN must match its explicit database and role and include a
  password; percent-encode reserved characters in credentials. DSN query options
  such as `sslmode`/`options` are rejected. Production TLS verifies certificates;
  provision approved trust separately, never disable verification to make it work.
- The API additionally needs the pinned issuer and existing logical API audience.
  Set required scopes only to permissions actually provisioned by the account
  service; a template does not create a new scope or product entitlement.
- The API defaults to loopback. A public listener, proxy/TLS routing and ingress
  policy require separate approval. The worker needs no issuer or HTTP listener.
- E1 upload preparation additionally requires an explicit positive canonical
  `KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES` decimal byte limit (at most signed-int64).
  Omit the variable to disable preparation; leaving it present but empty, zero
  or malformed fails preflight. It does not provision an owner, quota, budget,
  storage credential or fixed-object grant. The PUT metadata and POST preparation
  endpoints return preparation facts only; no file transfer or E4 handler is enabled.
- Maintenance uses only `KNOWLEDGE_MAINTENANCE_DATABASE_ROLE` and
  `KNOWLEDGE_MAINTENANCE_DATABASE_URL`, never API/worker or generic PG credentials.
  `KNOWLEDGE_QUEUE_NAME` must be one existing explicit queue, not a wildcard.
  The maintenance actor needs queue metadata and retention/instance housekeeping
  rights; ordinary API/worker roles deliberately cannot run this command.
- `DATABASE_URL`, generic `PG*` variables, website configuration and `NODE_ENV=test`
  do not provide missing knowledge settings or enable isolated-test exceptions.
- There is no custom dotenv loader, secret provider, `_FILE` setting or key
  rotation mechanism. A supervisor may supply a dedicated process environment or
  a trusted secret-backed environment file; never put DSNs in command arguments,
  logs, CI artifacts, crash reports or source control.

Node's `--env-file` is relative to the working directory unless given an absolute
path, fails if the file is missing, and gives inherited environment variables
precedence over file values. File contents can also configure Node through
`NODE_OPTIONS`. Therefore use only trusted operator-managed files, a dedicated
service environment with no stale knowledge/Node overrides, and the same immutable
configuration revision for preflight and launch. This is not an upload-file parser
or a sandbox. Never use an optional-file flag or source the file as shell code.

## Offline preflight and gated launch

From the candidate directory, substitute the approved absolute secret paths:

```sh
node --env-file=/protected/knowledge-api.env check-config.mjs api
node --env-file=/protected/knowledge-worker.env check-config.mjs worker
```

Preflight parses only the selected role's configuration. It opens no socket,
database or JWKS connection, imports no driver, performs no migration and prints
only `knowledge-api configuration valid` or `knowledge-worker configuration valid`.
Invalid configuration/arguments yield exit 1 and only `NOT_CONFIGURED`; a missing
environment file fails in Node before the script. Neither outcome dumps secrets.
Success does not prove connectivity, role grants/RLS, token validity, product
rights, schema compatibility, queue readiness or secret rotation.

Only after the applicable approvals and external checks, the corresponding launch
commands would be:

```sh
node --env-file=/protected/knowledge-api.env api.mjs
node --env-file=/protected/knowledge-worker.env worker.mjs
```

Launch makes a real database connection and a read-only database/session-role
probe before readiness. The API exposes `/healthz`, `/readyz` and authenticated
`/api/knowledge/status`, not working business routes. The shipped worker CLI only
performs health probes; library callers can explicitly supply the B4 consumer
handler, with attempt-fenced heartbeats and cooperative cancellation. SIGINT/SIGTERM request bounded cleanup; failed cleanup is
not a successful stop. Record the release/configuration revision and sanitized
outcome, never a raw environment or DSN. Stopping a real process also needs the
approved operational scope.

## Explicit queue maintenance

For an approved existing schema/queue only, validate the separate maintenance
configuration without connecting, then explicitly run one pass:

```sh
node --env-file=/protected/knowledge-maintenance.env check-config.mjs maintenance
node --env-file=/protected/knowledge-maintenance.env maintenance.mjs
```

An independently approved host scheduler can invoke it at the queue monitor cadence
(60 seconds by default); this candidate does not install a scheduler. Queue-level
expiry/heartbeat recovery and retention obey pg-boss database-side interval claims.
The pass also prunes stale pg-boss instance metadata, but does not touch knowledge
content or independently settle its financial/operation facts. A missing queue or
privilege/connection failure returns a stable error and nonzero exit, not success.
The local synthetic verification uses the existing migrator identity, without
granting maintenance privileges to runtime roles or creating a production actor.

## Production migration entry: requirements, not an implemented command

The development-only `db:apply:local`, `db:apply:immutable:local`, `db:apply:content:local` and
`test:database` commands now exercise
the approved marked native cluster in `tmp`, including atomic candidate/FORCE/
grant application and pg_dump/pg_restore. They refuse arbitrary DSNs, existing
schemas and unrelated restore targets. Their local receipts and successful
stop/restart do not designate a production migration actor, cloud backup/PITR,
financial/outbox reconciliation or deployment approval. The immutable-facts
increment checks the accepted local baseline, preserves its hashes and records
its own receipt; it does not grant lifecycle writes or run during service startup.
The content increment also checks the immutable-facts receipt and records its own
hash chain; shared local migration checks do not make these a production runner.

After R2 and B2/B3 are approved, designate exactly one independent migration entry
using a separate approved migration identity, not API/worker credentials. Require
an explicit target database and expected current/next revision, consistent generated
schema/SQL/journal/snapshot from the pinned tooling, concurrency exclusion and a
reviewed backup/restore checkpoint. Review locks, failure boundaries and grants
before execution; do not handwrite an entire generated migration from this plan.

API/worker startup, restart, health checks, preflight and shutdown must never invoke
this entry. A failure stops rollout and preserves evidence; it must not silently
retry against a different database or borrow the website migration provider.
No current command claims to verify any of these future properties.

## Stop and recovery checklist

1. Before release, record approved artifact/config/schema revisions, backup and
   restore-test evidence, traffic/worker stop order and the named recovery actor.
2. Failed install or preflight: leave the running release untouched; correct the
   candidate or secret revision. Do not alter schema to make configuration pass.
3. Failed gated startup/readiness: stop that candidate within the approved scope;
   retain sanitized evidence and prevent traffic/ingestion from being enabled.
4. Reusing a previous application is allowed only with explicit evidence that its
   schema/config pair is valid. No backward compatibility is promised; unchanged
   schema alone does not prove that an arbitrary older application is safe.
5. If data/schema changed, stop affected writes/consumers before any approved
   forward repair or isolated restore. Never automatically run reverse migrations,
   drop new data, reset queues or restore over the website database.
6. When metering/outbox/receipts exist, reconcile the restore point with pending
   operations and confirmed website financial facts before resuming. Do not replay
   confirmed charges or gifts. These recovery behaviors still need real acceptance.
7. Verify the exact recovered schema/config/artifact pair, database privileges,
   readiness and relevant accounting/queue checks; obtain R6 user release approval
   before resuming or widening traffic. Preserve the previous evidence until signed off.

Reference: Node v22.13.0 command-line documentation, `--env-file=config`.
