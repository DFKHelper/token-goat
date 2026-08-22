/**
 * Named-section extraction from text files.
 *
 * Unlike the Python `read_section` (which queries a tree-sitter-built `sections`
 * index in SQLite), this layer parses sections directly from text so it works
 * before the Layer 7 index exists. It recognises markdown headings, TOML/INI
 * tables, Python class/function bodies (via regex), and generic `key = value` /
 * `key:` blocks, choosing the parser by what the text looks like.
 *
 * A section spans from its own header line up to (but not including) the next
 * header at the same or shallower level — exactly the slice a reader means when
 * they ask for "the Install section" or "the [tool.ruff] table".
 */

import { readFileSync } from 'node:fs'

import { redactIfDotenv } from './dotenv_redact.js'
import { buildLineIndex, offsetToLine, findHtmlHeadingMatches } from './languages/common.js'
import { eachUnfencedLine } from './markdown_lines.js'
import { detectLanguage } from './parser_types.js'
import { decodeSource } from './util.js'
import { yamlOpenQuoteAfter, yamlLineClosesQuote, lineOpenDelimiterAfter, tomlBracketDelta } from './parser.js'
import { _detectOpenQuote as envDetectOpenQuote, _lineClosesQuote as envLineClosesQuote } from './languages/ini_idx.js'

/** One extracted section: its header text, body, and 1-based line span. */
export interface SectionResult {
  readonly heading: string
  readonly content: string
  readonly lineStart: number
  readonly lineEnd: number
  /** The original query a prefix redirect resolved from; absent on an exact match. */
  readonly redirectedFrom?: string
  /**
   * 1-based line numbers of every heading the spec matched, present only when the spec carried no
   * ordinal and more than one heading matched. Absent -- not a one-element array -- for the
   * unambiguous case, so a caller that ignores the field keeps the historical first-match result
   * and only a caller that checks it sees the ambiguity. See runSection, which refuses on it.
   */
  readonly occurrences?: readonly number[]
}

/** A located section header before its end line is resolved. */
interface SectionHeader {
  readonly heading: string
  /** Nesting depth: markdown `#` count, or table-dotted-segment count. */
  readonly level: number
  /** 0-based index of the header line. */
  readonly index: number
}

/** Kind of header finder that produced the headers. */
// 'table-toml' uses dotted-name nesting (tableSectionEndIndex): a later table only ends the current section if it is NOT a strict dotted descendant, matching TOML's real nesting convention (e.g. [tool.ruff] legitimately absorbs [tool.ruff.lint]). 'table-flat' is INI and the unknown-language table sniff, where a `.` in a section name (e.g. [server.pool] or [mysqld:replica]) is just a name, never a nesting operator, so every [header] must end strictly at the next header line regardless of dotted-prefix overlap.
type HeaderKind = 'markdown' | 'table-toml' | 'table-flat' | 'keyvalue' | 'python'

/**
 * Split a heading spec into its base text and optional 1-based ordinal.
 *
 * `"Setup#2"` → `{ base: "Setup", ordinal: 2 }`; `"Setup"` → `{ base: "Setup",
 * ordinal: null }`. Only a trailing `#<digits>` is treated as an ordinal so a
 * heading that legitimately contains `#` mid-text is left intact.
 */
function parseHeadingSpec(
  spec: string,
  headers?: readonly SectionHeader[],
): { base: string; ordinal: number | null } {
  const m = /^(.*?)#(\d+)$/.exec(spec)
  if (m !== null && m[1] !== undefined && m[2] !== undefined) {
    // A trailing #<digits> is normally an ordinal disambiguator (e.g. "Install#2"). But if a real heading text matches the full spec verbatim, the digits are part of the heading itself (e.g. "Issue #42") -- use the spec as-is rather than splitting off an ordinal.
    const specLower = spec.trim().toLowerCase()
    const isLiteralHeading = headers?.some((h) => h.heading.trim().toLowerCase() === specLower) ?? false
    if (isLiteralHeading) {
      return { base: spec.trim(), ordinal: null }
    }
    return { base: m[1].trim(), ordinal: Number.parseInt(m[2], 10) }
  }
  return { base: spec.trim(), ordinal: null }
}

/**
 * Normalise a heading string before comparison — "replacement" mode.
 *
 * Replaces em-dash (U+2014) and en-dash (U+2013) with a regular hyphen `-` so a
 * query typed with a hyphen matches a stored heading that uses a typographic dash.
 * Also strips trailing parentheticals and leading numeric prefixes.
 *
 * Apply to BOTH sides of the comparison.
 */
export function normalizeHeading(s: string): string {
  // Replace em-dash and en-dash with a regular hyphen
  let n = s.replace(/[—–]/g, '-')
  // Strip trailing parenthetical, e.g. " (June 2026)" or " (deprecated)"
  n = n.replace(/\s*\([^)]+\)\s*$/, '')
  // Strip leading numeric prefix, e.g. "5. " or "12. "
  n = n.replace(/^\d+\.\s+/, '')
  // Collapse runs of whitespace; trim
  return n.replace(/\s+/g, ' ').trim()
}

/**
 * Normalise a heading string — "subtitle strip" mode.
 *
 * Em-dash and en-dash often introduce a subtitle (`"Section Index — description"`).
 * This variant strips the dash and everything that follows so a bare prefix query
 * (`"Section Index"`) matches the full stored heading.
 *
 * Also strips trailing parentheticals and leading numeric prefixes.
 * Apply to BOTH sides of the comparison.
 */
function normalizeHeadingStrip(s: string): string {
  // Strip subtitle: everything from em-dash / en-dash onwards
  let n = s.replace(/\s*[—–].*$/, '')
  // Strip trailing parenthetical
  n = n.replace(/\s*\([^)]+\)\s*$/, '')
  // Strip leading numeric prefix
  n = n.replace(/^\d+\.\s+/, '')
  return n.replace(/\s+/g, ' ').trim()
}

// Minimum length for a query word to count in the widened suffix/word-subset match tier in
// resolveHeaderPos -- below this, short words like "a"/"of" would match almost any heading.
const MIN_WIDEN_WORD_LEN = 3

const MARKDOWN_HEADER_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
// TOML permits a trailing `# comment` after a table header, and INI files very commonly write `; comment` the same way; the trailing `(?:[#;].*)?` lets either follow the closing bracket(s) without treating the header line as anything other than a table header. Deliberately NOT fully unanchored to end-of-line (unlike the indexer's own regex) - this finder is also the unknown-language sniff fallback, so an unanchored match would let a markdown `[link](url)` be misread as a table header, which the comment-only relaxation avoids.
const TABLE_HEADER_RE = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:[#;].*)?$/
// A Python def/class header. Indentation = nesting; the name is the section key.
const PYTHON_HEADER_RE = /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/
// A generic `key = value` or `key:` block header at column zero. A bare URL on its own line (e.g. "https://example.com") must NOT match as a false "https" heading -- the colon there is a URL scheme separator immediately followed by "//", not a key/value split.
const KEYVALUE_HEADER_RE = /^([A-Za-z_][\w.-]*)\s*(?:=|:(?!\/\/))/
// Mirrors ENV_KEY_RE in languages/ini_idx.ts - .env/.envrc files commonly prefix an exported
// key with `export `, which the plain KEYVALUE_HEADER_RE above does not tolerate.
const ENV_KEYVALUE_HEADER_RE = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:(?!\/\/))/

/**
 * Locate every section header in `lines` for a markdown-style document.
 *
 * Level is the count of leading `#`. The header text is the trimmed remainder
 * with any trailing closing `#` run (ATX-closed headings) removed.
 *
 * Skips lines inside fenced code blocks so a `#`-comment line inside a fence
 * (common in shell snippets, e.g. `# install deps`) is not mistaken for a header
 * and does not truncate the enclosing section.
 */
function findMarkdownHeaders(lines: readonly string[]): SectionHeader[] {
  const headers: SectionHeader[] = []
  for (const [i, line] of eachUnfencedLine(lines)) {
    const m = MARKDOWN_HEADER_RE.exec(line)
    if (m === null || m[1] === undefined || m[2] === undefined) continue
    headers.push({ heading: m[2].trim(), level: m[1].length, index: i })
  }
  return headers
}

/**
 * Locate every TOML-table / INI-section header in `lines`.
 *
 * Tables are flat in document order: `[tool.ruff]` is a sibling of `[project]`,
 * not a child of it (the dot is part of the table name, not text nesting). So
 * every table is level 1 and a section ends at the very next table header. The
 * full dotted name is kept as the heading so `extractSection("tool.ruff")`
 * works.
 *
 * A TOML `"""`/`'''` multi-line string or a multi-line array can legally contain text that
 * looks like a `[section]` header (a description quoting example TOML, an array-of-arrays row
 * starting with `[`). Track the same open-delimiter/bracket-depth state the TOML indexer
 * (extractTomlSymbols in parser.ts) uses so a line inside one of those spans is never mistaken
 * for a real table header here while the indexer correctly skips it. The triple-quote tracking
 * is inert for INI, which has no such construct, but the bracket-array tracking is NOT inert
 * for INI - an INI value routinely contains a bare, net-unbalanced `[` (a stray bracket, a log
 * format string, a glob fragment) with no structural meaning, and applying TOML's array-depth
 * state machine to it would suppress every real `[section]` header that follows. `isToml` gates
 * that half of the state machine off for INI and the unknown-format sniff fallback.
 */
function findTableHeaders(lines: readonly string[], isToml: boolean): SectionHeader[] {
  const headers: SectionHeader[] = []
  let openDelim: string | null = null
  let arrayDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openDelim !== null) {
      const closeIdx = line.indexOf(openDelim)
      if (closeIdx === -1) continue
      const restStart = closeIdx + openDelim.length
      const m = TABLE_HEADER_RE.exec(line.slice(restStart))
      if (m !== null && m[1] !== undefined) headers.push({ heading: m[1].trim(), level: 1, index: i })
      openDelim = lineOpenDelimiterAfter(line, restStart)
      continue
    }

    if (isToml && arrayDepth > 0) {
      arrayDepth = Math.max(0, arrayDepth + tomlBracketDelta(line))
      continue
    }

    const m = TABLE_HEADER_RE.exec(line)
    if (m !== null && m[1] !== undefined) headers.push({ heading: m[1].trim(), level: 1, index: i })
    if (isToml) {
      openDelim = lineOpenDelimiterAfter(line, 0)
      if (openDelim === null) arrayDepth = Math.max(0, tomlBracketDelta(line))
    }
  }
  return headers
}

/**
 * Locate Python `def`/`class` headers, using indentation as nesting level.
 *
 * A top-level def/class is level 1; one indent step deeper is level 2, etc. Nesting is tracked
 * with a stack of indent widths (the same relative-comparison approach Python's own lexer uses
 * for blocks) rather than dividing the raw column count by a fixed 4-space unit - a fixed
 * divisor mis-levels every def/class in a 2-space or 3-space indented file (both indent widths
 * floor-divide to the SAME level as their enclosing class), which truncates the class's section
 * at its very first method instead of spanning the whole body. Tabs are normalised to 4 spaces
 * before comparison so a file mixing tabs and spaces at the same nesting depth still resolves
 * consistently.
 */
function findPythonHeaders(lines: readonly string[]): SectionHeader[] {
  const headers: SectionHeader[] = []
  const indentStack: number[] = []
  // Tracks a `"""`/`'''` triple-quoted string left open across lines, shared with the toml table finder's state machine (lineOpenDelimiterAfter, in parser.ts) so a `def`/`class` line that lives entirely inside a docstring/template string body is not mistaken for a real header - matching what the tree-sitter Python indexer already sees, since a string node never yields symbols.
  let openDelim: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    if (openDelim !== null) {
      const closeIdx = line.indexOf(openDelim)
      if (closeIdx === -1) continue
      openDelim = lineOpenDelimiterAfter(line, closeIdx + openDelim.length)
      continue
    }
    const m = PYTHON_HEADER_RE.exec(line)
    if (m === null || m[1] === undefined || m[2] === undefined) {
      openDelim = lineOpenDelimiterAfter(line, 0)
      continue
    }
    const indent = m[1].replace(/\t/g, '    ').length
    while (indentStack.length > 0 && indent <= (indentStack[indentStack.length - 1] ?? -1)) {
      indentStack.pop()
    }
    const level = indentStack.length + 1
    indentStack.push(indent)
    headers.push({ heading: m[2], level, index: i })
    openDelim = lineOpenDelimiterAfter(line, 0)
  }
  return headers
}

/**
 * Locate generic `key = value` / `key:` block headers at column zero.
 *
 * A quoted value can wrap across multiple physical lines (YAML folds an embedded newline into
 * a space; .env values can do the same). Without tracking an open quote across lines, a
 * continuation line that happens to itself look like `word:`/`word=` (wrapped prose, an
 * embedded "ratio: 16:9", part of a multi-line cert/PEM block, etc.) was read as a brand new
 * top-level key, fragmenting the real section and producing phantom ones. Reuses the same
 * quote-tracking helpers the yaml and .env indexers already use (extractYamlSymbols in
 * parser.ts, extractEnv in ini_idx.ts) so the live reader and the index stay consistent.
 */
function findKeyValueHeaders(lines: readonly string[], language: string): SectionHeader[] {
  const headers: SectionHeader[] = []
  const isEnv = language === 'env_file'
  let openQuote: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openQuote !== null) {
      const closed = isEnv
        ? envLineClosesQuote(line, openQuote)
        : yamlLineClosesQuote(line, openQuote as '"' | "'")
      if (closed) openQuote = null
      continue
    }

    const m = (isEnv ? ENV_KEYVALUE_HEADER_RE : KEYVALUE_HEADER_RE).exec(line)
    if (m === null || m[1] === undefined) continue
    headers.push({ heading: m[1], level: 1, index: i })
    openQuote = isEnv
      ? envDetectOpenQuote(line.slice(m[0].length))
      : yamlOpenQuoteAfter(line, m[0].length)
  }
  return headers
}

// Uses the same masked, dotall, whole-text heading scan (findHtmlHeadingMatches, in src/languages/common.ts) that the indexer's html.ts/liquid.ts extractors use, so a heading indexed as a symbol is always reachable via the live `section` command and vice versa: a heading formatted across multiple lines is found here too, and a commented-out (or <script>-body / CDATA) heading is excluded here too, instead of two regex implementations that can silently drift apart.
function findHtmlHeaders(text: string): SectionHeader[] {
  const lineIndex = buildLineIndex(text)
  const headers: SectionHeader[] = []
  for (const hm of findHtmlHeadingMatches(text)) {
    if (!hm.heading) continue
    const index = offsetToLine(lineIndex, hm.offset) - 1
    headers.push({ heading: hm.heading, level: hm.level, index })
  }
  return headers
}

/**
 * Choose the right header finder for `text` given a language hint.
 *
 * Markdown and table/INI are detected by their characteristic header lines even
 * when the language hint is `unknown` (so a raw `.txt` of TOML still parses).
 * Python uses the def/class finder; everything else falls back to key-value.
 *
 * Returns both the headers and the kind of finder that produced them so
 * termination rules can be tuned per kind (e.g. table headers use prefix-based
 * termination instead of level-based).
 */
function findHeaders(text: string, language: string): { headers: SectionHeader[]; kind: HeaderKind } {
  const lines = text.split('\n')

  if (language === 'markdown') return { headers: findMarkdownHeaders(lines), kind: 'markdown' }
  if (language === 'html' || language === 'liquid') return { headers: findHtmlHeaders(text), kind: 'markdown' }
  if (language === 'toml') return { headers: findTableHeaders(lines, true), kind: 'table-toml' }
  if (language === 'python') return { headers: findPythonHeaders(lines), kind: 'python' }
  // INI groups under [section] headers like TOML; route to the table finder so a leading `#`/`;` comment line is not mistaken for a markdown heading. Unlike TOML, a `.` in an INI section name is never a nesting operator (see the HeaderKind doc comment above), so this is 'table-flat', not 'table-toml'.
  if (language === 'ini') return { headers: findTableHeaders(lines, false), kind: 'table-flat' }
  // YAML and .env are key/value; their `#` comment lines must not be sniffed as markdown headings (which would hide every real key), so route explicitly.
  if (language === 'yaml' || language === 'env_file')
    return { headers: findKeyValueHeaders(lines, language), kind: 'keyvalue' }

  // Unknown / other: sniff. Prefer markdown headings, then tables, then a key-value fallback so generic config files still yield sections.
  const md = findMarkdownHeaders(lines)
  if (md.length > 0) return { headers: md, kind: 'markdown' }
  // The sniffer cannot tell TOML from INI syntactically (both use bare `[header]` lines) when there is no file extension to consult, so it keeps the pre-existing dotted-nesting behavior here for the ambiguous case - only the language==='ini' branch above, where the file extension makes the language unambiguous, uses the flat (non-nesting) kind.
  // isToml=false is a deliberate, known-imperfect choice for this ambiguous case: it disables findTableHeaders' TOML multi-line-array/triple-quote-string tracking, so an extension-less TOML-flavored file CAN misread a `[section]`-looking line quoted inside a triple-quoted string as a real header. isToml=true would fix that, but was rejected - it reintroduces the regressions the two "does not let a stray, net-unbalanced ..." tests below (in section_reader.test.ts) exist to prevent, where an ordinary INI value containing an unbalanced `[` or a triple-quote-length run gets misread as opening a multi-line TOML construct and silently swallows every following line, including a real `[section]` header. A single isToml boolean can't serve both flavors of ambiguous file at once; INI-style files were prioritized here because they already had regression coverage. Fixing the TOML-flavored case would need a smarter per-file heuristic, not a flag flip - left as a known limitation rather than resolved unilaterally.
  const tbl = findTableHeaders(lines, false)
  if (tbl.length > 0) return { headers: tbl, kind: 'table-toml' }
  return { headers: findKeyValueHeaders(lines, language), kind: 'keyvalue' }
}

/**
 * Resolve a header's end line: the line before the next header at the same or
 * a shallower level, or end-of-file when none follows.
 *
 * Returns a 0-based exclusive end index (the line *after* the section's last
 * content line), which the caller converts to a 1-based inclusive end.
 */
function sectionEndIndex(
  headers: readonly SectionHeader[],
  headerPos: number,
  totalLines: number,
): number {
  const current = headers[headerPos]
  if (current === undefined) return totalLines
  for (let j = headerPos + 1; j < headers.length; j++) {
    const next = headers[j]
    if (next === undefined) continue
    if (next.level <= current.level) return next.index
  }
  return totalLines
}

/**
 * Resolve a TOML table section's end line by dotted-name nesting rather than a
 * numeric level. A later table ends the section unless it is a strict
 * descendant — its dotted name begins with `<current>.` — so `[tool.ruff]`
 * absorbs `[tool.ruff.lint]` but stops at a sibling like `[tool.mypy]` or a
 * different root like `[project]`. Returns a 0-based exclusive end index.
 */
function tableSectionEndIndex(
  headers: readonly SectionHeader[],
  headerPos: number,
  totalLines: number,
): number {
  const current = headers[headerPos]
  if (current === undefined) return totalLines
  const prefix = current.heading + '.'
  for (let j = headerPos + 1; j < headers.length; j++) {
    const next = headers[j]
    if (next === undefined) continue
    if (next.heading.startsWith(prefix)) continue
    return next.index
  }
  return totalLines
}

/**
 * Resolve a heading spec to a header index. Tries exact / normalized / stripped
 * equality first; on a miss with no ordinal, falls back to a unique
 * normalized-prefix match (e.g. `"Business"` resolves a lone `"Business / logic"`)
 * and reports the original query via `redirectedFrom`. Returns null when nothing
 * resolves or a prefix is ambiguous across distinct headings.
 */
function resolveHeaderPos(
  headers: readonly SectionHeader[],
  base: string,
  ordinal: number | null,
): { headerPos: number; redirectedFrom: string | null; occurrences: number[] | null } | null {
  const target = base.toLowerCase()
  const normalizedTarget = normalizeHeading(base).toLowerCase()
  const strippedTarget = normalizeHeadingStrip(base).toLowerCase()
  // Tiered matching: exact equality wins over normalized equality, which wins over stripped equality. Sibling headings that only differ by a parenthetical or subtitle (e.g. "Setup (Windows)" / "Setup (Linux)") both normalize to the same text, so an exact-text query must never fall back to an earlier normalized-tier match — each header is assigned to the single best tier it qualifies for.
  const exactMatches: number[] = []
  const normalizedMatches: number[] = []
  const strippedMatches: number[] = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h === undefined) continue
    const headingLower = h.heading.toLowerCase()
    if (headingLower === target) {
      exactMatches.push(i)
    } else if (normalizeHeading(h.heading).toLowerCase() === normalizedTarget) {
      normalizedMatches.push(i)
    } else if (normalizeHeadingStrip(h.heading).toLowerCase() === strippedTarget) {
      strippedMatches.push(i)
    }
  }
  const matches =
    exactMatches.length > 0 ? exactMatches : normalizedMatches.length > 0 ? normalizedMatches : strippedMatches
  if (matches.length > 0) {
    const pick = ordinal === null ? 0 : ordinal - 1
    const headerPos = matches[pick]
    if (headerPos === undefined) return null
    // Report the ambiguity only when the caller did NOT already disambiguate. A spec carrying an
    // ordinal has picked its occurrence deliberately and must stay a plain, silent hit.
    let occurrences: number[] | null = null
    if (ordinal === null && matches.length > 1) {
      occurrences = []
      for (const i of matches) {
        const h = headers[i]
        if (h !== undefined) occurrences.push(h.index + 1)
      }
    }
    return { headerPos, redirectedFrom: null, occurrences }
  }
  // No exact match. Fall back to an unambiguous normalized-prefix match so a slash/ampersand subtitle (which the strip-normalizer doesn't cover) still resolves. An ordinal implies the caller already knows the exact text, so skip the fallback there.
  if (ordinal !== null || normalizedTarget.length === 0) return null
  let prefixPos = -1
  const distinct = new Set<string>()
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h === undefined) continue
    const norm = normalizeHeading(h.heading).toLowerCase()
    if (norm.startsWith(normalizedTarget)) {
      distinct.add(norm)
      if (prefixPos === -1) prefixPos = i
    }
  }
  if (distinct.size === 1 && prefixPos !== -1) {
    const chosen = headers[prefixPos]
    if (chosen === undefined) return null
    return { headerPos: prefixPos, redirectedFrom: base, occurrences: null }
  }
  // Still no match. Last-resort tier: a distinctive suffix or word-subset query, e.g. "Setup"
  // for "Installation and Setup", or "Config Options" for "Configuration Options". Every
  // normalized query word must be a substring (either direction) of some word in the heading.
  // Reached only once exact/normalized/stripped/prefix have all missed, so it can never divert
  // an exact-text query away from its own heading. Ambiguous across 2+ distinct headings is
  // still refused, same as the prefix tier above -- the caller reports a miss and lets the
  // (filtered) "did you mean" suggestions surface the candidates instead of guessing.
  const queryWords = normalizedTarget.split(/\s+/).filter((w) => w.length >= MIN_WIDEN_WORD_LEN)
  if (queryWords.length === 0) return null
  const widenedMatches: number[] = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h === undefined) continue
    const headingWords = normalizeHeading(h.heading).toLowerCase().split(/\s+/)
    // Forward containment only (heading word contains the query word, not the reverse) -- a
    // reverse check would let a short heading word like "title" match an unrelated longer
    // query word that merely happens to contain it (e.g. "subtitle" contains "title").
    const allWordsMatch = queryWords.every((qw) => headingWords.some((hw) => hw.includes(qw)))
    if (allWordsMatch) widenedMatches.push(i)
  }
  if (widenedMatches.length !== 1) return null
  const widenedPos = widenedMatches[0]
  if (widenedPos === undefined) return null
  return { headerPos: widenedPos, redirectedFrom: base, occurrences: null }
}

/**
 * Build a SectionResult for a resolved header: compute the section's end line,
 * trim a single trailing blank, and slice the body. `redirectedFrom`, when set,
 * is the original query text the spec resolved to via a prefix redirect.
 */
function buildSectionResult(
  headers: readonly SectionHeader[],
  kind: HeaderKind,
  lines: readonly string[],
  headerPos: number,
  redirectedFrom: string | null,
): SectionResult | null {
  const header = headers[headerPos]
  if (header === undefined) return null
  const endIndex =
    kind === 'table-toml'
      ? tableSectionEndIndex(headers, headerPos, lines.length)
      : sectionEndIndex(headers, headerPos, lines.length)
  // Trim a single trailing blank line so adjacent sections don't accrue the separator line into the earlier section's body.
  let endExclusive = endIndex
  while (
    endExclusive > header.index + 1 &&
    (lines[endExclusive - 1] === '' || lines[endExclusive - 1] === '\r')
  ) {
    endExclusive--
  }
  const content = lines.slice(header.index, endExclusive).join('\n')
  const result: SectionResult = {
    heading: header.heading,
    content,
    lineStart: header.index + 1,
    lineEnd: endExclusive,
  }
  return redirectedFrom === null ? result : { ...result, redirectedFrom }
}

/**
 * Extract a named section from `text`. Returns `null` when not found.
 *
 * `headingSpec` is the section name, optionally suffixed with `#N` to select the
 * Nth (1-based) occurrence among headers sharing that name. Matching is
 * case-insensitive on the trimmed heading text. Without an ordinal the first
 * occurrence by line order is returned.
 */
/** Shared by {@link extractSection}/{@link readSection}: resolve `headingSpec` against
 * `text`'s header structure (parsed for `language`) and build the section result. */
function resolveSectionFromText(text: string, headingSpec: string, language: string): SectionResult | null {
  const { headers, kind } = findHeaders(text, language)
  const { base, ordinal } = parseHeadingSpec(headingSpec, headers)
  if (base.length === 0) return null

  const lines = text.split('\n')

  const resolved = resolveHeaderPos(headers, base, ordinal)
  if (resolved === null) return null
  const built = buildSectionResult(headers, kind, lines, resolved.headerPos, resolved.redirectedFrom)
  if (built === null || resolved.occurrences === null) return built
  return { ...built, occurrences: resolved.occurrences }
}

export function extractSection(text: string, headingSpec: string): SectionResult | null {
  // Language is unknown here (we only have text); the sniffer handles it.
  return resolveSectionFromText(text, headingSpec, 'unknown')
}

/**
 * Read a section from a file on disk. Returns `null` when the file cannot be
 * read or the section is not found.
 *
 * The file's language is detected from its path so the correct header parser is
 * used (e.g. a `.py` file uses the Python def/class finder rather than the
 * markdown sniffer).
 */
// `readFn`, when supplied, replaces the raw `readFileSync` below -- callers that hold a pin
// verified by `confineTargets` (see src/mcp_server.ts) pass the pin-aware `readFileText` from
// read_commands.ts so a section read re-verifies file identity instead of trusting the path a
// second time. Threading a function rather than importing `readFileText` directly avoids a
// circular import (read_commands.ts already imports this module), and CLI callers that omit it
// keep the pre-existing plain-`fs` behavior byte-for-byte.
function readTextForSections(filePath: string, readFn?: (p: string) => string | null): string | null {
  let text: string
  if (readFn !== undefined) {
    const read = readFn(filePath)
    if (read === null) return null
    text = read
  } else {
    try {
      // decodeSource, not a utf-8 read: a UTF-16 file has no headings at all once its bytes are
      // read as UTF-8, so `section --list` on a PowerShell-written document answered "No sections
      // found" for a document full of them.
      text = decodeSource(readFileSync(filePath))
    } catch {
      return null
    }
  }

  // Strip UTF-8 BOM if present (U+FEFF); some editors save files with this prefix
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  // A dotenv section is its key and its value, and the value is the secret. Applied here rather
  // than only in the readFn branch so the plain CLI path (`token-goat section ".env::API_KEY"`,
  // which passes no readFn) is covered too. Redacting after the BOM strip keeps both transforms
  // in one place and line-for-line. See dotenv_redact.ts.
  return redactIfDotenv(filePath, text)
}

export function readSection(
  filePath: string,
  headingSpec: string,
  readFn?: (p: string) => string | null,
): SectionResult | null {
  const text = readTextForSections(filePath, readFn)
  if (text === null) return null

  return resolveSectionFromText(text, headingSpec, detectLanguage(filePath))
}

// Finds the tightest (innermost) heading section whose line range contains a symbol's [lineStart, lineEnd] (1-based, inclusive) -- mirrors enclosingSymbol's containment/tie-break approach in graph_commands.ts, but over heading ranges instead of symbol ranges. Returns null when the file has no heading structure enclosing the symbol, which is the common case for source files without markdown-style doc comments.
export function findContainingSection(
  filePath: string,
  lineStart: number,
  lineEnd: number,
  readFn?: (p: string) => string | null,
): SectionResult | null {
  const text = readTextForSections(filePath, readFn)
  if (text === null) return null

  const language = detectLanguage(filePath)
  const { headers, kind } = findHeaders(text, language)
  if (headers.length === 0) return null

  const lines = text.split('\n')

  let bestPos = -1
  let bestHeaderLine = -1
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    if (header === undefined) continue
    const endIndex =
      kind === 'table-toml' ? tableSectionEndIndex(headers, i, lines.length) : sectionEndIndex(headers, i, lines.length)
    const sectionLineStart = header.index + 1
    if (sectionLineStart <= lineStart && lineEnd <= endIndex) {
      if (header.index > bestHeaderLine) {
        bestHeaderLine = header.index
        bestPos = i
      }
    }
  }

  if (bestPos === -1) return null
  return buildSectionResult(headers, kind, lines, bestPos, null)
}

/**
 * List every section heading in a file at all nesting levels, in document order.
 *
 * Returns an empty array when the file cannot be read or has no recognisable
 * sections.
 */
export function listSections(filePath: string, readFn?: (p: string) => string | null): string[] {
  const text = readTextForSections(filePath, readFn)
  if (text === null) return []

  const language = detectLanguage(filePath)
  const { headers } = findHeaders(text, language)
  return headers.map((h) => h.heading)
}
