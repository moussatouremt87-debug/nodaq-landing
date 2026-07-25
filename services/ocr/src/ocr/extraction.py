"""Invoice text extraction: text-layer PDFs and plain text for the MVP.

Scanned-image OCR (docTR self-host, or Mistral Document AI EU behind LiteLLM)
is a planned extension of THIS module — the API contract will not change.
This service performs NO model call: structured field extraction from the
returned text is the TypeScript caller's job, through packages/llm.route()
(sovereign classification + audit stay in one single place).
NEVER log document content.
"""

import io
import logging

from pypdf import PdfReader

# pypdf logs RAW SLICES of the document when it hits malformed structures —
# that is customer content in service logs (RGPD audit 1.4, blocking).
# Silence its logger entirely: we never want its diagnostics.
_pypdf_logger = logging.getLogger("pypdf")
_pypdf_logger.addHandler(logging.NullHandler())
_pypdf_logger.propagate = False


class UnsupportedInvoiceError(Exception):
    """Raised with the file EXTENSION only — a filename can carry PII."""


def _extension(lower_filename: str) -> str:
    return lower_filename.rsplit(".", 1)[-1] if "." in lower_filename else "unknown"


def extract_text(data: bytes, filename: str) -> tuple[str, int]:
    """Returns (text, page_count). page_count is 1 for plain text."""
    lower = filename.lower()
    if lower.endswith(".pdf") or data[:5] == b"%PDF-":
        # ANY parsing failure maps to the content-free error: an unhandled
        # PdfReadError would put document bytes in a 500 traceback.
        try:
            reader = PdfReader(io.BytesIO(data))
            text = "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
            return text, len(reader.pages)
        except Exception as error:
            raise UnsupportedInvoiceError(
                f"unsupported invoice type: .{_extension(lower)}"
            ) from error
    try:
        return data.decode("utf-8").strip(), 1
    except UnicodeDecodeError as error:
        raise UnsupportedInvoiceError(f"unsupported invoice type: .{_extension(lower)}") from error
