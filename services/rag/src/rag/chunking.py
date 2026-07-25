"""Structure-aware chunking: split on paragraphs, merge up to a bounded size
with overlap between consecutive chunks (keeps retrieval context)."""


def chunk_text(text: str, max_chars: int = 1200, overlap_chars: int = 150) -> list[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        # A single huge paragraph is hard-split.
        while len(paragraph) > max_chars:
            head, paragraph = paragraph[:max_chars], paragraph[max_chars - overlap_chars :]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head.strip())
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) > max_chars and current:
            chunks.append(current)
            # Overlap: carry the tail of the previous chunk into the next one.
            current = (current[-overlap_chars:] + "\n\n" + paragraph).strip()
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks
