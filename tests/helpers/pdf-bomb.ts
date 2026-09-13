/**
 * A synthetic single-page PDF whose text-showing operators expand far past the compressed size.
 *
 * Provenance: HAND-DERIVED. The file layout (header, indirect objects, `xref` table, trailer) is
 * written from the PDF 1.7 object/cross-reference structure and the content stream from the
 * `BT`/`Tf`/`Tm`/`Tj`/`ET` text operators, independently of anything in `src/`. Nothing here is
 * read off token-goat's own extractor, so a build that agrees with this fixture is agreeing with
 * the format rather than with itself.
 */
import * as zlib from 'node:zlib'

export interface PdfBombShape {
  /** How many text-showing operators the decompressed content stream holds. */
  ops: number
  /**
   * How many characters each operator shows. Total extracted text is about `ops * (charsPerOp + 1)`.
   *
   * Keep it under ~76: each operator resets the text matrix to the same origin, and a renderer drops
   * the glyphs that then run off the 612pt-wide page, so a longer string yields no more text.
   */
  charsPerOp: number
}

/** A one-page PDF whose FlateDecode content stream decompresses to `ops` lines of `charsPerOp` characters. */
export function pdfBomb({ ops, charsPerOp }: PdfBombShape): Buffer {
  // Each operator re-places the text at the same origin, so every one of them yields its own line.
  const op = `1 0 0 1 10 700 Tm (${'A'.repeat(charsPerOp)}) Tj\n`
  const raw = Buffer.from(`BT /F1 12 Tf\n${op.repeat(ops)}ET\n`, 'latin1')
  const deflated = zlib.deflateSync(raw, { level: 9 })
  // Each object is one or more byte runs; the content stream's body is binary, so it rides as a Buffer.
  const objects: (string | Buffer)[][] = [
    ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'],
    ['2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'],
    ['3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n'],
    [`4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, deflated, '\nendstream\nendobj\n'],
    ['5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'],
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let at = chunks[0]!.length
  for (const object of objects) {
    offsets.push(at)
    for (const part of object) {
      const bytes = typeof part === 'string' ? Buffer.from(part, 'latin1') : part
      chunks.push(bytes)
      at += bytes.length
    }
  }
  const xref = ['xref\n0 6\n0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}
