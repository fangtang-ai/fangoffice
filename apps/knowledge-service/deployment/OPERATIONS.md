# Knowledge runtime: configuration and recovery preparation

## Status and authorization

This is an offline J1 candidate, not a deployment or migration approval. R1 covers
resources, R2 knowledge database/schema commands, R3 website financial changes,
R4 privacy, R5 commercial policy and R6 release/stop/recovery authority. Record the
approved target, actors and command scope before any real operation. Do not infer
approval from a passing preflight or from this document.

There is no knowledge schema, migration runner or queue consumer in this candidate.
Accepted local B2/B3/B4/B6 slices do not provide deployment or migration acceptance
for this runtime artifact. No production `migrate`, `down`, queue-maintenance or
restore command is supplied or implicitly run on startup.

## Candidate inventory

Copy only the explicit CI candidate files to a new versioned directory outside the
repository: six `.mjs` files (`api`, `worker`, `check-config`, `parser`, `text-worker`,
`markdown-worker`), two package files, two `.env.example` templates, this document,
`build-meta.json` and `build-manifest.json` (13 files total). Never copy a whole
deployment directory, a real environment file or a repository `node_modules`.

Check the manifest against the trusted release record and verify all 11 primary
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
`/api/knowledge/status`, not working business routes. The worker currently only
performs health probes. SIGINT/SIGTERM request bounded cleanup; failed cleanup is
not a successful stop. Record the release/configuration revision and sanitized
outcome, never a raw environment or DSN. Stopping a real process also needs the
approved operational scope.

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
