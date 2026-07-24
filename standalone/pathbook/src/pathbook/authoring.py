"""Client-side authoring helpers: build correctly-fingerprinted, correctly-
signed records and outcome reports. This is what an agent SDK embeds."""

from __future__ import annotations

import uuid
from typing import Any, Optional

from .fingerprint import context_fingerprint, fingerprint as fp_of
from .schema import (
    Outcome,
    OutcomeReport,
    PathbookRecord,
    Provenance,
    VerificationEvidence,
    utcnow_iso,
)
from .signing import Keypair
from .validation import remediation_risk


def make_record(
    keypair: Keypair,
    *,
    author_id: str,
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
    source: str = "",
) -> dict[str, Any]:
    """Return a contribute-ready record dict (fingerprint computed, payload
    signed). The returned dict round-trips through ``Registry.contribute``."""
    provenance = Provenance(
        author_id=author_id,
        author_public_key=keypair.public_hex,
        source=source,
        created_at=utcnow_iso(),
    )
    safety_class, safety_flags = remediation_risk(remediation_yaml)
    unsigned = PathbookRecord(
        id=record_id,
        title=title,
        error_signature=error_signature,
        error_fingerprint=fp_of(error_signature),
        context_fingerprint=context_fingerprint(error_signature),
        ecosystem=ecosystem,
        runtime=runtime,
        package_name=package_name,
        trigger_yaml=trigger_yaml,
        remediation_yaml=remediation_yaml,
        verify_yaml=verify_yaml,
        failed_attempts_yaml=failed_attempts_yaml,
        safety_class=safety_class,
        safety_flags=safety_flags,
        requires_confirmation=safety_class == "high",
        token_savings_estimate=token_savings_estimate,
        provenance=provenance,
        signature="0" * 128,  # placeholder; replaced below
    )
    signature = keypair.sign_payload(unsigned.signed_payload())
    data = unsigned.model_dump()
    data["signature"] = signature
    data["trust_tier"] = data["trust_tier"].value if hasattr(data["trust_tier"], "value") else data["trust_tier"]
    return data


def make_outcome_report(
    keypair: Keypair,
    *,
    reporter_id: str,
    pathbook_id: str,
    outcome: Outcome | str,
    verify_passed: bool,
    application_id: Optional[str] = None,
    details: str = "",
    evidence: Optional[VerificationEvidence | dict[str, Any]] = None,
) -> dict[str, Any]:
    """Return a signed outcome-report dict ready for ``Registry.report_outcome``."""
    # A caller may construct a report with its own id for negative testing or
    # offline signing, but Registry.report_outcome accepts only ids persisted
    # by Registry.execute().
    application_id = application_id or f"app-{uuid.uuid4().hex}"
    if evidence is None and Outcome(outcome) == Outcome.SUCCESS and verify_passed:
        evidence = VerificationEvidence.self_attested(details)
    unsigned = OutcomeReport(
        pathbook_id=pathbook_id,
        application_id=application_id,
        reporter_id=reporter_id,
        reporter_public_key=keypair.public_hex,
        outcome=Outcome(outcome),
        verify_passed=verify_passed,
        details=details,
        evidence=evidence,
        signature="0" * 128,
    )
    signature = keypair.sign_payload(unsigned.signed_payload())
    data = unsigned.model_dump()
    data["signature"] = signature
    data["outcome"] = data["outcome"].value if hasattr(data["outcome"], "value") else data["outcome"]
    return data


def make_maintainer_action(
    keypair: Keypair,
    *,
    pathbook_id: str,
    action: str,
) -> dict[str, Any]:
    payload = {
        "pathbook_id": pathbook_id,
        "action": action,
        "maintainer_public_key": keypair.public_hex,
        "acted_at": utcnow_iso(),
    }
    return {**payload, "signature": keypair.sign_payload(payload)}
