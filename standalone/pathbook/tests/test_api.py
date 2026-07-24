"""API suite — proves the HTTP layer translates faithfully: correct status
codes for every failure class, and the full closed loop works over HTTP."""

import pytest
from fastapi.testclient import TestClient

from conftest import sample_record
from pathbook import Keypair, Registry
from pathbook.api import build_app
from pathbook.authoring import make_maintainer_action, make_outcome_report


@pytest.fixture()
def maintainer():
    return Keypair.generate()


@pytest.fixture()
def client(tmp_path, maintainer):
    registry = Registry(tmp_path / "pb.db", maintainer_keys=[maintainer.public_hex])
    return TestClient(build_app(registry))


@pytest.fixture()
def author():
    return Keypair.generate()


@pytest.fixture()
def posted(client, author):
    data = sample_record(author)
    resp = client.post("/pathbooks", json=data)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestEndpoints:
    def test_spec(self, client):
        spec = client.get("/spec").json()
        assert spec["protocol"] == "pbp-0.1"
        assert "promotion_rules" in spec

    def test_contribute_and_get(self, client, posted):
        got = client.get(f"/pathbooks/{posted['id']}").json()
        assert got["trust_tier"] == "draft"

    def test_get_404(self, client):
        assert client.get("/pathbooks/NOPE-1").status_code == 404

    def test_contribute_bad_signature_401(self, client, author):
        data = sample_record(author, record_id="PB-BAD")
        data["title"] = "tampered"
        resp = client.post("/pathbooks", json=data)
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "bad_signature"

    def test_contribute_duplicate_409(self, client, author, posted):
        resp = client.post("/pathbooks", json=sample_record(author))
        assert resp.status_code == 409

    def test_contribute_schema_invalid_422(self, client):
        resp = client.post("/pathbooks", json={"id": "X"})
        assert resp.status_code == 422

    def test_lookup_hit_and_miss(self, client, posted):
        hit = client.get("/pathbooks/lookup", params={
            "error_text": "OSError: [WinError 10048] Only one usage of each socket address"})
        assert hit.json()["match_type"] == "exact"
        miss = client.get("/pathbooks/lookup", params={"error_text": "never seen before qzx"})
        assert miss.json()["match_type"] == "none"

    def test_lookup_no_query_422(self, client):
        assert client.get("/pathbooks/lookup").status_code == 422

    def test_list_filters(self, client, posted):
        res = client.get("/pathbooks", params={"runtime": "windows-bash"}).json()
        assert res["count"] == 1
        res = client.get("/pathbooks", params={"runtime": "linux"}).json()
        assert res["count"] == 0


class TestClosedLoopOverHTTP:
    def test_execute_verify_promote(self, client, posted):
        plan = client.post(
            f"/pathbooks/{posted['id']}/execute",
            json={"allow_untrusted": True},
        ).json()
        assert not plan["refused"]
        agent = Keypair.generate()
        report = make_outcome_report(
            agent, reporter_id="http-agent", pathbook_id=posted["id"],
            outcome="success", verify_passed=True, application_id=plan["application_id"])
        res = client.post(f"/pathbooks/{posted['id']}/verify", json=report)
        assert res.status_code == 200
        body = res.json()
        assert body["tier_changed"] and body["trust_tier"] == "reproduced"
        # replay -> idempotent
        replay = client.post(f"/pathbooks/{posted['id']}/verify", json=report).json()
        assert replay["duplicate"]

    def test_forged_report_401(self, client, posted):
        agent = Keypair.generate()
        report = make_outcome_report(agent, reporter_id="http-agent", pathbook_id=posted["id"],
                                     outcome="success", verify_passed=True)
        report["outcome"] = "failure"
        assert client.post(f"/pathbooks/{posted['id']}/verify", json=report).status_code == 401

    def test_maintainer_403_and_success(self, client, posted, maintainer):
        rando = Keypair.generate()
        bad = make_maintainer_action(rando, pathbook_id=posted["id"], action="approve")
        assert client.post(f"/pathbooks/{posted['id']}/maintainer", json=bad).status_code == 403
        good = make_maintainer_action(maintainer, pathbook_id=posted["id"], action="approve")
        res = client.post(f"/pathbooks/{posted['id']}/maintainer", json=good)
        assert res.status_code == 200 and res.json()["to"] == "maintainer_approved"

    def test_ledger_verify(self, client, posted):
        res = client.get("/ledger/verify").json()
        assert res["ok"] and res["entries"] >= 1
