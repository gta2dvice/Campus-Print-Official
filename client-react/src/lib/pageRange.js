/**
 * Shared PDF page-range helpers (Homepage upload flow + New Order page).
 *
 * A page range is a raw string like "33-55". It is only meaningful for a file
 * whose total page count is known. An empty/absent range means "print the whole
 * document" — the pre-existing behavior.
 */

/** A range input may only appear for PDFs with more than 2 pages. */
export function showPageRangeInput(file) {
  if (!file) return false;
  const isPdf = file.file?.type === 'application/pdf' || /\.pdf$/i.test(file.file?.name || '');
  return isPdf && Number.isFinite(file.pages) && file.pages > 2;
}

/**
 * Validates a raw range against the document's real page count.
 * Returns { ok: true, start, end, pages } or { ok: false, message }.
 * An empty range is not validated here — callers treat it as "full document".
 */
export function parsePageRange(raw, totalPages) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, empty: true, message: '' };

  const match = /^(\d+)\s*-\s*(\d+)$/.exec(value);
  if (!match) {
    return { ok: false, message: 'Use a page range like 33-55 (numbers only, e.g. 10-20).' };
  }

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const total = Number(totalPages);

  if (start < 1) {
    return { ok: false, message: 'Pages start at 1 — the start page cannot be 0.' };
  }
  if (start > end) {
    return { ok: false, message: 'The start page must be less than or equal to the end page.' };
  }
  if (Number.isFinite(total) && total >= 1 && end > total) {
    return { ok: false, message: `The range must be within 1-${total} pages for this PDF.` };
  }

  return { ok: true, start, end, pages: end - start + 1 };
}

/** True when the file carries a non-empty range that does NOT validate. */
export function hasInvalidPageRange(file) {
  if (!file || !file.pageRange) return false;
  if (!showPageRangeInput(file)) return false; // no known total / not a PDF → nothing to validate against
  return !parsePageRange(file.pageRange, file.pages).ok;
}

/**
 * How many pages this file will actually print: the selected range when valid,
 * otherwise the whole document (existing full-PDF behavior).
 */
export function printablePages(file) {
  const total = Number(file?.pages) || 1;
  if (file?.pageRange && showPageRangeInput(file)) {
    const parsed = parsePageRange(file.pageRange, file.pages);
    if (parsed.ok) return parsed.pages;
  }
  return total;
}
