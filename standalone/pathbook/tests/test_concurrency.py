"""Concurrency suite — proves telemetry, promotion, and the ledger stay
consistent under parallel writers (threads with independent connections;
SQLite WAL + BEGIN IMMEDIATE serializes the mutations)."""

import threading

from conftest import issued_report, sample_record
from pathbook import Keypair, Registry, TrustTier
from pathbook.authoring import make_outcome_report


def test_parallel_outcome_reports_consistent(tmp_path, author_key):
    registry = Registry(tmp_path / "pb.db")
    rec = registry.contribute(sample_record(author_key))

    n = 12
    errors: list[Exception] = []

    def report(i: int) -> None:
        try:
            agent = Keypair.generate()
            registry.report_outcome(issued_report(
                registry, agent, reporter_id=f"agent-{i}", pathbook_id=rec.id,
                outcome="success", verify_passed=True))
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=report, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    final = registry.get(rec.id)
    assert final.times_applied == n and final.times_succeeded == n
    assert final.trust_tier == TrustTier.COMMUNITY_CONFIRMED
    ledger = registry.verify_ledger()
    assert ledger["ok"]
    # contribute + n outcomes + at least the reproduced/verified/community transitions
    assert ledger["entries"] >= 1 + n + 3


def test_parallel_duplicate_replay_counts_once(tmp_path, author_key):
    registry = Registry(tmp_path / "pb.db")
    rec = registry.contribute(sample_record(author_key))
    agent = Keypair.generate()
    report = issued_report(
        registry, agent, reporter_id="agent-x", pathbook_id=rec.id,
        outcome="success", verify_passed=True)

    results = []

    def send() -> None:
        try:
            results.append(registry.report_outcome(dict(report)))
        except Exception as e:  # pragma: no cover
            results.append(e)

    threads = [threading.Thread(target=send) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    recorded = [r for r in results if isinstance(r, dict) and r.get("recorded")]
    dupes = [r for r in results if isinstance(r, dict) and r.get("duplicate")]
    assert len(recorded) == 1 and len(dupes) == 7
    assert registry.get(rec.id).times_applied == 1
    assert registry.verify_ledger()["ok"]


def test_two_registry_instances_same_db(tmp_path, author_key):
    """Cross-process shape: two independent Registry objects on one DB file."""
    reg_a = Registry(tmp_path / "pb.db")
    reg_b = Registry(tmp_path / "pb.db")
    rec = reg_a.contribute(sample_record(author_key))
    agent = Keypair.generate()
    reg_b.report_outcome(issued_report(
        reg_b, agent, reporter_id="agent-b", pathbook_id=rec.id,
        outcome="success", verify_passed=True))
    seen_by_a = reg_a.get(rec.id)
    assert seen_by_a.times_applied == 1
    assert seen_by_a.trust_tier == TrustTier.REPRODUCED
    assert reg_a.verify_ledger()["ok"] and reg_b.verify_ledger()["ok"]
