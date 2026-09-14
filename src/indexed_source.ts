/** Resolves the document a stored symbol line range actually addresses. Kept as its own module rather than folded into index_reader.ts (which several tests mock wholesale) or src/languages/ (which is hashed into PARSER_FINGERPRINT, where any edit forces every installed index to reparse). */

import { ipynbToVirtualSource } from './languages/ipynb_idx.js'

/** The document a stored `line_start`/`line_end` pair addresses, given the file's raw source text. A `.ipynb` is parsed through the flattened virtual Python document parser.ts's ipynb branch builds, never the JSON bytes on disk, so every line number recorded for a notebook symbol indexes that virtual document. A reader re-deriving a symbol's text from source (the empty-stored-body fallback in read_commands.ts and notes.ts, which fires for any symbol over MAX_SYMBOL_BODY_CHARS) must therefore slice the same document the indexer measured -- slicing the raw JSON hands back notebook markup under the symbol's name, or nothing at all when the notebook is minified onto one line. Every other file is its own source and comes back unchanged. */
export function indexedSourceText(filePath: string, raw: string): string {
  return filePath.toLowerCase().endsWith('.ipynb') ? ipynbToVirtualSource(raw).content : raw
}
