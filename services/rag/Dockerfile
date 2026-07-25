# NODAQ RAG service — internal-only (never exposed publicly).
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY src ./src
RUN uv sync --frozen --no-dev

# Non-root: this service handles `confidentiel` documents.
RUN useradd --system --no-create-home rag && chown -R rag:rag /app
USER rag

EXPOSE 8100
CMD ["uv", "run", "--no-dev", "uvicorn", "--factory", "rag.app:create_app", "--host", "0.0.0.0", "--port", "8100"]
