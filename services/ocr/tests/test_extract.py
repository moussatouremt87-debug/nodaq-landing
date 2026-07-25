"""Extraction endpoint: auth gate, text/PDF paths, no content leakage."""

import base64
import uuid

import pytest
from fastapi.testclient import TestClient

from ocr.app import create_app
from tests.conftest import INTERNAL_TOKEN

AUTH = {"authorization": f"Bearer {INTERNAL_TOKEN}"}

INVOICE_TEXT = (
    "FACTURE F-2026-042\n\n"
    "Fournisseur : ACME SARL\n"
    "Total TTC : 1 200,00 EUR\n"
    "Échéance : 15/08/2026"
)


def _client() -> TestClient:
    return TestClient(create_app())


def _body(text: bytes, filename: str = "facture.txt") -> dict[str, str]:
    return {
        "tenantId": str(uuid.uuid4()),
        "filename": filename,
        "contentBase64": base64.b64encode(text).decode(),
    }


def test_health_is_liveness_only() -> None:
    assert _client().get("/health").json() == {"status": "ok"}


def test_extract_requires_the_internal_token() -> None:
    client = _client()
    assert client.post("/extract", json=_body(b"x")).status_code == 401
    wrong = {"authorization": "Bearer wrong"}
    assert client.post("/extract", headers=wrong, json=_body(b"x")).status_code == 401


def test_extract_plain_text_invoice() -> None:
    response = _client().post("/extract", headers=AUTH, json=_body(INVOICE_TEXT.encode()))
    assert response.status_code == 200
    payload = response.json()
    assert "FACTURE F-2026-042" in payload["text"]
    assert payload["pages"] == 1


def test_extract_blank_pdf_yields_empty_text() -> None:
    import io

    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)

    response = _client().post(
        "/extract", headers=AUTH, json=_body(buffer.getvalue(), "scan.pdf")
    )
    assert response.status_code == 200
    assert response.json() == {"text": "", "pages": 1}


def test_binary_garbage_rejected_extension_only() -> None:
    response = _client().post(
        "/extract", headers=AUTH, json=_body(b"\xff\xfe\x01secret-bytes", "paie-dupont.bin")
    )
    assert response.status_code == 415
    assert "secret-bytes" not in response.text
    assert "paie-dupont" not in response.text  # filename can carry PII
    assert ".bin" in response.json()["detail"]


def test_no_content_in_logs(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("DEBUG"):
        _client().post("/extract", headers=AUTH, json=_body(INVOICE_TEXT.encode()))
    assert "ACME SARL" not in caplog.text


def test_corrupted_pdf_never_leaks_bytes_in_logs_or_response(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """RGPD audit 1.4 (blocking): pypdf logs raw document slices on malformed
    PDFs, and an unhandled PdfReadError would traceback with content."""
    corrupted = b"%PDF-1.4\n1 0 obj << /Marker (ACME-SECRET-MARKER) /Type &Broken >>\nendobj"
    with caplog.at_level("DEBUG"):
        response = _client().post(
            "/extract", headers=AUTH, json=_body(corrupted, "facture.pdf")
        )
    assert response.status_code == 415
    assert "ACME-SECRET-MARKER" not in caplog.text
    assert "ACME-SECRET-MARKER" not in response.text
    assert ".pdf" in response.json()["detail"]


def test_422_does_not_echo_the_input(caplog: pytest.LogCaptureFixture) -> None:
    """FastAPI's default validation error echoes `input` — an oversized
    contentBase64 would re-emit the whole document."""
    body = _body(INVOICE_TEXT.encode())
    body["filename"] = "x" * 400  # over the 300-char bound, PII-like marker inside
    body["filename"] = "paie-dupont-" + "x" * 400
    response = _client().post("/extract", headers=AUTH, json=body)
    assert response.status_code == 422
    assert "paie-dupont" not in response.text
    assert response.json()["detail"][0]["loc"] == ["body", "filename"]


def test_boot_fails_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OCR_INTERNAL_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="OCR_INTERNAL_TOKEN"), TestClient(create_app()):
        pass
