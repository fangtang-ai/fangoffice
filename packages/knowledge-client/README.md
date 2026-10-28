# Account-bound knowledge client workspace

`@genoffice/knowledge-client` is the private Office source mirror. The canonical
backend and distributable `@fangtang-ai/knowledge-client` candidate are maintained
in `fangtang-ai/fangtang-knowledge`. Office keeps the current workspace until a
versioned private SDK distribution is explicitly adopted; this change does not
publish to a registry or add a sibling-directory runtime dependency.

## Trusted integration

Only the main process creates the client through its trusted account adapter.
`createAccountKnowledgeClient()` reuses the existing account session and refresh
coordination. The renderer receives fixed IPC actions, not tokens, arbitrary URLs,
owner selectors, object-store locations, or database credentials.

The configured knowledge endpoint must use the account API origin and the fixed
`/api/knowledge` path. Test and production builds keep their existing independent
factory configuration, application identity, updater feed, and release gates.
Never copy a developer `.local.json` or test token into an installer.

## Fixed actions

- Space/document reads and creation use validated resource targets and pagination.
- History reads bind every version, build, or operation to the complete requested
  parent chain, rather than substituting the current active object.
- `getQuota()` returns capacity and reservation information, not wallet funds or
  permission to spend. Knowledge funds are provided separately by the website.
- `getSourceUnit()` requires space, document, version, build, and source-unit IDs.
  It returns validated original text, hashes, locators, coverage, and warnings.
  This GET does not perform embedding, search, or original-file downloading.
- `search()` is an explicit, potentially paid operation with bounded scope and
  query length. Network errors and uncertain provider costs do not authorize an
  automatic retry, a free query, or a replacement billing attempt.
- Upload preparation, object upload, and completion preserve one account session,
  resource target, generation, declaration, and idempotency key. A transferred
  object is not proof that the document has been indexed or published.
- `deleteDocument()` accepts a single document scope and a stable intent ID after
  confirmation. An uncertain reply must not create a fresh intent. A `deleted`
  reply confirms logical convergence, not physical cleanup, storage-debt removal,
  or a payment refund.

Account switches, logout, and cancellation reject late results. Authentication
refresh reuses the same request snapshot instead of changing its target or intent.
The client has no Electron, database, cloud SDK, or service-runtime dependency.

## Ownership and checks

Office owns account adaptation, IPC, UI, and the client/contract workspace mirrors.
The independent knowledge repository owns API/worker builds, initialization, SQL,
parsers, model execution, service CI, and SDK packaging. Do not rebuild or deploy
an archived Office service copy.

Run `npm run test:knowledge` and `npm run typecheck:knowledge` from the Office root.
See `docs/knowledge-desktop.md` for actual controlled-test evidence and format limits;
service operations and private SDK distribution are documented in the independent
repository. Synthetic unit tests do not replace cloud or production acceptance.
