import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import { buildLineIndex, lineTextAt, offsetToLine, stripJsComments, stripXmlComments } from './common.js'
import { countContentLines } from '../util.js'

export interface SalesforceFrontendResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
}

function bundleName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const parent = path.posix.basename(path.posix.dirname(normalized))
  const base = path.posix.basename(normalized).replace(/\.[^.]+$/, '')
  return parent === 'lwc' || parent === 'aura' ? base : parent
}

function lwcTagAlias(name: string): string {
  const kebab = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
  return `c-${kebab}`
}

function symbol(filePath: string, name: string, kind: string, lineStart: number, lineEnd = lineStart): SymbolEntry {
  return { filePath, name, kind, lineStart, lineEnd, body: '', docstring: '', parent: '' }
}

function ref(filePath: string, name: string, line: number, col: number, context: string): RefEntry {
  return { filePath, name, line, col, context }
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function extractLwcJavaScript(content: string, filePath: string): SalesforceFrontendResult {
  const lineIndex = buildLineIndex(content)
  const bundle = bundleName(filePath)
  const symbols: SymbolEntry[] = [
    symbol(filePath, bundle, 'lwc_bundle', 1, countContentLines(content)),
    symbol(filePath, lwcTagAlias(bundle), 'lwc_component_alias', 1, countContentLines(content)),
  ]
  const refs: RefEntry[] = []

  // Blank comments (backtick-template-literal-aware, see stripJsComments) so commented-out
  // `@api` declarations and Salesforce imports aren't indexed as live code; string/template
  // literal content is untouched.
  const commentFree = stripJsComments(content)

  const apiRe = /@api\s*(?:\r?\n\s*)?(?:(get|set)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\()?/g
  for (const match of commentFree.matchAll(apiRe)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    const kind = match[3] && !match[1] ? 'lwc_api_method' : 'lwc_api_property'
    symbols.push(symbol(filePath, match[2] ?? '', kind, line))
  }

  const importRe = /from\s+['"]@salesforce\/(apex|schema|label|resourceUrl|messageChannel|customPermission|userPermission)\/([^'"]+)['"]/g
  for (const match of commentFree.matchAll(importRe)) {
    const offset = match.index ?? 0
    const line = offsetToLine(lineIndex, offset)
    const context = lineTextAt(content, lineIndex, line)
    const target = match[2] ?? ''
    const targetOffset = offset + (match[0]?.indexOf(target) ?? 0)
    const col = targetOffset - (commentFree.lastIndexOf('\n', targetOffset) + 1)
    if (match[1] === 'apex') {
      const className = target.split('.')[0] ?? target
      refs.push(ref(filePath, className, line, col, context))
    }
    refs.push(ref(filePath, target, line, col, context))
  }

  return {
    symbols: dedupe(symbols, (entry) => `${entry.name}\0${entry.kind}\0${entry.lineStart}`),
    refs: dedupe(refs, (entry) => `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`),
  }
}

export function extractLwcTemplate(content: string, filePath: string): SalesforceFrontendResult {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []

  // Blank `<!-- ... -->` spans before matching anything below, not just the event-handler
  // bindings, so a commented-out element (e.g. `<!-- <div lwc:ref="oldRef"> -->` or `<!-- <c-old-widget> -->`)
  // isn't indexed as a live symbol/ref. Length-preserving, so line offsets computed against it
  // still line up with the original content.
  const markupNoComments = stripXmlComments(content)
  // One index over the original content, reused by every loop below. `stripXmlComments` is length-preserving, so an offset into `markupNoComments` addresses the same line in `content`.
  const lineIndex = buildLineIndex(content)

  for (const match of markupNoComments.matchAll(/\blwc:ref\s*=\s*["']([^"']+)["']/gi)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    symbols.push(symbol(filePath, match[1] ?? '', 'lwc_ref', line))
  }
  for (const match of markupNoComments.matchAll(/\bid\s*=\s*["']([^"'{}:]+)["']/gi)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    symbols.push(symbol(filePath, match[1] ?? '', 'lwc_id', line))
  }
  for (const match of markupNoComments.matchAll(/\bon[a-z][\w-]*\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/gi)) {
    const offset = match.index ?? 0
    const line = offsetToLine(lineIndex, offset)
    refs.push(ref(filePath, match[1] ?? '', line, 0, lineTextAt(content, lineIndex, line)))
  }
  for (const match of markupNoComments.matchAll(/<\s*(c-[a-z][\w-]*)\b/gi)) {
    const offset = match.index ?? 0
    const line = offsetToLine(lineIndex, offset)
    refs.push(ref(filePath, (match[1] ?? '').toLowerCase(), line, 0, lineTextAt(content, lineIndex, line)))
  }

  return {
    symbols: dedupe(symbols, (entry) => `${entry.name}\0${entry.kind}\0${entry.lineStart}`),
    refs: dedupe(refs, (entry) => `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`),
  }
}

const MARKUP_KIND: Readonly<Record<string, string>> = {
  '.cmp': 'aura_bundle',
  '.app': 'aura_application',
  '.evt': 'aura_event_bundle',
  '.intf': 'aura_interface',
  '.design': 'aura_design',
  '.auradoc': 'aura_documentation',
  '.tokens': 'aura_tokens',
  '.page': 'visualforce_page',
  '.component': 'visualforce_component',
  '.email': 'visualforce_email_template',
}

function markupArtifactName(filePath: string, extension: string): string {
  if (extension === '.page' || extension === '.component' || extension === '.email') {
    return path.posix.basename(filePath.replaceAll('\\', '/')).replace(new RegExp(`${extension.replace('.', '\\.')}$`, 'i'), '')
  }
  return bundleName(filePath)
}

function addAttributeSymbols(
  symbols: SymbolEntry[],
  content: string,
  lineIndex: readonly number[],
  filePath: string,
  tag: string,
  kind: string,
): void {
  const tagRe = new RegExp(`<\\s*${tag}\\b[^>]*\\bname\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi')
  for (const match of content.matchAll(tagRe)) {
    symbols.push(symbol(filePath, match[1] ?? '', kind, offsetToLine(lineIndex, match.index ?? 0)))
  }
}

function attributeRefs(
  refs: RefEntry[],
  content: string,
  lineIndex: readonly number[],
  filePath: string,
  attribute: string,
  split = false,
): void {
  const attributeRe = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, 'gi')
  for (const match of content.matchAll(attributeRe)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    const values = split ? (match[1] ?? '').split(',').map((value) => value.trim()).filter(Boolean) : [match[1] ?? '']
    for (const value of values) refs.push(ref(filePath, value, line, 0, lineTextAt(content, lineIndex, line)))
  }
}

export function extractSalesforceMarkup(content: string, filePath: string): SalesforceFrontendResult {
  const normalized = filePath.replaceAll('\\', '/')
  const extension = path.posix.extname(normalized).toLowerCase()
  const kind = MARKUP_KIND[extension] ?? 'salesforce_markup'
  const symbols: SymbolEntry[] = [
    symbol(filePath, markupArtifactName(normalized, extension), kind, 1, countContentLines(content)),
  ]
  const refs: RefEntry[] = []
  const isAura = ['.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens'].includes(extension)

  // Blank `<!-- ... -->` spans before matching anything below, not just the action bindings, so
  // a commented-out attribute/handler/controller/extension/c:Component reference isn't indexed
  // as live (matches extractLwcTemplate's equivalent fix above).
  const markupNoComments = stripXmlComments(content)
  // One index over the original content, reused by every loop and helper below. `stripXmlComments` is length-preserving, so an offset into `markupNoComments` addresses the same line in `content`.
  const lineIndex = buildLineIndex(content)

  if (isAura) {
    addAttributeSymbols(symbols, markupNoComments, lineIndex, filePath, 'aura:attribute', 'aura_attribute')
    addAttributeSymbols(symbols, markupNoComments, lineIndex, filePath, 'aura:handler', 'aura_handler')
    addAttributeSymbols(symbols, markupNoComments, lineIndex, filePath, 'aura:registerEvent', 'aura_event')
    addAttributeSymbols(symbols, markupNoComments, lineIndex, filePath, 'design:attribute', 'aura_design_attribute')
  }

  attributeRefs(refs, markupNoComments, lineIndex, filePath, 'controller')
  attributeRefs(refs, markupNoComments, lineIndex, filePath, 'extensions', true)

  const actionRe = isAura
    ? /\{!\s*c\.([A-Za-z_$][\w$]*)(?:[^}\w$][^}]*)?\}/gi
    : /\baction\s*=\s*["']\{!\s*(?:c\.)?([A-Za-z_$][\w$]*)(?:[^}\w$][^}]*)?\}["']/gi
  for (const match of markupNoComments.matchAll(actionRe)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    refs.push(ref(filePath, match[1] ?? '', line, 0, lineTextAt(content, lineIndex, line)))
  }

  for (const match of markupNoComments.matchAll(/\bc:[A-Za-z_$][\w$]*/g)) {
    const line = offsetToLine(lineIndex, match.index ?? 0)
    refs.push(ref(filePath, match[0], line, 0, lineTextAt(content, lineIndex, line)))
  }

  return {
    symbols: dedupe(symbols, (entry) => `${entry.name}\0${entry.kind}\0${entry.lineStart}`),
    refs: dedupe(refs, (entry) => `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`),
  }
}
