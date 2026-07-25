"""Service configuration. Read at CALL time (testable), fail-fast in production.

Secrets come from the environment (.env in dev, injected from the Scaleway
Secret Manager in prod — same contract as the TypeScript services).
"""

import os

# Embedding dimension — MUST match the vector(N) column in packages/db
# (prisma/migrations/*rag_documents*). Single source of truth on the DB side.
EMBEDDING_DIM = 1024


def _require_in_prod(name: str, dev_default: str) -> str:
    value = os.environ.get(name)
    if value:
        return value
    if os.environ.get("NODE_ENV") == "production" or os.environ.get("ENV") == "production":
        raise RuntimeError(f"{name} must be provided in production (Secret Manager)")
    return dev_default


def database_url() -> str:
    """Connection string for the NON-superuser app role (RLS applies)."""
    return _require_in_prod(
        "APP_DATABASE_URL", "postgresql://app_user:app_password@localhost:5432/appdb"
    ).replace("postgresql://", "postgresql+psycopg://", 1)


def litellm_base_url() -> str:
    return _require_in_prod("LITELLM_BASE_URL", "http://localhost:4000")


def litellm_master_key() -> str:
    return _require_in_prod("LITELLM_MASTER_KEY", "sk-local-master")


def internal_token() -> str:
    """Internal-call token: this service is NEVER exposed publicly.

    NO default, in ANY environment (RGPD audit 1.3, blocking): this token is
    the only barrier before the body-provided tenantId is trusted — a deployed
    image without the variable must refuse to serve, not accept a public value.
    """
    value = os.environ.get("RAG_INTERNAL_TOKEN")
    if not value:
        raise RuntimeError("RAG_INTERNAL_TOKEN must be set (vault in prod, .env in dev)")
    return value
