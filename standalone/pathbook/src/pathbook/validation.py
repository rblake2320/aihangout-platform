"""Content and remediation validation for untrusted Pathbook contributions."""

from __future__ import annotations

import re
from typing import Any

import yaml

MAX_STRUCTURED_TEXT = 20_000
MAX_NODES = 500
MAX_DEPTH = 12

_INJECTION_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bignore\s+(?:all\s+)?previous\s+instructions\b",
        r"\breveal\s+(?:the\s+)?system\s+prompt\b",
        r"\byou\s+are\s+now\s+(?:dan|unrestricted)\b",
        r"<\s*/?\s*system\s*>",
    )
]

_HIGH_RISK_PATTERNS = [
    ("recursive_delete", re.compile(r"(?:\brm\s+-rf\b|\bRemove-Item\b[^\n]*-Recurse)", re.IGNORECASE)),
    ("broad_process_kill", re.compile(r"\btaskkill\b[^\n]*(?:/IM|\*)", re.IGNORECASE)),
    ("disk_format", re.compile(r"\b(?:format|mkfs(?:\.\w+)?)\b", re.IGNORECASE)),
    ("registry_or_boot", re.compile(r"\b(?:bcdedit|reg\s+(?:delete|add)|Set-ItemProperty\s+['\"]?HKLM)", re.IGNORECASE)),
    ("download_execute", re.compile(r"(?:curl|wget|Invoke-WebRequest)[^\n|;]*(?:\||;)[^\n]*(?:sh|bash|powershell|pwsh)", re.IGNORECASE)),
]


def _shape(value: Any, depth: int = 0) -> tuple[int, int]:
    if depth > MAX_DEPTH:
        raise ValueError(f"structured content exceeds maximum depth {MAX_DEPTH}")
    nodes = 1
    deepest = depth
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, (str, int, float, bool)):
                raise ValueError("structured content contains an unsupported mapping key")
            child_nodes, child_depth = _shape(item, depth + 1)
            nodes += child_nodes
            deepest = max(deepest, child_depth)
    elif isinstance(value, list):
        for item in value:
            child_nodes, child_depth = _shape(item, depth + 1)
            nodes += child_nodes
            deepest = max(deepest, child_depth)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise ValueError("structured content contains an unsupported value")
    if nodes > MAX_NODES:
        raise ValueError(f"structured content exceeds maximum node count {MAX_NODES}")
    return nodes, deepest


def validate_structured_text(value: str, *, allow_empty: bool = False) -> str:
    """Parse YAML with ``safe_load`` and enforce bounded, data-only content."""
    if not isinstance(value, str):
        raise ValueError("structured content must be text")
    if not value and allow_empty:
        return value
    if not value.strip():
        raise ValueError("structured content cannot be blank")
    if len(value) > MAX_STRUCTURED_TEXT:
        raise ValueError(f"structured content exceeds {MAX_STRUCTURED_TEXT} characters")
    for pattern in _INJECTION_PATTERNS:
        if pattern.search(value):
            raise ValueError("structured content contains a prompt-injection pattern")
    parsed = yaml.safe_load(value)
    if parsed is None:
        raise ValueError("structured content cannot decode to null")
    if not isinstance(parsed, (dict, list)):
        raise ValueError("structured content must decode to a mapping or list")
    _shape(parsed)
    return value


def remediation_risk(value: str) -> tuple[str, list[str]]:
    flags = [name for name, pattern in _HIGH_RISK_PATTERNS if pattern.search(value)]
    return ("high" if flags else "low"), flags
