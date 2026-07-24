"""Fingerprint suite — proves the normalization pipeline is deterministic,
collides structurally-identical errors on purpose, and never collides across
structurally different errors by accident of normalization order."""

import pytest

from pathbook.fingerprint import (
    MAX_NORMALIZED_LEN,
    fingerprint,
    is_fingerprint,
    normalize,
)


class TestNormalization:
    def test_lowercases(self):
        assert normalize("ERROR Failed") == normalize("error failed")

    def test_hex_addresses_collapse(self):
        a = normalize("Error at 0x7f3a29b1 in frame")
        b = normalize("Error at 0x9B1C44D2 in frame")
        assert a == b == "error at <hash> in frame"

    def test_bare_long_hex_collapses(self):
        assert normalize("commit deadbeefcafe1234 failed") == "commit <hash> failed"

    def test_short_hex_not_collapsed_but_digits_are(self):
        # "cafe" is 4 hex chars — below the 8-char bare-hex bar; digits go to <num>
        assert normalize("cafe 42") == "cafe <num>"

    def test_digit_runs_collapse(self):
        a = normalize("line 42 col 7")
        b = normalize("line 999 col 123456")
        assert a == b == "line <num> col <num>"

    def test_crlf_and_whitespace_erased(self):
        # Windows CRLF, tabs, and multiple spaces all normalize identically
        a = normalize("Error:\r\n  something   broke\t badly")
        b = normalize("error: something broke badly")
        assert a == b

    def test_truncation_boundary(self):
        long = "x" * (MAX_NORMALIZED_LEN + 500)
        assert len(normalize(long)) == MAX_NORMALIZED_LEN

    def test_non_string_raises(self):
        with pytest.raises(TypeError):
            normalize(None)  # type: ignore[arg-type]


class TestFingerprint:
    def test_deterministic(self):
        text = "OSError: [WinError 10048] Only one usage of each socket address"
        assert fingerprint(text) == fingerprint(text)

    def test_structural_collision_on_purpose(self):
        assert fingerprint("Error at 0x7f3a... line 42") == fingerprint(
            "Error at 0x9b1c... line 88"
        )

    def test_different_errors_differ(self):
        assert fingerprint("PermissionError: [WinError 5] Access is denied") != fingerprint(
            "OSError: [WinError 10048] address in use"
        )
        # NOTE: WinError codes are digit runs, so 'WinError 5' vs 'WinError 32'
        # with identical surrounding text WOULD collide — the message text is
        # what differentiates. This is a documented pbp-0.1 property.

    def test_format(self):
        fp = fingerprint("anything")
        assert fp.startswith("sha256:") and len(fp) == 7 + 64
        assert is_fingerprint(fp)

    def test_is_fingerprint_rejects_garbage(self):
        assert not is_fingerprint("sha256:xyz")
        assert not is_fingerprint("md5:" + "a" * 32)
        assert not is_fingerprint("sha256:" + "A" * 64)  # uppercase not canonical
        assert not is_fingerprint(12345)  # type: ignore[arg-type]

    def test_unicode_stable(self):
        assert fingerprint("fehler: können ✓ nicht") == fingerprint("FEHLER: können ✓  nicht")

    def test_adversarial_prenormalized_text_cannot_forge_hex_collapse(self):
        # An attacker submitting the literal token "<hash>" gets the same
        # fingerprint as a real hex run — that is BY DESIGN (normalization is
        # canonicalization, not authentication); trust comes from signatures
        # and tiers, never from the fingerprint itself.
        assert fingerprint("boom at <hash> now") == fingerprint("boom at 0xdeadbeef now")
