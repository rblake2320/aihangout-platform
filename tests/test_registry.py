"""Registry suite — proves the facade enforces every invariant: signature
gates, fingerprint integrity, contributor-state stripping, the closed
verify->telemetry->promotion loop, idempotent replay, gaming resistance at
the storage layer, and key-gated maintainer actions."""

import pytest

from conftest import issued_report, sample_record
from pathbook import Keypair, RegistryError, TrustTier
from pathbook.authoring import make_maintainer_action, make_outcome_report


class TestContribute:
    def test_valid_contribution_enters_at_draft(self, registry, author_key):
        rec = registry.contribute(sample_record(author_key))
        assert rec.trust_tier == TrustTier.DRAFT
        assert rec.times_applied == rec.times_succeeded == 0

    def test_forged_signature_rejected(self, registry, author_key):
        data = sample_record(author_key)
        data["title"] = "tampered after signing"
        with pytest.raises(RegistryError) as e:
            registry.contribute(data)
        assert e.value.code == "bad_signature"

    def test_signature_from_wrong_key_rejected(self, registry):
        # A different keypair signs the identical payload — signature is valid
        # cryptography, but not under provenance.author_public_key: rejected.
        victim, attacker = Keypair.generate(), Keypair.generate()
        data = sample_record(victim)
        from pathbook.schema import PathbookRecord
        payload = PathbookRecord(**data).signed_payload()
        data["signature"] = attacker.sign_payload(payload)
        with pytest.raises(RegistryError) as e:
            registry.contribute(data)
        assert e.value.code == "bad_signature"

    def test_fingerprint_mismatch_rejected(self, registry, author_key):
        data = sample_record(author_key)
        data["error_fingerprint"] = "sha256:" + "0" * 64
        with pytest.raises(RegistryError) as e:
            registry.contribute(data)
        assert e.value.code in ("fingerprint_mismatch", "bad_signature")

    def test_duplicate_id_rejected(self, registry, author_key, contributed):
        with pytest.raises(RegistryError) as e:
            registry.contribute(sample_record(author_key))
        assert e.value.code == "duplicate_id"

    def test_smuggled_trust_state_stripped(self, registry, author_key):
        data = sample_record(author_key, record_id="PB-SMUGGLE")
        data["trust_tier"] = "maintainer_approved"
        data["times_applied"] = 9999
        data["times_succeeded"] = 9999
        data["confidence"] = 1.0
        rec = registry.contribute(data)
        assert rec.trust_tier == TrustTier.DRAFT
        assert rec.times_applied == 0 and rec.confidence == 0.5

    def test_author_identity_key_pinning(self, registry, author_key):
        registry.contribute(sample_record(author_key, record_id="PB-A"))
        imposter = Keypair.generate()
        with pytest.raises(RegistryError) as e:
            registry.contribute(sample_record(imposter, record_id="PB-B", author_id="author-1"))
        assert e.value.code == "key_conflict"


class TestLookup:
    def test_exact_hit_via_error_text_variants(self, registry, contributed):
        for text in [
            "OSError: [WinError 10048] Only one usage of each socket address",
            "oserror: [winerror 10048] only one usage   of each socket address",  # case+ws differ
        ]:
            res = registry.lookup(error_text=text)
            assert res.match_type == "exact"
            assert res.candidates[0].id == contributed.id

    def test_lookup_by_fingerprint(self, registry, contributed):
        res = registry.lookup(fingerprint=contributed.error_fingerprint)
        assert [c.id for c in res.candidates] == [contributed.id]

    def test_malformed_fingerprint_actionable_error(self, registry):
        with pytest.raises(RegistryError) as e:
            registry.lookup(fingerprint="10048")
        assert e.value.code == "bad_fingerprint"
        assert "error_text" in str(e.value)  # tells the agent what to do instead

    def test_miss_returns_none_type(self, registry):
        res = registry.lookup(error_text="totally novel failure nobody has seen")
        assert res.match_type == "none" and res.candidates == []

    def test_dangerous_surfaces_as_warning_not_candidate(self, registry, contributed, maintainer_key):
        registry.maintainer_action(
            make_maintainer_action(maintainer_key, pathbook_id=contributed.id, action="dangerous")
        )
        res = registry.lookup(fingerprint=contributed.error_fingerprint)
        assert res.candidates == []
        assert res.warnings and res.warnings[0].trust_tier == TrustTier.DANGEROUS
        assert res.match_type == "exact"  # the agent is told, not left silent


class TestClosedLoop:
    def test_execute_then_report_promotes(self, registry, contributed):
        plan = registry.execute(contributed.id, allow_untrusted=True)
        assert not plan["refused"] and "remediation_yaml" in plan
        agent = Keypair.generate()
        report = make_outcome_report(
            agent, reporter_id="agent-x", pathbook_id=contributed.id,
            outcome="success", verify_passed=True, application_id=plan["application_id"],
        )
        res = registry.report_outcome(report)
        assert res["tier_changed"] and res["trust_tier"] == "reproduced"
        assert res["times_applied"] == 1 and res["times_succeeded"] == 1

    def test_replay_is_idempotent(self, registry, contributed):
        agent = Keypair.generate()
        report = issued_report(
            registry, agent, reporter_id="agent-x", pathbook_id=contributed.id,
            outcome="success", verify_passed=True)
        first = registry.report_outcome(report)
        second = registry.report_outcome(report)
        assert first["recorded"] and second["duplicate"]
        rec = registry.get(contributed.id)
        assert rec.times_applied == 1  # not double-counted

    def test_forged_outcome_report_rejected(self, registry, contributed):
        agent = Keypair.generate()
        report = issued_report(
            registry, agent, reporter_id="agent-x", pathbook_id=contributed.id,
            outcome="success", verify_passed=True)
        report["verify_passed"] = True
        report["outcome"] = "failure"  # flips a signed field
        with pytest.raises(RegistryError) as e:
            registry.report_outcome(report)
        assert e.value.code == "bad_signature"

    def test_reporter_key_hijack_rejected(self, registry, contributed):
        real = Keypair.generate()
        registry.report_outcome(issued_report(
            registry, real, reporter_id="agent-x", pathbook_id=contributed.id,
            outcome="success", verify_passed=True))
        imposter = Keypair.generate()
        with pytest.raises(RegistryError) as e:
            registry.report_outcome(issued_report(
                registry, imposter, reporter_id="agent-x", pathbook_id=contributed.id,
                outcome="failure", verify_passed=False))
        assert e.value.code == "key_conflict"

    def test_full_ladder_climb_to_community_confirmed(self, registry, contributed):
        # 10 distinct agents, all verified successes
        for i in range(10):
            agent = Keypair.generate()
            registry.report_outcome(issued_report(
                registry, agent, reporter_id=f"agent-{i}", pathbook_id=contributed.id,
                outcome="success", verify_passed=True))
        rec = registry.get(contributed.id)
        assert rec.trust_tier == TrustTier.COMMUNITY_CONFIRMED
        assert rec.times_applied == 10 and rec.times_succeeded == 10
        assert rec.confidence == pytest.approx(11 / 12)

    def test_single_agent_spam_stalls_at_reproduced(self, registry, contributed):
        agent = Keypair.generate()
        for _ in range(20):
            registry.report_outcome(issued_report(
                registry, agent, reporter_id="spammer", pathbook_id=contributed.id,
                outcome="success", verify_passed=True))
        rec = registry.get(contributed.id)
        assert rec.trust_tier == TrustTier.REPRODUCED  # capped, cannot climb further
        assert rec.times_applied <= 3  # per-reporter counted cap

    def test_author_self_reports_do_not_promote(self, registry, author_key, contributed):
        registry.report_outcome(issued_report(
            registry, author_key, reporter_id="author-1", pathbook_id=contributed.id,
            outcome="success", verify_passed=True))
        rec = registry.get(contributed.id)
        assert rec.trust_tier == TrustTier.DRAFT and rec.times_applied == 0

    def test_failures_deprecate(self, registry, contributed):
        for i in range(5):
            agent = Keypair.generate()
            registry.report_outcome(issued_report(
                registry, agent, reporter_id=f"f-{i}", pathbook_id=contributed.id,
                outcome="failure", verify_passed=False))
        rec = registry.get(contributed.id)
        assert rec.trust_tier == TrustTier.DEPRECATED

    def test_two_danger_flags_make_dangerous_and_execute_refuses(self, registry, contributed):
        for i in range(2):
            agent = Keypair.generate()
            registry.report_outcome(issued_report(
                registry, agent, reporter_id=f"d-{i}", pathbook_id=contributed.id,
                outcome="dangerous", verify_passed=False))
        rec = registry.get(contributed.id)
        assert rec.trust_tier == TrustTier.DANGEROUS and not rec.active
        plan = registry.execute(contributed.id)
        assert plan["refused"] and "dangerous" in plan["reason"].lower()

    def test_ledger_records_the_whole_story(self, registry, contributed):
        agent = Keypair.generate()
        registry.report_outcome(issued_report(
            registry, agent, reporter_id="agent-x", pathbook_id=contributed.id,
            outcome="success", verify_passed=True))
        check = registry.verify_ledger()
        assert check["ok"] and check["entries"] >= 3  # contribute + outcome + tier_transition


class TestMaintainerActions:
    def test_approve_requires_registered_key(self, registry, contributed):
        rando = Keypair.generate()
        with pytest.raises(RegistryError) as e:
            registry.maintainer_action(
                make_maintainer_action(rando, pathbook_id=contributed.id, action="approve"))
        assert e.value.code == "not_maintainer"

    def test_approve_with_maintainer_key(self, registry, contributed, maintainer_key):
        res = registry.maintainer_action(
            make_maintainer_action(maintainer_key, pathbook_id=contributed.id, action="approve"))
        assert res["to"] == "maintainer_approved"
        assert registry.get(contributed.id).trust_tier == TrustTier.MAINTAINER_APPROVED

    def test_forged_maintainer_signature_rejected(self, registry, contributed, maintainer_key):
        action = make_maintainer_action(maintainer_key, pathbook_id=contributed.id, action="approve")
        action["action"] = "dangerous"  # tamper after signing
        with pytest.raises(RegistryError) as e:
            registry.maintainer_action(action)
        assert e.value.code == "bad_signature"

    def test_unknown_action_rejected(self, registry, contributed, maintainer_key):
        with pytest.raises(RegistryError):
            registry.maintainer_action(
                make_maintainer_action(maintainer_key, pathbook_id=contributed.id, action="bless"))
