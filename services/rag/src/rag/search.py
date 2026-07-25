"""Retrieval: query embedding -> cosine similarity under RLS -> top-k chunks.

NO generation here (by design): chunks are `confidentiel` data; the caller is
responsible for routing any model call through packages/llm.route()."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from .db import with_tenant
from .embeddings import embed_texts, to_pgvector


@dataclass(frozen=True)
class SearchHit:
    content: str
    score: float
    document_id: str
    source: str
    metadata: dict[str, Any]


def search_chunks(
    tenant_id: str,
    query: str,
    dept: str | None = None,
    top_k: int = 5,
) -> list[SearchHit]:
    [vector] = embed_texts([query])
    with with_tenant(tenant_id) as connection:
        rows = connection.execute(
            text(
                "SELECT content, document_id, source, metadata,"
                "       1 - (embedding <=> CAST(:query_vector AS vector)) AS score"
                " FROM document_chunks"
                " WHERE embedding IS NOT NULL"
                "   AND (CAST(:dept AS text) IS NULL OR dept = :dept)"
                " ORDER BY embedding <=> CAST(:query_vector AS vector)"
                " LIMIT :top_k"
            ),
            {"query_vector": to_pgvector(vector), "dept": dept, "top_k": top_k},
        ).all()
    return [
        SearchHit(
            content=row.content,
            score=float(row.score),
            document_id=str(row.document_id),
            source=row.source,
            metadata=dict(row.metadata) if row.metadata else {},
        )
        for row in rows
    ]
