# Cloud knowledge desktop guide

Status: 2026-10-31. Office test **0.9.9** is published from `02c24589` through release
`41029633126`, completed on 2026-10-30 and independently checked on 2026-10-31.
The user has confirmed the test experience. Built-in knowledge chat and the existing
knowledge recharge bridge are included; they are not unreleased source-only work.
The service supports four upload formats with an 8 MiB single-file limit, with real
upload, private storage, embedding, Chinese search, and source acceptance evidence.
Windows remains `NotSigned`; the new 0.9.9 installer was hash-checked, not reinstalled
by this audit. Historical 0.9.7 installation evidence below has a narrower scope.

Website test `fd1748c` and knowledge API/worker `4622507` (runtime source prefix
`df3a34d7f1b6`) were deployed together on 2026-10-30, including website migration 0022. Do not repeat initialization, migration, deployment, or paid calls because an
older report says they are pending. Later documentation commits are not deployed
source snapshots. Production website and stable 0.9.7 remain unchanged.

## Branch and shared-service boundaries

- Office stays on `feat/cloud-knowledge-base`. Do not merge into `main` or the
  default `release/fangtang` branch, and do not publish stable for this work.
- Knowledge uses the existing shared service and account-owned data, not a required
  production/test database split. Verified JWT `sub`, owner checks, and RLS isolate
  accounts. The same trusted account can share its library across clients; a client
  channel does not automatically create a separate library.
- Account isolation does not select a billing ledger. The service's website budget
  base URL and machine credential currently target the test website. Production
  integration needs a separate trusted billing-source decision, not client-reported
  environment routing; it is outside this documentation update.
- The website has clean `feat/knowledge-main-baseline` and
  `feat/knowledge-main-integration` candidates rooted in remote `main`, with one SQL
  migration per future PR. Existing test branches stay separate; no main/test merge
  or website production deployment is authorized here.
- The independent knowledge PR remains a draft pending a separate merge decision.
  Registry publication is still unfinished and is not a prerequisite for this test.

## Repository ownership

The knowledge API, worker, parsers, initialization, SQL, service CI, and distributable
SDK candidates are maintained in `fangtang-ai/fangtang-knowledge`. Office retains its
account/main-process/IPC/UI adapters and private client/contract workspace mirrors.
The old Office backend copy has been archived locally, not used as another release
source. Registry publication is not required for the current desktop integration.

## Format limits

- TXT has actual upload, search, source, cross-account isolation, and logical-delete
  evidence. It was the first acceptance path, not the complete format scope.
- Markdown has a ready/sealed build, a matching Chinese search result, original
  text, line locators, source integrity, and the original-file SHA256.
- DOCX has actual binary upload, model indexing, search, document-block sources,
  original text, and matching binary SHA256. Complex visual layout is not promised.
- Text PDF has actual indexing and search evidence. New v2 builds return physical
  page numbers and corrected precise rectangles; existing sealed v1 builds are
  not rewritten. Complex fonts and all multilingual layouts are not fully covered.
- XLSX sheet/range selection is not connected to upload/build, despite an existing
  parser in the independent service. The desktop does not offer XLSX upload.
- Scanned-PDF OCR is not connected. The built-in chat integration retrieves
  knowledge on demand through built-in tools; it does not attach the entire library
  to every ordinary message or prove that every document has been fully read.

## Built-in AI knowledge chat (test 0.9.9)

Docs, Sheets, Slides, PDF, and Markdown share one read-only knowledge skill. It is
independent of MCP presets and uses the signed-in account through the main process.
No MCP server, pasted source, special prompt template, or repeated upload is required.

- Ask whether the library contains a document: `list_knowledge_spaces` and
  `list_knowledge_documents` inspect the actual account catalog. Both preserve
  pagination; an unfinished page or empty semantic search is not proof of absence.
- File status comes from published builds and desired operations. `not_ready` means
  no published searchable build; `get_knowledge_status` reads the real operation
  before describing a file as queued, parsing, failed, or cancelled.
- Ask a content question: `search_knowledge` targets catalog spaces or documents,
  then `read_knowledge_source` retrieves the original passage. Replies must use
  returned citation IDs such as `[K1]`, the file title, and its block/page/line locator.
  Search snippets alone are not presented as verified original passages.
- Follow-up source questions reuse the same document/version/build/source-unit
  reference. Long original passages are paged by Unicode code point, with an explicit
  next offset; retrieved content is reference data, not executable instructions.
- Missing login, forbidden access, service failures, unready files, and no search
  hits remain distinct outcomes. The tools do not create, upload, or delete files.

Account changes cancel/reset the visible and model conversation and discard stale
history and tool replies. New local chat transcripts and project timelines are
account-scoped, including saved drafts and file moves between projects. Existing
unscoped local transcripts remain on disk but are not silently assigned to a user.
This isolates chat context, not local document files or the shared project catalog.

Local tests cover the normal agent loop, preload, owned-editor IPC, account client,
source locators, and account-switch history restoration. These use synthetic data;
they do not prove that the user's Zhongyuan University DOCX is ready or that an
actual model has answered from it. That three-question live check remains a release
gate. Local policy currently rejects starting the acceptance client; no alternate
execution path or replacement upload is used to bypass that gate.

## Account and security boundaries

The knowledge endpoint must share the configured account API origin and use the
fixed `/api/knowledge` path. The renderer cannot choose a service URL, obtain an
account token, provide an arbitrary local path, or bypass service authorization.

Unauthenticated clients do not read knowledge documents. Missing service settings,
index profiles, quota, or upload budgets are shown explicitly. An upload-budget
failure does not prevent authorized cleanup of existing documents. Account changes
and unmounting discard late results; multi-step uploads remain bound to one session.

The knowledge wallet comes from the independent `data.knowledge` account field,
not AI/MCP products. Configured budget policy does not prove current service health,
capacity, or authorization for a particular spend. Funds, held amounts, logical
quota, and physical capacity must not be conflated. Refresh reloads account funds;
logout immediately hides the previous account's amounts.

Deletion is limited to one document. The main process reads its server title and
shows a native warning that defaults to cancel. Uncertain replies preserve the
same intent and require result confirmation, not automatic resubmission. Logical
`deleted` does not mean physical cleanup, debt removal, or a refund. UI intent state
is not a persistent cross-restart billing or deletion ledger.

## Controlled testing

1. Normally sign in with a test account that already has knowledge funding, quota,
   and an active index profile. Registration alone does not provision these.
2. Open Cloud Knowledge, inspect the independent wallet and capacity, and select a
   designated test space.
3. Upload one small, non-sensitive supported document with a unique fact. Wait for
   the operation to become `ready`; transferred bytes alone are not acceptance.
4. Explicitly search for the fact and inspect source text and line/block/page
   locators. Search may call a paid embedding provider; do not repeat it for a screenshot.
5. On uncertainty, inspect the original operation and stable error code before
   retrying. Never include passwords, tokens, or sensitive original text in reports.
6. Delete only your own designated test document after confirmation. Retain physical
   reservation/debt distinctions and do not promise immediate cleanup or refunds.

## Historical cloud evidence (2026-10-28) and open boundaries

The test API/worker was updated to PDF parser v2 on 2026-10-28. One new two-page PDF
passed actual upload/search and original-file verification. Its 12 pt fact line on
physical page 2 returns `(54, 87.384, 285.432, 99.384)` pt on a 612 x 792 pt page.
The document/query supplier reports of 97/40 tokens match two captured website
budgets, one cent each, with no held funds. Old sealed v1 sources remain unchanged.

Website embedding settlement has actual receipts. `upload_build_pending` is a
build-binding placeholder, not a pending storage bill to settle or charge again.
Generic metering delivery, unknown-cost recovery, and periodic storage billing
remain separate unfinished commercialization work. Do not repeat initialization,
old migrations, deployment, or paid calls to establish desktop installation.

## Historical installer verification (0.9.7, 2026-10-28)

The fixed candidate is the 0.9.7 test NSIS installer in `dist/`, 136848380 bytes,
SHA256 `ebc8dec8495172adc689f80852db6138342b39b01f01e8c277d62f11d2f5eec1`.
Actual installer payload inspection found no secret overrides and verified test
account/knowledge endpoints, source UI, four-format/8 MiB entry points, and test feed.
Only pure test directory builds may carry developer `.local.json` overrides; NSIS,
portable, zip, and mixed targets must not ship them and fail closed if present.

At 21:18 on 2026-10-28, the same installer completed a current-user NSIS installation
with exit code 0. All 639 baseline files matched SHA256; the only extra was the
uninstaller. Both shortcuts and the current-user uninstall entry were correct.
Installed asar, public defaults, and updater settings matched the audited payload.

The installed executable, not the unpacked build, signed in normally with a fresh
isolated profile. Four indexed documents, 4889 bytes, zero logical reservations,
knowledge funds of CNY 9.87 with zero held funds, and the existing PDF v2 source were
read successfully. Page 2, original text, SHA256, precise rectangle, and complete
2/2-page coverage passed read-only assertions without upload, search, or chat.
Physical accounted/reserved capacity remained 40/16 MiB; no historical debt was cleared.

The test window exited normally and installation, profile, and cloud documents
were retained. The installer and application remain `NotSigned`. This local file
had no download-zone marker and showed no SmartScreen/UAC interaction; that does
not verify behavior after an internet download. No protection was disabled, and
no uninstall, public release, updater-feed change, or distribution was performed.

## Knowledge billing in test 0.9.9

The configured knowledge wallet now offers **知识库明细与充值** through the existing
account recharge bridge with `product=knowledge_base`. It retains the configured
test/production website and account-mismatch checks; unknown or disabled knowledge
policy has no purchase button. Failed browser opening shows a generic retry message.

The deployed test website adds a Knowledge tab to the original recharge page, not a
second payment system. Knowledge funds remain a product balance in the existing
wallet. No default knowledge price or gift is created. Document customer fees accrue
only after publication; exact sub-cent usage carries forward instead of charging a
one-cent minimum. AI answers use the AI product; daily storage charging is not enabled.

Website migration 0022, the website, and the knowledge worker were deployed in the
approved test maintenance window on 2026-10-30. Office test 0.9.9 includes the bridge.
No knowledge packages are currently configured for sale; pricing, listing, and actual
knowledge-product payment acceptance remain separate approvals. Existing captured
supplier/website evidence does not prove a real recharge payment under the new rules.
Generic metering/storage pending records are not unpaid bills to charge again.

## Local checks

```sh
npm run test:knowledge
npm run typecheck:knowledge
npm run test -w @genoffice/shell -- --maxWorkers=2
npm run typecheck -w @genoffice/shell
npm run build -w @genoffice/shell
```

The workspace-ownership, knowledge IPC/UI/deletion, account recovery, and release
configuration tests cover the desktop seam. Synthetic tests do not call real
models, upload user documents, or establish production readiness. Service tests,
SQL gates, SDK packaging, and server builds run in the independent repository.
