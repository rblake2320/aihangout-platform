"""Pydantic schema for pbp-0.1 records.

A Pathbook record separates *immutable, author-signed content* from *mutable
registry state*:

- Signed content: identity, scoping, trigger/remediation/verify/failed_attempts,
  provenance, token_savings_estimate. Covered by the author's Ed25519 signature.
- Registry state: trust_tier, times_applied, times_succeeded, confidence,
  active. Owned by the registry's trust engine, never by the contributor,
  and therefore excluded from the author signature (and protected instead by
  the registry's hash-chained ledger).
"""

from __future__ import annotations

import enum
import hashlib
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .validation import remediation_risk, validate_structured_text

PROTOCOL_VERSION = "pbp-0.1"


class TrustTier(str, enum.Enum):
    DRAFT = "draft"
    REPRODUCED = "reproduced"
    VERIFIED = "verified"
    COMMUNITY_CONFIRMED = "community_confirmed"
    MAINTAINER_APPROVED = "maintainer_approved"
    DEPRECATED = "deprecated"
    DANGEROUS = "dangerous"


#: Rank used for ordering lookups. Terminal warning tiers rank below draft.
TIER_RANK: dict[TrustTier, int] = {
    TrustTier.MAINTAINER_APPROVED: 5,
    TrustTier.COMMUNITY_CONFIRMED: 4,
    TrustTier.VERIFIED: 3,
    TrustTier.REPRODUCED: 2,
    TrustTier.DRAFT: 1,
    TrustTier.DEPRECATED: 0,
    TrustTier.DANGEROUS: -1,
}

#: Tiers a record can be automatically promoted through, in order.
PROMOTION_LADDER = [
    TrustTier.DRAFT,
    TrustTier.REPRODUCED,
    TrustTier.VERIFIED,
    TrustTier.COMMUNITY_CONFIRMED,
]


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Provenance(BaseModel):
    author_id: str = Field(min_length=1, max_length=200, description="Stable identifier for the contributing human/agent.")
    author_public_key: str = Field(min_length=64, max_length=64, description="Hex-encoded 32-byte Ed25519 public key.")
    source: str = Field(default="", max_length=2000, description="Where this fix came from (repo, incident, session id).")
    created_at: str = Field(default_factory=utcnow_iso)

    @field_validator("author_public_key")
    @classmethod
    def _hex_key(cls, v: str) -> str:
        bytes.fromhex(v)  # raises ValueError on non-hex
        return v.lower()


class PathbookRecord(BaseModel):
    # ---- signed, immutable content ------------------------------------
    id: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]+$")
    protocol: str = Field(default=PROTOCOL_VERSION)
    title: str = Field(min_length=1, max_length=300)
    error_signature: str = Field(
        min_length=1,
        max_length=10_000,
        description="A raw exemplar of the error text this pathbook keys on.",
    )
    error_fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    context_fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    ecosystem: str = Field(default="", max_length=100)
    runtime: str = Field(default="", max_length=100)
    package_name: str = Field(default="", max_length=200)
    trigger_yaml: str = Field(min_length=1, max_length=20_000, description="When this pathbook applies.")
    remediation_yaml: str = Field(min_length=1, max_length=20_000, description="The fix steps.")
    verify_yaml: str = Field(min_length=1, max_length=20_000, description="How to confirm the fix worked.")
    failed_attempts_yaml: str = Field(default="", max_length=20_000, description="What NOT to try — negative knowledge.")
    safety_class: str = Field(default="low", pattern=r"^(low|high)$")
    safety_flags: list[str] = Field(default_factory=list, max_length=20)
    requires_confirmation: bool = False
    token_savings_estimate: int = Field(default=0, ge=0)
    provenance: Provenance
    signature: str = Field(min_length=128, max_length=128, description="Hex-encoded Ed25519 signature over the canonical signed payload.")

    # ---- mutable registry state (never author-controlled) -------------
    trust_tier: TrustTier = TrustTier.DRAFT
    times_applied: int = Field(default=0, ge=0)
    times_succeeded: int = Field(default=0, ge=0)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    active: bool = True
    updated_at: str = Field(default_factory=utcnow_iso)

    @field_validator("protocol")
    @classmethod
    def _protocol(cls, v: str) -> str:
        if v != PROTOCOL_VERSION:
            raise ValueError(f"unsupported protocol version {v!r}; this registry speaks {PROTOCOL_VERSION}")
        return v

    @field_validator("signature")
    @classmethod
    def _hex_sig(cls, v: str) -> str:
        bytes.fromhex(v)
        return v.lower()

    @field_validator("trigger_yaml", "remediation_yaml", "verify_yaml")
    @classmethod
    def _structured_required(cls, v: str) -> str:
        return validate_structured_text(v)

    @field_validator("failed_attempts_yaml")
    @classmethod
    def _structured_optional(cls, v: str) -> str:
        return validate_structured_text(v, allow_empty=True)

    @model_validator(mode="after")
    def _safety_matches_content(self) -> "PathbookRecord":
        expected_class, expected_flags = remediation_risk(self.remediation_yaml)
        if self.safety_class != expected_class or sorted(self.safety_flags) != sorted(expected_flags):
            raise ValueError("safety metadata does not match remediation content")
        if expected_class == "high" and not self.requires_confirmation:
            raise ValueError("high-risk remediation requires explicit confirmation")
        return self

    def signed_payload(self) -> dict[str, Any]:
        """The exact dict covered by the author signature. Mutable registry
        state is deliberately excluded."""
        return {
            "id": self.id,
            "protocol": self.protocol,
            "title": self.title,
            "error_signature": self.error_signature,
            "error_fingerprint": self.error_fingerprint,
            "context_fingerprint": self.context_fingerprint,
            "ecosystem": self.ecosystem,
            "runtime": self.runtime,
            "package_name": self.package_name,
            "trigger_yaml": self.trigger_yaml,
            "remediation_yaml": self.remediation_yaml,
            "verify_yaml": self.verify_yaml,
            "failed_attempts_yaml": self.failed_attempts_yaml,
            "safety_class": self.safety_class,
            "safety_flags": self.safety_flags,
            "requires_confirmation": self.requires_confirmation,
            "token_savings_estimate": self.token_savings_estimate,
            "provenance": self.provenance.model_dump(),
        }


class Outcome(str, enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DANGEROUS = "dangerous"  # "this 'fix' caused harm" — a first-class signal


class VerificationEvidence(BaseModel):
    """Signed evidence describing what the reporter actually checked."""

    check_id: str = Field(min_length=1, max_length=200)
    exit_code: int = Field(ge=-255, le=255)
    output_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    environment_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    observed_at: str = Field(default_factory=utcnow_iso)

    @classmethod
    def self_attested(cls, details: str = "", *, exit_code: int = 0) -> "VerificationEvidence":
        output = hashlib.sha256(details.encode("utf-8")).hexdigest()
        environment = hashlib.sha256(b"unspecified").hexdigest()
        return cls(
            check_id="self-attested-client-check",
            exit_code=exit_code,
            output_digest=f"sha256:{output}",
            environment_digest=f"sha256:{environment}",
        )


class OutcomeReport(BaseModel):
    """A signed report that an agent applied a pathbook and observed a result.

    ``application_id`` is the idempotency key: the same application reported
    twice mutates telemetry exactly once.
    """

    pathbook_id: str
    application_id: str = Field(min_length=8, max_length=80)
    reporter_id: str = Field(min_length=1, max_length=200)
    reporter_public_key: str = Field(min_length=64, max_length=64)
    outcome: Outcome
    verify_passed: bool = False
    details: str = Field(default="", max_length=4000)
    evidence: Optional[VerificationEvidence] = None
    reported_at: str = Field(default_factory=utcnow_iso)
    signature: str = Field(min_length=128, max_length=128)

    @field_validator("reporter_public_key")
    @classmethod
    def _hex_key(cls, v: str) -> str:
        bytes.fromhex(v)
        return v.lower()

    @field_validator("signature")
    @classmethod
    def _hex_sig(cls, v: str) -> str:
        bytes.fromhex(v)
        return v.lower()

    def signed_payload(self) -> dict[str, Any]:
        return {
            "pathbook_id": self.pathbook_id,
            "application_id": self.application_id,
            "reporter_id": self.reporter_id,
            "reporter_public_key": self.reporter_public_key,
            "outcome": self.outcome.value,
            "verify_passed": self.verify_passed,
            "details": self.details,
            "evidence": self.evidence.model_dump() if self.evidence else None,
            "reported_at": self.reported_at,
        }

    @model_validator(mode="after")
    def _success_requires_evidence(self) -> "OutcomeReport":
        if self.outcome == Outcome.SUCCESS and self.verify_passed and self.evidence is None:
            raise ValueError("verified success requires signed verification evidence")
        if self.evidence is not None and self.verify_passed and self.evidence.exit_code != 0:
            raise ValueError("verify_passed cannot be true when evidence exit_code is nonzero")
        return self


class LookupResult(BaseModel):
    match_type: str  # "exact" | "none"
    fingerprint: str
    normalized: Optional[str] = None
    candidates: list[PathbookRecord] = Field(default_factory=list)
    warnings: list[PathbookRecord] = Field(default_factory=list)  # dangerous/deprecated records for this fingerprint
