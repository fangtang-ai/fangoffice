# Knowledge contract workspace

`@genoffice/knowledge-contract` is the private source mirror consumed by Office.
The canonical backend and distributable SDK candidates are maintained in
`fangtang-ai/fangtang-knowledge`, where the SDK package is named
`@fangtang-ai/knowledge-contract`. Registry publication is not a prerequisite
for the current desktop integration, and this workspace is not a second backend.

## Runtime boundaries

- Parsers validate requests, responses, pagination, complete parent targets, and
  unknown fields. An accepted UUID or response shape is not authorization.
- Clients cannot supply an owner, access token, arbitrary URL, object-store key,
  embedding vector, index profile, or billing authority through knowledge requests.
- Resource UUIDs and content-derived source-unit IDs have distinct validators.
  Source IDs do not relax the UUID rules for spaces, documents, or operations.
- Generations, byte counts, token counts, and storage quantities remain exact
  decimal strings. Do not convert them to floating-point accounting values.
- Text ranges use Unicode code-point offsets. Locators, text hashes, coverage,
  parser revisions, and complete version/build targets must remain consistent.
- Search validates explicit scope, bounded queries, ranking, previews, and source
  mappings. Distance is not confidence, and a result is not a citation manifest.
- Source reads return original text and validated locators for a complete target;
  they are not raw-file download permissions or proof of ownership.
- Delete intents identify one document and preserve the same intent across an
  uncertain response. Logical deletion is not physical cleanup or a refund.
- Quota, physical capacity, knowledge wallet funds, and payment reservations are
  separate concepts. Unknown or pending cost must not be presented as zero.

JWT validation, ownership, row-level security, publication, source verification,
provider calls, and settlement belong to the independent service and website.
The contract package performs no networking, database access, or model calls.

## Validation

Run `npm run test:knowledge` and `npm run typecheck:knowledge` from the Office root.
These commands validate the client/contract mirrors only. Service initialization,
SQL, runtime builds, and service CI belong to the independent knowledge repository.
For canonical schema and SDK distribution details, consult its corresponding
package README and `docs/SDK-DISTRIBUTION.md`.
