/** A synthetic PDF whose text-showing operators expand far past the compressed size. Provenance: HAND-DERIVED. The file layout (header, indirect objects, `xref` table, trailer) is written from the PDF 1.7 object/cross-reference structure and the content stream from the `BT`/`Tf`/`Tm`/`Tj`/`ET` text operators, independently of anything in `src/`. Nothing here is read off token-goat's own extractor, so a build that agrees with this fixture is agreeing with the format rather than with itself. */
import * as zlib from 'node:zlib'

export interface PdfBombShape {
  /** How many text-showing operators the decompressed content stream holds. */
  ops: number
  /** How many characters each operator shows. Total extracted text is about `ops * (charsPerOp + 1)`. Keep it under ~76: each operator resets the text matrix to the same origin, and a renderer drops the glyphs that then run off the 612pt-wide page, so a longer string yields no more text. */
  charsPerOp: number
  /** How many pages carry that content stream. Defaults to 1. The pages are distinct objects, as ISO 32000-1 7.7.3.3 requires (each carries its own `/Parent`), but they all name the same content stream, so a hundred pages cost a hundred short dictionaries rather than a hundred copies of the text. */
  pages?: number
  /** How many graphics operators precede the text, on every page. Defaults to 0. These cost parse time and produce no text, so a page carrying them yields no chunk from pdfjs's text stream: a bound checked only inside that stream's loop never sees them. */
  graphicsOps?: number
}

/** Serialise numbered indirect objects into a PDF with a matching `xref` table and trailer. Each object is a list of byte runs, so a binary stream body can ride as a Buffer beside its string dictionary. */
function assemble(objects: (string | Buffer)[][]): Buffer {
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
  const size = objects.length + 1
  const xref = [`xref\n0 ${size}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}

/** A one-glyph PDF placing its text at `y` user-space units up the page, on a `/MediaBox` tall enough to hold it. Provenance: HAND-DERIVED from ISO 32000-1 (`Tm`, 9.4.2; `/MediaBox`, 7.7.3.3), then CAPTURE-confirmed: pdfjs reports `item.transform[5] === y` verbatim for each value used here, with no clamp. The tall box is load-bearing rather than decoration -- at the default 792pt height pdfjs culls the off-page glyph and reports no text item at all, so a fixture that omits it silently tests nothing. PDF reals have no exponent syntax, so `y` must be written in full decimal digits. */
export function pdfTextAtY(y: string): Buffer {
  return pdfTextItemsAtY(y, 1)
}

/** `ops` one-glyph text items, every one of them placed at `y` by its own `Tm`, with `d` as the vertical scale that `Tm` sets alongside it. Same provenance as {@link pdfTextAtY}. `d` is a parameter because it is how a document reaches NaN: a `y` of 10^310 written in full decimal digits overflows `transform[5]` to Infinity on its own, and an equally overflowing `d` beside it makes the product of the two NaN instead. Many items rather than one because what a non-finite `y` costs is quadratic in how many of them share it -- a single item never showed the cost at all. */
export function pdfTextItemsAtY(y: string, ops: number, d = '1'): Buffer {
  const content = `BT /F1 12 Tf ${`1 0 0 ${d} 10 ${y} Tm (A) Tj `.repeat(ops)}ET\n`
  return assemble([
    ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'],
    ['2 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n'],
    [`3 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`],
    ['4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'],
    [`5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${y}] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>\nendobj\n`],
  ])
}

/** A PDF whose FlateDecode content stream decompresses to `ops` lines of `charsPerOp` characters, on each of `pages` pages. */
export function pdfBomb({ ops, charsPerOp, pages = 1, graphicsOps = 0 }: PdfBombShape): Buffer {
  // Each operator re-places the text at the same origin, so every one of them yields its own line.
  const op = `1 0 0 1 10 700 Tm (${'A'.repeat(charsPerOp)}) Tj\n`
  // A save/transform/rectangle/no-op/restore group: parsed in full, shows nothing (ISO 32000-1 8.4, 8.5).
  const paint = 'q 1 0 0 1 1 1 cm 0 0 1 1 re n Q\n'.repeat(graphicsOps)
  const raw = Buffer.from(`${paint}BT /F1 12 Tf\n${op.repeat(ops)}ET\n`, 'latin1')
  const deflated = zlib.deflateSync(raw, { level: 9 })
  // Each object is one or more byte runs; the content stream's body is binary, so it rides as a Buffer. 1 catalog, 2 page tree, 3 content stream, 4 font, then one object per page from 5 on.
  const firstPage = 5
  const kids = Array.from({ length: pages }, (_, i) => `${firstPage + i} 0 R`).join(' ')
  const objects: (string | Buffer)[][] = [
    ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'],
    [`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`],
    [`3 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, deflated, '\nendstream\nendobj\n'],
    ['4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'],
    ...Array.from({ length: pages }, (_, i) => [
      `${firstPage + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>\nendobj\n`,
    ]),
  ]
  return assemble(objects)
}
