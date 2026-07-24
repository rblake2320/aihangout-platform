"""Pathbook Protocol (pbp-0.1) reference implementation.

A shared, machine-readable, trust-tiered known-error registry for AI agents:
fingerprint-indexed lookup, Ed25519-enforced provenance, telemetry-driven
tier promotion, and a tamper-evident event ledger — with the full
lookup -> execute -> verify -> report -> promote loop closed.
"""

from .authoring import make_maintainer_action, make_outcome_report, make_record
from .fingerprint import fingerprint, is_fingerprint, normalize
from .registry import Registry, RegistryError
from .schema import (
    PROTOCOL_VERSION,
    LookupResult,
    Outcome,
    OutcomeReport,
    PathbookRecord,
    Provenance,
    TrustTier,
)
from .signing import Keypair, verify_payload

__version__ = "0.1.0"

__all__ = [
    "PROTOCOL_VERSION",
    "Registry",
    "RegistryError",
    "Keypair",
    "verify_payload",
    "fingerprint",
    "normalize",
    "is_fingerprint",
    "PathbookRecord",
    "OutcomeReport",
    "Provenance",
    "Outcome",
    "TrustTier",
    "LookupResult",
    "make_record",
    "make_outcome_report",
    "make_maintainer_action",
]
