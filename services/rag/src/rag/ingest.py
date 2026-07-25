"""Ingestion pipeline: parse -> chunk -> sovereign embeddings -> upsert under
RLS. Idempotent per (tenant, sha256 of the raw file). DML only — the schema
(tables, RLS, vector index) is owned by Prisma in packages/db."""

import hashlib
import json
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from .chunking import chunk_text
from .db import with_tenant
from .embeddings import embed_texts, to_pgvector
from .parsing import parse_document


@dataclass(frozen=True)
class IngestResult:
    document_id: str
    chunks: int
    deduplicated: bool


def ingest_document(
    tenant_id: str,
    dept: str,
    source: str,
    filename: str,
    data: bytes,
    metadata: dict[str, Any] | None = None,
    object_key: str | None = None,
) -> IngestResult:
    file_hash = hashlib.sha256(data).hexdigest()

    # Idempotency check + document row, sealed by RLS.
    with with_tenant(tenant_id) as connection:
        existing = connection.execute(
            text(
                "SELECT id, indexed_at FROM documents"
                " WHERE tenant_id = :tenant_id AND hash = :hash"
            ),
            {"tenant_id": tenant_id, "hash": file_hash},
        ).first()
        if existing is not None and existing.indexed_at is not None:
            return IngestResult(document_id=str(existing.id), chunks=0, deduplicated=True)
        if existing is None:
            document_id = str(uuid.uuid4())
            connection.execute(
                text(
                    "INSERT INTO documents (id, tenant_id, object_key, dept, source, hash)"
                    " VALUES (:id, :tenant_id, :object_key, :dept, :source, :hash)"
                ),
                {
                    "id": document_id,
                    "tenant_id": tenant_id,
                    "object_key": object_key,
                    "dept": dept,
                    "source": source,
                    "hash": file_hash,
                },
            )
        else:
            document_id = str(existing.id)

    # Parse + chunk + embed OUTSIDE the transaction (no long-held connection
    # while calling the embeddings endpoint).
    content = parse_document(data, filename)
    chunks = chunk_text(content)
    vectors = embed_texts(chunks)

    with with_tenant(tenant_id) as connection:
        # Re-ingestion after a failed run: replace any partial chunks.
        connection.execute(
            text("DELETE FROM document_chunks WHERE document_id = :document_id"),
            {"document_id": document_id},
        )
        for index, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True)):
            connection.execute(
                text(
                    "INSERT INTO document_chunks"
                    " (id, tenant_id, document_id, chunk_index, content, embedding, dept,"
                    "  source, metadata)"
                    " VALUES (:id, :tenant_id, :document_id, :chunk_index, :content,"
                    "         CAST(:embedding AS vector), :dept, :source,"
                    "         CAST(:metadata AS jsonb))"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "tenant_id": tenant_id,
                    "document_id": document_id,
                    "chunk_index": index,
                    "content": chunk,
                    "embedding": to_pgvector(vector),
                    "dept": dept,
                    "source": source,
                    "metadata": json.dumps(metadata or {}),
                },
            )
        connection.execute(
            text("UPDATE documents SET indexed_at = now() WHERE id = :document_id"),
            {"document_id": document_id},
        )

    return IngestResult(document_id=document_id, chunks=len(chunks), deduplicated=False)
