/** The text a source file's symbol line numbers count: a leading byte order mark dropped, and a lone carriage return (classic Mac OS line endings) read as a line break, so the regex extractors (which split on `\r?\n`), tree-sitter (which counts only `\n`) and every reader that slices a stored line range all see the same lines. The embedding chunker (chunkFile) cuts its lines through this too, so both fingerprints hash it. */

/** `text` with a leading U+FEFF removed and every `\r` not followed by `\n` turned into `\n`. Replacing one character with one character keeps every offset after the mark where it was, so a tree-sitter position still indexes the same character. */
export function normalizeSourceText(text: string): string {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return unmarked.includes('\r') ? unmarked.replace(/\r(?!\n)/g, '\n') : unmarked
}
