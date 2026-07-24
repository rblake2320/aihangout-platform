"""FastAPI surface for pbp-0.1.

Two ways to serve it:

- Standalone: ``pathbook-api`` (or ``uvicorn pathbook.api:app``) with
  PATHBOOK_DB / PATHBOOK_SECRET_FILE / PATHBOOK_MAINTAINER_KEYS env vars.
- Embedded: ``build_router(registry)`` returns an ``APIRouter`` any host app
  (aihangout or anything else) mounts under a prefix of its choosing::

      app.include_router(build_router(registry), prefix="/pathbook")

All invariants live in ``Registry``; this layer only translates HTTP.
"""

from __future__ import annotations

import os
import hmac
from typing import Any, Optional

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from pydantic import ValidationError

from .registry import Registry, RegistryError

_ERROR_STATUS = {
    "not_found": 404,
    "duplicate_id": 409,
    "key_conflict": 409,
    "bad_signature": 401,
    "not_maintainer": 403,
    "bad_fingerprint": 422,
    "fingerprint_mismatch": 422,
    "missing_query": 422,
    "invalid_request": 422,
    "invalid_application": 422,
    "expired_application": 410,
    "stale_application": 409,
    "application_identity_mismatch": 403,
}


def _raise(err: RegistryError) -> None:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(err.code, 400),
        detail={"code": err.code, "message": str(err)},
    )


def build_router(
    registry: Registry,
    *,
    write_api_key: Optional[str] = None,
    allow_unauthenticated_local_writes: bool = True,
) -> APIRouter:
    router = APIRouter(tags=["pathbook"])

    def require_write_access(request: Request) -> None:
        if write_api_key:
            header = request.headers.get("authorization", "")
            supplied = header[7:] if header.lower().startswith("bearer ") else ""
            if not hmac.compare_digest(supplied, write_api_key):
                raise HTTPException(401, detail={"code": "unauthorized", "message": "valid bearer API key required"})
            return
        host = request.client.host if request.client else ""
        if allow_unauthenticated_local_writes and host in {"127.0.0.1", "::1", "localhost", "testclient"}:
            return
        raise HTTPException(
            503,
            detail={
                "code": "write_auth_not_configured",
                "message": "Set PATHBOOK_API_KEY or mount the router behind platform authentication.",
            },
        )

    @router.get("/spec")
    def spec() -> dict[str, Any]:
        return registry.spec()

    @router.get("/pathbooks")
    def list_pathbooks(
        runtime: Optional[str] = None,
        ecosystem: Optional[str] = None,
        trust_tier: Optional[str] = None,
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        records = registry.list(
            runtime=runtime, ecosystem=ecosystem, trust_tier=trust_tier,
            limit=limit, offset=offset,
        )
        return {"count": len(records), "pathbooks": [r.model_dump() for r in records]}

    @router.get("/pathbooks/lookup")
    def lookup(
        error_text: Optional[str] = Query(default=None, max_length=10_000),
        fingerprint: Optional[str] = None,
        runtime: Optional[str] = None,
    ) -> dict[str, Any]:
        try:
            return registry.lookup(
                error_text=error_text, fingerprint=fingerprint, runtime=runtime
            ).model_dump()
        except RegistryError as e:
            _raise(e)

    @router.get("/pathbooks/{pathbook_id}")
    def get_pathbook(pathbook_id: str) -> dict[str, Any]:
        rec = registry.get(pathbook_id)
        if rec is None:
            raise HTTPException(404, detail={"code": "not_found", "message": f"no pathbook {pathbook_id!r}"})
        return rec.model_dump()

    @router.post("/pathbooks", status_code=201)
    async def contribute(request: Request) -> dict[str, Any]:
        require_write_access(request)
        data = await request.json()
        try:
            rec = registry.contribute(data)
        except RegistryError as e:
            _raise(e)
        except ValidationError as e:
            raise HTTPException(422, detail={"code": "schema_invalid", "message": str(e)})
        return rec.model_dump()

    @router.post("/pathbooks/{pathbook_id}/execute")
    async def execute(pathbook_id: str, request: Request) -> dict[str, Any]:
        require_write_access(request)
        try:
            data = await request.json()
        except Exception:
            data = {}
        try:
            return registry.execute(
                pathbook_id,
                executor_id=data.get("executor_id"),
                executor_public_key=data.get("executor_public_key"),
                allow_untrusted=bool(data.get("allow_untrusted", False)),
            )
        except RegistryError as e:
            _raise(e)

    @router.post("/pathbooks/{pathbook_id}/verify")
    async def verify(pathbook_id: str, request: Request) -> dict[str, Any]:
        require_write_access(request)
        data = await request.json()
        data["pathbook_id"] = pathbook_id
        try:
            return registry.report_outcome(data)
        except RegistryError as e:
            _raise(e)
        except ValidationError as e:
            raise HTTPException(422, detail={"code": "schema_invalid", "message": str(e)})

    @router.post("/pathbooks/{pathbook_id}/maintainer")
    async def maintainer(pathbook_id: str, request: Request) -> dict[str, Any]:
        require_write_access(request)
        data = await request.json()
        data["pathbook_id"] = pathbook_id
        try:
            return registry.maintainer_action(data)
        except RegistryError as e:
            _raise(e)

    @router.get("/ledger/verify")
    def ledger_verify() -> dict[str, Any]:
        return registry.verify_ledger()

    return router


def build_app(registry: Optional[Registry] = None) -> FastAPI:
    if registry is None:
        db = os.environ.get("PATHBOOK_DB", "pathbook.db")
        maintainers = [k for k in os.environ.get("PATHBOOK_MAINTAINER_KEYS", "").split(",") if k]
        registry = Registry(db, maintainer_keys=maintainers)
    app = FastAPI(
        title="Pathbook Registry",
        version="0.1.0",
        description="pbp-0.1 — fingerprint-indexed, trust-tiered known-error registry for AI agents.",
    )
    app.include_router(
        build_router(
            registry,
            write_api_key=os.environ.get("PATHBOOK_API_KEY"),
        )
    )
    app.state.registry = registry
    return app


app = build_app() if os.environ.get("PATHBOOK_EAGER_APP") == "1" else None


def main() -> None:  # pathbook-api entry point
    import uvicorn

    uvicorn.run(
        build_app(),
        host=os.environ.get("PATHBOOK_HOST", "127.0.0.1"),
        port=int(os.environ.get("PATHBOOK_PORT", "8321")),
    )
