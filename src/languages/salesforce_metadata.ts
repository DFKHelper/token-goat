import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import { buildLineIndex, offsetToLine, stripXmlComments, type AdapterSpan, makeSpanSymbol } from './common.js'

const MAX_SYMBOLS = 1000
const MAX_REFS = 1000

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

function xmlText(content: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}>`,
    'i',
  )
  const match = re.exec(content)
  if (match?.[1] === undefined) return null
  return decodeXml(match[1].trim())
}

// Like xmlText, but only returns a match that is a DIRECT child of `content` (nesting depth 0),
// not one buried inside a descendant element. Salesforce serializes each Flow element's own
// children alphabetically, so a collection child that sorts before "name" - e.g. a screen's
// <fields> (each of which has its own <name> naming the field) or an actionCall's
// <inputParameters> (each named too) - ends up BEFORE the element's own <name> in raw XML text.
// A first-match-anywhere search like xmlText would then return the wrong, deeply-nested name
// instead of the flow element's own.
function directChildText(content: string, tag: string): string | null {
  const candidateRe = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9_]*)\b[^>]*?(\/?)>/g
  for (const cand of content.matchAll(candidateRe)) {
    const idx = cand.index ?? 0
    let depth = 0
    tagRe.lastIndex = 0
    let t: RegExpExecArray | null
    while ((t = tagRe.exec(content)) !== null) {
      if (t.index >= idx) break
      const closing = t[1] === '/'
      const selfClosing = t[3] === '/'
      if (selfClosing) continue
      depth += closing ? -1 : 1
    }
    if (depth === 0) return decodeXml((cand[1] ?? '').trim())
  }
  return null
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

function wholeFileSpan(content: string): AdapterSpan {
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
): AdapterSpan {
  const startLine = offsetToLine(lineIndex, startOffset)
  const endLine = offsetToLine(lineIndex, Math.max(startOffset, endOffset - 1))
  return {
    startLine,
    endLine,
    body: content.slice(startOffset, endOffset).trimEnd(),
  }
}

function rootElement(content: string): string | null {
  const match = /<(?!\?|!)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\b[^>]*>/.exec(content)
  if (match === null) return null
  const root = match[1]
  if (root === undefined) return null
  // A self-closing root (e.g. `<CustomObjectTranslation xmlns="..."/>`) has no separate close tag to find.
  if (match[0].endsWith('/>')) return root
  const close = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${root}\\s*>`, 'i')
  return close.test(content) ? root : null
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function companionName(filePath: string): string | null {
  const base = path.basename(filePath)
  const match = /^(.+)\.(?:cls|trigger|page|component|cmp|app|evt|intf|design|auradoc|tokens|js)-meta\.xml$/i.exec(base)
  return match?.[1] === undefined ? null : `${match[1]}.metadata`
}

function metadataArtifactName(filePath: string): string {
  const base = path.basename(filePath)
  const match = /^(.+)\.[^.]+-meta\.xml$/i.exec(base)
  return match?.[1] ?? basenameWithout(filePath, '-meta.xml')
}

function elementBlocks(content: string, tag: string): Array<{ inner: string; offset: number; text: string }> {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}>`,
    'gi',
  )
  return [...content.matchAll(re)].map((match) => ({
    inner: match[1] ?? '',
    offset: match.index ?? 0,
    text: match[0],
  }))
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes)
  return match?.[2] === undefined ? null : decodeXml(match[2])
}

function propertyElements(content: string): Array<{ name: string; offset: number; text: string }> {
  const re =
    /<(?:[A-Za-z_][\w.-]*:)?property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?property\s*>)/gi
  const out: Array<{ name: string; offset: number; text: string }> = []
  for (const match of content.matchAll(re)) {
    const name = attributeValue(match[1] ?? '', 'name')
    if (name !== null && name !== '') out.push({ name, offset: match.index ?? 0, text: match[0] })
  }
  return out
}

function makeRef(content: string, filePath: string, name: string, offset: number): RefEntry {
  const before = content.slice(0, offset)
  const line = before.split(/\r?\n/).length
  const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1
  const sourceLine = content.slice(lineStart).split(/\r?\n/, 1)[0] ?? ''
  return { filePath, name, line, col: offset - lineStart, context: sourceLine.trim() }
}

function emitRef(refs: RefEntry[], seen: Set<string>, ref: RefEntry): void {
  if (!ref.name || refs.length >= MAX_REFS) return
  const key = `${ref.filePath}\0${ref.name}\0${ref.line}\0${ref.col}`
  if (seen.has(key)) return
  seen.add(key)
  refs.push(ref)
}

function addTagRefs(
  refs: RefEntry[],
  seen: Set<string>,
  content: string,
  filePath: string,
  tags: readonly string[],
): void {
  for (const tag of tags) {
    for (const block of elementBlocks(content, tag)) {
      const name = decodeXml(block.inner.trim())
      if (name !== '') emitRef(refs, seen, makeRef(content, filePath, name, block.offset))
    }
  }
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
    const name = directChildText(inner, 'name')
    if (name === null || name === '') continue
    const startOffset = match.index ?? 0
    const endOffset = startOffset + match[0].length
    const span = spanFromOffsets(content, lineIndex, startOffset, endOffset)
    const kind = FLOW_TAG_KIND[tag] ?? 'sf_flow_element'
    emit(symbols, seen, makeSpanSymbol(filePath, name, kind, span, flowName))
  }
}

function emit(symbols: SymbolEntry[], seen: Set<string>, symbol: SymbolEntry): void {
  if (!symbol.name || symbols.length >= MAX_SYMBOLS) return
  const key = `${symbol.name}\0${symbol.kind}\0${symbol.lineStart}`
  if (seen.has(key)) return
  seen.add(key)
  symbols.push(symbol)
}

// Shared by the .field-meta.xml and .validationrule-meta.xml branches below: both emit an
// object-scoped metadata symbol (plus an `Object.Name`-qualified duplicate when the object
// name is resolvable) -- identical shape, differing only in the metadata suffix (used for
// name resolution, case-sensitive per Salesforce's own file-naming convention) and kind.
function emitObjectScopedMetadata(
  symbols: SymbolEntry[],
  seen: Set<string>,
  filePath: string,
  content: string,
  whole: AdapterSpan,
  metadataSuffix: string,
  kind: string,
): void {
  const name = metadataName(filePath, content, metadataSuffix)
  const objectName = objectNameFromPath(filePath) ?? ''
  emit(symbols, seen, makeSpanSymbol(filePath, name, kind, whole, objectName))
  if (objectName !== '') {
    emit(symbols, seen, makeSpanSymbol(filePath, `${objectName}.${name}`, kind, whole, objectName))
  }
}

export function extractSalesforceMetadata(
  rawContent: string,
  filePath: string,
): { symbols: SymbolEntry[]; refs: RefEntry[] } {
  // Blank `<!-- ... -->` spans up front so every regex-based extractor below scans only live XML and never mistakes commented-out metadata for the real thing; blanking (not deleting) preserves line/column offsets.
  const content = stripXmlComments(rawContent)
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const refs: RefEntry[] = []
  const seenRefs = new Set<string>()
  const base = path.basename(filePath).toLowerCase()
  const whole = wholeFileSpan(content)
  const root = rootElement(content)

  if (root === null) return { symbols, refs }

  if (base.endsWith('.object-meta.xml')) {
    const name = metadataName(filePath, content, '.object-meta.xml')
    const isPlatformEvent = name.endsWith('__e') || xmlText(content, 'eventType') !== null
    emit(symbols, seen, makeSpanSymbol(filePath, name, isPlatformEvent ? 'sf_platform_event' : 'sf_object', whole))
    return { symbols, refs }
  }

  if (base.endsWith('.field-meta.xml')) {
    emitObjectScopedMetadata(symbols, seen, filePath, content, whole, '.field-meta.xml', 'sf_custom_field')
    return { symbols, refs }
  }

  if (base.endsWith('.validationrule-meta.xml')) {
    emitObjectScopedMetadata(symbols, seen, filePath, content, whole, '.validationRule-meta.xml', 'sf_validation_rule')
    return { symbols, refs }
  }

  if (base.endsWith('.flow-meta.xml')) {
    const name = basenameWithout(filePath, '.flow-meta.xml')
    emit(symbols, seen, makeSpanSymbol(filePath, name, 'sf_flow', whole))
    addFlowElements(symbols, seen, content, filePath, name)
    addTagRefs(refs, seenRefs, content, filePath, ['actionName', 'flowName'])
    for (const tag of ['recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes']) {
      for (const block of elementBlocks(content, tag)) {
        const objectBlock = elementBlocks(block.text, 'object')[0]
        if (objectBlock === undefined) continue
        const objectName = decodeXml(objectBlock.inner.trim())
        if (objectName === '') continue
        // Locate the actual <object> element via elementBlocks rather than a bare indexOf(objectName):
        // Flow elements are conventionally named Verb_ObjectName (e.g. Get_Account), so objectName is
        // almost always a substring of the enclosing <name> tag, which serializes before <object> --
        // a plain indexOf locks onto that earlier, unrelated occurrence instead of the real <object> tag.
        const objectOffset = block.offset + objectBlock.offset
        emitRef(refs, seenRefs, makeRef(content, filePath, objectName, objectOffset))
        // A running cursor into block.text, not a fresh indexOf(field.text) each time: two
        // <filters>/<inputAssignments> entries referencing the same field name inside one
        // recordLookups/recordCreates/recordUpdates/recordDeletes block is a normal Flow
        // pattern (e.g. "Status = Open OR Status != Closed"). A plain indexOf always resolves
        // to the FIRST occurrence, so every subsequent same-named <field> collided with the
        // first one's offset -- and since emitRef dedupes on filePath/name/line/col, the
        // second (real, distinct) reference was silently dropped as a duplicate.
        let fieldSearchFrom = 0
        for (const field of elementBlocks(block.inner, 'field')) {
          const fieldName = decodeXml(field.inner.trim())
          if (fieldName === '') continue
          const idx = block.text.indexOf(field.text, fieldSearchFrom)
          const offset = block.offset + (idx >= 0 ? idx : 0)
          if (idx >= 0) fieldSearchFrom = idx + field.text.length
          emitRef(refs, seenRefs, makeRef(content, filePath, `${objectName}.${fieldName}`, offset))
        }
      }
    }
    return { symbols, refs }
  }

  if (base.endsWith('.permissionset-meta.xml')) {
    const name = basenameWithout(filePath, '.permissionset-meta.xml')
    emit(symbols, seen, makeSpanSymbol(filePath, name, 'sf_permission_set', whole))
    return { symbols, refs }
  }

  if (base.endsWith('.profile-meta.xml')) {
    const name = basenameWithout(filePath, '.profile-meta.xml')
    emit(symbols, seen, makeSpanSymbol(filePath, name, 'sf_profile', whole))
    return { symbols, refs }
  }

  if (base.endsWith('.md-meta.xml')) {
    const name = basenameWithout(filePath, '.md-meta.xml')
    emit(symbols, seen, makeSpanSymbol(filePath, name, 'sf_custom_metadata_record', whole))
    return { symbols, refs }
  }

  const objectMemberKinds: Readonly<Record<string, string>> = {
    'recordtype-meta.xml': 'sf_record_type',
    'fieldset-meta.xml': 'sf_field_set',
    'compactlayout-meta.xml': 'sf_compact_layout',
    'businessprocess-meta.xml': 'sf_business_process',
    'weblink-meta.xml': 'sf_web_link',
    'sharingreason-meta.xml': 'sf_sharing_reason',
  }
  const memberEntry = Object.entries(objectMemberKinds).find(([suffix]) => base.endsWith(suffix))
  if (memberEntry !== undefined) {
    const member = xmlText(content, 'fullName') ?? basenameWithout(filePath, `.${memberEntry[0]}`)
    const objectName = objectNameFromPath(filePath)
    const name = objectName === null ? member : `${objectName}.${member}`
    emit(symbols, seen, makeSpanSymbol(filePath, name, memberEntry[1], whole, objectName ?? ''))
    return { symbols, refs }
  }

  const companion = companionName(filePath)
  const name =
    companion ??
    (base.endsWith('.labels-meta.xml') ? null : xmlText(content, 'fullName')) ??
    metadataArtifactName(filePath)
  emit(symbols, seen, makeSpanSymbol(filePath, name, `sf_${snakeCase(root)}`, whole))

  if (base.endsWith('.labels-meta.xml')) {
    const lineIndex = buildLineIndex(content)
    for (const block of elementBlocks(content, 'labels')) {
      const labelName = xmlText(block.inner, 'fullName')
      if (labelName === null) continue
      emit(
        symbols,
        seen,
        makeSpanSymbol(
          filePath,
          labelName,
          'sf_custom_label',
          spanFromOffsets(content, lineIndex, block.offset, block.offset + block.text.length),
        ),
      )
    }
  }

  if (base.endsWith('.js-meta.xml')) {
    const lineIndex = buildLineIndex(content)
    const lwcSeen = new Set<string>()
    for (const target of elementBlocks(content, 'target')) {
      const targetName = decodeXml(target.inner.trim())
      const key = `target\0${targetName}`
      if (targetName === '' || lwcSeen.has(key)) continue
      lwcSeen.add(key)
      emit(
        symbols,
        seen,
        makeSpanSymbol(
          filePath,
          targetName,
          'sf_lwc_target',
          spanFromOffsets(content, lineIndex, target.offset, target.offset + target.text.length),
        ),
      )
    }
    for (const configs of elementBlocks(content, 'targetConfigs')) {
      for (const property of propertyElements(configs.inner)) {
        const key = `property\0${property.name}`
        if (lwcSeen.has(key)) continue
        lwcSeen.add(key)
        const offset = configs.offset + configs.text.indexOf(property.text)
        emit(
          symbols,
          seen,
          makeSpanSymbol(
            filePath,
            property.name,
            'sf_lwc_property',
            spanFromOffsets(content, lineIndex, offset, offset + property.text.length),
          ),
        )
      }
    }
  }

  if (base.endsWith('.flexipage-meta.xml')) {
    addTagRefs(refs, seenRefs, content, filePath, ['sobjectType', 'componentName'])
  } else if (base.endsWith('.quickaction-meta.xml')) {
    addTagRefs(refs, seenRefs, content, filePath, ['targetObject', 'lightningComponent'])
  } else if (base.endsWith('.messagechannel-meta.xml')) {
    addTagRefs(refs, seenRefs, content, filePath, ['fieldName'])
  }

  return { symbols, refs }
}
