# Cloud knowledge desktop guide

Status: 2026-10-28. The isolated test service supports four upload formats with an
8 MiB single-file limit. Actual upload, private object storage, embedding, Chinese
search, and source inspection have been verified. The existing 0.9.7 test installer
also passes current-user NSIS installation and clean-profile login/read-only checks.
This is controlled testing, not production publication or completed distribution.
The installer remains `NotSigned`.

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
- Scanned-PDF OCR and automatic document RAG are not connected. Passing a source
  into a real conversation is not evidence of an automatic RAG pipeline.

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

## Current evidence and open boundaries

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

## Installer verification

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
