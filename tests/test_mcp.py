"""MCP suite — proves the agent-facing tools drive the same closed loop:
lookup -> execute -> report_outcome, plus contribute, with automatic signing."""

import asyncio

import pytest

import pathbook.mcp_server as srv
from pathbook import Registry, TrustTier
from pathbook.seeds import seed
from pathbook.signing import Keypair


@pytest.fixture()
def mcp_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PATHBOOK_DB", str(tmp_path / "pb.db"))
    monkeypatch.setenv("PATHBOOK_AGENT_KEY_FILE", str(tmp_path / "agent.key"))
    monkeypatch.setenv("PATHBOOK_AGENT_ID", "test-agent")
    # reset module singletons between tests
    srv._registry = None
    srv._agent_key = None
    yield
    srv._registry = None
    srv._agent_key = None


def test_tools_registered(mcp_env):
    tools = asyncio.run(srv.mcp.list_tools())
    names = {t.name for t in tools}
    assert {"pathbook_lookup", "pathbook_get", "pathbook_execute",
            "pathbook_report_outcome", "pathbook_contribute", "pathbook_spec"} <= names


def test_contribute_lookup_execute_report_loop(mcp_env):
    contributed = srv.pathbook_contribute(
        record_id="MCP-TEST001",
        title="Test via MCP",
        error_signature="RuntimeError: widget exploded at 0xdeadbeef",
        trigger_yaml="when: testing",
        remediation_yaml="steps:\n  - reattach widget",
        verify_yaml="check: widget attached",
        failed_attempts_yaml="do_not:\n  - percussive maintenance",
        runtime="windows-bash",
    )
    assert contributed["contributed"] and contributed["trust_tier"] == "draft"

    found = srv.pathbook_lookup("RuntimeError: widget exploded at 0x12345678")
    assert found["match_type"] == "exact"
    assert found["candidates"][0]["id"] == "MCP-TEST001"

    plan = srv.pathbook_execute("MCP-TEST001", allow_untrusted=True)
    assert not plan["refused"]

    # self-report: recorded but never counted toward promotion (same agent key)
    res = srv.pathbook_report_outcome(
        "MCP-TEST001", plan["application_id"], "success", True)
    assert res["recorded"] and res["counted"] is False
    assert res["trust_tier"] == "draft"

    # an independent agent's report promotes — inject via a second registry handle
    from pathbook.authoring import make_outcome_report
    other = Keypair.generate()
    other_plan = srv._get_registry().execute(
        "MCP-TEST001",
        executor_id="independent",
        executor_public_key=other.public_hex,
        allow_untrusted=True,
    )
    srv._get_registry().report_outcome(make_outcome_report(
        other, reporter_id="independent", pathbook_id="MCP-TEST001",
        outcome="success", verify_passed=True,
        application_id=other_plan["application_id"]))
    assert srv.pathbook_get("MCP-TEST001")["trust_tier"] == "reproduced"


def test_lookup_miss_guides_contribution(mcp_env):
    res = srv.pathbook_lookup("some error nobody catalogued zzz")
    assert res["match_type"] == "none" and res["candidates"] == []


def test_report_invalid_outcome_value(mcp_env):
    srv.pathbook_contribute(
        record_id="MCP-TEST002", title="t",
        error_signature="Boom", trigger_yaml="when: test",
        remediation_yaml="steps: [retry]", verify_yaml="check: ok")
    res = srv.pathbook_report_outcome("MCP-TEST002", "app-x" * 3, "sorta-worked", False)
    assert res.get("error") == "invalid_request"


def test_seeded_registry_over_mcp(mcp_env):
    reg = srv._get_registry()
    result = seed(reg, Keypair.generate())
    assert len(result["added"]) == 8 and result["frp_port001_promoted"]
    hit = srv.pathbook_lookup(
        "OSError: [WinError 10048] Only one usage of each socket address "
        "(protocol/network address/port) is normally permitted")
    assert hit["match_type"] == "exact"
    assert hit["candidates"][0]["trust_tier"] == "reproduced"
