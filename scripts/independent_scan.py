#!/usr/bin/env python3
"""Independent pre-publication scan — a second opinion the pack's author did not write.

Rationale: sanitize_content_pack.py was authored and self-tested by the same person
who wrote the content, so it can only catch anticipated problems. This adds:

  1. Microsoft Presidio (third-party PII detection) — NOT authored here.
     Presidio's own docs state it cannot guarantee finding everything, so this is
     an additional check, never proof.
  2. A deterministic identifier search over THIS project's own sensitive strings,
     which a generic PII tool has no way to know are sensitive.
  3. Code blocks scanned separately — text scanners often skip fenced code, and
     snippets are where real paths, thresholds and internal names hide.

Exit 0 = both checks clean. Exit 1 = findings to review.
"""
import json
import re
import sys
from pathlib import Path

# Project-specific identifiers. A generic PII scanner will not flag these.
PROJECT_IDENTIFIERS = [
    # invention family folder ids
    r"\bP-[A-Z][A-Z-]{2,}\b", r"\bP0\d{2}\b",
    # phrases lifted from claim text
    r"tiered task resolution", r"structural secrecy", r"dual-layer AI communication",
    r"pure-OS-substrate", r"kernel-attested", r"hash-chained provenance",
    r"earned-autonomy", r"graduated autonomy", r"glass-box",
    # organisations named in the analysis
    r"\bIBM\b", r"\bNVIDIA\b", r"\bUiPath\b", r"\bQomplx\b", r"\bAhyve\b",
    r"\bCitibank\b", r"\bVivint\b", r"\bConversica\b", r"\bBowhead\b", r"\bSalesforce\b",
    # accounts, hosts, infra
    r"\btechai\b", r"\brblake\w*", r"\bUncNeph\b", r"spark-\w+",
    r"\b8130\b", r"\b8100\b", r"\b8300\b", r"\b11434\b",
    r"[A-Za-z]:\\", r"/home/\w+", r"~/\w+",
    # commit-hash shapes
    r"\b[0-9a-f]{7,40}\b",
    # the portfolio's own structural counts — individually harmless, jointly
    # descriptive of an unfiled portfolio's shape and weaknesses
    r"\b127\s+(claims|items)\b", r"\b13\s+families\b", r"\b12\s+of\s+13\b",
    r"\b59\s+independent", r"\b68\s+dependent", r"\b7\s+of\s+7\b",
]


def collect(node, path="", out=None):
    """Flatten every string in the pack, tagged with its field path."""
    if out is None:
        out = []
    if isinstance(node, dict):
        for k, v in node.items():
            collect(v, f"{path}.{k}" if path else k, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            collect(v, f"{path}[{i}]", out)
    elif isinstance(node, str):
        out.append((path, node))
    return out


def run_presidio(fields):
    try:
        from presidio_analyzer import AnalyzerEngine
    except Exception as exc:
        print(f"  presidio unavailable ({exc}) — SKIPPED, not clean")
        return None
    try:
        eng = AnalyzerEngine()
    except Exception as exc:
        print(f"  presidio engine failed to start ({exc}) — SKIPPED, not clean")
        return None
    # Entities worth flagging for a public technical post. URL/DATE_TIME excluded:
    # too noisy on code and prose, and neither is sensitive here by itself.
    want = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IBAN_CODE",
            "IP_ADDRESS", "US_SSN", "LOCATION", "CRYPTO", "US_PASSPORT"]
    hits = []
    for fp, text in fields:
        if len(text) < 3:
            continue
        try:
            for r in eng.analyze(text=text, language="en", entities=want):
                if r.score < 0.6:
                    continue
                hits.append((fp, r.entity_type, text[r.start:r.end], round(r.score, 2)))
        except Exception:
            continue
    return hits


def run_identifiers(fields):
    hits = []
    for fp, text in fields:
        for pat in PROJECT_IDENTIFIERS:
            for m in re.finditer(pat, text):
                hits.append((fp, pat, m.group(0)))
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: independent_scan.py <pack.json>", file=sys.stderr)
        return 1
    pack = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    fields = collect(pack)
    code_fields = [(p, t) for p, t in fields if "code_snippet" in p]
    print(f"pack fields: {len(fields)} strings, of which {len(code_fields)} are code snippets\n")

    print("[1] Microsoft Presidio (third-party, not authored here)")
    p_hits = run_presidio(fields)
    if p_hits is None:
        presidio_ok = False
    else:
        presidio_ok = not p_hits
        if p_hits:
            for fp, ent, val, sc in p_hits[:25]:
                print(f"  {ent:16s} {val!r:28s} score={sc}  at {fp}")
            print(f"  total: {len(p_hits)}")
        else:
            print("  no PII entities at score >= 0.6")

    print("\n[2] Project-specific identifier search (incl. code snippets)")
    i_hits = run_identifiers(fields)
    if i_hits:
        seen = set()
        for fp, pat, val in i_hits:
            k = (pat, val)
            if k in seen:
                continue
            seen.add(k)
            print(f"  {val!r:30s} matched {pat!r}  at {fp}")
        print(f"  total distinct: {len(seen)}")
    else:
        print("  no project identifiers found")

    print("\n[3] Code snippets scanned separately")
    c_hits = run_identifiers(code_fields)
    print(f"  {len(c_hits)} identifier hit(s) inside code blocks")

    clean = presidio_ok and not i_hits
    print("\nRESULT: " + ("CLEAN by both checks" if clean else "REVIEW REQUIRED"))
    if not presidio_ok and p_hits is None:
        print("NOTE: presidio did not run, so 'clean' is not established.")
    print("Neither tool guarantees completeness. A human read of every entry is still required.")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
