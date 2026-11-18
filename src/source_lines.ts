/** The one place file text is cut into the lines the index numbered. Both fingerprints hash it, the parser's through parser_types.ts and the embedding one through markdown_hints.ts and parser_types.ts, so an edit here makes every installed index reparse and re-embed. */

import { normalizeSourceText } from './source_text.js'

/** `text` as the lines a stored line number counts: a leading byte order mark dropped, a lone carriage return read as a line break (classic Mac OS files), and `\r\n` or `\n` ending a line. A reader that prints a line number or a line's text to the user cuts its file through this and never with its own `split`, because a hand-written cut sees a CR-only file as one giant line 1. The final element is the empty string after a trailing line break, as with `split` itself; a caller that counts lines drops it. */
export function sourceLines(text: string): string[] {
  return normalizeSourceText(text).split(/\r?\n/)
}
