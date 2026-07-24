"""Seed suite — proves the Windows-bash domain seeds load, are idempotent,
and every seed's own error signature round-trips to an exact lookup hit
(density: an agent in this niche gets a hit, not a miss)."""

from pathbook import Registry, TrustTier
from pathbook.seeds import SEEDS, seed
from pathbook.signing import Keypair


def test_seed_and_idempotency(tmp_path):
    reg = Registry(tmp_path / "pb.db")
    key = Keypair.generate()
    first = seed(reg, key)
    assert len(first["added"]) == len(SEEDS) == 8
    assert first["frp_port001_promoted"]
    again = seed(reg, key)
    assert again["added"] == [] and len(again["skipped"]) == 8


def test_every_seed_error_hits_on_lookup(tmp_path):
    reg = Registry(tmp_path / "pb.db")
    seed(reg, Keypair.generate())
    for spec in SEEDS:
        res = reg.lookup(error_text=spec["error_signature"], runtime="windows-bash")
        assert res.match_type == "exact", spec["record_id"]
        assert spec["record_id"] in [c.id for c in res.candidates]


def test_frp_port001_state_matches_live_example(tmp_path):
    reg = Registry(tmp_path / "pb.db")
    seed(reg, Keypair.generate())
    rec = reg.get("FRP-PORT001")
    assert rec.trust_tier == TrustTier.REPRODUCED
    assert "unlink(missing_ok=True)" in rec.remediation_yaml
    assert "taskkill" in rec.failed_attempts_yaml  # negative knowledge present
    assert reg.verify_ledger()["ok"]
