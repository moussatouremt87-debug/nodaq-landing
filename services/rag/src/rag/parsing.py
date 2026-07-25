"""Document parsing: PDF + plain text for the MVP.

Office formats (Docling/unstructured) are a planned extension — the interface
takes bytes + a filename and returns text, so adding parsers is local to this
module. NEVER log document content.
"""

import io

from pypdf import PdfReader


class UnsupportedDocumentError(Exception):
    """Raised when no parser matches the document type (type only, no content)."""


def parse_document(data: bytes, filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf") or data[:5] == b"%PDF-":
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
    if lower.endswith((".txt", ".md", ".csv")):
        return data.decode("utf-8", errors="replace").strip()
    # Last resort: try utf-8; refuse binary garbage instead of indexing noise.
    try:
        return data.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        # Extension only — a filename can itself carry PII ("bulletin-paie-dupont.pdf").
        extension = lower.rsplit(".", 1)[-1] if "." in lower else "unknown"
        raise UnsupportedDocumentError(f"unsupported document type: .{extension}") from error
