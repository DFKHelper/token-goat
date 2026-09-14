/**
 * Language-specific import and export extractors.
 *
 * Scans source text across 25+ programming languages to identify exported symbol names
 * and imported module specifiers, covering tree-sitter languages and specialized legacy
 * languages through dedicated adapter dispatch tables.
 */

import * as path from 'node:path'

import { basenameImportsExtension, FILENAME_LANGUAGE } from './language_specs.js'
import { detectLanguage } from './parser_types.js'
import { IMPORT_RE as SWIFT_IMPORT_RE, stripLeadingAttributes as stripSwiftImportAttributes } from './languages/swift.js'
import { extractCobol } from './languages/cobol.js'
import { extractNatural } from './languages/natural.js'
import { extractAbap } from './languages/abap.js'
import { extractAbl, isAblSource } from './languages/abl.js'
import { extractJcl } from './languages/jcl.js'
import { extractPli } from './languages/pli.js'
import { extractRpg } from './languages/rpg.js'
import { extractSas } from './languages/sas.js'
import type { StatementAdapterResult } from './languages/span_collector.js'
import type { AdapterImport } from './languages/common.js'
import { extractGroovy } from './languages/groovy.js'
import { extractObjc, isObjcHeader, isObjcSource } from './languages/objc.js'
import { extractPerl, isPerlSource, isPrologSource } from './languages/perl.js'
import { extractCShader } from './languages/shader.js'
import { extractSolidity } from './languages/solidity.js'
import { extractThrift } from './languages/thrift.js'
import { extractFortran } from './languages/fortran.js'
import { extractPascal, isPascalSource } from './languages/pascal.js'
import { extractMatlab, isMatlabSource } from './languages/matlab.js'
import { extractCmake } from './languages/cmake.js'
import { extractAsm } from './languages/asm.js'
import { extractBatch } from './languages/batch.js'
import { extractErlang } from './languages/erlang.js'

/** The statement-scanning adapters whose import targets `imports` reads, by lowercase extension. */
const STATEMENT_ADAPTER_IMPORTS: ReadonlyMap<string, (content: string, filePath: string) => StatementAdapterResult> = new Map([
  ['.abap', extractAbap],
  ['.sas', extractSas],
  ['.pli', extractPli],
  ['.pl1', extractPli],
  ['.rpgle', extractRpg],
  ['.sqlrpgle', extractRpg],
  ['.jcl', extractJcl],
  ...['.f', '.for', '.f77', '.f90', '.f95', '.f03', '.f08'].map((e): [string, typeof extractFortran] => [e, extractFortran]),
  ...['.pas', '.dpr', '.dpk', '.lpr'].map((e): [string, typeof extractPascal] => [e, extractPascal]),
  ['.cmake', extractCmake],
  ...['.s', '.asm', '.nasm'].map((e): [string, typeof extractAsm] => [e, extractAsm]),
  ...['.bat', '.cmd'].map((e): [string, typeof extractBatch] => [e, extractBatch]),
  ...['.erl', '.hrl'].map((e): [string, typeof extractErlang] => [e, extractErlang]),
])

/** The brace-language and Perl adapters whose import targets `imports` reads, by lowercase extension. `.m`, `.h`, `.pl` and `.t` are here only when their content says so (see braceAdapterImportsFor). */
const BRACE_ADAPTER_IMPORTS: ReadonlyMap<string, (content: string, filePath: string) => { imports: readonly AdapterImport[] }> = new Map([
  ['.mm', extractObjc],
  ['.groovy', extractGroovy],
  ['.gvy', extractGroovy],
  ['.gradle', extractGroovy],
  ['.pm', extractPerl],
  ['.sol', extractSolidity],
  ['.thrift', extractThrift],
  ...['.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese', '.hlsl', '.hlsli', '.metal'].map((e): [string, typeof extractCShader] => [e, extractCShader]),
])

/** The adapter `imports` reads a file with extension `e` through, or undefined; the shared extensions go to it only when their content is that language, so a MATLAB `.m`, a C header, a Prolog `.pl` or a non-Perl `.t` reads as before. */
function braceAdapterImportsFor(e: string, text: string): ((content: string, filePath: string) => { imports: readonly AdapterImport[] }) | undefined {
  if (e === '.m') return isObjcSource(text) ? extractObjc : isMatlabSource(text) ? extractMatlab : undefined
  if (e === '.pp') return isPascalSource(text) ? extractPascal : undefined
  if (e === '.h') return isObjcHeader(text) ? extractObjc : undefined
  if (e === '.pl') return isPrologSource(text) ? undefined : extractPerl
  if (e === '.t') return isPerlSource(text) ? extractPerl : undefined
  return BRACE_ADAPTER_IMPORTS.get(e)
}

/**
 * Extract exported symbol names from source text. The tree-sitter indexer
 * stores a symbol's body starting at the inner declaration (e.g. `function`),
 * not the `export` modifier on its parent statement, so a body-prefix heuristic
 * misses real exports — this scans the source so `exports` is functional for the
 * flagship TS/JS case as well as Python, Rust, and Java.
 */
export function extractExportNames(text: string, ext: string): string[] {
  const names: string[] = []
  const push = (s: string | undefined): void => {
    let v = (s ?? '').trim()
    if (v.includes(' as ')) v = v.split(/\s+as\s+/).pop()?.trim() ?? v
    if (v !== '' && v !== 'default' && !names.includes(v)) names.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(e)) {
    const declRe = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
    const defaultRe = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/g
    const namedRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = declRe.exec(text)) !== null) push(m[1])
    while ((m = defaultRe.exec(text)) !== null) push(m[1])
    while ((m = namedRe.exec(text)) !== null) {
      for (const part of (m[1] ?? '').split(',')) push(part)
    }
  } else if (e === '.py') {
    for (const line of lines) {
      const m = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line)
      if (m && !(m[1] ?? '').startsWith('_')) push(m[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const m = /^\s*pub(?:\s*\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod|static)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /\bpublic\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  }
  return names
}

/**
 * Split `s` on top-level commas only, ignoring commas nested inside `{...}` groups. Used to
 * enumerate a Rust `use` brace group's selectors without splitting inside a nested group
 * (`io::{self, Read}` inside `std::{fs, io::{self, Read}}` must stay one selector).
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim() !== '') parts.push(cur)
  return parts
}

/**
 * Expand a Rust `use base::{selector, selector, ...}` brace group into one fully-qualified
 * target per selector, recursing into nested groups (`std::{fs, io::{self, Read}}` ->
 * `std::fs`, `std::io`, `std::io::Read`). `self` resolves to `base` itself (the group's own
 * module), and a rename (`Read as R`) resolves to the original name, matching what call sites
 * actually reference.
 */
function expandRustUseGroup(base: string, inner: string): string[] {
  const results: string[] = []
  for (const part of splitTopLevelCommas(inner)) {
    const trimmed = part.trim()
    if (trimmed === '' || trimmed === 'self') {
      if (trimmed === 'self') results.push(base)
      continue
    }
    const nested = /^([\w:]+)::\{([\s\S]*)\}$/.exec(trimmed)
    if (nested) {
      results.push(...expandRustUseGroup(`${base}::${nested[1] ?? ''}`, nested[2] ?? ''))
      continue
    }
    const name = (trimmed.split(/\s+as\s+/)[0] ?? '').trim()
    if (name === '' || name === 'self') { results.push(base); continue }
    results.push(`${base}::${name}`)
  }
  return results
}

/**
 * Extract import/include module specifiers from source text, covering the
 * bundled tree-sitter languages plus a few common extras. Returns one entry per
 * import in source order, de-duplicated. This is deliberately index-independent:
 * the symbol index does not store import statements as rows for the tree-sitter
 * languages, so a query-only `imports` returned nothing for TS/JS/Python/etc.
 */
export function extractImports(text: string, ext: string): string[] {
  const found: string[] = []
  const push = (s: string | undefined): void => {
    const v = (s ?? '').trim()
    if (v !== '' && !found.includes(v)) found.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'].includes(e)) {
    const fromRe = /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g
    const bareRe = /^\s*import\s*['"]([^'"]+)['"]/gm
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const matches: Array<{ index: number; value: string }> = []
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = bareRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = reqRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = dynRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    matches.sort((a, b) => a.index - b.index)
    for (const match of matches) push(match.value)
  } else if (e === '.py') {
    for (const line of lines) {
      const from = /^\s*from\s+([.\w]+)\s+import\b/.exec(line)
      if (from) { push(from[1]); continue }
      const imp = /^\s*import\s+(.+)$/.exec(line)
      if (imp) {
        const spec = (imp[1] ?? '').split('#')[0] ?? ''
        for (const part of spec.split(',')) push(part.trim().split(/\s+as\s+/)[0])
      }
    }
  } else if (e === '.go') {
    let inBlock = false
    for (const line of lines) {
      if (/^\s*import\s*\(/.test(line)) { inBlock = true; continue }
      if (inBlock) {
        if (/^\s*\)/.test(line)) { inBlock = false; continue }
        const m = /['"]([^'"]+)['"]/.exec(line)
        if (m) push(m[1])
        continue
      }
      const single = /^\s*import\s+(?:[\w.]+\s+)?['"]([^'"]+)['"]/.exec(line)
      if (single) push(single[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const groupM = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::\{([\s\S]*)\}/.exec(line)
      if (groupM) {
        for (const t of expandRustUseGroup(groupM[1] ?? '', groupM[2] ?? '')) push(t)
        continue
      }
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line)
      if (m) { push(m[1]); continue }
      const req = /^\s*requires\s+(?:transitive\s+|static\s+)*([\w.]+)\s*;/.exec(line)
      if (req) push(req[1])
    }
  } else if (e === '.rb' || e === '.rake') {
    for (const line of lines) {
      const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.cs') {
    for (const line of lines) {
      const m = /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*(?:=\s*([\w.<>,\s]+))?\s*;/.exec(line)
      if (m) push(m[2] ?? m[1])
    }
  } else if (e === '.php') {
    for (const line of lines) {
      const req = /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/.exec(line)
      if (req) { push(req[1]); continue }
      const groupUse = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)\\\{([^}]*)\}/.exec(line)
      if (groupUse) {
        const base = groupUse[1] ?? ''
        for (const part of (groupUse[2] ?? '').split(',')) {
          const trimmed = part.trim().replace(/^(?:function|const)\s+/, '')
          if (trimmed === '') continue
          const name = (trimmed.split(/\s+as\s+/)[0] ?? '').trim()
          if (name !== '') push(`${base}\\${name}`)
        }
        continue
      }
      const use = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*;/.exec(line)
      if (use) push(use[1])
    }
  } else if (['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.sh', '.bash'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*(?:source|\.)\s+['"]?([^\s'";]+)['"]?/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.ps1', '.psm1'].includes(e)) {
    for (const line of lines) {
      const importMod = /^\s*Import-Module\s+(?:-Name\s+)?['"]?([^\s'";]+)/i.exec(line)
      if (importMod) { push(importMod[1]); continue }
      const usingMod = /^\s*using\s+module\s+['"]?([^\s'";]+)/i.exec(line)
      if (usingMod) { push(usingMod[1]); continue }
      const dotSource = /^\s*\.\s+['"]?([^\s'";]+\.psm?1)['"]?\s*$/i.exec(line)
      if (dotSource) push(dotSource[1])
    }
  } else if (e === '.mk') {
    for (const line of lines) {
      const m = /^ *(?:-include|sinclude|include)\s+(.+)$/.exec(line)
      if (m) {
        const targets = (m[1] ?? '').split('#')[0] ?? ''
        for (const target of targets.split(/\s+/)) push(target)
      }
    }
  } else if (e === '.zig') {
    for (const line of lines) {
      const re = /@import\s*\(\s*"([^"]+)"\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (e === '.r') {
    for (const line of lines) {
      const re = /\b(?:library|require|source)\s*\(\s*["']?([A-Za-z0-9_./\\-]+)["']?/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (e === '.vb' || e === '.bas' || e === '.vbs') {
    for (const line of lines) {
      const m = /^\s*Imports\s+([^'<][^']*)/i.exec(line)
      if (!m) continue
      for (const clause of m[1]!.split(',')) {
        const c = clause.trim()
        if (c === '' || c.startsWith('<')) continue
        const alias = /^[A-Za-z_]\w*\s*=\s*([\w.]+(?:\(Of[^)]*\))?)/i.exec(c)
        push(alias ? alias[1] : (/^[\w.]+/.exec(c) ?? [undefined])[0])
      }
    }
  } else if (/^\.(?:cbl|cob|cpy|cobol)$/i.test(e)) {
    for (const imp of extractCobol(text, `imports${e}`).imports) push(imp.target)
  } else if (/^\.ns[pnsalgch]$/i.test(e)) {
    for (const imp of extractNatural(text, `imports${e}`).imports) push(imp.target)
  } else if (STATEMENT_ADAPTER_IMPORTS.has(e)) {
    for (const imp of STATEMENT_ADAPTER_IMPORTS.get(e)!(text, `imports${e}`).imports) push(imp.target)
  } else if (braceAdapterImportsFor(e, text) !== undefined) {
    for (const imp of braceAdapterImportsFor(e, text)!(text, `imports${e}`).imports) push(imp.target)
  } else if ((e === '.p' || e === '.w' || e === '.cls') && isAblSource(text)) {
    for (const imp of extractAbl(text, `imports${e}`).imports) push(imp.target)
  } else if (e === '.lua') {
    for (const line of lines) {
      const re = /\brequire\s*\(?\s*["']([^"']+)["']/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (['.scala', '.sc'].includes(e)) {
    for (const line of lines) {
      const stripped = line.trim()
      const braceM = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)\.\{([^}]*)\}/.exec(stripped)
      if (braceM) {
        const base = braceM[1] ?? ''
        for (const sel of (braceM[2] ?? '').split(',')) {
          const original = sel.trim().split(/\s*=>\s*/)[0]?.trim() ?? ''
          if (original === '') continue
          push(original === '_' ? `${base}._` : `${base}.${original}`)
        }
        continue
      }
      const m = /^import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\._)?)/.exec(stripped)
      if (m) push(m[1])
    }
  } else if (['.ex', '.exs'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*(?:alias|import|require|use)\s+([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)(?:\.\{([^}]*)\})?/.exec(line)
      if (m === null) continue
      const base = m[1] ?? ''
      const group = m[2]
      if (group !== undefined && group.trim() !== '') {
        for (const part of group.split(',')) push(`${base}.${part.trim()}`)
      } else {
        push(base)
      }
    }
  } else if (['.kt', '.kts'].includes(e)) {
    const re = /^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/
    for (const line of lines) {
      const m = re.exec(line.trim())
      if (m) push(m[1])
    }
  } else if (e === '.swift') {
    for (const line of lines) {
      const m = SWIFT_IMPORT_RE.exec(stripSwiftImportAttributes(line.trim()))
      if (m) push(m[1])
    }
  } else if (e === '.hs') {
    const re = /^import\s+(?:safe\s+)?(?:qualified\s+)?([A-Za-z_][A-Za-z0-9_.']*)/
    for (const line of lines) {
      const m = re.exec(line.trim())
      if (m) push(m[1])
    }
  } else if (['.tf', '.tfvars', '.hcl'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*source\s*=\s*"([^"]+)"/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.css', '.scss', '.sass', '.less'].includes(e)) {
    for (const line of lines) {
      const urlForm = /@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(line)
      if (urlForm) { push(urlForm[1]); continue }
      if (/^\s*@import\b/.test(line)) {
        const re = /['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        let any = false
        while ((m = re.exec(line)) !== null) { push(m[1]); any = true }
        if (any) continue
      }
      const useForward = /@(?:use|forward)\s+['"]([^'"]+)['"]/.exec(line)
      if (useForward) push(useForward[1])
    }
  } else if (['.graphql', '.gql'].includes(e)) {
    const re = /^[ \t]*#[ \t]*import\b(?:[^"'\n]*)?['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(m[1])
  } else if (e === '.liquid') {
    const re = /{%-?\s*(?:include|render|section)\s+(['"])((?:(?!\1)[\s\S])+?)\1/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(m[2])
  } else {
    for (const line of lines) {
      const m = /(?<![A-Za-z0-9_])(?:import|require|use|#include)\s+['"<]?([^'">;]+)/.exec(line)
      if (m) push(m[1])
    }
  }
  return found
}

/**
 * {@link extractImports}'s dispatch key, derived from `filePath` rather than a bare
 * `path.extname()` call: a `Makefile`/`GNUmakefile`/`BSDmakefile` (mirrors parser_types.ts's
 * FILENAME_LANGUAGE basename map) has no real file extension, so `path.extname()` alone always
 * yields `''` for it -- routing to extractImports' generic fallback, which requires a literal
 * `#include` and never matches Make's own `include`/`-include`/`sinclude` directives. Maps such
 * a basename to the synthetic `.mk` key extractImports' Makefile branch dispatches on; every
 * other path falls through to its real `path.extname()`.
 */
export function importsExtensionFor(filePath: string): string {
  const ext = path.extname(filePath)
  if (ext === '' || FILENAME_LANGUAGE.has(path.basename(filePath).toLowerCase())) return basenameImportsExtension(detectLanguage(filePath)) ?? ext
  return ext
}
