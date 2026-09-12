/**
 * Perl symbol extractor: packages and named subs, a sub taking its package as parent. Brace matching is unreliable in Perl
 * (`q{}`, `s{}{}`, heredocs, POD), so a span ends where the next sub or package starts, trimmed back to that body's last `}`.
 * POD, heredoc bodies, multi-line `q`/`qq`/`qw` bracket strings, comments, and everything after `__END__` or `__DATA__` are skipped.
 */

import type { SymbolEntry } from '../parser_types.js'
import { precedingDocComment } from '../doc_comment.js'
import type { AdapterImport } from './common.js'

export interface PerlResult {
  readonly symbols: SymbolEntry[]
  readonly imports: AdapterImport[]
}

const MAX_SYMBOLS = 10_000

// The Perl and Prolog sniffs live in sniff.ts so language detection on the hook path does not load this adapter.
export { isPerlSource, isPrologSource } from './sniff.js'

type LineClass = 'code' | 'blank' | 'comment' | 'skip'

const SUB_RE = /^\s*sub\s+([A-Za-z_][\w:']*)/
const PACKAGE_RE = /^\s*package\s+([A-Za-z_][\w:]*)/
const HEREDOC_RE = /<<(~?)(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_]\w*))/g
const Q_OPEN_RE = /(?<![\w$@%&])q[qwrx]?\s*([{([<])/g
const CLOSER: Readonly<Record<string, string>> = { '{': '}', '(': ')', '[': ']', '<': '>' }

/** `line` up to its `#` comment, ignoring a `#` inside a quote or after `$` (`$#array`). */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote !== '') {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && line[i - 1] !== '$') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * `code` with the contents of its single- and double-quoted strings blanked.
 *
 * A scan for an opening marker must not match text that is only quoted data: `my $msg = "pass <<EOF
 * to the shell";` otherwise opens a heredoc that no later line terminates, and every sub after it
 * disappears from the file. Length is preserved, so a match offset still lines up with `code`.
 */
function maskStrings(code: string): string {
  const out = code.split('')
  let quote = ''
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!
    if (quote !== '') {
      out[i] = ' '
      if (c === '\\') {
        if (i + 1 < code.length) out[i + 1] = ' '
        i++
      } else if (c === quote) {
        out[i] = c
        quote = ''
      }
    } else if (c === '"' || c === "'") {
      quote = c
    }
  }
  return out.join('')
}

/** Net open count of `open` in `s` (openers minus closers). */
function balance(s: string, open: string): number {
  const close = CLOSER[open]!
  let n = 0
  for (const c of s) {
    if (c === open) n++
    else if (c === close) n--
  }
  return n
}

export function extractPerl(content: string, filePath: string): PerlResult {
  const lines = content.split(/\r?\n/)
  const cls: LineClass[] = new Array<LineClass>(lines.length).fill('skip')
  const decls: Array<{ name: string; kind: 'sub' | 'package'; line: number; parent: string }> = []
  const imports: AdapterImport[] = []
  let pod = false
  let heredocs: Array<{ term: string; indented: boolean }> = []
  let qOpen: { open: string; depth: number } | null = null
  let pkg = ''
  let last = lines.length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (heredocs.length > 0) {
      const h = heredocs[0]!
      if ((h.indented ? line.trim() : line) === h.term) heredocs = heredocs.slice(1)
      continue
    }
    if (pod) {
      if (/^=cut\b/.test(line)) pod = false
      continue
    }
    if (qOpen !== null) {
      qOpen.depth += balance(line, qOpen.open)
      if (qOpen.depth <= 0) qOpen = null
      continue
    }
    if (/^=[A-Za-z]/.test(line)) {
      pod = !/^=cut\b/.test(line)
      continue
    }
    if (/^__(?:END|DATA)__\s*$/.test(line)) {
      last = i
      break
    }
    const code = stripComment(line)
    cls[i] = code.trim() === '' ? (line.trim() === '' ? 'blank' : 'comment') : 'code'
    if (cls[i] !== 'code') continue

    const sub = SUB_RE.exec(code)
    const p = sub === null ? PACKAGE_RE.exec(code) : null
    if (sub !== null && decls.length < MAX_SYMBOLS) {
      // `sub name;` and `sub name($);` are forward declarations.
      const rest = code.slice(sub[0].length).replace(/^\s*\([^)]*\)/, '').trimStart()
      if (!rest.startsWith(';')) {
        const full = sub[1]!.replace(/'/g, '::')
        const cut = full.lastIndexOf('::')
        const name = cut < 0 ? full : full.slice(cut + 2)
        const parent = cut < 0 ? (pkg === 'main' ? '' : pkg) : full.slice(0, cut)
        if (name !== '') decls.push({ name, kind: 'sub', line: i, parent })
      }
    } else if (p !== null && decls.length < MAX_SYMBOLS) {
      pkg = p[1]!
      decls.push({ name: pkg, kind: 'package', line: i, parent: '' })
    } else {
      const u = /^\s*(?:use|require)\s+([A-Za-z_][\w:]*)/.exec(code)
      // Pragmas (`strict`, `warnings`, `lib`) are lowercase by convention; a module name has a capital or a `::`.
      if (u !== null && /[A-Z]|::/.test(u[1]!)) imports.push({ kind: 'import', target: u[1]!, line: i + 1 })
    }

    // Both openers are matched against the real code and only FILTERED by the masked copy: a `<<EOF` or `q{` that is merely quoted data opens nothing, and taking it as an opener swallows the rest of the file. Matching against the masked text instead would be wrong, because a heredoc tag is very often quoted itself (`<<'EOT'`, `<<~'EOT'`), and blanking the quoted tag loses the terminator the span is looking for. `maskStrings` preserves length, so a blank at the opener's own index is the test for "this sits inside a string".
    const scan = maskStrings(code)
    const insideString = (index: number): boolean => scan[index] === ' ' && code[index] !== ' '
    HEREDOC_RE.lastIndex = 0
    for (let m = HEREDOC_RE.exec(code); m !== null; m = HEREDOC_RE.exec(code)) {
      if (insideString(m.index)) continue
      heredocs.push({ term: m[2] ?? m[3] ?? m[4] ?? '', indented: m[1] === '~' })
    }
    Q_OPEN_RE.lastIndex = 0
    for (let m = Q_OPEN_RE.exec(code); m !== null; m = Q_OPEN_RE.exec(code)) {
      if (insideString(m.index)) continue
      const open = m[1]!
      const depth = balance(scan.slice(m.index + m[0].length - 1), open)
      if (depth > 0) {
        qOpen = { open, depth }
        break
      }
    }
  }

  const symbols: SymbolEntry[] = decls.map((d, k) => {
    // A sub stops at the next sub or package; a package holds its subs and stops at the next package.
    let next = k + 1
    while (d.kind === 'package' && next < decls.length && decls[next]!.kind !== 'package') next++
    let end = next < decls.length ? decls[next]!.line - 1 : last - 1
    // A sub ends at its body's last `}`; a package at its last line of code. POD, comments and blank lines after either are not part of it.
    if (d.kind === 'sub') {
      let e = end
      while (e > d.line && !(cls[e] === 'code' && stripComment(lines[e]!).trimEnd().endsWith('}'))) e--
      end = e > d.line ? e : d.line
    }
    while (end > d.line && cls[end] !== 'code') end--
    return {
      filePath,
      name: d.name,
      kind: d.kind,
      lineStart: d.line + 1,
      lineEnd: end + 1,
      body: lines.slice(d.line, end + 1).join('\n'),
      docstring: precedingDocComment(lines, d.line + 1, 'hash'),
      parent: d.kind === 'sub' ? d.parent : '',
    }
  })
  return { symbols, imports }
}
