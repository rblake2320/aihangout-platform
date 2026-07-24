"""Ed25519 signing for pbp-0.1 — signatures that are actually verified.

Design rules:

- Canonical JSON (sorted keys, compact separators, UTF-8) is the only thing
  ever signed. Any reordering/whitespace game produces a different byte stream
  and a failed verification, never a different accepted payload.
- Public keys are hex-encoded raw 32-byte Ed25519 keys; signatures are
  hex-encoded 64-byte Ed25519 signatures.
- ``verify_payload`` returns False on *any* failure (bad hex, wrong length,
  wrong key, tampered payload) — it never raises on untrusted input, and it
  never falls through to "accepted".
"""

from __future__ import annotations

import json
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def canonical_bytes(payload: dict[str, Any]) -> bytes:
    """Deterministic byte serialization of a payload dict."""
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


class Keypair:
    """A convenience wrapper around an Ed25519 private key."""

    def __init__(self, private_key: Ed25519PrivateKey):
        self._sk = private_key

    @classmethod
    def generate(cls) -> "Keypair":
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def from_private_hex(cls, private_hex: str) -> "Keypair":
        raw = bytes.fromhex(private_hex)
        return cls(Ed25519PrivateKey.from_private_bytes(raw))

    @property
    def private_hex(self) -> str:
        return self._sk.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        ).hex()

    @property
    def public_hex(self) -> str:
        return self._sk.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        ).hex()

    def sign_payload(self, payload: dict[str, Any]) -> str:
        """Sign canonical JSON of *payload*; return hex signature."""
        return self._sk.sign(canonical_bytes(payload)).hex()


def verify_payload(payload: dict[str, Any], signature_hex: str, public_key_hex: str) -> bool:
    """Cryptographically verify *signature_hex* over *payload* with *public_key_hex*.

    Returns False on any malformed or invalid input. Never raises for
    untrusted data, never returns True without a passing Ed25519 check.
    """
    try:
        pk_raw = bytes.fromhex(public_key_hex)
        sig_raw = bytes.fromhex(signature_hex)
        if len(pk_raw) != 32 or len(sig_raw) != 64:
            return False
        pk = Ed25519PublicKey.from_public_bytes(pk_raw)
        pk.verify(sig_raw, canonical_bytes(payload))
        return True
    except (ValueError, InvalidSignature, TypeError):
        return False
