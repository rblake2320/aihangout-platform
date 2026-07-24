"""Trust engine suite — proves the ladder promotes on breadth of independent
evidence, demotes on failure, treats danger as dominant, and cannot be climbed
by a single identity hammering "success"."""

from pathbook.schema import TrustTier
from pathbook.trust import (
    MAX_COUNTED_PER_REPORTER,
    Telemetry,
    compute_telemetry,
    next_tier,
    should_count,
)


def outcome(reporter, result="success", verify=True, counted=True):
    return {
        "reporter_id": reporter,
        "outcome": result,
        "verify_passed": verify,
        "counted": counted,
    }


class TestShouldCount:
    def test_author_never_counts(self):
        assert not should_count(0, "author-1", "author-1")

    def test_cap_enforced(self):
        assert should_count(MAX_COUNTED_PER_REPORTER - 1, "r1", "author")
        assert not should_count(MAX_COUNTED_PER_REPORTER, "r1", "author")


class TestPromotionLadder:
    def test_draft_to_reproduced_needs_one_independent_verified_success(self):
        t = compute_telemetry([outcome("r1")], author_id="author")
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.REPRODUCED

    def test_unverified_success_does_not_reproduce(self):
        t = compute_telemetry([outcome("r1", verify=False)], author_id="author")
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.DRAFT

    def test_verified_needs_two_distinct_reporters(self):
        # 3 verified successes but all from one reporter -> stays reproduced
        t = compute_telemetry([outcome("r1")] * 3, author_id="author")
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.REPRODUCED
        # 3 successes across two reporters -> verified
        t = compute_telemetry([outcome("r1"), outcome("r1"), outcome("r2")], author_id="author")
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.VERIFIED

    def test_community_confirmed_thresholds(self):
        rows = [outcome(f"r{i}") for i in range(5)] + [outcome(f"r{i}", ) for i in range(5, 10)]
        t = compute_telemetry(rows, author_id="author")
        assert t.times_applied == 10 and t.distinct_reporters == 10
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.COMMUNITY_CONFIRMED

    def test_community_blocked_by_low_success_rate(self):
        rows = [outcome(f"r{i}") for i in range(7)] + [
            outcome(f"r{i}", result="failure", verify=False) for i in range(7, 10)
        ]
        t = compute_telemetry(rows, author_id="author")
        assert t.success_rate == 0.7  # < 0.80 bar
        assert next_tier(TrustTier.VERIFIED, t) == TrustTier.VERIFIED

    def test_promotion_never_moves_down(self):
        # community_confirmed with thin telemetry (e.g. counters recomputed
        # after cap changes) must not regress via the promotion path
        t = compute_telemetry([outcome("r1")], author_id="author")
        assert next_tier(TrustTier.COMMUNITY_CONFIRMED, t) == TrustTier.COMMUNITY_CONFIRMED


class TestAntiGaming:
    def test_single_reporter_spam_cannot_pass_reproduced(self):
        # 50 successes, one identity, cap counts only MAX_COUNTED_PER_REPORTER
        rows = [outcome("sock-puppet", counted=(i < MAX_COUNTED_PER_REPORTER)) for i in range(50)]
        t = compute_telemetry(rows, author_id="author")
        assert t.times_applied == MAX_COUNTED_PER_REPORTER
        assert t.distinct_success_reporters == 1
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.REPRODUCED  # and no further
        assert next_tier(TrustTier.REPRODUCED, t) == TrustTier.REPRODUCED

    def test_author_self_reports_never_promote(self):
        rows = [outcome("author", counted=False)] * 10
        t = compute_telemetry(rows, author_id="author")
        assert t.times_applied == 0
        assert next_tier(TrustTier.DRAFT, t) == TrustTier.DRAFT


class TestDemotionAndDanger:
    def test_auto_deprecation_on_failure_evidence(self):
        rows = [outcome(f"r{i}", result="failure", verify=False) for i in range(4)] + [outcome("r9")]
        t = compute_telemetry(rows, author_id="author")
        assert t.times_applied == 5 and t.success_rate == 0.2
        assert next_tier(TrustTier.VERIFIED, t) == TrustTier.DEPRECATED

    def test_danger_needs_two_distinct_flaggers(self):
        one = compute_telemetry([outcome("r1", result="dangerous", verify=False)], "author")
        assert next_tier(TrustTier.VERIFIED, one) != TrustTier.DANGEROUS
        two = compute_telemetry(
            [outcome("r1", result="dangerous", verify=False),
             outcome("r2", result="dangerous", verify=False)], "author")
        assert next_tier(TrustTier.VERIFIED, two) == TrustTier.DANGEROUS

    def test_danger_flags_count_even_beyond_reporter_cap(self):
        # dangerous flags are tallied on distinct reporters regardless of `counted`
        rows = [outcome("r1", result="dangerous", verify=False, counted=False),
                outcome("r2", result="dangerous", verify=False, counted=False)]
        t = compute_telemetry(rows, "author")
        assert t.dangerous_flaggers == 2
        assert next_tier(TrustTier.COMMUNITY_CONFIRMED, t) == TrustTier.DANGEROUS

    def test_danger_dominates_everything(self):
        t = Telemetry(times_applied=100, times_succeeded=100, verified_successes=100,
                      distinct_success_reporters=50, distinct_reporters=50, dangerous_flaggers=2)
        for tier in TrustTier:
            assert next_tier(tier, t) == TrustTier.DANGEROUS

    def test_terminal_tiers_sticky(self):
        healthy = compute_telemetry([outcome(f"r{i}") for i in range(10)], "author")
        assert next_tier(TrustTier.DEPRECATED, healthy) == TrustTier.DEPRECATED
        assert next_tier(TrustTier.DANGEROUS, healthy) == TrustTier.DANGEROUS

    def test_maintainer_approved_never_auto_moves(self):
        bad = compute_telemetry([outcome(f"r{i}", result="failure", verify=False) for i in range(10)], "author")
        assert next_tier(TrustTier.MAINTAINER_APPROVED, bad) == TrustTier.MAINTAINER_APPROVED

    def test_next_tier_idempotent(self):
        t = compute_telemetry([outcome("r1"), outcome("r2"), outcome("r3")], "author")
        once = next_tier(TrustTier.DRAFT, t)
        assert next_tier(once, t) == once
