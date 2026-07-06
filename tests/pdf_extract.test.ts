import { describe, expect, it } from 'vitest';
import { extractPdfText, parsePageRange } from '../src/pdf_extract.js';

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
});
