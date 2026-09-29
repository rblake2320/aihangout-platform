#!/usr/bin/env python3
"""Fail-closed sanitizer for public content packs.

Content in these packs goes to a PUBLIC site. This gate blocks any pack carrying
invention content, identities, infrastructure identifiers, or internal paths.

Both-direction tested (--selftest): it must BLOCK a planted violation and PASS a
clean pack. A scanner only verified against clean input is passed by a scanner
that never flags anything -- the same single-direction control error this content
pack is itself about.

Exit 0 = safe to publish. Exit 1 = blocked, with the reason.
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Each rule: (label, regex). Deliberately over-inclusive; a false positive costs
# a rewrite, a false negative costs a public disclosure.
FORBIDDEN = [
    ("invention codename", r"\b(BPC|TSK|GUMBO|MELD|ANVIL|PKA|DMS|NLF|SelfConnect|CheatVision|Orbweaver|GroundClean|Abel|Sentinel|CALLOSUM|Meridian)\b"),
    ("patent vocabulary", r"\b(provisional|prior art|claim set|independent claim|dependent claim|patentab|USPTO|AIA|prosecut|anticipat\w* by|§\s?10[123]|35 U\.S\.C)"),
    ("patent/claim numbering", r"\b(US\s?\d{1,2},\d{3},\d{3}|WO\s?\d{4}/\d{6}|EP\s?\d{7})"),
    ("family folder id", r"\bP-[A-Z]{2,}[A-Z-]*\b|\bP0\d{2}-[a-z]"),
    ("personal identity", r"\b(rblake2320|UncNeph|techai|rob47595|Robert Blake|Ron Blake|R\. Blake)\b"),
    ("email address", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("windows path", r"[A-Za-z]:\\\\?[A-Za-z0-9_]"),
    ("unix home path", r"(?<!\w)~/[A-Za-z0-9_.-]+/"),
    ("repo reference", r"github\.com/|\bgh api\b|\brepos/[A-Za-z0-9_-]+/"),
    ("cloud identifier", r"\bs3://|\bAKIA[0-9A-Z]{8,}|\baws\s+s3\b|\b\d{12}\b"),
    ("infra hostname", r"\bspark-[0-9a-f]{4}\b|\bDGX\b|\bGB10\b|\b192\.168\.\d+\.\d+\b|\b10\.0\.0\.\d+\b"),
    ("internal tool name", r"\bwhy-engine\b|\bMemoryWeb\b|\bUltraRAG\b|\bwrangler\b|\bLaya\b|\bJev\b|\bTypeSafe\b"),
    ("named model/vendor tie", r"\bcudaIpc\w+|\bSO_PEERCRED\b|\bCGEventPostToPid\b|\bWM_CHAR\b|\bPostMessage\b|\bclonefile\b|\bAPFS\b|\bos_log\b|\bBonjour\b|\bFSEvents\b|\bNSPasteboard\b|\bSecure Enclave\b"),
    ("api key shape", r"\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)"),
]

ALLOW = [
    # generic technical vocabulary that would otherwise trip a broad rule
    re.compile(r"\bclaim\b(?! set| \d)", re.I),
]


def scan(text: str):
    hits = []
    for label, pat in FORBIDDEN:
        for m in re.finditer(pat, text, re.I):
            frag = text[max(0, m.start() - 30):m.end() + 30].replace("\n", " ")
            hits.append((label, m.group(0), frag))
    return hits


def pack_text(path: Path) -> str:
    """All human-readable strings in the pack, so nothing hides in a nested field."""
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                out.append(str(k))
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        else:
            out.append(str(node))

    walk(data)
    return "\n".join(out)


def selftest() -> int:
    """Both directions. A scanner that never flags must fail this."""
    clean = json.dumps({"problems": [{
        "title": "A negative control passed and the result was still wrong",
        "description": "We validated a classifier with one control whose answer was 'no'.",
        "solution": {"solution_text": "Add a positive control.", "code_snippet": "assert pos > 0.7"},
    }]})
    planted = [
        ("codename", "The GUMBO trust gate handles fusion."),
        ("patent vocab", "We filed a provisional covering the independent claim."),
        ("identity", "Contact rblake2320 for details."),
        ("path", r"See D:\projects\aihangout-app for the source."),
        ("repo", "Cloned from github.com/example/thing."),
        ("infra", "Ran it on spark-3cdf over 192.168.12.220."),
        ("tool", "We used Laya, a decision model, for scoring."),
        ("api shape", "token ghp_abcdefghijklmnopqrstuvwxyz01"),
        ("email", "reach me at someone@example.com"),
        ("patent number", "See US 12,693,917 B1 for the reference."),
    ]
    fails = []
    if scan(clean):
        fails.append(f"FALSE POSITIVE on clean text: {scan(clean)[:2]}")
    for label, txt in planted:
        if not scan(txt):
            fails.append(f"MISSED planted violation [{label}]: {txt!r}")
    print(f"selftest: clean={'ok' if not scan(clean) else 'FLAGGED'} "
          f"planted_caught={sum(1 for _l, t in planted if scan(t))}/{len(planted)}")
    for f in fails:
        print("  " + f)
    if fails:
        print("SELFTEST FAILED — the scanner itself is not trustworthy")
        return 1
    print("selftest: PASS (blocks planted violations, passes clean text)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pack", nargs="?")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()
    if not a.pack:
        print("usage: sanitize_content_pack.py <pack.json> | --selftest", file=sys.stderr)
        return 1

    # The scanner must prove itself before it is trusted on real content.
    if selftest() != 0:
        return 1
    print()

    p = Path(a.pack)
    text = pack_text(p)
    hits = scan(text)
    n_problems = len(json.loads(p.read_text(encoding="utf-8")).get("problems", []))
    print(f"scanning {p.name}: {n_problems} problems, {len(text)} chars of text")
    if not hits:
        print("RESULT: CLEAN — safe to publish")
        return 0
    print(f"RESULT: BLOCKED — {len(hits)} finding(s)")
    seen = set()
    for label, match, frag in hits:
        key = (label, match.lower())
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{label}] {match!r}\n      ...{frag}...")
    return 1


if __name__ == "__main__":
    sys.exit(main())
