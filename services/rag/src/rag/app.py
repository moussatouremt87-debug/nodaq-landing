"""FastAPI app — INTERNAL service only (never exposed publicly, never called
by the front). Every data endpoint requires the internal bearer token.

The tenant_id comes from the trusted caller (session context, via the API) AND
is re-sealed by RLS: defense in depth — a wrong tenant_id yields the wrong
tenant's EMPTY view, never another tenant's data without membership upstream.
"""

import base64
import binascii
import hmac
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text

from .config import internal_token
from .db import assert_app_role_is_not_superuser, engine
from .ingest import ingest_document
from .parsing import UnsupportedDocumentError
from .search import search_chunks


def require_internal_token(request: Request) -> None:
    header = request.headers.get("authorization", "")
    expected = f"Bearer {internal_token()}"
    if not hmac.compare_digest(header, expected):
        raise HTTPException(status_code=401, detail="internal token required")


Auth = Annotated[None, Depends(require_internal_token)]


class IngestRequest(BaseModel):
    tenantId: uuid.UUID
    dept: str = Field(min_length=1, max_length=50)
    source: Literal["UPLOAD", "CONNECTOR"] = "UPLOAD"
    filename: str = Field(min_length=1, max_length=300)
    contentBase64: str = Field(max_length=14_000_000)  # ~10 MiB decoded
    objectKey: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class IngestResponse(BaseModel):
    documentId: str
    chunks: int
    deduplicated: bool


class SearchRequest(BaseModel):
    tenantId: uuid.UUID
    query: str = Field(min_length=1, max_length=10_000)
    dept: str | None = None
    topK: int = Field(default=5, ge=1, le=50)


class SearchHitResponse(BaseModel):
    content: str
    score: float
    documentId: str
    source: str
    metadata: dict[str, Any]


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Boot guard: a superuser/BYPASSRLS role would silently void the RLS
        # isolation — refuse to start (same rule as the TypeScript services).
        assert_app_role_is_not_superuser()
        internal_token()  # fail fast when the token is missing
        yield

    app = FastAPI(
        title="nodaq-rag", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        # Liveness only — no DB access, no auth (nothing to leak, no pool pressure).
        return {"status": "ok"}

    @app.get("/ready")
    def ready(_: Auth) -> dict[str, str]:
        with engine().connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"status": "ok", "db": "ok"}

    @app.post("/ingest", response_model=IngestResponse)
    def ingest(_: Auth, body: IngestRequest) -> IngestResponse:
        try:
            data = base64.b64decode(body.contentBase64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="contentBase64 invalid") from error
        try:
            result = ingest_document(
                tenant_id=str(body.tenantId),
                dept=body.dept,
                source=body.source,
                filename=body.filename,
                data=data,
                metadata=body.metadata,
                object_key=body.objectKey,
            )
        except UnsupportedDocumentError as error:
            # Type-only message — never document content.
            raise HTTPException(status_code=415, detail=str(error)) from error
        return IngestResponse(
            documentId=result.document_id,
            chunks=result.chunks,
            deduplicated=result.deduplicated,
        )

    @app.post("/search", response_model=list[SearchHitResponse])
    def search(_: Auth, body: SearchRequest) -> list[SearchHitResponse]:
        hits = search_chunks(
            tenant_id=str(body.tenantId),
            query=body.query,
            dept=body.dept,
            top_k=body.topK,
        )
        return [
            SearchHitResponse(
                content=hit.content,
                score=hit.score,
                documentId=hit.document_id,
                source=hit.source,
                metadata=hit.metadata,
            )
            for hit in hits
        ]

    return app
