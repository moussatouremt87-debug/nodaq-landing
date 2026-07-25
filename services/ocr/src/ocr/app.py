"""FastAPI app — INTERNAL service only (bearer token, never called by the
front). Stateless: no database, no model calls, no logging of content."""

import base64
import binascii
import hmac
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import internal_token
from .extraction import UnsupportedInvoiceError, extract_text


async def validation_error_without_input_echo(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's default 422 echoes the offending `input` — for an oversized
    contentBase64 that re-emits the whole document (RGPD audit 1.4). Return
    type + location only, never values."""
    detail = [{"type": e.get("type"), "loc": list(e.get("loc", []))} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": detail})


def require_internal_token(request: Request) -> None:
    header = request.headers.get("authorization", "")
    expected = f"Bearer {internal_token()}"
    if not hmac.compare_digest(header, expected):
        raise HTTPException(status_code=401, detail="internal token required")


Auth = Annotated[None, Depends(require_internal_token)]


class ExtractRequest(BaseModel):
    # Traceability only — this stateless service touches no tenant data store;
    # the caller (MCP action) re-seals everything under withTenant.
    tenantId: uuid.UUID
    filename: str = Field(min_length=1, max_length=300)
    contentBase64: str = Field(max_length=14_000_000)  # ~10 MiB decoded


class ExtractResponse(BaseModel):
    text: str
    pages: int


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        internal_token()  # fail fast when the token is missing
        yield

    app = FastAPI(
        title="nodaq-ocr", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    app.add_exception_handler(RequestValidationError, validation_error_without_input_echo)  # type: ignore[arg-type]

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/extract", response_model=ExtractResponse)
    def extract(_: Auth, body: ExtractRequest) -> ExtractResponse:
        try:
            data = base64.b64decode(body.contentBase64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="contentBase64 invalid") from error
        try:
            text, pages = extract_text(data, body.filename)
        except UnsupportedInvoiceError as error:
            raise HTTPException(status_code=415, detail=str(error)) from error
        return ExtractResponse(text=text, pages=pages)

    return app
