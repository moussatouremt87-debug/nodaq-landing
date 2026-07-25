"""Sovereign embeddings via the LiteLLM proxy (OpenAI-compatible).

NEVER a provider SDK (CLAUDE.md rule #1): plain HTTP to the proxy, which owns
the sovereign `embeddings` model group. Document content transits to a
sovereign model only. Errors carry HTTP statuses, never payloads.
"""

import httpx

from .config import EMBEDDING_DIM, litellm_base_url, litellm_master_key


def embed_texts(texts: list[str], timeout_s: float = 30.0) -> list[list[float]]:
    if not texts:
        return []
    response = httpx.post(
        f"{litellm_base_url()}/v1/embeddings",
        headers={"authorization": f"Bearer {litellm_master_key()}"},
        json={"model": "embeddings", "input": texts},
        timeout=timeout_s,
    )
    if response.status_code != 200:
        raise RuntimeError(f"embeddings call failed: HTTP {response.status_code}")
    data = response.json().get("data")
    if not isinstance(data, list) or len(data) != len(texts):
        raise RuntimeError("embeddings call returned a malformed response")
    vectors: list[list[float]] = []
    for item in data:
        vector = item.get("embedding") if isinstance(item, dict) else None
        if not isinstance(vector, list) or len(vector) != EMBEDDING_DIM:
            raise RuntimeError(
                f"embedding dimension mismatch (expected {EMBEDDING_DIM})"
            )
        vectors.append([float(x) for x in vector])
    return vectors


def to_pgvector(vector: list[float]) -> str:
    """Serializes a vector for a `::vector` cast in SQL."""
    return "[" + ",".join(f"{x:.8f}" for x in vector) + "]"
