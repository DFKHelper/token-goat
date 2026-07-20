/**
 * Terraform / HCL (.tf, .tfvars, .hcl) extractor.
 *
 * Extracts resource, data, variable, output, module, provider, and locals blocks as symbols,
 * named after Terraform's own addressing convention (`aws_instance.web`, `data.aws_ami.ubuntu`,
 * `var.region`, ...) so `token-goat symbol`/`read`/`outline`/`skeleton` work on Terraform files
 * the same way they do on any other language. No tree-sitter-hcl grammar exists as a maintained
 * npm dependency, and HCL's block syntax (`keyword "label" "label" { ... }`) is regular enough
 * that a brace-counting regex adapter -- the same pattern already used for languages without a
 * bundled grammar, e.g. proto_idx.ts's message/enum/service extraction -- is proportionate.
 * Pure-regex; no tree-sitter.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import {
  assignFlatEndLines,
  buildLineIndex,
  findMatchingBraceEndLine,
  isInsideStringLiteral,
  makeSymbolEmitter,
  offsetToLine,
  propagateEndLinesToSymbols,
  stripCstyleComments,
  stripLineComment,
} from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

// HCL heredocs (`<<EOF ... EOF` / `<<-EOF ... EOF`) can legally contain brace characters,
// quote characters, and `#`/`//`/`/* */`-looking text in their body (e.g. an embedded JSON or
// shell snippet). None of that is real HCL syntax, so it must never reach the comment-stripping
// or brace-counting passes below -- if it did, an unbalanced `"` or `{` inside the heredoc body
// would desync quote/brace tracking for the rest of the file, mis-parenting every symbol after
// it (the same class of bug previously fixed for other regex adapters' brace counters). Masking
// runs first, on the raw content, and blanks each body line to spaces (never removing the line
// itself) so line numbers stay correct for everything downstream.
const HEREDOC_START_RE = /<<-?([A-Za-z_][A-Za-z0-9_]*)/g

function maskHeredocs(text: string): string {
  const lines = text.split('\n')
  let terminator: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    if (terminator !== null) {
      if (line.trim() === terminator) {
        terminator = null
      } else {
        lines[i] = ' '.repeat(line.length)
      }
      continue
    }
    HEREDOC_START_RE.lastIndex = 0
    let m: RegExpExecArray | null
    let found: string | null = null
    while ((m = HEREDOC_START_RE.exec(line)) !== null) {
      if (isInsideStringLiteral(line, m.index)) continue
      found = m[1] ?? null
      break
    }
    if (found !== null) terminator = found
  }
  return lines.join('\n')
}

// HCL allows three comment styles: `#`, `//`, and `/* ... */`. stripCstyleComments already
// handles `//` and block comments quote-aware; `#` line comments are stripped in a second,
// per-line pass the same way proto_idx.ts layers its own comment stripping on top of the
// shared C-style helper.
function stripComments(text: string): string {
  const out = stripCstyleComments(text)
  return out
    .split('\n')
    .map((line) => stripLineComment(line, ['#']))
    .join('\n')
}

// Top-level two-labeled blocks: resource "type" "name" { and data "type" "name" {
const RESOURCE_RE = /^[ \t]*resource\s+"([^"]*)"\s+"([^"]*)"\s*\{/gm
const DATA_RE = /^[ \t]*data\s+"([^"]*)"\s+"([^"]*)"\s*\{/gm

// Top-level single-labeled blocks: variable "name" {, output "name" {, module "name" {,
// provider "name" {
const VARIABLE_RE = /^[ \t]*variable\s+"([^"]*)"\s*\{/gm
const OUTPUT_RE = /^[ \t]*output\s+"([^"]*)"\s*\{/gm
const MODULE_RE = /^[ \t]*module\s+"([^"]*)"\s*\{/gm
const PROVIDER_RE = /^[ \t]*provider\s+"([^"]*)"\s*\{/gm

// locals { } -- unlabeled; extracted as a single `locals` symbol per block rather than one
// symbol per assignment inside it (simpler MVP scope, still enough for symbol/read/outline).
const LOCALS_RE = /^[ \t]*locals\s*\{/gm

// resource/data/variable/output/module/provider/locals blocks can all contain nested
// sub-blocks (a resource's `lifecycle { ... }` or `dynamic "..." { ... }`, a provider's nested
// alias config, ...). The shared assignFlatEndLines/propagateEndLinesToSymbols helpers only do
// flat "ends where the next section starts" propagation, which truncates an outer block's end
// to right before its first nested child. Each regex above ends with `\{`, so its offset is
// known -- find the true matching closing brace instead, via findMatchingBraceEndLine in
// common.ts (same approach as proto_idx.ts's block extraction).

interface BlockMatch {
  readonly name: string
  readonly kind: string
  readonly matchIndex: number
  readonly openBraceOffsetFromMatchStart: number
}

function collectTwoLabel(
  re: RegExp,
  stripped: string,
  kind: string,
  nameFor: (type: string, label: string) => string,
): BlockMatch[] {
  const out: BlockMatch[] = []
  for (const m of stripped.matchAll(re)) {
    const type = m[1]?.trim() ?? ''
    const label = m[2]?.trim() ?? ''
    if (!type || !label) continue
    out.push({
      name: nameFor(type, label),
      kind,
      matchIndex: m.index ?? 0,
      openBraceOffsetFromMatchStart: m[0].length - 1,
    })
  }
  return out
}

function collectOneLabel(
  re: RegExp,
  stripped: string,
  kind: string,
  nameFor: (label: string) => string,
): BlockMatch[] {
  const out: BlockMatch[] = []
  for (const m of stripped.matchAll(re)) {
    const label = m[1]?.trim() ?? ''
    if (!label) continue
    out.push({
      name: nameFor(label),
      kind,
      matchIndex: m.index ?? 0,
      openBraceOffsetFromMatchStart: m[0].length - 1,
    })
  }
  return out
}

export function extractTerraform(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const stripped = stripComments(maskHeredocs(content))
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(stripped)

  const blockEndLines = new Map<string, number>()

  const matches: BlockMatch[] = [
    ...collectTwoLabel(RESOURCE_RE, stripped, 'tf_resource', (type, label) => `${type}.${label}`),
    ...collectTwoLabel(DATA_RE, stripped, 'tf_data', (type, label) => `data.${type}.${label}`),
    ...collectOneLabel(VARIABLE_RE, stripped, 'tf_variable', (label) => `var.${label}`),
    ...collectOneLabel(OUTPUT_RE, stripped, 'tf_output', (label) => `output.${label}`),
    ...collectOneLabel(MODULE_RE, stripped, 'tf_module', (label) => `module.${label}`),
    ...collectOneLabel(PROVIDER_RE, stripped, 'tf_provider', (label) => `provider.${label}`),
  ]

  for (const m of stripped.matchAll(LOCALS_RE)) {
    matches.push({
      name: 'locals',
      kind: 'tf_locals',
      matchIndex: m.index ?? 0,
      openBraceOffsetFromMatchStart: m[0].length - 1,
    })
  }

  for (const bm of matches) {
    const line = offsetToLine(lineIndex, bm.matchIndex)
    const openBraceIndex = bm.matchIndex + bm.openBraceOffsetFromMatchStart
    const endLine = findMatchingBraceEndLine(stripped, openBraceIndex, totalLines, lineIndex)
    blockEndLines.set(`${bm.name}\0${bm.kind}\0${line}`, endLine)
    emit(bm.name, bm.kind, line)
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  const withFlatEnds = propagateEndLinesToSymbols(symbols, sections)

  // makeSymbolEmitter's dedupe key is (name, kind, line) (see its own comment on why kind must
  // be included), so the true-brace-end lookup keys the same way.
  return withFlatEnds.map((sym) => {
    const braceEndLine = blockEndLines.get(`${sym.name}\0${sym.kind}\0${sym.lineStart}`)
    return braceEndLine !== undefined && braceEndLine !== sym.lineEnd
      ? { ...sym, lineEnd: braceEndLine }
      : sym
  })
}
