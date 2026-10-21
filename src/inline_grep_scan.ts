/** The lines of a file as ripgrep, run the way Claude Code runs it, would test a pattern against them, for the inlined Grep answer's proof that a pattern matches only what the answer shows. Kept apart from inline_symbol_answer.ts so the directory scope and the bare-identifier listing share one definition of "a line". */

/** The text of `bytes` split into the lines ripgrep searches, or null when ripgrep and this reading could disagree about them, so the caller passes the Grep through. Lines end at `\n` only and keep a trailing `\r`: ripgrep without `--crlf` ends a line at `\n` alone, so `$` does not match before a `\r` (`rg --help` 15.1.0 on `--crlf`; `rg -n 'foo$'` on "foo\r\n" prints nothing and exits 1). A NUL byte (ripgrep's binary detection, and the mark of a UTF-16 file), bytes that are not UTF-8, and a CR that is not part of CRLF (ripgrep sees one long line where the index sees many) all return null. A leading byte-order mark is dropped, as ripgrep drops it. */
export function ripgrepLines(bytes: Buffer): string[] | null {
  if (bytes.includes(0)) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (/\r(?!\n)/.test(text)) return null
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
