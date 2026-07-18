/**
 * Single-File-Component extractor for Vue (`.vue`), Svelte (`.svelte`), and Astro (`.astro`).
 *
 * None of these three have a maintained tree-sitter grammar as an npm dependency in this
 * project, so this is a pure-regex adapter -- the same convention every other non-tree-sitter
 * language here follows (see terraform_idx.ts, html.ts). The three formats share enough
 * structure (a script-ish block of top-level JS/TS declarations + a markup region that may
 * reference other components) that they share block-extraction and declaration-extraction
 * helpers below, parameterized per format.
 *
 * Symbol kinds emitted (shared across all three formats for consistency -- see task discussion,
 * "your call, but be consistent and document the choice"):
 *   `vue_component` / `svelte_component` / `astro_component` -- one per file, the whole-file
 *     span, named after the file's basename without extension. This is what makes
 *     `token-goat symbol MyComponent` findable at all for these files.
 *   `sfc_script_function` / `sfc_script_const` / `sfc_script_class` -- top-level declarations
 *     found directly in the script block (Vue/Svelte) or frontmatter fence (Astro). Shared kind
 *     names across all three formats rather than per-format kinds, since the declarations mean
 *     the same thing regardless of which SFC format they're declared in.
 *
 * Refs (not symbols): a `RefEntry` per template-level custom-element/component-tag reference
 * (PascalCase for all three; additionally kebab-case-with-a-hyphen for Vue/Svelte, which both
 * support that authoring convention). Plain lowercase HTML tags with no hyphen are never
 * treated as component references.
 *
 * Known simplifications (documented, not accidental -- proportionate scope per the task):
 *   - Block extraction (`<script>`/`<template>`/`<style>`) is a non-greedy regex match to the
 *     FIRST matching close tag, not a real tag-depth counter. A `<template>` containing a
 *     nested, literal `<template>`/`</template>` pair (rare -- scoped-slot templates use
 *     `<template v-slot>`, not a second top-level `<template>` element) would mis-detect the
 *     block boundary. Mirrors the level of block-extraction simplicity already accepted
 *     elsewhere in this codebase (e.g. `maskHtmlNoise`'s `<script>` body regex).
 *   - Top-level declaration detection uses a per-line, string-literal-aware brace counter
 *     (`stripStringLiterals`, single-line only) to know when it's back at depth 0, not a real
 *     parser. A brace character inside a multi-line template literal is not tracked correctly
 *     (a known limitation `stripStringLiterals` itself carries, since it operates one line at a
 *     time); this can only ever under- or over-count depth inside a script block, never touch
 *     ref extraction or the whole-file component symbol.
 */

import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import {
  buildLineIndex,
  makeLineSymbol,
  offsetToLine,
  stripStringLiterals,
  stripXmlComments,
} from './common.js'

export interface SfcResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
}

const MAX_SYMBOLS = 500

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function finalize(symbols: SymbolEntry[], refs: RefEntry[]): SfcResult {
  return {
    symbols: dedupe(symbols, (s) => `${s.name}\0${s.kind}\0${s.lineStart}`).slice(0, MAX_SYMBOLS),
    refs: dedupe(refs, (r) => `${r.filePath}\0${r.name}\0${r.line}\0${r.col}`),
  }
}

function componentName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  return path.posix.basename(normalized).replace(/\.[^.]+$/, '')
}

function matchLine(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function lineContext(content: string, line: number): string {
  return content.split('\n')[line - 1]?.trim() ?? ''
}

/**
 * Blanks `//` and `/* *\/` JS/TS comments in a single linear scan, leaving quoted-string and
 * backtick template-literal spans untouched -- same algorithm as
 * `salesforce_frontend.ts`'s `stripJsComments` (duplicated here rather than imported: it is not
 * currently exported from that module, and this adapter's `MAX_SYMBOLS`/dedupe/result-shape
 * conventions already diverge enough from the LWC adapter that sharing just this one function
 * across a module boundary wasn't worth the coupling). Any future change to the algorithm in one
 * copy should be mirrored in the other.
 */
function stripJsComments(content: string): string {
  let out = ''
  let i = 0
  const n = content.length
  while (i < n) {
    const ch = content[i]
    if (ch === '/' && content[i + 1] === '/') {
      let j = i
      while (j < n && content[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(content[j] === '*' && content[j + 1] === '/')) j++
      const end = j < n ? j + 2 : n
      out += content.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (content[j] === '\\' && j + 1 < n) {
          j += 2
          continue
        }
        if (content[j] === quote) {
          j++
          break
        }
        if (quote !== '`' && content[j] === '\n') {
          j++
          break
        }
        j++
      }
      out += content.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

// Top-level (depth-0) declaration matchers. Only genuinely top-level `function`/`const`/`class`
// declarations, optionally `export`ed/`default`-exported -- no attempt at Vue Options API
// (`methods: { ... }`) member extraction, per task scope.
const FUNC_DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/
const CONST_DECL_RE = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/
const CLASS_DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/

function extractTopLevelDeclarations(
  scriptContent: string,
  filePath: string,
  startLine: number,
): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const commentFree = stripJsComments(scriptContent)
  const lines = commentFree.split('\n')
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const trimmed = rawLine.trimStart()
    if (depth === 0 && trimmed) {
      const line = startLine + i
      const fm = FUNC_DECL_RE.exec(trimmed)
      if (fm?.[1]) {
        symbols.push(makeLineSymbol(filePath, fm[1], 'sfc_script_function', line))
      } else {
        const cm = CONST_DECL_RE.exec(trimmed)
        if (cm?.[1]) {
          symbols.push(makeLineSymbol(filePath, cm[1], 'sfc_script_const', line))
        } else {
          const clm = CLASS_DECL_RE.exec(trimmed)
          if (clm?.[1]) symbols.push(makeLineSymbol(filePath, clm[1], 'sfc_script_class', line))
        }
      }
    }
    const braceLine = stripStringLiterals(rawLine)
    depth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
  }
  return symbols
}

// PascalCase tags are treated as component refs for all three formats; kebab-case-with-a-hyphen
// tags additionally count for Vue/Svelte (both support that authoring convention). A plain
// lowercase tag with no hyphen (`<div>`, `<button>`) is never a component reference.
const OPEN_TAG_RE = /<\s*([A-Za-z][\w.:-]*)\b/g

function isComponentTag(tag: string, allowKebab: boolean): boolean {
  if (/^[A-Z]/.test(tag)) return true
  if (allowKebab && /^[a-z][\w.:]*-/.test(tag)) return true
  return false
}

function extractComponentRefs(
  markup: string,
  filePath: string,
  startLine: number,
  allowKebab: boolean,
): RefEntry[] {
  const refs: RefEntry[] = []
  for (const m of markup.matchAll(OPEN_TAG_RE)) {
    const tag = m[1] ?? ''
    if (!tag || !isComponentTag(tag, allowKebab)) continue
    const offset = m.index ?? 0
    const relLine = matchLine(markup, offset)
    const line = startLine - 1 + relLine
    refs.push({ filePath, name: tag, line, col: 0, context: lineContext(markup, relLine) })
  }
  return refs
}

/** One `<tag ...>...</tag>` block found by {@link extractTagBlocks}. */
interface TagBlock {
  readonly content: string
  /** 1-indexed line of the first character after the opening tag's `>`. */
  readonly contentStartLine: number
  /** Offset of the full match's start/end in the original (unmasked) content, for masking. */
  readonly matchStart: number
  readonly matchEnd: number
}

/**
 * Finds every top-level `<tag ...>...</tag>` block for a fixed tag name (`script`/`style`/
 * `template`; no regex metacharacters, safe to interpolate). Non-greedy to the first matching
 * close tag -- see the "known simplifications" module doc comment for why that's an accepted
 * limitation here. `lineIndex` must be built from the same `content` this runs against so
 * `contentStartLine` lines up.
 */
function extractTagBlocks(content: string, lineIndex: readonly number[], tag: string): TagBlock[] {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')
  const blocks: TagBlock[] = []
  for (const m of content.matchAll(re)) {
    const matchStart = m.index ?? 0
    const attrs = m[1] ?? ''
    const inner = m[2] ?? ''
    const openTagLen = 1 + tag.length + attrs.length + 1
    blocks.push({
      content: inner,
      contentStartLine: offsetToLine(lineIndex, matchStart + openTagLen),
      matchStart,
      matchEnd: matchStart + m[0].length,
    })
  }
  return blocks
}

/**
 * Blanks the given `[start, end)` offset spans in `content` to spaces (newlines kept in place),
 * so subsequent line-number math against the result stays valid -- same masking discipline as
 * `maskHtmlNoise`/`maskHeredocs`, generalized to arbitrary offset spans instead of a fixed regex.
 */
function maskSpans(content: string, spans: ReadonlyArray<readonly [number, number]>): string {
  const chars = content.split('')
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

function componentSymbol(filePath: string, name: string, kind: string, totalLines: number): SymbolEntry {
  return { filePath, name, kind, lineStart: 1, lineEnd: totalLines, body: '', docstring: '' }
}

// ---------------------------------------------------------------------------
// Vue (.vue)
// ---------------------------------------------------------------------------

/**
 * Vue SFC: explicit `<script>`/`<script setup>` block(s), explicit `<template>` block, and
 * explicit `<style>` block(s) (ignored here beyond not scanning them -- they're simply never
 * visited since only `<script>`/`<template>` blocks are extracted by name).
 */
export function extractVue(content: string, filePath: string): SfcResult {
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(content)
  const name = componentName(filePath)
  const symbols: SymbolEntry[] = [componentSymbol(filePath, name, 'vue_component', totalLines)]
  const refs: RefEntry[] = []

  for (const block of extractTagBlocks(content, lineIndex, 'script')) {
    symbols.push(...extractTopLevelDeclarations(block.content, filePath, block.contentStartLine))
  }

  for (const block of extractTagBlocks(content, lineIndex, 'template')) {
    const markup = stripXmlComments(block.content)
    refs.push(...extractComponentRefs(markup, filePath, block.contentStartLine, true))
  }

  return finalize(symbols, refs)
}

// ---------------------------------------------------------------------------
// Svelte (.svelte)
// ---------------------------------------------------------------------------

/**
 * Svelte component: explicit `<script>` (optionally `context="module"`) and `<style>` blocks,
 * but the template is NOT wrapped in a tag -- it's everything else in the file. Modeled as "the
 * whole file with `<script>...</script>` and `<style>...</style>` spans masked to blank lines"
 * (mirrors `maskHtmlNoise`'s masking discipline).
 */
export function extractSvelte(content: string, filePath: string): SfcResult {
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(content)
  const name = componentName(filePath)
  const symbols: SymbolEntry[] = [componentSymbol(filePath, name, 'svelte_component', totalLines)]
  const refs: RefEntry[] = []

  const scriptBlocks = extractTagBlocks(content, lineIndex, 'script')
  for (const block of scriptBlocks) {
    symbols.push(...extractTopLevelDeclarations(block.content, filePath, block.contentStartLine))
  }

  const styleBlocks = extractTagBlocks(content, lineIndex, 'style')
  const spans: Array<readonly [number, number]> = [...scriptBlocks, ...styleBlocks].map((b) => [
    b.matchStart,
    b.matchEnd,
  ])
  const markup = stripXmlComments(maskSpans(content, spans))
  refs.push(...extractComponentRefs(markup, filePath, 1, true))

  return finalize(symbols, refs)
}

// ---------------------------------------------------------------------------
// Astro (.astro)
// ---------------------------------------------------------------------------

interface AstroFrontmatter {
  /** 0-indexed line of the opening `---` fence. */
  readonly openLine: number
  /** 0-indexed line of the closing `---` fence. */
  readonly closeLine: number
}

/**
 * Detects Astro's leading `---\n...\n---` frontmatter fence. Only recognized when the opening
 * `---` is the very first non-whitespace content of the file (at most one leading blank line
 * skipped) -- a `---` appearing later in the markup body must never be misdetected as
 * frontmatter.
 */
function detectAstroFrontmatter(content: string): AstroFrontmatter | null {
  const lines = content.split('\n')
  let openLine = 0
  if ((lines[0] ?? '').trim() === '') openLine = 1
  const fenceLine = lines[openLine]
  if (fenceLine === undefined || fenceLine.replace(/\r$/, '') !== '---') return null
  for (let j = openLine + 1; j < lines.length; j++) {
    if ((lines[j] ?? '').replace(/\r$/, '') === '---') {
      return { openLine, closeLine: j }
    }
  }
  return null
}

/**
 * Astro component: a leading `---` frontmatter fence of plain TS/JS (Astro's defining syntax --
 * NOT wrapped in `<script>` tags) followed by JSX-like markup. `<style>` tags in the markup are
 * masked out the same way Vue's are (never scanned for refs), matching "extract that the same
 * way Vue does if you have time" from the task; no `<script>` special-casing beyond the
 * frontmatter fence itself is needed for Astro.
 */
export function extractAstro(content: string, filePath: string): SfcResult {
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(content)
  const name = componentName(filePath)
  const symbols: SymbolEntry[] = [componentSymbol(filePath, name, 'astro_component', totalLines)]
  const refs: RefEntry[] = []

  const lines = content.split('\n')
  const fm = detectAstroFrontmatter(content)
  const spans: Array<readonly [number, number]> = []

  if (fm) {
    const frontmatterContent = lines.slice(fm.openLine + 1, fm.closeLine).join('\n')
    const contentStartLine = fm.openLine + 2
    symbols.push(...extractTopLevelDeclarations(frontmatterContent, filePath, contentStartLine))

    // Mask the whole frontmatter fence (both `---` lines and everything between) out of the
    // markup pass below, by offset, so frontmatter code is never scanned for component refs.
    const fenceStartOffset = lineIndex[fm.openLine] ?? 0
    const fenceEndOffset = lineIndex[fm.closeLine + 1] ?? content.length
    spans.push([fenceStartOffset, fenceEndOffset])
  }

  const styleBlocks = extractTagBlocks(content, lineIndex, 'style')
  for (const block of styleBlocks) spans.push([block.matchStart, block.matchEnd])

  const markup = stripXmlComments(maskSpans(content, spans))
  refs.push(...extractComponentRefs(markup, filePath, 1, false))

  return finalize(symbols, refs)
}
