"""Registry facade — the single entry point every interface (REST, MCP,
embedding host) goes through. All invariants live here, not in the transport
layers, so mounting Pathbook inside another product cannot bypass them.

Closed loop:

    lookup(error) -> execute(id) -> agent applies fix -> runs verify_yaml
        -> report_outcome(signed) -> telemetry -> auto-promotion -> ledger

Every mutation is: verify signature -> single SQLite transaction containing
(state change + ledger entry) -> commit. Crash between any two operations
leaves the database at the previous consistent state.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from . import ledger as ledger_mod
from .fingerprint import context_fingerprint, fingerprint as fp_of, is_fingerprint, normalize
from .schema import (
    PROTOCOL_VERSION,
    LookupResult,
    Outcome,
    OutcomeReport,
    PathbookRecord,
    TIER_RANK,
    TrustTier,
    utcnow_iso,
)
from .signing import verify_payload
from .store import Store
from .trust import compute_telemetry, next_tier, should_count


class RegistryError(Exception):
    """Domain error with an agent-actionable message."""

    def __init__(self, message: str, code: str = "invalid_request"):
        super().__init__(message)
        self.code = code


class Registry:
    def __init__(
        self,
        db_path: str | Path,
        secret: Optional[bytes] = None,
        maintainer_keys: Optional[list[str]] = None,
    ):
        self.store = Store(db_path, secret=secret)
        #: Hex public keys allowed to perform maintainer actions
        #: (maintainer_approved promotion, manual deprecate, dangerous flag).
        self.maintainer_keys = set(k.lower() for k in (maintainer_keys or []))

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get(self, pathbook_id: str) -> Optional[PathbookRecord]:
        with self.store.connect() as conn:
            return self.store.get(conn, pathbook_id)

    def list(self, **kwargs: Any) -> list[PathbookRecord]:
        with self.store.connect() as conn:
            return self.store.list(conn, **kwargs)

    def lookup(
        self,
        error_text: Optional[str] = None,
        fingerprint: Optional[str] = None,
        runtime: Optional[str] = None,
    ) -> LookupResult:
        """Exact-hash lookup. Give either raw error text (fingerprinted here)
        or a precomputed ``sha256:...`` fingerprint.

        Returns candidates ordered by (tier rank desc, confidence desc);
        dangerous/deprecated matches are returned separately as warnings so an
        agent is actively told "this known 'fix' is a trap", never just
        given silence.
        """
        if fingerprint is None and error_text is None:
            raise RegistryError("provide error_text or fingerprint", "missing_query")
        norm = None
        context_fp = None
        if fingerprint is None:
            norm = normalize(error_text)  # type: ignore[arg-type]
            fingerprint = fp_of(error_text)  # type: ignore[arg-type]
            context_fp = context_fingerprint(error_text)  # type: ignore[arg-type]
        elif not is_fingerprint(fingerprint):
            raise RegistryError(
                f"malformed fingerprint {fingerprint!r}; expected sha256:<64 hex chars>. "
                "If you have raw error text, pass it as error_text instead.",
                "bad_fingerprint",
            )
        with self.store.connect() as conn:
            records = (
                self.store.by_context_fingerprint(conn, context_fp)
                if context_fp
                else []
            )
            if not records:
                records = self.store.by_fingerprint(conn, fingerprint)
        if runtime:
            records = [r for r in records if not r.runtime or r.runtime == runtime]
        warn_tiers = {TrustTier.DANGEROUS, TrustTier.DEPRECATED}
        candidates = [r for r in records if r.active and r.trust_tier not in warn_tiers]
        warnings = [r for r in records if not r.active or r.trust_tier in warn_tiers]
        candidates.sort(key=lambda r: (TIER_RANK[r.trust_tier], r.confidence), reverse=True)
        return LookupResult(
            match_type="exact" if candidates or warnings else "none",
            fingerprint=fingerprint,
            normalized=norm,
            candidates=candidates,
            warnings=warnings,
        )

    # ------------------------------------------------------------------
    # Contribute
    # ------------------------------------------------------------------

    def contribute(self, record_data: dict[str, Any]) -> PathbookRecord:
        """Validate, cryptographically verify, and store a new pathbook.

        Contributor-supplied trust/telemetry fields are discarded: every
        record enters at ``draft`` with zeroed counters no matter what the
        submission claims. The signature is verified against the canonical
        signed payload — "signed provenance" is enforced, not decorative.
        """
        record_data = dict(record_data)
        # Strip any registry-owned state the contributor tried to smuggle in.
        for field in ("trust_tier", "times_applied", "times_succeeded", "confidence", "active", "updated_at"):
            record_data.pop(field, None)
        rec = PathbookRecord(**record_data)

        expected_fp = fp_of(rec.error_signature)
        if rec.error_fingerprint != expected_fp:
            raise RegistryError(
                f"error_fingerprint does not match error_signature: got {rec.error_fingerprint}, "
                f"expected {expected_fp}. Compute it with pathbook.fingerprint.fingerprint().",
                "fingerprint_mismatch",
            )
        expected_context_fp = context_fingerprint(rec.error_signature)
        if rec.context_fingerprint != expected_context_fp:
            raise RegistryError(
                "context_fingerprint does not match error_signature",
                "fingerprint_mismatch",
            )
        if not verify_payload(rec.signed_payload(), rec.signature, rec.provenance.author_public_key):
            raise RegistryError(
                "Ed25519 signature verification failed: signature does not match the canonical "
                "signed payload under provenance.author_public_key. Sign with "
                "Keypair.sign_payload(record.signed_payload()).",
                "bad_signature",
            )
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                if not self.store.pin_reporter_key(conn, rec.provenance.author_id, rec.provenance.author_public_key):
                    raise RegistryError(
                        f"author_id {rec.provenance.author_id!r} is pinned to a different public key; "
                        "use the original key or a new author_id.",
                        "key_conflict",
                    )
                if self.store.get(conn, rec.id) is not None:
                    raise RegistryError(f"pathbook id {rec.id!r} already exists", "duplicate_id")
                self.store.insert_record(conn, rec)
                ledger_mod.append_event(
                    conn, self.store.secret, "contribute",
                    {"pathbook_id": rec.id, "fingerprint": rec.error_fingerprint,
                     "author_id": rec.provenance.author_id, "signature": rec.signature},
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        self.store.refresh_checkpoint()
        return rec

    # ------------------------------------------------------------------
    # Execute (fetch-the-plan half of the loop)
    # ------------------------------------------------------------------

    def execute(
        self,
        pathbook_id: str,
        *,
        executor_id: Optional[str] = None,
        executor_public_key: Optional[str] = None,
        allow_untrusted: bool = False,
        ttl_seconds: int = 1800,
    ) -> dict[str, Any]:
        """Return the remediation plan plus an ``application_id`` the agent
        must echo back in its outcome report. Refuses to hand out plans for
        dangerous records (returns the warning instead)."""
        rec = self.get(pathbook_id)
        if rec is None:
            raise RegistryError(f"no pathbook with id {pathbook_id!r}", "not_found")
        application_id = f"app-{uuid.uuid4().hex}"
        blocked_tiers = {TrustTier.DANGEROUS, TrustTier.DEPRECATED}
        if not rec.active or rec.trust_tier in blocked_tiers:
            return {
                "application_id": application_id,
                "pathbook_id": rec.id,
                "refused": True,
                "reason": (
                    f"This pathbook is {rec.trust_tier.value} or inactive and cannot be executed."
                ),
                "failed_attempts_yaml": rec.failed_attempts_yaml,
            }
        if rec.trust_tier == TrustTier.DRAFT and not allow_untrusted:
            return {
                "application_id": application_id,
                "pathbook_id": rec.id,
                "refused": True,
                "reason": "Draft pathbooks require explicit allow_untrusted=true review mode.",
                "failed_attempts_yaml": rec.failed_attempts_yaml,
            }
        if bool(executor_id) != bool(executor_public_key):
            raise RegistryError(
                "executor_id and executor_public_key must be supplied together",
                "invalid_request",
            )
        if executor_public_key:
            try:
                raw_key = bytes.fromhex(executor_public_key)
            except ValueError as exc:
                raise RegistryError("executor_public_key must be hex", "invalid_request") from exc
            if len(raw_key) != 32:
                raise RegistryError("executor_public_key must encode 32 bytes", "invalid_request")
            executor_public_key = executor_public_key.lower()
        ttl_seconds = max(60, min(int(ttl_seconds), 86_400))
        issued_at = datetime.now(timezone.utc)
        expires_at = issued_at + timedelta(seconds=ttl_seconds)
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                self.store.issue_application(
                    conn,
                    application_id=application_id,
                    pathbook_id=rec.id,
                    pathbook_signature=rec.signature,
                    executor_id=executor_id,
                    executor_public_key=executor_public_key,
                    issued_at=issued_at.isoformat(),
                    expires_at=expires_at.isoformat(),
                )
                ledger_mod.append_event(
                    conn,
                    self.store.secret,
                    "application_issued",
                    {
                        "application_id": application_id,
                        "pathbook_id": rec.id,
                        "executor_id": executor_id,
                        "expires_at": expires_at.isoformat(),
                    },
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        self.store.refresh_checkpoint()
        return {
            "application_id": application_id,
            "pathbook_id": rec.id,
            "refused": False,
            "trust_tier": rec.trust_tier.value,
            "confidence": rec.confidence,
            "expires_at": expires_at.isoformat(),
            "requires_confirmation": rec.requires_confirmation,
            "safety_class": rec.safety_class,
            "safety_flags": rec.safety_flags,
            "trigger_yaml": rec.trigger_yaml,
            "remediation_yaml": rec.remediation_yaml,
            "verify_yaml": rec.verify_yaml,
            "failed_attempts_yaml": rec.failed_attempts_yaml,
            "instructions": (
                "Apply remediation_yaml, then run verify_yaml. Report the result via "
                "report_outcome with this application_id, signed with your Ed25519 key."
            ),
        }

    # ------------------------------------------------------------------
    # Verify / report outcome (close-the-loop half)
    # ------------------------------------------------------------------

    def report_outcome(self, report_data: dict[str, Any]) -> dict[str, Any]:
        """Ingest a signed outcome report; update telemetry; run promotion.

        Idempotent on (pathbook_id, application_id): replaying the same report
        changes nothing and says so.
        """
        report = OutcomeReport(**report_data)
        if not verify_payload(report.signed_payload(), report.signature, report.reporter_public_key):
            raise RegistryError(
                "Ed25519 signature verification failed for outcome report. Sign the canonical "
                "payload from OutcomeReport.signed_payload() with your private key.",
                "bad_signature",
            )
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                rec = self.store.get(conn, report.pathbook_id)
                if rec is None:
                    raise RegistryError(f"no pathbook with id {report.pathbook_id!r}", "not_found")
                application = self.store.get_application(conn, report.application_id)
                if application is None:
                    raise RegistryError(
                        "application_id was not issued by Registry.execute()",
                        "invalid_application",
                    )
                if application["pathbook_id"] != report.pathbook_id:
                    raise RegistryError(
                        "application_id belongs to a different pathbook",
                        "invalid_application",
                    )
                if self.store.outcome_exists(conn, report.pathbook_id, report.application_id):
                    conn.execute("ROLLBACK")
                    return {
                        "recorded": False,
                        "duplicate": True,
                        "pathbook_id": rec.id,
                        "trust_tier": rec.trust_tier.value,
                        "reason": "application_id already reported; telemetry unchanged (idempotent).",
                    }
                if application["consumed_at"] is not None:
                    raise RegistryError("application_id has already been consumed", "invalid_application")
                try:
                    expires_at = datetime.fromisoformat(application["expires_at"])
                except ValueError as exc:
                    raise RegistryError("application expiry is invalid", "invalid_application") from exc
                if expires_at <= datetime.now(timezone.utc):
                    raise RegistryError("application_id has expired", "expired_application")
                if application["pathbook_signature"] != rec.signature:
                    raise RegistryError(
                        "pathbook changed after application issuance; execute the current version",
                        "stale_application",
                    )
                if application["executor_id"] and application["executor_id"] != report.reporter_id:
                    raise RegistryError(
                        "outcome reporter does not match the issued executor",
                        "application_identity_mismatch",
                    )
                if (
                    application["executor_public_key"]
                    and application["executor_public_key"] != report.reporter_public_key
                ):
                    raise RegistryError(
                        "outcome signing key does not match the issued executor",
                        "application_identity_mismatch",
                    )
                if not self.store.pin_reporter_key(conn, report.reporter_id, report.reporter_public_key):
                    raise RegistryError(
                        f"reporter_id {report.reporter_id!r} is pinned to a different public key.",
                        "key_conflict",
                    )
                prior = self.store.outcomes_for(conn, report.pathbook_id)
                prior_counted_by_reporter = sum(
                    1 for o in prior if o["reporter_id"] == report.reporter_id and o["counted"]
                )
                counted = should_count(
                    prior_counted_by_reporter, report.reporter_id, rec.provenance.author_id
                )
                inserted = self.store.insert_outcome(conn, report, counted)
                if not inserted:
                    conn.execute("ROLLBACK")
                    return {
                        "recorded": False, "duplicate": True,
                        "pathbook_id": rec.id, "trust_tier": rec.trust_tier.value,
                        "reason": "application_id already reported; telemetry unchanged (idempotent).",
                    }
                if not self.store.consume_application(conn, report.application_id, utcnow_iso()):
                    raise RegistryError("application_id could not be consumed", "invalid_application")
                outcomes = self.store.outcomes_for(conn, report.pathbook_id)
                telemetry = compute_telemetry(outcomes, rec.provenance.author_id)
                old_tier = rec.trust_tier
                new_tier = next_tier(old_tier, telemetry)
                self.store.update_registry_state(
                    conn, rec.id,
                    trust_tier=new_tier,
                    times_applied=telemetry.times_applied,
                    times_succeeded=telemetry.times_succeeded,
                    confidence=telemetry.confidence,
                    active=rec.active and new_tier not in (TrustTier.DANGEROUS,),
                    updated_at=utcnow_iso(),
                )
                ledger_mod.append_event(
                    conn, self.store.secret, "outcome",
                    {"pathbook_id": rec.id, "application_id": report.application_id,
                     "reporter_id": report.reporter_id, "outcome": report.outcome.value,
                     "verify_passed": report.verify_passed, "counted": counted,
                     "signature": report.signature},
                )
                if new_tier != old_tier:
                    ledger_mod.append_event(
                        conn, self.store.secret, "tier_transition",
                        {"pathbook_id": rec.id, "from": old_tier.value, "to": new_tier.value,
                         "times_applied": telemetry.times_applied,
                         "times_succeeded": telemetry.times_succeeded,
                         "distinct_success_reporters": telemetry.distinct_success_reporters},
                    )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        self.store.refresh_checkpoint()
        return {
            "recorded": True, "duplicate": False, "counted": counted,
            "pathbook_id": rec.id,
            "trust_tier": new_tier.value,
            "tier_changed": new_tier != old_tier,
            "times_applied": telemetry.times_applied,
            "times_succeeded": telemetry.times_succeeded,
            "confidence": telemetry.confidence,
        }

    # ------------------------------------------------------------------
    # Maintainer actions (signed, key-gated)
    # ------------------------------------------------------------------

    def maintainer_action(self, action_data: dict[str, Any]) -> dict[str, Any]:
        """Actions: approve | deprecate | dangerous | reinstate.
        Payload must be signed by a key in ``maintainer_keys``."""
        required = {"pathbook_id", "action", "maintainer_public_key", "signature", "acted_at"}
        missing = required - set(action_data)
        if missing:
            raise RegistryError(f"missing fields: {sorted(missing)}", "invalid_request")
        pk = action_data["maintainer_public_key"].lower()
        if pk not in self.maintainer_keys:
            raise RegistryError("public key is not a registered maintainer key", "not_maintainer")
        payload = {k: action_data[k] for k in ("pathbook_id", "action", "maintainer_public_key", "acted_at")}
        if not verify_payload(payload, action_data["signature"], pk):
            raise RegistryError("Ed25519 signature verification failed for maintainer action", "bad_signature")
        action = action_data["action"]
        tier_map = {
            "approve": TrustTier.MAINTAINER_APPROVED,
            "deprecate": TrustTier.DEPRECATED,
            "dangerous": TrustTier.DANGEROUS,
            "reinstate": TrustTier.DRAFT,
        }
        if action not in tier_map:
            raise RegistryError(f"unknown action {action!r}; one of {sorted(tier_map)}", "invalid_request")
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                rec = self.store.get(conn, action_data["pathbook_id"])
                if rec is None:
                    raise RegistryError(f"no pathbook with id {action_data['pathbook_id']!r}", "not_found")
                new_tier = tier_map[action]
                self.store.update_registry_state(
                    conn, rec.id,
                    trust_tier=new_tier,
                    times_applied=rec.times_applied,
                    times_succeeded=rec.times_succeeded,
                    confidence=rec.confidence,
                    active=new_tier != TrustTier.DANGEROUS,
                    updated_at=utcnow_iso(),
                )
                ledger_mod.append_event(
                    conn, self.store.secret, "maintainer_action",
                    {"pathbook_id": rec.id, "action": action, "from": rec.trust_tier.value,
                     "to": new_tier.value, "maintainer_public_key": pk,
                     "signature": action_data["signature"]},
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        self.store.refresh_checkpoint()
        return {"pathbook_id": rec.id, "from": rec.trust_tier.value, "to": new_tier.value}

    # ------------------------------------------------------------------
    # Ledger / spec
    # ------------------------------------------------------------------

    def verify_ledger(self) -> dict[str, Any]:
        with self.store.connect() as conn:
            return ledger_mod.verify_chain(
                conn,
                self.store.secret,
                self.store.checkpoint_path,
            )

    def spec(self) -> dict[str, Any]:
        from .trust import (
            COMMUNITY_MIN_APPLICATIONS,
            COMMUNITY_MIN_DISTINCT_REPORTERS,
            COMMUNITY_MIN_SUCCESS_RATE,
            DANGEROUS_MIN_DISTINCT_FLAGGERS,
            DEPRECATE_MAX_SUCCESS_RATE,
            DEPRECATE_MIN_APPLICATIONS,
            MAX_COUNTED_PER_REPORTER,
            VERIFIED_MIN_DISTINCT_REPORTERS,
            VERIFIED_MIN_SUCCESSES,
        )
        return {
            "protocol": PROTOCOL_VERSION,
            "fingerprint": {
                "algorithm": "sha256 over normalized text",
                "normalization": [
                    "lowercase",
                    "hex runs (0x... any length; bare hex >= 8 chars) -> <hash>",
                    "digit runs -> <num>",
                    "collapse whitespace (incl. CRLF) to single spaces, strip",
                    "truncate to 2048 chars",
                ],
                "format": "sha256:<64 hex chars>",
            },
            "trust_tiers": [t.value for t in TrustTier],
            "promotion_rules": {
                "reproduced": ">=1 independent verified success",
                "verified": f">={VERIFIED_MIN_SUCCESSES} verified successes from >={VERIFIED_MIN_DISTINCT_REPORTERS} distinct reporters",
                "community_confirmed": f">={COMMUNITY_MIN_APPLICATIONS} applications, >={COMMUNITY_MIN_DISTINCT_REPORTERS} distinct reporters, success rate >={COMMUNITY_MIN_SUCCESS_RATE}",
                "maintainer_approved": "manual maintainer action only",
                "deprecated_auto": f">={DEPRECATE_MIN_APPLICATIONS} applications with success rate <{DEPRECATE_MAX_SUCCESS_RATE}",
                "dangerous": f">={DANGEROUS_MIN_DISTINCT_FLAGGERS} distinct dangerous flags, or one maintainer flag",
                "per_reporter_counted_cap": MAX_COUNTED_PER_REPORTER,
                "author_self_reports": "stored but never counted toward promotion",
            },
            "signing": {
                "algorithm": "Ed25519 over canonical JSON (sorted keys, compact separators, UTF-8)",
                "record_signed_fields": "PathbookRecord.signed_payload() — registry state excluded",
                "outcome_signed_fields": "OutcomeReport.signed_payload()",
                "enforcement": "verified on contribute, report_outcome, and maintainer actions; invalid signatures are rejected",
            },
            "ledger": "hash-chained + HMAC-sealed; GET /ledger/verify walks the full chain",
            "endpoints": [
                "GET /spec", "GET /pathbooks", "GET /pathbooks/lookup",
                "GET /pathbooks/{id}", "POST /pathbooks", "POST /pathbooks/{id}/execute",
                "POST /pathbooks/{id}/verify", "POST /pathbooks/{id}/maintainer",
                "GET /ledger/verify",
            ],
        }
