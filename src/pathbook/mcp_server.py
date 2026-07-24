"""Pathbook MCP server — the distribution wedge.

Any MCP-capable agent stack (Claude Code, Cursor, custom SDK loops) points at
this stdio server and gets the full closed loop as tools:

    pathbook_lookup -> pathbook_execute -> (agent applies fix + runs verify)
        -> pathbook_report_outcome

Config (env):
    PATHBOOK_DB               path to the SQLite registry (default: pathbook.db)
    PATHBOOK_SECRET_FILE      registry HMAC secret sidecar (optional)
    PATHBOOK_MAINTAINER_KEYS  comma-separated hex maintainer public keys
    PATHBOOK_AGENT_KEY_FILE   file holding this agent's Ed25519 private key (hex).
                              Created on first use if absent, so outcome reports
                              can be signed automatically.
    PATHBOOK_AGENT_ID         stable reporter identity (default: derived from key)

Claude Code registration (Windows PowerShell):
    claude mcp add pathbook -- python -m pathbook.mcp_server
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from .authoring import make_outcome_report, make_record
from .registry import Registry, RegistryError
from .signing import Keypair

mcp = FastMCP("pathbook")

_registry: Optional[Registry] = None
_agent_key: Optional[Keypair] = None


def _get_registry() -> Registry:
    global _registry
    if _registry is None:
        db = os.environ.get("PATHBOOK_DB", "pathbook.db")
        maintainers = [k for k in os.environ.get("PATHBOOK_MAINTAINER_KEYS", "").split(",") if k]
        _registry = Registry(db, maintainer_keys=maintainers)
    return _registry


def _get_agent_key() -> Keypair:
    """Load (or create) this agent's signing key so reports are signed
    transparently. POSIX perms 0600; on Windows protect the file with an ACL
    or point PATHBOOK_AGENT_KEY_FILE at DPAPI-protected storage."""
    global _agent_key
    if _agent_key is None:
        key_file = Path(os.environ.get("PATHBOOK_AGENT_KEY_FILE", "pathbook_agent.key"))
        if key_file.exists():
            _agent_key = Keypair.from_private_hex(key_file.read_text().strip())
        else:
            _agent_key = Keypair.generate()
            fd = os.open(str(key_file), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, _agent_key.private_hex.encode())
            finally:
                os.close(fd)
    return _agent_key


def _agent_id() -> str:
    return os.environ.get("PATHBOOK_AGENT_ID", f"agent-{_get_agent_key().public_hex[:16]}")


def _err(e: RegistryError) -> dict[str, Any]:
    return {"error": e.code, "message": str(e)}


@mcp.tool()
def pathbook_lookup(error_text: str, runtime: str = "") -> dict[str, Any]:
    """Look up a known fix for an error BEFORE re-diagnosing or retrying.

    Pass the raw error text exactly as observed (traceback line, stderr, OS
    error). It is normalized and fingerprinted server-side; structurally
    identical errors hit the same record. Returns ranked candidates (best
    trust tier + confidence first) and explicit warnings for fixes known to be
    dangerous or deprecated. If match_type is "none", solve it yourself —
    then consider pathbook_contribute so the next agent doesn't have to.
    """
    try:
        result = _get_registry().lookup(error_text=error_text, runtime=runtime or None)
    except RegistryError as e:
        return _err(e)
    return {
        "match_type": result.match_type,
        "fingerprint": result.fingerprint,
        "candidates": [
            {
                "id": r.id, "title": r.title, "trust_tier": r.trust_tier.value,
                "confidence": round(r.confidence, 3), "runtime": r.runtime,
                "ecosystem": r.ecosystem, "times_applied": r.times_applied,
                "times_succeeded": r.times_succeeded,
                "token_savings_estimate": r.token_savings_estimate,
            }
            for r in result.candidates
        ],
        "warnings": [
            {"id": r.id, "title": r.title, "trust_tier": r.trust_tier.value,
             "failed_attempts_yaml": r.failed_attempts_yaml}
            for r in result.warnings
        ],
        "next_step": "Call pathbook_execute(id) for the best candidate to get the remediation plan.",
    }


@mcp.tool()
def pathbook_get(pathbook_id: str) -> dict[str, Any]:
    """Fetch one pathbook's full record by id, including trigger/remediation/
    verify/failed_attempts YAML, provenance, signature, telemetry, and tier."""
    rec = _get_registry().get(pathbook_id)
    if rec is None:
        return {"error": "not_found", "message": f"no pathbook {pathbook_id!r}"}
    return rec.model_dump()


@mcp.tool()
def pathbook_execute(pathbook_id: str, allow_untrusted: bool = False) -> dict[str, Any]:
    """Get the remediation plan for a pathbook plus an application_id.

    Apply remediation_yaml, avoid everything in failed_attempts_yaml, run
    verify_yaml, then ALWAYS call pathbook_report_outcome with the returned
    application_id — success or failure. Outcome reports are what promote
    good fixes and demote bad ones for every agent after you.
    """
    try:
        key = _get_agent_key()
        return _get_registry().execute(
            pathbook_id,
            executor_id=_agent_id(),
            executor_public_key=key.public_hex,
            allow_untrusted=allow_untrusted,
        )
    except RegistryError as e:
        return _err(e)


@mcp.tool()
def pathbook_report_outcome(
    pathbook_id: str,
    application_id: str,
    outcome: str,
    verify_passed: bool,
    details: str = "",
) -> dict[str, Any]:
    """Report what happened after applying a pathbook. outcome is one of
    'success', 'failure', 'dangerous' (use 'dangerous' if the fix caused
    harm). verify_passed states whether the verify_yaml check passed. The
    report is Ed25519-signed with this agent's key automatically. Idempotent
    per application_id.
    """
    try:
        report = make_outcome_report(
            _get_agent_key(),
            reporter_id=_agent_id(),
            pathbook_id=pathbook_id,
            outcome=outcome,
            verify_passed=verify_passed,
            application_id=application_id,
            details=details,
        )
        return _get_registry().report_outcome(report)
    except RegistryError as e:
        return _err(e)
    except ValueError as e:
        return {"error": "invalid_request", "message": str(e)}


@mcp.tool()
def pathbook_contribute(
    record_id: str,
    title: str,
    error_signature: str,
    trigger_yaml: str,
    remediation_yaml: str,
    verify_yaml: str,
    failed_attempts_yaml: str = "",
    ecosystem: str = "",
    runtime: str = "",
    package_name: str = "",
    token_savings_estimate: int = 0,
) -> dict[str, Any]:
    """Contribute a NEW pathbook after solving an error the registry missed.

    error_signature must be the raw error text (it is fingerprinted for
    lookup). remediation_yaml = the fix steps; verify_yaml = how to confirm it
    worked; failed_attempts_yaml = dead ends you tried that others must skip.
    The record is signed with this agent's key and enters at trust tier
    'draft' — it earns promotion when other agents verify it.
    """
    try:
        record = make_record(
            _get_agent_key(),
            author_id=_agent_id(),
            record_id=record_id,
            title=title,
            error_signature=error_signature,
            trigger_yaml=trigger_yaml,
            remediation_yaml=remediation_yaml,
            verify_yaml=verify_yaml,
            failed_attempts_yaml=failed_attempts_yaml,
            ecosystem=ecosystem,
            runtime=runtime,
            package_name=package_name,
            token_savings_estimate=token_savings_estimate,
            source="mcp",
        )
        rec = _get_registry().contribute(record)
        return {"contributed": True, "id": rec.id, "trust_tier": rec.trust_tier.value,
                "fingerprint": rec.error_fingerprint}
    except RegistryError as e:
        return _err(e)


@mcp.tool()
def pathbook_spec() -> dict[str, Any]:
    """Return the pbp-0.1 protocol spec: fingerprint algorithm, trust tiers,
    promotion rules, signing scheme, and available operations."""
    return _get_registry().spec()


def main() -> None:  # pathbook-mcp entry point
    mcp.run()


if __name__ == "__main__":
    main()
