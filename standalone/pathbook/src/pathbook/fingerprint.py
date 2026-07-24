"""Error fingerprinting for pbp-0.1.

The load-bearing idea: structurally-identical errors must collide on purpose.
``Error at 0x7f3a... line 42`` and ``Error at 0x9b1c... line 88`` normalize to
the same text and therefore the same SHA-256 fingerprint.

Normalization pipeline (order matters — hex before digits, otherwise digit
substitution destroys hex runs before they can be recognized):

1. lowercase
2. replace hex runs (``0x...`` of any length, or bare hex >= 8 chars) with ``<hash>``
3. replace digit runs with ``<num>``
4. collapse all whitespace (including CRLF) to single spaces, strip
5. truncate to 2048 chars
6. SHA-256 the UTF-8 bytes -> ``sha256:<hexdigest>``

The pipeline is deterministic and pure: same input text always yields the same
fingerprint on any OS (CRLF vs LF differences are erased by step 4).
"""

from __future__ import annotations

import hashlib
import re

MAX_NORMALIZED_LEN = 2048
FINGERPRINT_PREFIX = "sha256:"

# 0x-prefixed hex of any length, or a bare hex run of >= 8 chars.
# Applied after lowercasing, so [0-9a-f] is sufficient.
_HEX_RE = re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b")
_NUM_RE = re.compile(r"\d+")
_WS_RE = re.compile(r"\s+")

_FP_FORMAT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_STABLE_CODE_RE = re.compile(
    r"\b(winerror|errno|error\s+code|status(?:\s+code)?|http|cuda\s+error)"
    r"\s*[:#]?\s*(\d{1,6})\b",
    re.IGNORECASE,
)


def normalize(text: str) -> str:
    """Return the canonical normalized form of an error text."""
    if not isinstance(text, str):
        raise TypeError("error text must be a string")
    out = text.lower()
    out = _HEX_RE.sub("<hash>", out)
    out = _NUM_RE.sub("<num>", out)
    out = _WS_RE.sub(" ", out).strip()
    return out[:MAX_NORMALIZED_LEN]


def fingerprint(text: str) -> str:
    """Return the pbp-0.1 fingerprint ``sha256:<hexdigest>`` of an error text."""
    norm = normalize(text)
    digest = hashlib.sha256(norm.encode("utf-8")).hexdigest()
    return f"{FINGERPRINT_PREFIX}{digest}"


def context_fingerprint(text: str) -> str:
    """Return a collision-resistant companion fingerprint.

    The primary fingerprint deliberately erases all digits so volatile line
    numbers, ports, addresses, and PIDs collide. Some numbers are semantic,
    however—``WinError 5`` and ``WinError 32`` are different failures. This
    companion digest binds recognized error-code markers to the normalized
    fingerprint while retaining the primary fingerprint for broad lookup.
    """
    if not isinstance(text, str):
        raise TypeError("error text must be a string")
    stable_codes = [
        f"{re.sub(r'\\s+', '-', label.lower())}:{code}"
        for label, code in _STABLE_CODE_RE.findall(text)
    ]
    material = f"{fingerprint(text)}|{'|'.join(stable_codes)}"
    return f"{FINGERPRINT_PREFIX}{hashlib.sha256(material.encode('utf-8')).hexdigest()}"


def is_fingerprint(value: str) -> bool:
    """True if *value* is a syntactically valid pbp-0.1 fingerprint."""
    return isinstance(value, str) and bool(_FP_FORMAT_RE.match(value))
