"""Database access — the Python replica of the TypeScript `withTenant` contract.

Rules (CLAUDE.md):
- connect with the NON-superuser role `app_user` (a superuser bypasses RLS);
- `set_config('app.current_tenant_id', <uuid>, true)` INSIDE a transaction
  (transaction-local scope — safe with connection pooling);
- every business query goes through `with_tenant`; outside of it, RLS returns
  zero rows (fail closed);
- schema is owned by Prisma (packages/db): this module does DML ONLY.
"""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Connection, Engine, create_engine, text

from .config import database_url

_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(database_url(), pool_pre_ping=True)
    return _engine


@contextmanager
def with_tenant(tenant_id: str) -> Iterator[Connection]:
    """Opens a transaction sealed to `tenant_id` by RLS."""
    uuid.UUID(tenant_id)  # reject anything that is not a UUID before it reaches SQL
    with engine().begin() as connection:
        connection.execute(
            text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": tenant_id},
        )
        yield connection


def assert_app_role_is_not_superuser() -> None:
    """Startup guard: the RLS guarantee is void under a superuser role."""
    with engine().connect() as connection:
        row = connection.execute(
            text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
        ).scalar()
    if row:
        raise RuntimeError("RAG service must not run with a superuser/BYPASSRLS role")
