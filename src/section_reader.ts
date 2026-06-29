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

import { detectLanguage } from './parser_types.js'

/** One extracted section: its header text, body, and 1-based line span. */
export interface SectionResult {
  readonly heading: string
  readonly content: string
  readonly lineStart: number
  readonly lineEnd: number
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
type HeaderKind = 'markdown' | 'table' | 'keyvalue' | 'python'

/**
 * Split a heading spec into its base text and optional 1-based ordinal.
 *
 * `"Setup#2"` → `{ base: "Setup", ordinal: 2 }`; `"Setup"` → `{ base: "Setup",
 * ordinal: null }`. Only a trailing `#<digits>` is treated as an ordinal so a
 * heading that legitimately contains `#` mid-text is left intact.
 */
function parseHeadingSpec(spec: string): { base: string; ordinal: number | null } {
  const m = /^(.*?)#(\d+)$/.exec(spec)
  if (m !== null && m[1] !== undefined && m[2] !== undefined) {
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

const MARKDOWN_HEADER_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
const TABLE_HEADER_RE = /^\s*\[+\s*([^\]]+?)\s*\]+\s*$/
// A Python def/class header. Indentation = nesting; the name is the section key.
const PYTHON_HEADER_RE = /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/
// A generic `key = value` or `key:` block header at column zero.
const KEYVALUE_HEADER_RE = /^([A-Za-z_][\w.-]*)\s*(?:=|:)/

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
  // Track fenced-code-block state. `fence` holds the marker char (backtick or
  // tilde) while inside a block; a fence closes only on the same marker char
  // so a ``` block isn't closed by a ~~~ line.
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const fm = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fm !== null && fm[1] !== undefined) {
      const ch = fm[1][0] ?? null
      if (fence === null) fence = ch
      else if (fence === ch) fence = null
      continue
    }
    if (fence !== null) continue
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
 */
function findTableHeaders(lines: readonly string[]): SectionHeader[] {
  const headers: SectionHeader[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = TABLE_HEADER_RE.exec(line)
    if (m === null || m[1] === undefined) continue
    headers.push({ heading: m[1].trim(), level: 1, index: i })
  }
  return headers
}

/**
 * Locate Python `def`/`class` headers, using indentation as nesting level.
 *
 * A top-level def/class is level 1; one indent step deeper is level 2, etc.
 * Indentation width is normalised in 4-space units (tabs counted as one step)
 * so a method inside a class nests one level below it.
 */
function findPythonHeaders(lines: readonly string[]): SectionHeader[] {
  const headers: SectionHeader[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = PYTHON_HEADER_RE.exec(line)
    if (m === null || m[1] === undefined || m[2] === undefined) continue
    const indent = m[1].replace(/\t/g, '    ').length
    const level = Math.floor(indent / 4) + 1
    headers.push({ heading: m[2], level, index: i })
  }
  return headers
}

/** Locate generic `key = value` / `key:` block headers at column zero. */
function findKeyValueHeaders(lines: readonly string[]): SectionHeader[] {
  const headers: SectionHeader[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = KEYVALUE_HEADER_RE.exec(line)
    if (m === null || m[1] === undefined) continue
    headers.push({ heading: m[1], level: 1, index: i })
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
  if (language === 'toml') return { headers: findTableHeaders(lines), kind: 'table' }
  if (language === 'python') return { headers: findPythonHeaders(lines), kind: 'python' }
  // INI groups under [section] headers like TOML; route to the table finder so a
  // leading `#`/`;` comment line is not mistaken for a markdown heading.
  if (language === 'ini') return { headers: findTableHeaders(lines), kind: 'table' }
  // YAML and .env are key/value; their `#` comment lines must not be sniffed as
  // markdown headings (which would hide every real key), so route explicitly.
  if (language === 'yaml' || language === 'env_file')
    return { headers: findKeyValueHeaders(lines), kind: 'keyvalue' }

  // Unknown / other: sniff. Prefer markdown headings, then tables, then a
  // key-value fallback so generic config files still yield sections.
  const md = findMarkdownHeaders(lines)
  if (md.length > 0) return { headers: md, kind: 'markdown' }
  const tbl = findTableHeaders(lines)
  if (tbl.length > 0) return { headers: tbl, kind: 'table' }
  return { headers: findKeyValueHeaders(lines), kind: 'keyvalue' }
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
 * Extract a named section from `text`. Returns `null` when not found.
 *
 * `headingSpec` is the section name, optionally suffixed with `#N` to select the
 * Nth (1-based) occurrence among headers sharing that name. Matching is
 * case-insensitive on the trimmed heading text. Without an ordinal the first
 * occurrence by line order is returned.
 */
export function extractSection(text: string, headingSpec: string): SectionResult | null {
  const { base, ordinal } = parseHeadingSpec(headingSpec)
  if (base.length === 0) return null

  // Language is unknown here (we only have text); the sniffer handles it.
  const { headers, kind } = findHeaders(text, 'unknown')
  const lines = text.split('\n')

  const target = base.toLowerCase()
  const normalizedTarget = normalizeHeading(base).toLowerCase()
  const strippedTarget = normalizeHeadingStrip(base).toLowerCase()
  const matches: number[] = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h === undefined) continue
    if (
      h.heading.toLowerCase() === target ||
      normalizeHeading(h.heading).toLowerCase() === normalizedTarget ||
      normalizeHeadingStrip(h.heading).toLowerCase() === strippedTarget
    ) {
      matches.push(i)
    }
  }
  if (matches.length === 0) return null

  const pick = ordinal === null ? 0 : ordinal - 1
  const headerPos = matches[pick]
  if (headerPos === undefined) return null

  const header = headers[headerPos]
  if (header === undefined) return null

  const endIndex =
    kind === 'table'
      ? tableSectionEndIndex(headers, headerPos, lines.length)
      : sectionEndIndex(headers, headerPos, lines.length)
  // Trim a single trailing blank line so adjacent sections don't accrue the
  // separator line into the earlier section's body.
  let endExclusive = endIndex
  while (endExclusive > header.index + 1 && lines[endExclusive - 1] === '') {
    endExclusive--
  }

  const content = lines.slice(header.index, endExclusive).join('\n')
  return {
    heading: header.heading,
    content,
    lineStart: header.index + 1,
    lineEnd: endExclusive,
  }
}

/**
 * Read a section from a file on disk. Returns `null` when the file cannot be
 * read or the section is not found.
 *
 * The file's language is detected from its path so the correct header parser is
 * used (e.g. a `.py` file uses the Python def/class finder rather than the
 * markdown sniffer).
 */
export function readSection(filePath: string, headingSpec: string): SectionResult | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const { base, ordinal } = parseHeadingSpec(headingSpec)
  if (base.length === 0) return null

  const language = detectLanguage(filePath)
  const { headers, kind } = findHeaders(text, language)
  const lines = text.split('\n')

  const target = base.toLowerCase()
  const normalizedTarget = normalizeHeading(base).toLowerCase()
  const strippedTarget = normalizeHeadingStrip(base).toLowerCase()
  const matches: number[] = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h === undefined) continue
    if (
      h.heading.toLowerCase() === target ||
      normalizeHeading(h.heading).toLowerCase() === normalizedTarget ||
      normalizeHeadingStrip(h.heading).toLowerCase() === strippedTarget
    ) {
      matches.push(i)
    }
  }
  if (matches.length === 0) return null

  const pick = ordinal === null ? 0 : ordinal - 1
  const headerPos = matches[pick]
  if (headerPos === undefined) return null

  const header = headers[headerPos]
  if (header === undefined) return null

  const endIndex =
    kind === 'table'
      ? tableSectionEndIndex(headers, headerPos, lines.length)
      : sectionEndIndex(headers, headerPos, lines.length)
  let endExclusive = endIndex
  while (endExclusive > header.index + 1 && lines[endExclusive - 1] === '') {
    endExclusive--
  }

  const content = lines.slice(header.index, endExclusive).join('\n')
  return {
    heading: header.heading,
    content,
    lineStart: header.index + 1,
    lineEnd: endExclusive,
  }
}

/**
 * List every top-level (level-1) section name in a file, in document order.
 *
 * Returns an empty array when the file cannot be read or has no recognisable
 * sections. "Top-level" means the shallowest level present among headers, so a
 * doc whose headings start at `##` still lists those.
 */
export function listSections(filePath: string): string[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const language = detectLanguage(filePath)
  const { headers } = findHeaders(text, language)
  if (headers.length === 0) return []

  let minLevel = Number.POSITIVE_INFINITY
  for (const h of headers) {
    if (h.level < minLevel) minLevel = h.level
  }

  return headers.filter((h) => h.level === minLevel).map((h) => h.heading)
}

/**
 * List every section heading in a file at all nesting levels, in document order.
 *
 * Returns an empty array when the file cannot be read or has no recognisable
 * sections. Unlike `listSections`, this includes all levels (## and ### etc.),
 * so the caller can show the complete heading inventory when a lookup misses.
 */
export function listAllSections(filePath: string): string[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const language = detectLanguage(filePath)
  const { headers } = findHeaders(text, language)
  return headers.map((h) => h.heading)
}
