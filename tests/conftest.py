import pytest

from pathbook import Keypair, Registry
from pathbook.authoring import make_outcome_report, make_record


@pytest.fixture()
def author_key():
    return Keypair.generate()


@pytest.fixture()
def maintainer_key():
    return Keypair.generate()


@pytest.fixture()
def registry(tmp_path, maintainer_key):
    return Registry(tmp_path / "pb.db", maintainer_keys=[maintainer_key.public_hex])


def sample_record(key, record_id="PB-TEST001", author_id="author-1", **over):
    base = dict(
        record_id=record_id,
        title="Test pathbook",
        error_signature="OSError: [WinError 10048] Only one usage of each socket address",
        trigger_yaml="when: test",
        remediation_yaml="steps:\n  - do the fix",
        verify_yaml="check: it worked",
        failed_attempts_yaml="do_not:\n  - the bad thing",
        ecosystem="python",
        runtime="windows-bash",
        token_savings_estimate=1000,
    )
    base.update(over)
    return make_record(key, author_id=author_id, **base)


@pytest.fixture()
def contributed(registry, author_key):
    rec = registry.contribute(sample_record(author_key))
    return rec


def issued_report(
    registry,
    key,
    *,
    reporter_id,
    pathbook_id,
    outcome,
    verify_passed,
    details="",
):
    plan = registry.execute(
        pathbook_id,
        executor_id=reporter_id,
        executor_public_key=key.public_hex,
        allow_untrusted=True,
    )
    assert not plan["refused"]
    return make_outcome_report(
        key,
        reporter_id=reporter_id,
        pathbook_id=pathbook_id,
        outcome=outcome,
        verify_passed=verify_passed,
        application_id=plan["application_id"],
        details=details,
    )
