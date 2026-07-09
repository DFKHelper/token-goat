import * as path from 'node:path'

import type { SymbolEntry } from '../parser_types.js'
import { buildLineIndex, offsetToLine } from './common.js'

const MAX_SYMBOLS = 1000

const FLOW_TAG_KIND: Readonly<Record<string, string>> = {
  actionCalls: 'sf_flow_action',
  assignments: 'sf_flow_assignment',
  choices: 'sf_flow_choice',
  collectionProcessors: 'sf_flow_collection_processor',
  constants: 'sf_flow_constant',
  decisions: 'sf_flow_decision',
  dynamicChoiceSets: 'sf_flow_dynamic_choice_set',
  formulas: 'sf_flow_formula',
  loops: 'sf_flow_loop',
  recordCreates: 'sf_flow_record_create',
  recordDeletes: 'sf_flow_record_delete',
  recordLookups: 'sf_flow_record_lookup',
  recordUpdates: 'sf_flow_record_update',
  screens: 'sf_flow_screen',
  subflows: 'sf_flow_subflow',
  textTemplates: 'sf_flow_text_template',
  transforms: 'sf_flow_transform',
  variables: 'sf_flow_variable',
}

interface Span {
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}

function xmlText(content: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = re.exec(content)
  if (match?.[1] === undefined) return null
  return decodeXml(match[1].trim())
}

function decodeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function normalizedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function basenameWithout(filePath: string, suffix: string): string {
  const base = path.basename(filePath)
  return base.toLowerCase().endsWith(suffix.toLowerCase())
    ? base.slice(0, base.length - suffix.length)
    : base
}

function objectNameFromPath(filePath: string): string | null {
  const match = /\/objects\/([^/]+)\//.exec(normalizedPath(filePath))
  return match?.[1] ?? null
}

function wholeFileSpan(content: string): Span {
  const lines = content.split(/\r?\n/)
  return {
    startLine: 1,
    endLine: lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length,
    // File-level metadata symbols can be several megabytes (profiles are a common case).
    // Keep only the source span in the index; `read` reconstructs empty bodies from disk.
    body: '',
  }
}

function spanFromOffsets(
  content: string,
  lineIndex: readonly number[],
  startOffset: number,
  endOffset: number,
): Span {
  const startLine = offsetToLine([...lineIndex], startOffset)
  const endLine = offsetToLine([...lineIndex], Math.max(startOffset, endOffset - 1))
  return {
    startLine,
    endLine,
    body: content.slice(startOffset, endOffset).trimEnd(),
  }
}

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  span: Span,
  docstring = '',
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: span.startLine,
    lineEnd: span.endLine,
    body: span.body,
    docstring,
  }
}

function rootElement(content: string): string | null {
  const match = /<([A-Za-z][A-Za-z0-9_]*)\b/.exec(content)
  return match?.[1] ?? null
}

function metadataName(filePath: string, content: string, suffix: string): string {
  return xmlText(content, 'fullName') ?? basenameWithout(filePath, suffix)
}

function addFlowElements(
  symbols: SymbolEntry[],
  seen: Set<string>,
  content: string,
  filePath: string,
  flowName: string,
): void {
  const lineIndex = buildLineIndex(content)
  const tagAlternation = Object.keys(FLOW_TAG_KIND).join('|')
  const re = new RegExp(`<(${tagAlternation})>\\s*([\\s\\S]*?)\\s*</\\1>`, 'g')

  for (const match of content.matchAll(re)) {
    if (symbols.length >= MAX_SYMBOLS) return
    const tag = match[1] ?? ''
    const inner = match[2] ?? ''
    const name = xmlText(inner, 'name')
    if (name === null || name === '') continue
    const startOffset = match.index ?? 0
    const endOffset = startOffset + match[0].length
    const span = spanFromOffsets(content, lineIndex, startOffset, endOffset)
    const kind = FLOW_TAG_KIND[tag] ?? 'sf_flow_element'
    emit(symbols, seen, makeSymbol(filePath, name, kind, span, flowName))
  }
}

function emit(symbols: SymbolEntry[], seen: Set<string>, symbol: SymbolEntry): void {
  if (!symbol.name || symbols.length >= MAX_SYMBOLS) return
  const key = `${symbol.name}\0${symbol.kind}\0${symbol.lineStart}`
  if (seen.has(key)) return
  seen.add(key)
  symbols.push(symbol)
}

export function extractSalesforceMetadata(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const base = path.basename(filePath).toLowerCase()
  const whole = wholeFileSpan(content)

  if (base.endsWith('.object-meta.xml')) {
    const name = metadataName(filePath, content, '.object-meta.xml')
    const isPlatformEvent = name.endsWith('__e') || xmlText(content, 'eventType') !== null
    emit(symbols, seen, makeSymbol(filePath, name, isPlatformEvent ? 'sf_platform_event' : 'sf_object', whole))
    return { symbols }
  }

  if (base.endsWith('.field-meta.xml')) {
    const name = metadataName(filePath, content, '.field-meta.xml')
    const objectName = objectNameFromPath(filePath) ?? ''
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_custom_field', whole, objectName))
    if (objectName !== '') {
      emit(symbols, seen, makeSymbol(filePath, `${objectName}.${name}`, 'sf_custom_field', whole, objectName))
    }
    return { symbols }
  }

  if (base.endsWith('.validationrule-meta.xml')) {
    const name = metadataName(filePath, content, '.validationRule-meta.xml')
    const objectName = objectNameFromPath(filePath) ?? ''
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_validation_rule', whole, objectName))
    if (objectName !== '') {
      emit(symbols, seen, makeSymbol(filePath, `${objectName}.${name}`, 'sf_validation_rule', whole, objectName))
    }
    return { symbols }
  }

  if (base.endsWith('.flow-meta.xml')) {
    const name = basenameWithout(filePath, '.flow-meta.xml')
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_flow', whole))
    addFlowElements(symbols, seen, content, filePath, name)
    return { symbols }
  }

  if (base.endsWith('.permissionset-meta.xml')) {
    const name = basenameWithout(filePath, '.permissionset-meta.xml')
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_permission_set', whole))
    return { symbols }
  }

  if (base.endsWith('.profile-meta.xml')) {
    const name = basenameWithout(filePath, '.profile-meta.xml')
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_profile', whole))
    return { symbols }
  }

  if (base.endsWith('.md-meta.xml')) {
    const name = basenameWithout(filePath, '.md-meta.xml')
    emit(symbols, seen, makeSymbol(filePath, name, 'sf_custom_metadata_record', whole))
    return { symbols }
  }

  const root = rootElement(content)
  if (root !== null) {
    const name = xmlText(content, 'fullName') ?? basenameWithout(filePath, '-meta.xml')
    emit(symbols, seen, makeSymbol(filePath, name, `sf_${root}`, whole))
  }
  return { symbols }
}
