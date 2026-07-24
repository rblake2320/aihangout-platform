"""True cross-process SQLite/ledger verification, including Windows spawn."""

import multiprocessing

from conftest import sample_record
from pathbook import Keypair, Registry
from pathbook.authoring import make_outcome_report


def _report_from_process(db_path: str, reporter_id: str, queue) -> None:
    try:
        registry = Registry(db_path)
        key = Keypair.generate()
        plan = registry.execute(
            "PB-TEST001",
            executor_id=reporter_id,
            executor_public_key=key.public_hex,
            allow_untrusted=True,
        )
        result = registry.report_outcome(
            make_outcome_report(
                key,
                reporter_id=reporter_id,
                pathbook_id="PB-TEST001",
                outcome="success",
                verify_passed=True,
                application_id=plan["application_id"],
            )
        )
        queue.put(("ok", result["recorded"]))
    except Exception as exc:  # pragma: no cover - details returned to parent
        queue.put(("error", repr(exc)))


def test_spawned_processes_preserve_state_and_ledger(tmp_path):
    db_path = tmp_path / "pb.db"
    registry = Registry(db_path)
    registry.contribute(sample_record(Keypair.generate()))

    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    workers = [
        context.Process(
            target=_report_from_process,
            args=(str(db_path), f"process-agent-{index}", queue),
        )
        for index in range(4)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(30)
        assert worker.exitcode == 0

    results = [queue.get(timeout=5) for _ in workers]
    assert all(result == ("ok", True) for result in results)
    assert registry.get("PB-TEST001").times_applied == 4
    assert registry.verify_ledger()["ok"]
