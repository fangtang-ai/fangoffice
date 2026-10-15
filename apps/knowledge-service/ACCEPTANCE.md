# Local knowledge acceptance — 2026-10-15

## Accepted scope

| Tasks | Local deliverable                                                                                | Status                              |
| ----- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| A1–A4 | Shared runtime contracts, locators, quantities and commercial snapshots                          | Locally accepted                    |
| A5–A7 | Account-bound desktop client, pure authorization/admission policies and workspace wiring         | Locally accepted                    |
| B1    | Independent API/worker entries, explicit configuration, JWT/JWKS and read-only connection probes | Synthetic/local acceptance only     |
| E3    | Strict UTF-8 TXT DocIR and bounded worker execution                                              | Locally accepted                    |
| F3–F4 | Markdown and DOCX DocIR                                                                          | Locally accepted                    |
| F5    | Text PDF DocIR                                                                                   | Locally accepted                    |
| F6    | XLSX workbook inspection and source-bound selection snapshots                                    | Locally accepted                    |
| F7    | Simple XLSX DocIR consuming the confirmed F6 snapshot                                            | Not implemented                     |
| J1    | Pinned CI candidate and hashed build manifest                                                    | In progress; hosted CI not executed |

F6 exposes `inspectKnowledgeXlsxWorkbook` and `freezeKnowledgeXlsxSelection`.
Inspection reports visibility, declared/observed dimensions, hidden rows/columns,
formula counts, date system and unsupported features. Selection records the
source hash, explicit hidden-content choice and sheet ranges with a deterministic
snapshot hash. This is preflight, not XLSX text extraction or a functioning import UI.

## Reproduction

Run from the repository root:

```sh
npm run test:knowledge
npm run typecheck:knowledge
npm run test -w @genoffice/electron-utils
npm run typecheck -w @genoffice/electron-utils
npm run test -w @genoffice/shell
npm run typecheck -w @genoffice/shell
npm run build:knowledge
npm run build -w @genoffice/shell
npm run format:check
```

The checked local environment is Windows with Node 25.8.1 and npm 11.19.1.
Knowledge tests: 43 files / 720 cases (contract 409, client 60, service 251).
Electron utilities: 13 files / 136 cases. Shell: 27 files / 284 cases.
All five workspace typechecks, changed-file formatting and strict no-explicit-any
lint on the affected sources/tests pass. These are affected-workspace results,
not a claim that the entire repository test chain was executed.

The closeout corrects root workspace-script coverage, removes two unused values,
formats the parser additions and makes the CI artifact list cover every file in
the build manifest, including `markdown-worker.mjs`. Generated `.build/` test
bundles are ignored rather than included in source commits.

## Unverified boundaries

- No real database, migration, RLS, queue, object upload, billing or model call is validated.
- No private document, production credential, deployment or installer is used.
- R1–R6 resource/privacy/commercial/release approvals remain outstanding.
- J1 is a local candidate, not completed deployment or hosted Linux/Windows CI acceptance.
- Minimum Node 22.12 execution is not validated here; `pdfjs-dist` declares Node
  `>=22.13.0 || >=24`, which J1 must reconcile with its current Node 22.12 target.
- F7 and the end-to-end knowledge product remain unfinished.

Detailed local planning and per-task acceptance notes remain outside Git under
`.planning/` and `tmp/`; this document preserves the non-sensitive acceptance summary.
