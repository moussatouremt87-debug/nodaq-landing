"""Service configuration — same contract as services/rag: internal token with
NO default in ANY environment (a deployed image without the variable must
refuse to serve, not accept a public value)."""

import os


def internal_token() -> str:
    value = os.environ.get("OCR_INTERNAL_TOKEN")
    if not value:
        raise RuntimeError("OCR_INTERNAL_TOKEN must be set (vault in prod, .env in dev)")
    return value
