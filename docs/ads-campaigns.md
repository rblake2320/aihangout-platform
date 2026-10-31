# Ad slots and campaigns (AIH-R9)

First-party ads: house ads first, sponsorship-friendly, no third-party ad code. Code:
`src/ads.js` (routes registered before the SPA catch-all), `migrations/0026_ad_campaigns.sql`,
`frontend/src/components/AdSlot.tsx`, `frontend/src/components/CampaignsAdmin.tsx`.
Tests: `test/ads.test.js`.

## Model

| Concept | Contract |
|---|---|
| Placement ids | `feed-inline` (home feed, after the third problem), `problem-footer` (problem page, below the answers). Listed at `GET /api/ads/placements`. Stable ids: advertisers buy them by name. |
| Campaign | `ad_campaigns`: advertiser, kind, status, placements, target tags, headline / body / CTA / optional https image, link, priority, weight, `starts_at` / `ends_at`. Public id is a UUID. |
| Kinds and fill order | `paid` (sponsorship) → `community` (free slots for open projects) → `house` (fill). Three house ads are seeded active, so no slot is empty before anything is sold. |
| Targeting | Contextual only: the tags of the page being viewed. Empty `target_tags` = every page. A tag-targeted match beats run-of-site within a kind; then priority; ties share the slot by weight. No profile of the viewer exists or is built. |
| Disclosure | Every served ad carries a label: `Sponsored by <advertiser>` for paid/community, `From AI Hangout` for house. Sponsored links get `rel="sponsored noopener noreferrer"` and open in a new tab. |
| Creatives | Text plus an optional image; links must be https or a same-site path (`javascript:`, `data:`, `http:`, `//host` refused). Free text goes through `sanitizeContent`. Rendered by our React component: no script, iframe or pixel from anyone else. |
| Creative images | **Never loaded from the advertiser by the visitor.** Served ads carry `image_url: /api/ads/creative/<campaign id>`; the Worker fetches the advertiser's image itself with a fresh request (no visitor headers copied), no redirects, raster types only (PNG, JPEG, GIF, WebP; SVG refused), a magic-byte check, a 512 KB cap, and caches it per campaign revision. The advertiser's image host therefore sees Cloudflare, not the visitor's IP, cookies or referrer. Image URLs must be https on a public host name (no IP literals, `localhost` or single-label hosts). |
| Events | `POST /api/ads/events?consent=analytics` with up to 20 `{type: impression|click, campaign_id, placement, view_id}`. Stored in `analytics_events` as `ad_impression` / `ad_click` with **no** IP, user agent, user id, session or page URL. Unknown campaigns, wrong placements and duplicate (view, campaign, placement) events are dropped. Impression = half the slot visible for one second. |
| Consent | Same rule as AIH-R4's telemetry gate: without `?consent=analytics`, or with `Sec-GPC: 1` / `DNT: 1`, the endpoint returns 204 and stores nothing. The client sends events only when `aih_consent` holds a current "yes" and no opt-out signal is set. Ads are still shown without consent (contextual, nothing recorded). |
| Admin | `GET/POST /api/admin/campaigns`, `PUT /api/admin/campaigns/:id` (401 without auth, 403 without `is_admin`). Admin page → **Campaigns** tab: list with impressions, clicks, CTR; pause/activate; create form. |

## Reference evidence (REA, clean-room: behaviour only)

| Behaviour | Evidence |
|---|---|
| A privacy-focused ad network (EthicalAds on a Read the Docs site) declares the placement on the element (`data-ea-type`, `data-ea-style`, `data-ea-publisher`), targets by **page keywords** (`data-ea-keywords`, the project's own topics), and asks for an ordered list of campaign tiers `community\|house\|paid`. The decision request carries placement id, ad type, keywords and campaign types, not a user id. | `capture_browser_scenario` `ev_c3b8118fdcd96d41754651355ef70fff6d30bc6498060bbb8855e6af1323e2b2` (capture sha256 `5229099e3ad88ad20b3a1b9add0f37460b768ecdd610ae3bb6e557ecde4ee421`) |
| The same docs host's own pages carry no ad slot | `ev_c940c96956dc1934cb84ff007e6310a30ea2f759af61625dab578d5cf8fbb87b` |

Deliberate differences: no third-party script or JSONP (our creative is JSON rendered by our own
component); paid sponsorships fill before community and house ads (the reference request lists
community first); the decision body and its view/click pixels were not captured (headless, no fill),
so view-counting semantics follow the common "50% visible for 1 s" rule instead.

## Verification (local, shipped form)

`wrangler d1 migrations apply --local` (0026 applied, house ads seeded), `wrangler dev` with the built
`frontend/dist`, three problems posted:

- `GET /api/ads/serve?placement=feed-inline` → house ad `From AI Hangout`, link `/create-problem`.
- `POST /api/ads/events` without consent → 204, nothing stored; with `?consent=analytics` → `accepted: 1`.
- REA browser run of `/`, no consent stored: `ev_5f1164978f1b5566935327f376d38b3aa2fad50a7de796a1a6436757754fe67e`. The slot renders with its label, `GET /api/ads/serve` is the only ad request, **no** event request, and every request is to the site's own origin.
- Same run with a stored consent decision: `ev_e82831fff49e8c32408c4084e348b3a4f834012655eba8d113d52bbf36b2315b`. After the dwell one `POST /api/ads/events?consent=analytics` carries `{"type":"impression",...,"placement":"feed-inline"}`, again same-origin only.
- The stored rows have `ip_address`, `user_agent`, `user_id` and `session_id` all null.

## Not done / residuals

- `src/ads.js` `eventConsentGiven()` and `frontend/src/ads/consent.ts` mirror AIH-R4 (PR #18) because R4
  is not on master yet. After #18 merges, the client helper should become `analyticsAllowed()` from
  `../consent` and the server gate should delegate to `analyticsConsentGiven()`, so one rule lives in one place.
- New admin routes changed the bundle-recon baseline (`recon/local-dist/2026-10-31.json`); this file
  will conflict trivially with #18, which also rewrites it. Regenerate after merging.
- No frequency capping, budgets, invoicing or advertiser self-serve; impressions are not deduplicated
  across page views (each view has its own `view_id`).
- Clicks are reported by the client on click, so a click with consent but no JavaScript is not counted.
- No tag-page placement yet; add `tag-header` once AIH-R1's `/tags/:tag` page is merged.
- Not deployed; migration 0026 must be applied before the code.
