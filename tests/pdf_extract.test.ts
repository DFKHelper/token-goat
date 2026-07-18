import { describe, expect, it } from 'vitest';
import { extractPdfMeta, extractPdfOutline, extractPdfText, parsePageRange } from '../src/pdf_extract.js';

// Minimal hand-authored single-page PDF (Helvetica text object), the standard
// fixture shape for exercising a PDF parser without a binary test asset.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`;

function pdfBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(MINIMAL_PDF, 'latin1'));
}

// Same shape as MINIMAL_PDF, but with three text objects: two on the same row at
// different x (a simulated two-column line) and one on a row below, to exercise
// --layout's row-grouping + left-to-right reconstruction.
const LAYOUT_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 111 >>
stream
BT /F1 24 Tf 20 150 Td (Left) Tj ET
BT /F1 24 Tf 150 150 Td (Right) Tj ET
BT /F1 24 Tf 20 50 Td (Bottom) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`;

function layoutPdfBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(LAYOUT_PDF, 'latin1'));
}

// A/B/C/D on a single visual line, but with SMOOTHLY DRIFTING y (each adjacent pair within
// Y_EPSILON=2, e.g. baseline jitter from a scanned/rotated PDF) such that the first and last
// item's y differ by more than Y_EPSILON. Regression: reconstructLayout used to compare every
// new item's y only against the row's FIRST item, not its nearest neighbor, so this whole
// chain got wrongly split into two rows once cumulative drift exceeded Y_EPSILON from A.
const DRIFT_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 200 >>
stream
BT /F1 10 Tf 20 100.0 Td (A) Tj ET
BT /F1 10 Tf 60 98.5 Td (B) Tj ET
BT /F1 10 Tf 100 97.0 Td (C) Tj ET
BT /F1 10 Tf 140 95.5 Td (D) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`;

function driftPdfBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(DRIFT_PDF, 'latin1'));
}

// Two-page PDF where page 1 has an empty content stream (a blank cover page) and page 2
// has real text -- exercises extractPdfMeta's multi-page text-layer sample, which must
// not conclude "no text layer" from page 1 alone.
const BLANK_FIRST_PAGE_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /MediaBox [0 0 200 200] /Contents 7 0 R >>
endobj
5 0 obj
<< /Length 0 >>
stream
endstream
endobj
6 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
7 0 obj
<< /Length 46 >>
stream
BT /F1 24 Tf 20 100 Td (Page two text) Tj ET
endstream
endobj
trailer
<< /Size 8 /Root 1 0 R >>
%%EOF
`;

function blankFirstPagePdfBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(BLANK_FIRST_PAGE_PDF, 'latin1'));
}

describe('parsePageRange', () => {
  it('returns null for an unset spec (all pages)', () => {
    expect(parsePageRange(undefined, 10)).toBeNull();
  });

  it('parses a single page number', () => {
    expect(parsePageRange('3', 10)).toEqual({ start: 3, end: 3 });
  });

  it('parses an inclusive range', () => {
    expect(parsePageRange('2-5', 10)).toEqual({ start: 2, end: 5 });
  });

  it('clamps to the document page count', () => {
    expect(parsePageRange('1-99', 10)).toEqual({ start: 1, end: 10 });
  });

  it('rejects an invalid spec', () => {
    expect(() => parsePageRange('abc', 10)).toThrow(/invalid --pages spec/);
  });

  it('rejects end before start', () => {
    expect(() => parsePageRange('5-2', 10)).toThrow(/invalid --pages spec/);
  });

  it('rejects a start page beyond the document', () => {
    expect(() => parsePageRange('10', 5)).toThrow(/page 10 is past end of document with 5 pages/);
  });

  it('rejects a range starting beyond the document', () => {
    expect(() => parsePageRange('8-12', 5)).toThrow(/page 8 is past end of document with 5 pages/);
  });
});

describe('extractPdfText', () => {
  it('extracts text content from a real single-page PDF', async () => {
    const result = await extractPdfText(pdfBytes());
    expect(result.pageCount).toBe(1);
    expect(result.pagesExtracted).toBe(1);
    expect(result.text).toContain('Hello PDF');
  });

  it('respects a --pages range beyond the document, clamped to what exists', async () => {
    const result = await extractPdfText(pdfBytes(), '1-5');
    expect(result.pagesExtracted).toBe(1);
    expect(result.text).toContain('Hello PDF');
  });

  it('reconstructs row-grouped reading order with --layout', async () => {
    const result = await extractPdfText(layoutPdfBytes(), undefined, true);
    const lines = result.text.split('\n');
    expect(lines[0]).toContain('Left');
    expect(lines[0]).toContain('Right');
    expect(lines[0].indexOf('Left')).toBeLessThan(lines[0].indexOf('Right'));
    expect(lines[1]).toContain('Bottom');
  });

  it('keeps a smoothly y-drifting line as one row instead of splitting it once cumulative drift exceeds Y_EPSILON (regression: row grouping used to compare only against the first item in a row, not its nearest neighbor)', async () => {
    const result = await extractPdfText(driftPdfBytes(), undefined, true);
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('A B C D');
  });
});

describe('extractPdfOutline', () => {
  it('returns an empty array for a PDF with no bookmarks', async () => {
    expect(await extractPdfOutline(pdfBytes())).toEqual([]);
  });
});

describe('extractPdfMeta', () => {
  it('reports page count, null title/author, and a text layer for a PDF with no /Info dict', async () => {
    const meta = await extractPdfMeta(pdfBytes());
    expect(meta.pageCount).toBe(1);
    expect(meta.title).toBeNull();
    expect(meta.author).toBeNull();
    expect(meta.hasTextLayer).toBe(true);
  });

  it('detects a text layer from a later page when the first page is blank', async () => {
    const meta = await extractPdfMeta(blankFirstPagePdfBytes());
    expect(meta.pageCount).toBe(2);
    expect(meta.hasTextLayer).toBe(true);
  });
});
