/** Resolves the document a stored symbol line range actually addresses. Kept as its own module rather than folded into index_reader.ts (which several tests mock wholesale) or src/languages/ (which is hashed into PARSER_FINGERPRINT, where any edit forces every installed index to reparse). */

import { ipynbToVirtualSource } from './languages/ipynb_idx.js'

/** The document a stored `line_start`/`line_end` pair addresses, given the file's raw source text. A `.ipynb` is parsed through the flattened virtual Python document parser.ts's ipynb branch builds, never the JSON bytes on disk, so every line number recorded for a notebook symbol indexes that virtual document. A reader re-deriving a symbol's text from source (the empty-stored-body fallback in read_commands.ts and notes.ts, which fires for any symbol over MAX_SYMBOL_BODY_CHARS) must therefore slice the same document the indexer measured -- slicing the raw JSON hands back notebook markup under the symbol's name, or nothing at all when the notebook is minified onto one line. Every other file is its own source and comes back unchanged. */
export function indexedSourceText(filePath: string, raw: string): string {
  return isVirtualIndexedPath(filePath) ? ipynbToVirtualSource(raw).content : raw
}

/** True when this path is indexed from a document the bytes on disk do not contain, so a stored line range and the file's own lines are two different coordinate systems. A caller holding text it did not get from {@link indexedSourceText} -- the rows a Read or a `cat` delivered, say -- must not cross index coordinates with them: the body-fold path did, and cut a notebook's JSON mid-array under a notice naming a symbol whose span was measured somewhere else entirely. Shares its extension test with {@link indexedSourceText} so the two can never disagree about which files convert. */
export function isVirtualIndexedPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ipynb')
}

/** Shared by {@link formatSymbolLocation} and outline's path-less columnar row (which has no `path:` prefix to hang the check on, only the bare `sym.filePath` it renders alongside), so the wording naming a virtual-indexed location can never drift between the two surfaces. */
export const NOTEBOOK_CELL_LINES_SUFFIX = ' (notebook cell lines)'

/** Formats a symbol's stored location for display, appending {@link NOTEBOOK_CELL_LINES_SUFFIX} when the path is virtual-indexed so the printed coordinate is never mistaken for a line in the JSON on disk -- see {@link isVirtualIndexedPath}'s doc for the bug this closes (brief/outline printed `nb.ipynb:13-14`, which addressed the flattened virtual document, not line 13 of the notebook JSON). Non-notebook output is byte-identical to the pre-existing hand-rolled label: a `lineEnd` is only omitted when the caller passed none (a single-line result), never collapsed just because `lineStart === lineEnd` -- several callers (runSymbol, brief) print a one-line symbol's range as `1-1` today, and tests pin that exact byte shape. */
export function formatSymbolLocation(displayPath: string, lineStart: number, lineEnd?: number): string {
  const range = lineEnd === undefined ? `${lineStart}` : `${lineStart}-${lineEnd}`
  const suffix = isVirtualIndexedPath(displayPath) ? NOTEBOOK_CELL_LINES_SUFFIX : ''
  return `${displayPath}:${range}${suffix}`
}
