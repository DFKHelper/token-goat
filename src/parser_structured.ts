/**
 * Extractors for structured textual formats (Markdown, JSON, YAML, TOML, CSS, Dockerfile)
 * and fallback regex symbol recovery.
 */

import { precedingDocComment, type DocCommentStyle } from './doc_comment.js'
import { stripCstyleComments, stripStringLiterals } from './languages/common.js'
import { eachUnfencedLine } from './markdown_lines.js'
import type { SymbolEntry } from './parser_types.js'

/**
 * Return the offset one past the end of the JSON value starting at `start`.
 *
 * Handles the three value shapes separately: a quoted string (walk to the
 * matching close quote, honoring backslash escapes), a container (`{`/`[` —
 * walk to the matching close brace/bracket, skipping over string contents so a
 * brace inside a string cannot unbalance the count), and a primitive (number /
 * `true` / `false` / `null` — ends at the first delimiter). Each walk is linear
 * in the length of the value it scans, so scanning every top-level value of a
 * document costs O(document), not O(keys × document).
 *
 * An unterminated value (malformed/truncated JSON) yields `content.length`
 * rather than throwing; the caller already treats extraction as best-effort.
 */
function scanJsonValueEnd(content: string, start: number): number {
  const first = content[start]
  if (first === undefined) return content.length

  if (first === '"') {
    let escaping = false
    for (let j = start + 1; j < content.length; j++) {
      const c = content[j]
      if (escaping) {
        escaping = false
        continue
      }
      if (c === '\\') {
        escaping = true
        continue
      }
      if (c === '"') return j + 1
    }
    return content.length
  }

  if (first === '{' || first === '[') {
    // Track the open delimiters themselves, not just a depth counter: matching `}` against `[`
    // lets malformed input (`{"a":[1}`) close a container it never opened, which would hand the
    // caller a body running past the value's real end. On a mismatch, stop at the offending
    // character rather than consuming forward to EOF.
    const stack: string[] = []
    let inStr = false
    let escaping = false
    for (let j = start; j < content.length; j++) {
      const c = content[j]
      if (inStr) {
        if (escaping) {
          escaping = false
          continue
        }
        if (c === '\\') {
          escaping = true
          continue
        }
        if (c === '"') inStr = false
        continue
      }
      if (c === '"') {
        inStr = true
        continue
      }
      if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') {
        const open = stack.pop()
        if (open !== (c === '}' ? '{' : '[')) return j
        if (stack.length === 0) return j + 1
      }
    }
    return content.length
  }

  for (let j = start; j < content.length; j++) {
    const c = content[j]
    if (c === ',' || c === '}' || c === ']' || c === '\n' || c === '\r') return j
  }
  return content.length
}

/** Count `\n` occurrences in `s` (used to derive a span's end line from its start line). */
function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return n
}
export function extractMarkdownSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)
  const unfenced = Array.from(eachUnfencedLine(lines))

  for (let u = 0; u < unfenced.length; u++) {
    const [i, line] = unfenced[u]!
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const atxMatch = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line)
    if (atxMatch !== null && atxMatch[2] !== undefined) {
      const name = atxMatch[2].trim()
      if (name !== '') {
        out.push({
          filePath,
          name,
          kind: 'heading',
          lineStart: i + 1,
          lineEnd: i + 1,
          body: line.trim(),
          docstring: '',
          parent: '',
        })
      }
      continue
    }

    const trimmed = line.trim()
    if (
      trimmed !== '' &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('|') &&
      !trimmed.startsWith('```') &&
      !trimmed.startsWith('~~~') &&
      !/^([-*+]|\d+\.)\s/.test(trimmed) &&
      u + 1 < unfenced.length
    ) {
      const [nextIdx, nextLine] = unfenced[u + 1]!
      if (nextIdx === i + 1) {
        const isUnderline = /^\s*(=+|-+)\s*$/.test(nextLine)
        if (isUnderline) {
          out.push({
            filePath,
            name: trimmed,
            kind: 'heading',
            lineStart: i + 1,
            lineEnd: i + 2,
            body: `${trimmed}\n${nextLine.trim()}`,
            docstring: '',
            parent: '',
          })
          u++
        }
      }
    }
  }

  return out
}

// Blank `//` and `/* */` comments outside strings, keeping every offset and newline, so a JSONC comment neither opens a phantom string nor shifts the depth count. A no-op on strict JSON, which has no comments.
function blankJsonComments(raw: string): string {
  const out: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? ''
    if (inStr) {
      out.push(ch)
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out.push(ch)
      continue
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') {
        out.push(' ')
        i++
      }
      if (i < raw.length) out.push('\n')
      continue
    }
    if (ch === '/' && raw[i + 1] === '*') {
      out.push('  ')
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        out.push(raw[i] === '\n' ? '\n' : ' ')
        i++
      }
      if (i < raw.length) {
        out.push('  ')
        i++
      }
      continue
    }
    out.push(ch)
  }
  return out.join('')
}

export function extractJsonSymbols(raw: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  // Scanned with comments blanked; bodies are cut from the raw text at the same offsets.
  const content = raw.includes('/') ? blankJsonComments(raw) : raw

  try {
    let depth = 0
    let inString = false
    let escaping = false
    let strChars: string[] = []
    let strStartLine = 1
    let strStartOffset = 0
    let depthWhenStringOpened = 0
    let line = 1

    for (let i = 0; i < content.length; i++) {
      const ch = content[i]
      if (ch === undefined) continue
      if (ch === '\n') line++
      if (escaping) {
        escaping = false
        if (inString) strChars.push(ch)
        continue
      }
      if (ch === '\\' && inString) {
        escaping = true
        continue
      }
      if (ch === '"') {
        if (!inString) {
          inString = true
          strChars = []
          strStartLine = line
          strStartOffset = i
          depthWhenStringOpened = depth
        } else {
          inString = false
          // A string is a top-level key iff it opened at object depth 1 and its next non-whitespace char is ':'. This rule is layout-independent, so it captures keys in single-line/minified JSON and keys that share a line with '{', which the previous line-oriented scan missed (it emitted zero symbols for minified JSON).
          let k = i + 1
          while (k < content.length && /\s/.test(content[k] ?? '')) {
            k++
          }
          if (content[k] === ':' && depthWhenStringOpened === 1) {
            // body/lineEnd are derived from the key's and value's own character offsets, never
            // from whole source lines.
            //
            // The previous implementation defaulted body to `lines[strStartLine - 1]` -- the
            // key's entire source line -- widening it only for string values with embedded
            // newlines. On minified JSON that default is catastrophic: every top-level key sits
            // on line 1, so every key stored a copy of the *whole file*. An N-key, S-byte
            // minified document wrote N x S bytes into `symbols.body`, mirrored again into
            // `symbols_fts`. One real 1.5 MB, 1142-key file grew global.db by 1.6 GB by itself,
            // which made each reindex transaction long enough to blow past db.ts's 15s
            // busy_timeout -- surfacing as "database is locked" and as long freezes during
            // `token-goat index`.
            //
            // Walking the value's true extent instead makes the stored bytes scale with the
            // value, so a whole document's bodies now sum to roughly the document's own size.
            // It also fixes a real correctness gap: an object/array value previously recorded
            // lineEnd as the key's line and a body of just `"key": {`, so `read file::key`
            // returned the opening brace rather than the value.
            let v = k + 1
            while (v < content.length && /\s/.test(content[v] ?? '')) {
              v++
            }
            const valueEnd = scanJsonValueEnd(content, v)
            const body = raw.slice(strStartOffset, valueEnd)
            const lineEnd = strStartLine + countNewlines(body)
            out.push({
              filePath,
              name: strChars.join(''),
              kind: 'property',
              lineStart: strStartLine,
              lineEnd,
              body,
              docstring: '',
              parent: '',
            })
          }
        }
        continue
      }
      if (inString) {
        strChars.push(ch)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth--
    }
  } catch {
    // Silently fall through
  }

  return out
}

// Mirrors ini_idx.ts's _detectOpenQuote: a value only opens a (possibly multi-line) quoted scalar when its leading non-whitespace char is a quote. A quote appearing later in the value - an apostrophe in a plain scalar (`title: It's working`), or a stray quote inside a trailing `#` comment - is never a delimiter and must not be scanned for parity, or a plain scalar with an interior apostrophe silently swallows every key after it until a matching quote happens to appear somewhere downstream.
export function yamlOpenQuoteAfter(line: string, startIdx: number): '"' | "'" | null {
  const value = line.slice(startIdx)
  const trimmed = value.replace(/^\s+/, '')
  const q = trimmed[0]
  if (q !== '"' && q !== "'") return null
  if (q === '"') {
    let j = 1
    while (j < trimmed.length) {
      if (trimmed[j] === '\\') { j += 2; continue }
      if (trimmed[j] === '"') return null
      j++
    }
    return '"'
  }
  let j = 1
  while (j < trimmed.length) {
    if (trimmed[j] === "'" && trimmed[j + 1] === "'") { j += 2; continue }
    if (trimmed[j] === "'") return null
    j++
  }
  return "'"
}

export function yamlLineClosesQuote(line: string, quote: '"' | "'"): boolean {
  let i = 0
  while (i < line.length) {
    if (quote === '"') {
      if (line[i] === '\\') { i += 2; continue }
      if (line[i] === '"') return true
    } else {
      if (line[i] === "'" && line[i + 1] === "'") { i += 2; continue }
      if (line[i] === "'") return true
    }
    i++
  }
  return false
}

export function extractYamlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  // A top-level key's double/single-quoted value can wrap across multiple lines (YAML folds the embedded newline into a space). Without tracking that, a continuation line that happens to contain its own `word:` -shaped text (e.g. wrapped prose mentioning "ratio: 16:9", or any string content resembling a key) was read as a brand new top-level key.
  let openQuote: '"' | "'" | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openQuote !== null) {
      if (yamlLineClosesQuote(line, openQuote)) openQuote = null
      continue
    }

    // A bare URL on its own line (e.g. `https://example.com`) must NOT match as a false `https` key - the colon there is a URL scheme separator immediately followed by `//`, not a key/value split. The key charset includes `.` so a flat/dotted top-level key (e.g. `server.host:`) is captured whole rather than silently dropped. Mirrors the same guard and charset the live section reader's KEYVALUE_HEADER_RE already applies (section_reader.ts).
    const match = /^([a-zA-Z_][\w.-]*)\s*:(?!\/\/)/.exec(line)
    if (match !== null && match[1] !== undefined) {
      out.push({
        filePath,
        name: match[1],
        kind: 'key',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
        parent: '',
      })
      openQuote = yamlOpenQuoteAfter(line, match[0].length)
    }
  }

  return out
}

// Multi-line TOML strings (`"""..."""` or `'''...'''`) can span many lines; text inside them (e.g. a description field quoting example TOML) must never be scanned for key/section syntax. Track whether a triple-quote span opened on an earlier line is still open across the loop, keyed by which delimiter opened it. The two delimiter styles' run counts cannot be tallied independently per line (e.g. via separate regex-match counts) -- only ONE style can be "open" at a time, so a """ string whose body happens to contain a ''' sequence (e.g. a description quoting example TOML syntax) must treat that ''' as inert text, not as its own independent open/close toggle. Counting each style's occurrences separately loses that positional relationship: an ODD number of ''' sequences sitting inertly inside an already-closed """..." span was wrongly read as opening a real multi-line literal string, desyncing every line after it until an unrelated ''' happened to appear later in the file. Scan the line once, left to right, tracking a single open-delimiter slot instead. Exported so the live section reader's TOML table finder (section_reader.ts) can share this exact state machine instead of re-implementing it and drifting out of sync with the indexer.
export function lineOpenDelimiterAfter(line: string, startIdx: number): string | null {
  let pos = startIdx
  let open: string | null = null
  for (;;) {
    if (open === null) {
      const dIdx = line.indexOf('"""', pos)
      const sIdx = line.indexOf("'''", pos)
      if (dIdx === -1 && sIdx === -1) return null
      if (dIdx !== -1 && (sIdx === -1 || dIdx <= sIdx)) {
        open = '"""'
        pos = dIdx + 3
      } else {
        open = "'''"
        pos = sIdx + 3
      }
    } else {
      const closeIdx = line.indexOf(open, pos)
      if (closeIdx === -1) return open
      open = null
      pos = closeIdx + 3
    }
  }
}

// A `#` outside a string starts a TOML comment, and comment prose carries no structure. Neither the triple-quote tracker nor the array-depth counter was comment-aware, so an ordinary note like `# TODO: handle [ nested extras` opened a phantom multi-line array that silently swallowed every table and key after it until an unrelated `]` happened to appear (a `'''` or `"""` inside a comment did the same via the delimiter tracker). Scans left to right tracking basic (`"`, backslash-escapable) and literal (`'`, no escapes) string state, so a `#` inside a value is never mistaken for a comment; a same-line `"""..."""` span stays protected by quote parity, and a span left open from an earlier line is consumed by the callers before this runs.
export function stripTomlComment(line: string): string {
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inBasic) {
      if (ch === '\\') i++
      else if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

// TOML arrays may legally span multiple physical lines (e.g. a matrix as an array of arrays, one row per line). A continuation row of such an array - especially a nested array-of-arrays row like `[1, 0, 0],` - starts with `[` and would otherwise be misread by the section regex as a new table header. Track the net bracket depth opened by an unclosed array so continuation lines are skipped from key/section matching entirely until the array actually closes. Brackets inside string literals are ignored (a quoted value like "a[b]" must never affect array depth). Exported for the same reason as lineOpenDelimiterAfter above.
export function tomlBracketDelta(line: string): number {
  const stripped = stripStringLiterals(line)
  let delta = 0
  for (const ch of stripped) {
    if (ch === '[') delta++
    else if (ch === ']') delta--
  }
  return delta
}

// A TOML simple-key is an unquoted key (letters, digits, `_`, `-`), a basic string, or a literal string; a full key is one or more simple keys joined by dots (`serde.workspace = true`, `"*" = [...]`, `'my.key' = 1`).
const TOML_SIMPLE_KEY = `(?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`
const TOML_KEY_RE = new RegExp(`^\\s*(${TOML_SIMPLE_KEY}(?:\\s*\\.\\s*${TOML_SIMPLE_KEY})*)\\s*=`)

export function extractTomlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  function matchLine(line: string, lineNum: number): void {
    // `\[?` matches the optional second bracket of a TOML array-of-tables header (`[[bin]]`) so the name captures as `bin`, not `[bin`.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const sectionMatch = /^\s*\[\[?\s*([^\]]+)\s*\]/.exec(line)
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      out.push({
        filePath,
        name: sectionMatch[1].trim(),
        kind: 'section',
        lineStart: lineNum + 1,
        lineEnd: lineNum + 1,
        body: line.trim(),
        docstring: '',
        parent: '',
      })
    }

    const keyMatch = TOML_KEY_RE.exec(line)
    if (keyMatch !== null && keyMatch[1] !== undefined) {
      out.push({
        filePath,
        name: keyMatch[1],
        kind: 'key',
        lineStart: lineNum + 1,
        lineEnd: lineNum + 1,
        body: line.trim(),
        docstring: '',
        parent: '',
      })
    }
  }

  let openDelim: string | null = null
  let arrayDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openDelim !== null) {
      const closeIdx = line.indexOf(openDelim)
      if (closeIdx === -1) continue // whole line is inside the open string body
      const restStart = closeIdx + openDelim.length
      matchLine(line.slice(restStart), i)
      openDelim = lineOpenDelimiterAfter(stripTomlComment(line.slice(restStart)), 0)
      continue
    }

    if (arrayDepth > 0) {
      arrayDepth = Math.max(0, arrayDepth + tomlBracketDelta(stripTomlComment(line)))
      continue
    }

    matchLine(line, i)
    // Comment text is stripped for the state machine only, never for matchLine: the symbol body deliberately keeps the trailing comment a reader would expect to see.
    const code = stripTomlComment(line)
    openDelim = lineOpenDelimiterAfter(code, 0)
    if (openDelim === null) arrayDepth = Math.max(0, tomlBracketDelta(code))
  }

  return out
}

// Splits a CSS selector-list capture on top-level commas only, skipping commas nested inside parentheses (`:is(.foo, .bar)`, `:not()`, `:nth-child(An+B of S)`) or, thanks to the caller already passing a string-literal-stripped `strippedCapture`, commas inside a quoted attribute value (`[data-x="a,b"]`). A plain `rawCapture.split(',')` treats every comma as a selector-list separator, which shreds any selector containing one of those constructs into multiple bogus selector fragments. Scanning happens over `strippedCapture` (so string interiors can't skew paren-depth tracking), but each segment is sliced back out of `rawCapture` at the same offsets so the indexed selector text stays verbatim.
function splitTopLevelSelectors(rawCapture: string, strippedCapture: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < strippedCapture.length; i++) {
    const ch = strippedCapture[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(rawCapture.slice(start, i))
      start = i + 1
    }
  }
  parts.push(rawCapture.slice(start))
  return parts
}

// True when the next non-blank line after `i` opens a bare Allman-style rule brace (`{` alone on its own line, e.g. `body\n{\n...`). Used to start selector-fragment accumulation for the FIRST fragment of a rule, which - unlike every later fragment of a multi-line comma list - has no trailing comma of its own to signal "more of this selector is still coming".
function nextContentLineOpensBrace(lines: readonly string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const next = lines[j]?.trim() ?? ''
    if (next.length === 0) continue
    return next === '{'
  }
  return false
}

export function extractCssSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  // Strip /* */ block comments (newlines preserved so line numbers stay correct) before scanning -- otherwise a commented-out selector at column 0 (e.g. inside a disabled block) is indexed as if it were live CSS.
  const lines = stripCstyleComments(content).split(/\r?\n/)
  // Raw (pre-strip) lines, kept only to distinguish "blanked by comment stripping" from
  // "genuinely blank in the source" below -- see the check at the top of the loop.
  const rawLines = content.split(/\r?\n/)

  // Selector fragments accumulated from preceding comma-continuation lines -- the common multi-line selector-list idiom (`.btn,\n.btn-primary,\n.btn-secondary {`). Each entry keeps its own line number/body so a fragment is indexed at the line it actually appears on, not the brace line, matching how a same-line comma list is already indexed per-fragment below.
  let pending: Array<{ name: string; line: number; body: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()

    // A line that became empty ONLY because stripCstyleComments blanked a `/* ... */` comment sitting on its own line (e.g. `/* primary button */` between selector fragments of a multi-line comma-separated list) must be a no-op, not a break in accumulation -- treating it like a genuinely blank line would silently drop every fragment gathered in `pending` so far (see the discard fallback at the bottom of the loop). A line that was already blank in the raw source still falls through to that discard below, unchanged.
    if (trimmed.length === 0 && (rawLines[i]?.trim().length ?? 0) > 0) {
      continue
    }

    // `^[.#][\w-]+[,\s{]` only matched a bare class/id selector immediately followed by a comma/space/brace, so a compound selector (`.foo.bar`), a pseudo-class/element (`.foo:hover`, `.foo::before`), a plain tag/attribute selector (`div`, `input[type]`), or any selector indented under a nested @media/@supports block (leading whitespace broke the `^` anchor) were all silently skipped. Match anything up to the opening brace instead - excluding lines that start with `@` (an at-rule header like `@media (...) {` is not itself a selector, though selectors nested inside its block are separate lines matched independently) or `{`/`}` (a bare brace-only line) - and split a same-line comma-separated selector list into one symbol per selector. Match against a string-literal-stripped copy of the line so a `{` inside a quoted declaration value (e.g. `content: "{";`, a common pseudo-element glyph pattern) is never mistaken for a rule-opening brace. stripStringLiterals blanks string interiors to same-length spaces, so the match's character offsets line up with the original `line` - the actual (unblanked) selector text is then re-sliced from `line` at those offsets, so a real selector that legitimately contains a quoted value (e.g. `input[type="text"]`) is still captured verbatim rather than with its quoted portion blanked out.
    const strippedLine = stripStringLiterals(line)
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const selectorLineMatch = /^[ \t]*([^{}@][^{]*)\{/d.exec(strippedLine)
    if (selectorLineMatch !== null && selectorLineMatch[1] !== undefined) {
      for (const p of pending) {
        out.push({
          filePath,
          name: p.name,
          kind: 'selector',
          lineStart: p.line,
          lineEnd: p.line,
          body: p.body,
          docstring: '',
          parent: '',
        })
      }
      pending = []
      const captureRange = (selectorLineMatch as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
        .indices?.[1]
      const rawCapture = captureRange ? line.slice(captureRange[0], captureRange[1]) : selectorLineMatch[1]
      const strippedCapture = captureRange
        ? strippedLine.slice(captureRange[0], captureRange[1])
        : selectorLineMatch[1]
      for (const part of splitTopLevelSelectors(rawCapture, strippedCapture)) {
        const name = part.trim()
        if (name) {
          out.push({
            filePath,
            name,
            kind: 'selector',
            lineStart: i + 1,
            lineEnd: i + 1,
            body: line.trim(),
            docstring: '',
            parent: '',
          })
        }
      }
      continue
    }

    // Brace-only line (nothing but `{`, possibly with surrounding whitespace) closing off a multi-line selector list whose fragments were accumulated via `pending` below (the idiom `.a,\n.b\n{\n...`). Flush those fragments as the selector list for this rule instead of falling through to the discard case at the bottom of the loop, which would otherwise silently drop every accumulated fragment because a bare `{` never matches `selectorLineMatch` above (it requires a non-`{`/`}`/`@` character before the brace).
    if (trimmed === '{') {
      for (const p of pending) {
        out.push({
          filePath,
          name: p.name,
          kind: 'selector',
          lineStart: p.line,
          lineEnd: p.line,
          body: p.body,
          docstring: '',
          parent: '',
        })
      }
      pending = []
      continue
    }

    // Continuation candidate: a bare selector-fragment line with no brace, not an at-rule header, and not a declaration (no `;`). Three shapes are accepted: a line ending in a trailing comma (starts or continues a comma list, e.g. `.a,`); once a comma-list is already underway (`pending.length > 0`), a bare trailing-fragment line with no comma at all (e.g. the final `.b` in `.a,\n.b\n{`); or a single Allman-brace selector whose `{` sits alone on the very next content line (e.g. `body\n{`) - this last shape has no trailing comma and starts with an empty `pending`, so without the forward-scan it fails both of the other two conditions and the selector is silently dropped. Either way the fragment is accumulated until the line that actually opens the brace (matched above) is reached, instead of being dropped.
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('@') &&
      !trimmed.includes('{') &&
      !trimmed.includes('}') &&
      !trimmed.includes(';')
    ) {
      const endsWithComma = trimmed.endsWith(',')
      if (endsWithComma || pending.length > 0 || nextContentLineOpensBrace(lines, i)) {
        const name = endsWithComma ? trimmed.slice(0, -1).trim() : trimmed
        if (name) pending.push({ name, line: i + 1, body: trimmed })
        continue
      }
    }

    // Anything else (blank line, declaration, closing brace, ...) breaks the accumulation --
    // the pending fragments weren't actually part of a selector list after all.
    pending = []
  }

  return out
}

export function extractDockerfileSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  // Dockerfile instructions may span multiple physical lines via a trailing backslash continuation (e.g. `RUN apt-get update && \`), and every non-first physical line of that logical instruction is shell text, not a new directive. Without tracking this, a continuation line that happens to start with a shell token colliding with a Dockerfile keyword under the case-insensitive match below (most commonly the `env VAR=val cmd` shell idiom, but also run/copy/add/user/label/arg/from) is misread as a standalone directive.
  let continuing = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (continuing) {
      continuing = line.trimEnd().endsWith('\\')
      continue
    }

    // A whole-line `#` comment never starts or continues a directive: Docker does not extend comments across lines via continuation, so a trailing backslash on a comment is just part of the comment text, not a real line-continuation marker.
    const isComment = line.trim().startsWith('#')
    const match = isComment
      ? null
      : /^\s*(FROM|RUN|COPY|ADD|EXPOSE|ENV|WORKDIR|CMD|ENTRYPOINT|ARG|LABEL|VOLUME|USER|HEALTHCHECK|ONBUILD|SHELL|STOPSIGNAL|MAINTAINER)\s+(.+)/i.exec(
          line,
        )
    if (match !== null && match[1] !== undefined) {
      const cmd = match[1]
      const arg = (match[2] ?? '').substring(0, 40)
      const name = `${cmd} ${arg}`.trim()
      out.push({
        filePath,
        name,
        kind: 'directive',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
        parent: '',
      })
    }

    continuing = !isComment && line.trimEnd().endsWith('\\')
  }

  return out
}

// --- Regex fallback ---------------------------------------------------------

// Top-level function/class patterns for the languages we lack a grammar for (and as a safety net
// when a native grammar fails to load mid-run). Each pattern also carries the comment `style` of
// the language it targets -- unlike the tree-sitter extractors, this fallback has no reliably
// detected `Language` to key off (it commonly runs against an 'unknown' extension), but the
// *pattern that matched* always knows its own source language, so the style travels with it.
const FALLBACK_PATTERNS: ReadonlyArray<{ re: RegExp; kind: string; style: DocCommentStyle }> = [
  // Python
  { re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', style: 'hash' },
  { re: /^[ \t]*class\s+([A-Za-z_]\w*)/, kind: 'class', style: 'hash' },
  // TS/JS function & class declarations (optionally exported/async)
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(?:\*\s*)?([A-Za-z_$][\w$]*)/,
    kind: 'function',
    style: 'c',
  },
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
    style: 'c',
  },
  { re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', style: 'c' },
  { re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type', style: 'c' },
  // const/let/var bound to an arrow or function expression
  {
    re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: 'function',
    style: 'c',
  },
  // Rust / Go function & struct/type patterns
  { re: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', style: 'c' },
  { re: /^[ \t]*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', style: 'c' },
  { re: /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', style: 'c' },
]

/**
 * Line-oriented regex extraction used when tree-sitter is unavailable.
 *
 * Captures the symbol name and a single-line body (the matched line). Line
 * numbers are 1-based. This is intentionally shallow: it recovers names for
 * `symbol`/`skeleton` lookups without full-body spans.
 */
// Exported for tests only. This fires in production for an unrecognized filename/extension (the
// `language === 'unknown'` early return upstream never actually reaches it for that case -- see
// extractSymbolsNoTreeSitter) and, more meaningfully, as the mid-parse safety net when a
// tree-sitter grammar throws on real source for a language that HAS one (still routed through
// `extractNoTreeSitter` -> `extractSymbolsNoTreeSitter` with that language's own real filePath
// extension). Neither path is practical to reach deterministically via `parseFile` in a unit
// test, so tests call this directly rather than asserting on unreachable-in-practice behavior.
export function extractWithRegex(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const { re, kind, style } of FALLBACK_PATTERNS) {
      const m = re.exec(line)
      if (m !== null && m[1] !== undefined) {
        out.push({
          filePath,
          name: m[1],
          kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          body: line.trim(),
          docstring: precedingDocComment(lines, i + 1, style),
          parent: '',
        })
        break // one symbol per line
      }
    }
  }
  return out
}
