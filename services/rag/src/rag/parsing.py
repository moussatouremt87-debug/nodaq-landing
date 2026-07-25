"""Document parsing: PDF + plain text for the MVP.

Office formats (Docling/unstructured) are a planned extension — the interface
takes bytes + a filename and returns text, so adding parsers is local to this
module. NEVER log document content.
"""

import io
import logging

from pypdf import PdfReader

# pypdf logs RAW SLICES of the document on malformed structures — silence it
# (same hardening as services/ocr, RGPD audit 1.4).
_pypdf_logger = logging.getLogger("pypdf")
_pypdf_logger.addHandler(logging.NullHandler())
_pypdf_logger.propagate = False


class UnsupportedDocumentError(Exception):
    """Raised when no parser matches the document type (type only, no content)."""


def _extension(lower_filename: str) -> str:
    return lower_filename.rsplit(".", 1)[-1] if "." in lower_filename else "unknown"


def parse_document(data: bytes, filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf") or data[:5] == b"%PDF-":
        try:
            reader = PdfReader(io.BytesIO(data))
            return "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
        except Exception as error:
            # Content-free error: an unhandled PdfReadError would put document
            # bytes into a 500 traceback.
            raise UnsupportedDocumentError(
                f"unsupported document type: .{_extension(lower)}"
            ) from error
    if lower.endswith((".txt", ".md", ".csv")):
        return data.decode("utf-8", errors="replace").strip()
    # Last resort: try utf-8; refuse binary garbage instead of indexing noise.
    try:
        return data.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        # Extension only — a filename can itself carry PII ("bulletin-paie-dupont.pdf").
        extension = lower.rsplit(".", 1)[-1] if "." in lower else "unknown"
        raise UnsupportedDocumentError(f"unsupported document type: .{extension}") from error
