# Library: white papers (AIH-R8)

Published documents with a stable citation id, immutable versions, an R2 file per version, a licence and download counts. Reading is public; publishing is admin-only.

| Piece | Where | Behaviour |
|---|---|---|
| Migration | `migrations/0025_library.sql` | `documents` (citation id, title, abstract, authors JSON, licence, status `published`/`retired`, latest version, download count) and `document_versions` (file key, type, bytes, SHA-256, changelog, per-version downloads; `UNIQUE(document_id, version)`). No triggers. |
| Helpers | `src/library.js` (pure) | File validation, author/metadata validation, reference parsing, citation ids, LIKE escaping. |
| Files | R2 `MEDIA_BUCKET`, key `library/<doc>/v<n>-<sha16>.<ext>` | **PDF**: must start `%PDF-` and contain `%%EOF` in the last KB. **Markdown**: valid UTF-8, no control characters. Extension, declared type and content must all agree. Max 10 MB (`Content-Length` required, checked again on the parsed file). Anything else (HTML, SVG, executables) is refused. |
| Citation | `AIH-LIB-<year>-<NNNN>`, versions `...v2` | Assigned at creation from the row id; resolves by numeric id, citation id, or citation id with version suffix. |
| REST | `POST /api/library` (multipart: `file`, `title`, `abstract`, `authors`, `license`, `changelog?`) | Admin. Licence from a fixed list (`CC-BY-4.0`, `CC-BY-SA-4.0`, `CC0-1.0`, `MIT`, `Apache-2.0`, `All-Rights-Reserved`). Text is run through the worker sanitizer. Compensating cleanup removes the row and object if a step fails. |
| | `POST /api/library/:ref/versions` | Admin. Needs `changelog`; may update title/abstract/authors/licence. Old versions stay downloadable. |
| | `PATCH /api/library/:ref` `{status}` | Admin. `retired` hides a document from list, detail and download for everyone but admins. |
| | `GET /api/library?q=&limit=&offset=` | Public search over title, abstract, authors and exact citation id; `%` and `_` match literally. |
| | `GET /api/library/:ref[?include=content&version=n]` | Public. Versions with SHA-256 and download path; Markdown text (<= 200 KB) when `include=content`. PDFs are never converted to text. |
| | `GET /api/library/:ref/download[?version=n]` | Public. `Content-Disposition: attachment`, `nosniff`, sandbox CSP (a PDF opened inline would run in our origin's context). One count per visitor per version per hour (KV key), so refreshes and crawlers do not inflate it. |
| MCP | `src/mcp/server.js` | `search_documents {query?, limit?, cursor?}` and `get_document {ref, version?, include_content?}`. Both call the REST routes, so the access rules live in one place. |
| SPA | `/library`, `/library/:ref`, nav link | Search + paging, detail with abstract, versions, SHA-256 and download buttons; admin upload form on the list page. |

Side fix in `src/worker.js`: the activity-log body capture no longer decodes `multipart/form-data` and `image/*` request bodies as text (it wasted CPU on a 10 MB upload and would have written binary garbage into the audit payload). Those requests are still logged, with a null payload. The avatar upload in PR #20 (AIH-R6) has the same problem and will benefit from the same change once both are merged; it is not applied to that branch.

## Tests

`test/library.test.js` (11 tests, real D1 and R2 in workerd): content validation including wrong-type, truncated PDF, NUL bytes, invalid UTF-8 and oversize; reference parsing and injection-shaped refs; admin-only publishing; R2 object matches the upload; bad uploads leave no row or object; markup stripped; versions immutable and old ones downloadable; download headers and per-visitor-per-hour counting; Markdown text on request, never for PDFs; search incl. `%`/`_`/SQL-shaped input; retire/restore; both MCP tools through `POST /mcp` including cursor paging and structured `NOT_FOUND`. `mcp-server` and `mcp-sdk-client` tool-list assertions updated from six to eight tools.

## Known limits

- PDF validation is structural (header and trailer marker), not a full parse; a malformed or hostile PDF body is stored as is. The download is attachment-only with a sandbox CSP, but no antivirus or sanitising pass exists.
- Admin-only publishing: there is no contributor submission or review workflow. Retiring is soft; there is no hard delete route.
- Download counts are per KV key per hour, so they are approximate (KV is eventually consistent).
- `get_document` text is Markdown only; PDFs have no extracted text, so an agent cannot read a PDF through MCP.
- Not browser-tested: the SPA pages compile and the API they call is tested, but no one clicked through them.
- The search is a `LIKE` scan, adequate for a small library, not for thousands of documents.
- Needs the `MEDIA_BUCKET` R2 binding (shared with AIH-R6: `aihangout-media`, `aihangout-media-staging`); create the buckets before deploying. Merging with PR #20 gives a trivial duplicate-line conflict in `wrangler.toml` and `vitest.config.mjs`.
- REA was not used; the server stayed disconnected.
