"""Shared fixtures: fake embeddings endpoint (deterministic), real Postgres.

The fake embedder is bag-of-words hashed into EMBEDDING_DIM dims and
normalized: texts sharing words get high cosine similarity, so retrieval
tests are meaningful without any real model call.
"""

import hashlib
import json
import os
import threading
import uuid
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import psycopg
import pytest

EMBEDDING_DIM = 1024
INTERNAL_TOKEN = "test-internal-token"


def fake_embedding(text: str) -> list[float]:
    vector = [0.0] * EMBEDDING_DIM
    for token in text.lower().split():
        index = int(hashlib.md5(token.encode()).hexdigest(), 16) % EMBEDDING_DIM
        vector[index] += 1.0
    norm = sum(x * x for x in vector) ** 0.5 or 1.0
    return [x / norm for x in vector]


class _EmbeddingsHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body: dict[str, Any] = json.loads(self.rfile.read(length))
        inputs: list[str] = body.get("input", [])
        payload = json.dumps(
            {"data": [{"embedding": fake_embedding(text)} for text in inputs]}
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # silence request logging in test output


@pytest.fixture(scope="session", autouse=True)
def fake_litellm() -> Iterator[None]:
    server = HTTPServer(("127.0.0.1", 0), _EmbeddingsHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    os.environ["LITELLM_BASE_URL"] = f"http://127.0.0.1:{server.server_port}"
    os.environ["RAG_INTERNAL_TOKEN"] = INTERNAL_TOKEN
    yield
    server.shutdown()


ADMIN_DSN = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/appdb"
)


@pytest.fixture(scope="session")
def admin_conn() -> Iterator[psycopg.Connection]:
    """SUPERUSER connection — test setup/teardown ONLY (bypasses RLS)."""
    with psycopg.connect(ADMIN_DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture(scope="session")
def tenants(admin_conn: psycopg.Connection) -> Iterator[tuple[str, str]]:
    tenant_a, tenant_b = str(uuid.uuid4()), str(uuid.uuid4())
    admin_conn.execute(
        "INSERT INTO tenants (id, name) VALUES (%s, 'RAG A'), (%s, 'RAG B')",
        (tenant_a, tenant_b),
    )
    yield tenant_a, tenant_b
    admin_conn.execute("DELETE FROM tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))


@pytest.fixture()
def clean_documents(
    admin_conn: psycopg.Connection, tenants: tuple[str, str]
) -> Iterator[None]:
    tenant_a, tenant_b = tenants
    admin_conn.execute(
        "DELETE FROM documents WHERE tenant_id IN (%s, %s)", (tenant_a, tenant_b)
    )
    yield
    admin_conn.execute(
        "DELETE FROM documents WHERE tenant_id IN (%s, %s)", (tenant_a, tenant_b)
    )
