"""The trust engine — the part of pbp-0.1 that turns a database into a system.

Tier semantics:

- draft                 : contributed, no independent evidence
- reproduced            : >=1 independent (non-author) success with verify passed
- verified              : >=3 counted successes w/ verify passed from >=2 distinct
                          non-author reporters
- community_confirmed   : >=10 counted applications, >=5 distinct non-author
                          reporters, success rate >= 0.80
- maintainer_approved   : manual only — never auto-assigned
- deprecated            : auto-demoted (>=5 counted applications, success rate < 0.40)
                          or manually retired
- dangerous             : >=2 distinct reporters flagged harm, or one maintainer flag

Anti-gaming rules (the difference between a ladder and an invitation):

1. Every outcome report is Ed25519-signed and verified before it touches state.
2. Reporter identities are pinned to their first-seen public key (TOFU). A
   report claiming an existing reporter_id with a different key is rejected.
3. Author self-reports are stored (they're honest telemetry) but never counted
   toward promotion — you cannot reproduce your own fix.
4. Per-reporter contribution to promotion counters is capped
   (MAX_COUNTED_PER_REPORTER): one identity hammering "success" 500 times
   advances the ladder no further than its cap.
5. Distinct-reporter thresholds mean tier climbs require breadth, not volume.
6. deprecated/dangerous are sticky: automatic promotion never resurrects them;
   only a maintainer action can.

Confidence is a Laplace-smoothed success rate over *counted* outcomes:
(successes + 1) / (applications + 2) — a record with no evidence sits at 0.5
and moves with evidence, resisting single-sample swings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .schema import Outcome, TrustTier

MAX_COUNTED_PER_REPORTER = 3

REPRODUCED_MIN_INDEPENDENT_SUCCESSES = 1
VERIFIED_MIN_SUCCESSES = 3
VERIFIED_MIN_DISTINCT_REPORTERS = 2
COMMUNITY_MIN_APPLICATIONS = 10
COMMUNITY_MIN_DISTINCT_REPORTERS = 5
COMMUNITY_MIN_SUCCESS_RATE = 0.80

DEPRECATE_MIN_APPLICATIONS = 5
DEPRECATE_MAX_SUCCESS_RATE = 0.40

DANGEROUS_MIN_DISTINCT_FLAGGERS = 2

_TERMINAL = {TrustTier.DEPRECATED, TrustTier.DANGEROUS}
_MANUAL_ONLY = {TrustTier.MAINTAINER_APPROVED}


@dataclass
class Telemetry:
    """Aggregates computed from stored outcomes for one pathbook."""

    times_applied: int = 0          # all counted applications
    times_succeeded: int = 0        # counted successes (any)
    verified_successes: int = 0     # counted successes with verify_passed
    distinct_success_reporters: int = 0   # distinct non-author reporters w/ verified success
    distinct_reporters: int = 0     # distinct non-author reporters, any outcome
    dangerous_flaggers: int = 0     # distinct reporters reporting outcome=dangerous

    @property
    def success_rate(self) -> float:
        if self.times_applied == 0:
            return 0.0
        return self.times_succeeded / self.times_applied

    @property
    def confidence(self) -> float:
        return (self.times_succeeded + 1) / (self.times_applied + 2)


def should_count(
    outcomes_so_far_by_reporter: int,
    reporter_id: str,
    author_id: str,
) -> bool:
    """Whether a new report participates in promotion counters."""
    if reporter_id == author_id:
        return False
    return outcomes_so_far_by_reporter < MAX_COUNTED_PER_REPORTER


def compute_telemetry(outcomes: list[dict[str, Any]], author_id: str) -> Telemetry:
    """Recompute aggregates from the full outcome history (source of truth).

    Only rows marked ``counted`` feed applied/succeeded numbers; dangerous
    flags are tallied over distinct reporters regardless of the counted cap.
    """
    t = Telemetry()
    success_reporters: set[str] = set()
    all_reporters: set[str] = set()
    flaggers: set[str] = set()
    for o in outcomes:
        if o["outcome"] == Outcome.DANGEROUS.value:
            flaggers.add(o["reporter_id"])
        if not o["counted"]:
            continue
        t.times_applied += 1
        all_reporters.add(o["reporter_id"])
        if o["outcome"] == Outcome.SUCCESS.value:
            t.times_succeeded += 1
            if o["verify_passed"]:
                t.verified_successes += 1
                if o["reporter_id"] != author_id:
                    success_reporters.add(o["reporter_id"])
    t.distinct_success_reporters = len(success_reporters)
    t.distinct_reporters = len(all_reporters)
    t.dangerous_flaggers = len(flaggers)
    return t


def next_tier(current: TrustTier, t: Telemetry, maintainer_flagged_dangerous: bool = False) -> TrustTier:
    """Pure function: given current tier + telemetry, return the tier the
    record should hold. Deterministic; safe to re-run (idempotent)."""
    # Danger dominates everything, including terminal deprecated.
    if maintainer_flagged_dangerous or t.dangerous_flaggers >= DANGEROUS_MIN_DISTINCT_FLAGGERS:
        return TrustTier.DANGEROUS

    # Terminal and manual tiers never move automatically.
    if current in _TERMINAL or current in _MANUAL_ONLY:
        return current

    # Auto-demotion: enough evidence that this fix mostly fails.
    if t.times_applied >= DEPRECATE_MIN_APPLICATIONS and t.success_rate < DEPRECATE_MAX_SUCCESS_RATE:
        return TrustTier.DEPRECATED

    # Auto-promotion: compute the highest tier the evidence supports, then
    # never move DOWN via the promotion path (demotion only via rules above).
    earned = TrustTier.DRAFT
    if t.verified_successes >= REPRODUCED_MIN_INDEPENDENT_SUCCESSES and t.distinct_success_reporters >= 1:
        earned = TrustTier.REPRODUCED
    if (
        t.verified_successes >= VERIFIED_MIN_SUCCESSES
        and t.distinct_success_reporters >= VERIFIED_MIN_DISTINCT_REPORTERS
    ):
        earned = TrustTier.VERIFIED
    if (
        t.times_applied >= COMMUNITY_MIN_APPLICATIONS
        and t.distinct_reporters >= COMMUNITY_MIN_DISTINCT_REPORTERS
        and t.success_rate >= COMMUNITY_MIN_SUCCESS_RATE
        and earned == TrustTier.VERIFIED
    ):
        earned = TrustTier.COMMUNITY_CONFIRMED

    order = [TrustTier.DRAFT, TrustTier.REPRODUCED, TrustTier.VERIFIED, TrustTier.COMMUNITY_CONFIRMED]
    if order.index(earned) > order.index(current):
        return earned
    return current
