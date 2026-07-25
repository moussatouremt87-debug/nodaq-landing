"""End-to-end ingestion + retrieval against real Postgres + fake embedder."""

import base64
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from rag.app import create_app
from tests.conftest import INTERNAL_TOKEN

AUTH = {"authorization": f"Bearer {INTERNAL_TOKEN}"}

DOC_TEXT = (
    "Procédure de relance des factures impayées.\n\n"
    "Au premier retard, envoyer un rappel courtois sous 7 jours.\n\n"
    "La politique congés de l'entreprise est décrite ailleurs."
)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def _ingest(
    client: TestClient,
    tenant_id: str,
    text: str = DOC_TEXT,
    dept: str = "compta",
    filename: str = "procedure.txt",
) -> dict[str, Any]:
    response = client.post(
        "/ingest",
        headers=AUTH,
        json={
            "tenantId": tenant_id,
            "dept": dept,
            "filename": filename,
            "contentBase64": base64.b64encode(text.encode()).decode(),
            "metadata": {"origin": "test"},
        },
    )
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def test_ingest_then_search_finds_the_right_chunk(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    tenant_a, _ = tenants
    result = _ingest(client, tenant_a)
    assert result["chunks"] >= 1
    assert result["deduplicated"] is False

    response = client.post(
        "/search",
        headers=AUTH,
        json={"tenantId": tenant_a, "query": "relance factures impayées", "topK": 3},
    )
    assert response.status_code == 200
    hits = response.json()
    assert len(hits) >= 1
    assert "relance des factures" in hits[0]["content"]
    assert hits[0]["score"] > 0
    assert hits[0]["documentId"] == result["documentId"]
    assert hits[0]["metadata"] == {"origin": "test"}


def test_dept_filter(client: TestClient, tenants: tuple[str, str], clean_documents: None) -> None:
    tenant_a, _ = tenants
    _ingest(client, tenant_a, text="Barème des notes de frais kilométriques.", dept="compta")
    _ingest(client, tenant_a, text="Planning des congés d'été de l'équipe.", dept="rh")

    response = client.post(
        "/search",
        headers=AUTH,
        json={"tenantId": tenant_a, "query": "congés été", "dept": "rh", "topK": 5},
    )
    hits = response.json()
    assert len(hits) == 1
    assert "congés" in hits[0]["content"]


def test_idempotent_by_hash(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    tenant_a, _ = tenants
    first = _ingest(client, tenant_a)
    again = _ingest(client, tenant_a)
    assert again["deduplicated"] is True
    assert again["documentId"] == first["documentId"]
    assert again["chunks"] == 0


def test_empty_pdf_ingests_with_zero_chunks(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    import io

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)

    tenant_a, _ = tenants
    response = client.post(
        "/ingest",
        headers=AUTH,
        json={
            "tenantId": tenant_a,
            "dept": "compta",
            "filename": "blank.pdf",
            "contentBase64": base64.b64encode(buffer.getvalue()).decode(),
        },
    )
    assert response.status_code == 200
    assert response.json()["chunks"] == 0


def test_no_document_content_in_logs(
    client: TestClient,
    tenants: tuple[str, str],
    clean_documents: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    tenant_a, _ = tenants
    with caplog.at_level("DEBUG"):
        _ingest(client, tenant_a, text="Texte ultra confidentiel IBAN FR761234567890123456")
        client.post(
            "/search",
            headers=AUTH,
            json={"tenantId": tenant_a, "query": "confidentiel"},
        )
    assert "ultra confidentiel" not in caplog.text
    assert "FR7612345678" not in caplog.text


def test_binary_garbage_is_rejected_without_content_echo(
    client: TestClient, tenants: tuple[str, str], clean_documents: None
) -> None:
    tenant_a, _ = tenants
    response = client.post(
        "/ingest",
        headers=AUTH,
        json={
            "tenantId": tenant_a,
            "dept": "compta",
            "filename": "image.bin",
            "contentBase64": base64.b64encode(b"\xff\xfe\x00\x01secret-bytes").decode(),
        },
    )
    assert response.status_code == 415
    assert "secret-bytes" not in response.text


def test_admin_fixture_is_superuser_but_service_role_is_not(
    admin_conn: psycopg.Connection,
) -> None:
    from sqlalchemy import text as sql_text

    from rag.db import engine

    cursor = admin_conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
    row = cursor.fetchone()
    assert row is not None and row[0] is True  # fixture bypasses RLS: setup only
    with engine().connect() as connection:
        value = connection.execute(
            sql_text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
        ).scalar()
    assert value is False  # the SERVICE role is subject to RLS
