import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import { stripCstyleComments, stripSlashLineComments, stripXmlComments } from './common.js'

export interface SalesforceFrontendResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
}

function lines(content: string): string[] {
  return content.split('\n')
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
  return { filePath, name, kind, lineStart, lineEnd, body: '', docstring: '' }
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
  const sourceLines = lines(content)
  const bundle = bundleName(filePath)
  const symbols: SymbolEntry[] = [
    symbol(filePath, bundle, 'lwc_bundle', 1, sourceLines.length),
    symbol(filePath, lwcTagAlias(bundle), 'lwc_component_alias', 1, sourceLines.length),
  ]
  const refs: RefEntry[] = []

  // Blank comments (block first, then quote-aware `//`) so commented-out `@api` declarations and Salesforce imports aren't indexed as live code; string-literal content is untouched.
  const commentFree = stripSlashLineComments(stripCstyleComments(content))

  const apiRe = /@api\s*(?:\r?\n\s*)?(?:(get|set)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\()?/g
  for (const match of commentFree.matchAll(apiRe)) {
    const before = commentFree.slice(0, match.index ?? 0)
    const line = before.split('\n').length
    const kind = match[3] && !match[1] ? 'lwc_api_method' : 'lwc_api_property'
    symbols.push(symbol(filePath, match[2] ?? '', kind, line))
  }

  const importRe = /from\s+['"]@salesforce\/(apex|schema|label|resourceUrl|messageChannel|customPermission|userPermission)\/([^'"]+)['"]/g
  for (const match of commentFree.matchAll(importRe)) {
    const offset = match.index ?? 0
    const line = commentFree.slice(0, offset).split('\n').length
    const context = sourceLines[line - 1]?.trim() ?? ''
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

function matchLine(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function lineContext(content: string, line: number): string {
  return lines(content)[line - 1]?.trim() ?? ''
}

export function extractLwcTemplate(content: string, filePath: string): SalesforceFrontendResult {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []

  for (const match of content.matchAll(/\blwc:ref\s*=\s*["']([^"']+)["']/gi)) {
    const line = matchLine(content, match.index ?? 0)
    symbols.push(symbol(filePath, match[1] ?? '', 'lwc_ref', line))
  }
  for (const match of content.matchAll(/\bid\s*=\s*["']([^"'{}:]+)["']/gi)) {
    const line = matchLine(content, match.index ?? 0)
    symbols.push(symbol(filePath, match[1] ?? '', 'lwc_id', line))
  }
  // Blank `<!-- ... -->` spans before matching event-handler bindings so a commented-out element (e.g. `<!-- <button onclick={oldHandler}> -->`) isn't indexed as a live ref.
  const markupNoComments = stripXmlComments(content)
  for (const match of markupNoComments.matchAll(/\bon[a-z][\w-]*\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/gi)) {
    const offset = match.index ?? 0
    const line = matchLine(markupNoComments, offset)
    refs.push(ref(filePath, match[1] ?? '', line, 0, lineContext(content, line)))
  }
  for (const match of content.matchAll(/<\s*(c-[a-z][\w-]*)\b/gi)) {
    const offset = match.index ?? 0
    const line = matchLine(content, offset)
    refs.push(ref(filePath, (match[1] ?? '').toLowerCase(), line, 0, lineContext(content, line)))
  }

  return {
    symbols: dedupe(symbols, (entry) => `${entry.name}\0${entry.kind}\0${entry.lineStart}`),
    refs: dedupe(refs, (entry) => `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`),
  }
}

export const SALESFORCE_MARKUP_EXTENSIONS = new Set([
  '.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens', '.page', '.component', '.email',
])

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
  filePath: string,
  tag: string,
  kind: string,
): void {
  const tagRe = new RegExp(`<\\s*${tag}\\b[^>]*\\bname\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi')
  for (const match of content.matchAll(tagRe)) {
    symbols.push(symbol(filePath, match[1] ?? '', kind, matchLine(content, match.index ?? 0)))
  }
}

function attributeRefs(
  refs: RefEntry[],
  content: string,
  filePath: string,
  attribute: string,
  split = false,
): void {
  const attributeRe = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, 'gi')
  for (const match of content.matchAll(attributeRe)) {
    const line = matchLine(content, match.index ?? 0)
    const values = split ? (match[1] ?? '').split(',').map((value) => value.trim()).filter(Boolean) : [match[1] ?? '']
    for (const value of values) refs.push(ref(filePath, value, line, 0, lineContext(content, line)))
  }
}

export function extractSalesforceMarkup(content: string, filePath: string): SalesforceFrontendResult {
  const normalized = filePath.replaceAll('\\', '/')
  const extension = path.posix.extname(normalized).toLowerCase()
  const sourceLines = lines(content)
  const kind = MARKUP_KIND[extension] ?? 'salesforce_markup'
  const symbols: SymbolEntry[] = [
    symbol(filePath, markupArtifactName(normalized, extension), kind, 1, sourceLines.length),
  ]
  const refs: RefEntry[] = []
  const isAura = ['.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens'].includes(extension)

  if (isAura) {
    addAttributeSymbols(symbols, content, filePath, 'aura:attribute', 'aura_attribute')
    addAttributeSymbols(symbols, content, filePath, 'aura:handler', 'aura_handler')
    addAttributeSymbols(symbols, content, filePath, 'aura:registerEvent', 'aura_event')
    addAttributeSymbols(symbols, content, filePath, 'design:attribute', 'aura_design_attribute')
  }

  attributeRefs(refs, content, filePath, 'controller')
  attributeRefs(refs, content, filePath, 'extensions', true)

  // Blank `<!-- ... -->` spans before matching `{!c.action}` / `action="{!...}"` bindings so a commented-out element isn't indexed as a live controller-action ref.
  const markupNoComments = stripXmlComments(content)
  const actionRe = isAura
    ? /\{!\s*c\.([A-Za-z_$][\w$]*)[^}]*\}/gi
    : /\baction\s*=\s*["']\{!\s*(?:c\.)?([A-Za-z_$][\w$]*)[^}]*\}["']/gi
  for (const match of markupNoComments.matchAll(actionRe)) {
    const line = matchLine(markupNoComments, match.index ?? 0)
    refs.push(ref(filePath, match[1] ?? '', line, 0, lineContext(content, line)))
  }

  for (const match of content.matchAll(/\bc:[A-Za-z_$][\w$]*/g)) {
    const line = matchLine(content, match.index ?? 0)
    refs.push(ref(filePath, match[0], line, 0, lineContext(content, line)))
  }

  return {
    symbols: dedupe(symbols, (entry) => `${entry.name}\0${entry.kind}\0${entry.lineStart}`),
    refs: dedupe(refs, (entry) => `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`),
  }
}
