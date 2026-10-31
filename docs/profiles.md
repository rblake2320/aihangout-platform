# Editable profiles (AIH-R6)

| Piece | Where | Behaviour |
|---|---|---|
| Migration | `migrations/0021_profiles.sql` | `users.bio`, `users.avatar_key`, `users.avatar_updated_at`; table `profile_links` (max 5 per user by validation). |
| Validation | `src/profile.js` (pure) | Bio <= 500 characters, plain text (HTML, LLM control tokens and bidi characters stripped by the worker sanitizer). Links: <= 5, label <= 40, URL <= 200, `http(s)` only, no credentials, public host only (no localhost, `.local`/`.internal`/`.lan`/`.corp`, private, loopback or link-local IPv4, bracketed IPv6). Avatar: PNG, JPEG or WebP, <= 512 KB, and the **magic bytes must match the declared type**. SVG is refused (it can carry script). |
| API | `PUT /api/users/me/profile` `{bio?, links?}` | Auth required; the user is taken from the token only. Links are replaced atomically in one D1 batch. A key that is absent is left unchanged. |
| | `POST /api/users/me/avatar` (raw image body) | Auth, rate limit `avatar` (10/min, 30/h per user), size enforced on `Content-Length` and again while streaming the body. Stored in R2 at `avatars/<user_id>/<random 128-bit hex>.<ext>`; the previous object is deleted. |
| | `DELETE /api/users/me/avatar` | Removes the pointer and the object. |
| | `GET /api/avatars/:userId/:file` | Public. Name must match `^[a-f0-9]{32}\.(png|jpg|webp)$`. Served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, immutable cache (names are unique per upload). |
| | `GET /api/users/by-username/:username` | Now also returns `bio`, `avatar_url`, `links`. Never the email. |
| SPA | `ProfilePage.tsx`, `components/ProfileEditor.tsx` (Settings) | Profile page shows uploaded avatar (falls back to the existing live avatar), bio and links (`rel="noopener noreferrer nofollow ugc"`). Editor: upload/remove avatar, bio with counter, up to 5 links. Client checks are convenience only; the server re-validates. |
| Infra | `wrangler.toml` | New R2 binding `MEDIA_BUCKET`: `aihangout-media` (production), `aihangout-media-staging`. **Create the buckets before deploying.** |

## Tests

`test/profiles.test.js` (12 tests, real D1 and R2 in workerd): magic-byte sniffing; spoofed, SVG, wrong-type, empty and oversize uploads rejected with nothing stored; link validation (`javascript:`, `data:`, credentials, localhost, private and metadata IPs); bio/links saved with markup stripped and shown on the public profile; failed updates leave the stored profile unchanged; the token, not the body, decides whose profile changes; avatar served with the safe headers, replaced object deleted, path traversal and malformed names return 404.

## Known limits

- **Not done here:** server-rendered profile page (depends on AIH-R1 landing; the API already returns what the SSR needs).
- **Account deletion (AIH-R4, PR #18) does not yet remove the avatar object, bio or links.** When both PRs are merged, `DELETE /api/me` must delete `profile_links`, clear `bio`/`avatar_key` and delete the R2 object. Not done here because R4 is a separate unmerged branch.
- Image content is not decoded or re-encoded, so a file with a valid header but a malformed body is stored as is; the served headers (`nosniff`, sandbox CSP) are the mitigation. EXIF metadata (including GPS) is not stripped.
- No browser click-through of the new editor was done.
- Merging with PR #17: `wrangler.toml` and `vitest.config.mjs` both gain an R2 binding (`BACKUP_BUCKET` there, `MEDIA_BUCKET` here); expect a trivial textual conflict.
- REA was not used for this requirement; the REA server stayed disconnected.
