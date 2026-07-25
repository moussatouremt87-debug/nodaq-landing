"""THE tests that matter: tenant isolation enforced by RLS from Python."""

import base64

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from rag.app import create_app
from rag.db import engine, with_tenant
from tests.conftest import INTERNAL_TOKEN

AUTH = {"authorization": f"Bearer {INTERNAL_TOKEN}"}
SECRET_TEXT = "Note interne du tenant A : marge brute 42%."


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def _ingest_for(client: TestClient, tenant_id: str) -> None:
    response = client.post(
        "/ingest",
        headers=AUTH,
        json={
            "tenantId": tenant_id,
            "dept": "direction",
            "filename": "note.txt",
            "contentBase64": base64.b64encode(SECRET_TEXT.encode()).decode(),
        },
    )
    assert response.status_code == 200


def test_tenant_b_never_sees_tenant_a_documents(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    tenant_a, tenant_b = tenants
    _ingest_for(client, tenant_a)

    response = client.post(
        "/search",
        headers=AUTH,
        json={"tenantId": tenant_b, "query": "marge brute"},
    )
    assert response.status_code == 200
    assert response.json() == []

    response_a = client.post(
        "/search",
        headers=AUTH,
        json={"tenantId": tenant_a, "query": "marge brute"},
    )
    assert len(response_a.json()) >= 1


def test_isolation_comes_from_rls_not_from_application_code(
    client: TestClient,
    admin_conn: psycopg.Connection,
    tenants: tuple[str, str],
    clean_documents: None,
) -> None:
    """Disable RLS -> tenant B DOES see tenant A's chunks (the leak happens),
    proving the queries have no application-side tenant filter and that the
    protection is the database policy."""
    tenant_a, tenant_b = tenants
    _ingest_for(client, tenant_a)

    admin_conn.execute("ALTER TABLE document_chunks DISABLE ROW LEVEL SECURITY")
    try:
        leaked = client.post(
            "/search",
            headers=AUTH,
            json={"tenantId": tenant_b, "query": "marge brute"},
        ).json()
        assert len(leaked) >= 1  # leak observed => no hidden app-side filter
    finally:
        admin_conn.execute("ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY")
        admin_conn.execute("ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY")

    sealed = client.post(
        "/search",
        headers=AUTH,
        json={"tenantId": tenant_b, "query": "marge brute"},
    ).json()
    assert sealed == []


def test_outside_with_tenant_zero_rows(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    tenant_a, _ = tenants
    _ingest_for(client, tenant_a)

    with engine().connect() as connection:
        count = connection.execute(text("SELECT count(*) FROM document_chunks")).scalar()
    assert count == 0  # no tenant context => RLS returns nothing, no error

    with with_tenant(tenant_a) as connection:
        count_a = connection.execute(text("SELECT count(*) FROM document_chunks")).scalar()
    assert count_a is not None and count_a >= 1


def test_with_tenant_rejects_non_uuid() -> None:
    with pytest.raises(ValueError), with_tenant("not-a-uuid' ; DROP TABLE notes; --"):
        pass
