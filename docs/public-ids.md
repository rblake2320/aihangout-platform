# Stable public identifiers (AIH-R2)

Problems, solutions and members carry a `public_id`: a UUIDv7 (RFC 9562) whose first 48 bits are
the row's creation time in Unix milliseconds. Integer ids stay internal (joins, foreign keys) and
remain in API responses for backwards compatibility; nothing public is keyed on them any more.

Code: `src/public-ids.js`, `migrations/0023_public_ids.sql`. Tests: `test/public-ids.test.js`.

## Contract (accepted forever)

| Surface | Behaviour |
|---|---|
| Problem page | Canonical URL `/problem/{public_id}/{slug}`. `/problem/{integer}`, `/problem/{public_id}`, a stale slug or an upper-case id all **301** to it. Only indexable problems redirect; pending, private and unknown ids are 404 + `noindex` in both forms, so a redirect never reveals that a hidden problem exists. |
| Member page | `/profile/{username}`; `/profile/{public_id}` 301s to it. New usernames may not be UUID-shaped, so the two forms cannot collide. |
| REST paths | Any `/api/.../{collection}/{public_id}/...` segment after `problems`, `solutions` or `users` resolves to the internal id before routing, so every existing route accepts both forms (e.g. `/api/problems/{pid}/solutions/{sid}/accept`). An unknown or wrong-collection public id is `404 {code: "NOT_FOUND"}`, never a fallthrough. Case-insensitive. |
| REST bodies | Register, create problem and create solution return `public_id` (problem also returns `path`); feed rows and problem detail add `public_id` and `slug`; `/api/auth/me` adds `public_id`. Integer fields are unchanged. |
| MCP | `get_problem` / `post_solution` take `problem_id` as a public id (preferred) or integer; outputs add `public_id` (and `path` for problems); `whoami` adds `public_id`. |
| Sitemaps, JSON-LD | Canonical public URLs only; answer anchors are `#solution-{public_id}`; ProfilePage `identifier` is `aihangout:user:{public_id}`. |

Slugs are a pure function of the current title (ASCII, at most 80 chars, never empty) and are never an
identity: a title edit changes the slug and the old one 301s. This is the reason there is no stored
slug column. The Stack Overflow capture used for AIH-R1 shows the same id → slugged-URL 301
(`ev_a971a18b3d035bb1ffbb5360e440aaf7e3bec7a4f4b9beedd05c6bd066c43c1b`, transaction `request-8`).

## Migration and backfill

`0023_public_ids.sql` adds the three columns, backfills every existing row in SQL (timestamp from
`created_at` / `join_date`, so old ids sort with new ones), and adds unique indexes. No triggers
(wrangler's remote splitter cannot apply them). New rows get their id from `uuidv7()` at the three
insert sites. Rows written by any other path are filled lazily by the same SQL expression
(`backfillPublicIds`, `publicIdFor`) before they are rendered, listed or redirected to.

Apply before deploying the code: `wrangler d1 migrations apply aihangout-database --env <env> --remote`.

## Verification

- `npm test`: 15 files, 149 tests (14 new). Covers format/uniqueness/timestamp of generated and
  SQL-backfilled ids, unique-index rejection, both id forms on REST (including the nested accept
  route), 404 on unknown/wrong-collection ids, all 301 cases, no redirect for hidden problems,
  profile redirect, UUID-shaped username refusal, MCP both forms.
- Local shipped form: `wrangler d1 migrations apply aihangout-dev --local` applied `0023` to a
  database that already held a problem posted before the migration. The row was backfilled to
  `01a19315-c968-7d20-86b4-a9d988cef705`; its first 48 bits decode to `2026-10-31 17:50:41`, the row's
  `created_at`. Against `wrangler dev` on that database, `/problem/1` → 301 to the canonical URL;
  canonical → 200 with matching `<link rel="canonical">` (html sha256
  `23cbac8d0aa632280284c1a79bc0807c0438bd2f7e9561f40539712c3398984b`); `/api/problems/{public_id}` →
  the same problem; unknown UUID → 404; sitemap lists the canonical URL. Lighthouse 12.6.1 SEO 100 on
  the canonical URL (report sha256 `dc5029d8951194d3d083cf671ec9a027d71abc64b075e3d98d79fa39d697fd1c`).
- Bundle recon gate: `node scripts/bundle-recon.mjs --dist frontend/dist --label local-dist --no-write --diff recon/local-dist`
  exit 0 (new page routes `/problem/:id/:slug`, `/tags/:tag`; no new suspicious literals, admin routes or source maps).

## Not covered

- Ids inside request **bodies** (e.g. bookmark `content_id`, vote targets) are still integers only.
- Notification, bookmark and admin links in the SPA still use integer URLs; they work (the API
  resolves them, a full page load 301s, and the problem page replaces the URL with the canonical one).
- Not applied to staging or production D1.
