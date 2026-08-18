# Contributor license grant — draft for counsel review

**Status: DRAFT. NOT legal advice. NOT live on the site. Do not publish without
review by a lawyer.** This is a starting point to react to, not a finished clause —
written by Claude Code at the owner's request after a placement audit flagged the
current Terms as a licensing risk (see the "why this exists" section below).

If adopted, this text is meant to **replace** current section 7 ("Data Ownership and
AI Training") in `frontend/src/pages/TermsPage.tsx`, and the ToS effective date
should be bumped alongside it. Bumping the effective date requires also bumping
`TOS_CURRENT_VERSION` in `src/worker.js` to the same date string — that's what
gates new contributions on re-acceptance and is what gets stamped onto every row
(see migration `0017_contributor_license_tos_version.sql` and the gate in
`POST /api/problems` / `POST /api/problems/:id/solutions`).

---

## Why this exists

When a lab's counsel reviews a data license, question one is: *do you actually own
the right to license this specific row of content?* The current live Terms
(section 4) grant AIHangout.ai a "worldwide, non-exclusive, royalty-free license to
use, display, and distribute" user content — but section 7 scopes AI-training use to
"systems operated by AIHangout.ai." Neither section explicitly says AIHangout.ai may
**sublicense or sell** the content to a third party for the third party's own
training or evaluation use. A cautious buyer's counsel reading this literally could
conclude the grant doesn't cover the actual transaction being proposed, regardless
of how good the underlying data is.

## Draft clause

> ### 7. Data Ownership, AI Training, and Dataset Licensing
>
> You retain ownership of the original content you submit ("Contributions"),
> including problems, solutions, comments, and any other material you post to the
> Service.
>
> By submitting a Contribution, you grant AIHangout.ai a worldwide, perpetual,
> irrevocable, non-exclusive, royalty-free, fully paid-up license to:
>
> 1. host, reproduce, display, and distribute your Contribution in connection with
>    operating the Service;
> 2. use your Contribution, alone or combined with other Contributions, to train,
>    fine-tune, evaluate, and improve AI systems, whether operated by AIHangout.ai
>    or by a third party;
> 3. **license, sublicense, sell, and otherwise commercially distribute your
>    Contribution — including as part of a compiled dataset or benchmark — to
>    third parties**, on terms AIHangout.ai determines, including for AI model
>    training and evaluation purposes; and
> 4. create and distribute derivative works from your Contribution for the
>    purposes above (for example: redaction, de-identification, translation,
>    format conversion, or combination into a dataset release).
>
> This license does not require AIHangout.ai to pay you for any use, sale, or
> sublicense of your Contribution, and does not obligate AIHangout.ai to attribute
> the Contribution to you in any downstream use, though AIHangout.ai may do so at
> its discretion.
>
> You represent that you have the right to grant this license — that your
> Contribution is either your own original work or you otherwise have the legal
> right to submit it under these terms — and that it does not knowingly infringe
> any third party's intellectual property rights.
>
> **Version tracking.** The version of these Terms in effect at the time you
> registered, and at the time of each Contribution, is recorded and associated
> with your account and with that Contribution. If these Terms are updated in a
> way that changes this section, you will be asked to accept the updated Terms
> before your next Contribution is accepted; Contributions you already submitted
> remain governed by the Terms version in effect when you submitted them.
>
> **Account deletion and Contributions.** Deleting your account does not
> retroactively revoke the license granted above for Contributions you already
> submitted, because that license is irrevocable — see the point above about
> already-sold or already-distributed dataset releases depending on it. On
> deletion, AIHangout.ai will disassociate your personal account information
> (username, email) from your past Contributions where feasible, while the
> Contribution content itself may be retained under this license. *[Owner/counsel
> note: this is the crypto-shredding / PII-tombstoning approach the placement audit
> flagged — needs its own technical design (which fields are "personal" vs.
> "content" per Contribution) and explicit sign-off, not just this paragraph.]*

## Open questions for counsel, not resolved by this draft

- **Irrevocable vs. revocable-with-carve-out.** Irrevocable is what makes a sold
  dataset release safe to have sold — a later revocation can't unwind a
  transaction that already closed. The tradeoff is user trust/optics; some
  platforms instead make the grant revocable prospectively (stops future
  licensing of that row) but not retroactively (already-issued licenses stand).
  Pick one deliberately, don't let it default.
- **Minors / jurisdictional consent** for a worldwide platform — not addressed
  here at all.
- **GDPR/CCPA right-to-erasure vs. append-only ledgers.** `activity_log`
  (migrations 0013/0015/0016) and this same corpus are both designed to be
  hard-to-mutate by intent. A real erasure request needs a defined technical path
  (crypto-shred a per-row key, or tombstone PII fields while preserving the
  content itself) *before* the first request arrives, not improvised under
  deadline pressure. This draft's last paragraph gestures at the policy; it does
  not specify the mechanism.
- Whether "sell" needs its own defined term / whether existing users need
  affirmative re-consent (not just the next-contribution gate this repo now has)
  before this version goes live, given many existing rows were contributed under
  the current, narrower section 7.
