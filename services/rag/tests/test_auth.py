"""Internal-token gate: this service is internal-only."""

import uuid

from fastapi.testclient import TestClient

from rag.app import create_app
from tests.conftest import INTERNAL_TOKEN


def test_health_is_open_liveness_only() -> None:
    client = TestClient(create_app())
    assert client.get("/health").json() == {"status": "ok"}  # no db field: no DB access


def test_ready_requires_the_internal_token() -> None:
    client = TestClient(create_app())
    assert client.get("/ready").status_code == 401
    response = client.get("/ready", headers={"authorization": f"Bearer {INTERNAL_TOKEN}"})
    assert response.json() == {"status": "ok", "db": "ok"}


def test_boot_guard_runs_in_lifespan_and_refuses_superuser() -> None:
    import sqlalchemy

    import rag.db as ragdb
    from tests.conftest import ADMIN_DSN

    # Normal boot (app_user role): lifespan passes.
    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200

    # Superuser engine: the boot guard must refuse to start.
    saved = ragdb._engine
    ragdb._engine = sqlalchemy.create_engine(
        ADMIN_DSN.replace("postgresql://", "postgresql+psycopg://", 1)
    )
    try:
        import pytest as _pytest

        with _pytest.raises(RuntimeError, match="superuser"), TestClient(create_app()):
            pass
    finally:
        ragdb._engine.dispose()
        ragdb._engine = saved


def test_data_endpoints_require_the_internal_token() -> None:
    client = TestClient(create_app())
    body = {"tenantId": str(uuid.uuid4()), "query": "x"}
    assert client.post("/search", json=body).status_code == 401
    assert (
        client.post("/search", headers={"authorization": "Bearer wrong"}, json=body).status_code
        == 401
    )
    ingest = {
        "tenantId": str(uuid.uuid4()),
        "dept": "compta",
        "filename": "a.txt",
        "contentBase64": "aGVsbG8=",
    }
    assert client.post("/ingest", json=ingest).status_code == 401


def test_correct_token_passes_auth_layer() -> None:
    client = TestClient(create_app())
    response = client.post(
        "/search",
        headers={"authorization": f"Bearer {INTERNAL_TOKEN}"},
        json={"tenantId": str(uuid.uuid4()), "query": "x"},
    )
    # 200 with empty results (unknown tenant sealed by RLS) — not 401.
    assert response.status_code == 200
