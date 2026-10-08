import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import { escapeRegExp } from '../util.js'

import { buildLineIndex, offsetToLine, stripXmlComments, type AdapterSpan, makeSpanSymbol } from './common.js'
import { findElements, gtFinder } from './markup_scan.js'

const MAX_SYMBOLS = 10_000 // raised from 1000: matches every sibling language adapter's cap, see makeSymbolEmitter's own comment in common.ts for the measurement; a large org's CustomLabels.labels-meta.xml or a complex Flow can hold well over 1000 entries
const MAX_REFS = 10_000 // raised from 1000: see MAX_SYMBOLS above

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

export function xmlText(content: string, tag: string): string | null {
  // XML 1.0 section 3.1 spells an end tag as `'</' Name S? '>'`, so whitespace before the `>` is legal: without the `\s*` a `</fullName >` never closes here and the lazy body runs on into the NEXT element's close tag, swallowing it.
  const first = findElements(content, tagOpenRe(tag, 'gi'), tagCloseRe(tag, 'gi'), 1)[0]
  if (first === undefined) return null
  return decodeXml(first.body.trim())
}

/** The open tag `<[prefix:]tag` up to a following whitespace or `>`, which is where the old `(?:\s[^>]*)?>` tail began. */
function tagOpenRe(tag: string, flags: string): RegExp {
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?=[\\s>])`, flags)
}

/** The whole close tag `</[prefix:]tag\s*>`. */
function tagCloseRe(tag: string, flags: string): RegExp {
  return new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`, flags)
}

// Like xmlText, but only returns a match that is a DIRECT child of `content` (nesting depth 0),
// not one buried inside a descendant element. Salesforce serializes each Flow element's own
// children alphabetically, so a collection child that sorts before "name" - e.g. a screen's
// <fields> (each of which has its own <name> naming the field) or an actionCall's
// <inputParameters> (each named too) - ends up BEFORE the element's own <name> in raw XML text.
// A first-match-anywhere search like xmlText would then return the wrong, deeply-nested name
// instead of the flow element's own.
export function directChildText(content: string, tag: string): string | null {
  // The depth walk has to see EVERY element, so its name pattern is the XML 1.0 Name production (leading `_` or `:`, and `.`/`-` inside), not just `[A-Za-z][A-Za-z0-9_]*`: a tag this misses is never counted and the depth reading goes wrong for every candidate after it.
  // The tags are listed once and the candidates, which come in increasing order, advance one depth pointer through them: re-walking the document from its start for every candidate made a document of n same-named elements cost n squared.
  let tags: Array<{ start: number; delta: number }> | null = null
  let next = 0
  let depth = 0
  for (const cand of findElements(content, tagOpenRe(tag, 'gi'), tagCloseRe(tag, 'gi'))) {
    tags ??= listTagDeltas(content)
    while (next < tags.length && (tags[next] as { start: number }).start < cand.start) {
      depth += (tags[next] as { delta: number }).delta
      next++
    }
    if (depth === 0) return decodeXml(cand.body.trim())
  }
  return null
}

/** Every tag of the document in order with its effect on nesting depth: +1 for an open tag, -1 for a close tag, 0 for a self-closing one. A tag runs to the first `>` after its name; a start with no `>` after it ends the list, since no later start has one either. */
function listTagDeltas(content: string): Array<{ start: number; delta: number }> {
  const re = /<(\/?)([A-Za-z_:][\w.:-]*)\b/g
  const out: Array<{ start: number; delta: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const nameEnd = m.index + m[0].length
    const gt = content.indexOf('>', nameEnd)
    if (gt < 0) break
    const selfClosing = content[gt - 1] === '/' && gt - 1 >= nameEnd
    out.push({ start: m.index, delta: selfClosing ? 0 : m[1] === '/' ? -1 : 1 })
    re.lastIndex = gt + 1
  }
  return out
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

export function rootElement(content: string): string | null {
  // The first start with a `>` after its name is the root, and when the first start has none no later one does: the old `[^>]*>` tail re-read to the end of the document from each of n unclosed `<a` starts.
  const match = /<(?!\?|!)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\b/.exec(content)
  if (match === null) return null
  const root = match[1]
  if (root === undefined) return null
  const gt = content.indexOf('>', match.index + match[0].length)
  if (gt < 0) return null
  // A self-closing root (e.g. `<CustomObjectTranslation xmlns="..."/>`) has no separate close tag to find.
  if (content[gt - 1] === '/') return root
  // `escapeRegExp`, because an XML name may legally contain `.` -- the capture above admits one --
  // and an unescaped one compiles as a wildcard. A root of `Custom.Object` then matched the close
  // tag `</CustomXObject>`, so a document that is not well formed was accepted and indexed. Nothing
  // worse is constructible here (the capture admits no `(`, `|`, `*`, `+` or `{`, so no quantifier
  // can be smuggled in), but a wildcard where a literal was meant is enough.
  const close = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(root)}\\s*>`, 'i')
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

export function elementBlocks(content: string, tag: string): Array<{ inner: string; offset: number; text: string }> {
  // Same XML 1.0 `'</' Name S? '>'` allowance as xmlText: without it one unclosed block merges with the next and both elements collapse into one symbol.
  return findElements(content, tagOpenRe(tag, 'gi'), tagCloseRe(tag, 'gi')).map((el) => ({
    inner: el.body,
    offset: el.start,
    text: content.slice(el.start, el.end),
  }))
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes)
  return match?.[2] === undefined ? null : decodeXml(match[2])
}

export function propertyElements(content: string): Array<{ name: string; offset: number; text: string }> {
  // A start that fails must not end the scan here, unlike the single-tag scanners: a self-closing `<property/>` needs no close tag, so one can still match after a `<property>` that never closes. What a miss does settle is every later non-self-closing start whose `>` is no earlier, since its close search is a part of the one that just failed.
  const open = /<(?:[A-Za-z_][\w.-]*:)?property\b/gi
  const close = /<\/(?:[A-Za-z_][\w.-]*:)?property\s*>/gi
  const nextGt = gtFinder(content)
  const out: Array<{ name: string; offset: number; text: string }> = []
  let deadFrom = Infinity
  let m: RegExpExecArray | null
  while ((m = open.exec(content)) !== null) {
    const nameEnd = m.index + m[0].length
    const gt = nextGt(nameEnd)
    if (gt < 0) break
    let end = gt + 1
    let attrs = content.slice(nameEnd, gt)
    if (content[gt - 1] === '/' && gt - 1 >= nameEnd) {
      attrs = content.slice(nameEnd, gt - 1)
    } else {
      if (gt >= deadFrom) continue
      close.lastIndex = gt + 1
      const c = close.exec(content)
      if (c === null) {
        deadFrom = gt
        continue
      }
      end = c.index + c[0].length
    }
    const name = attributeValue(attrs, 'name')
    if (name !== null && name !== '') out.push({ name, offset: m.index, text: content.slice(m.index, end) })
    open.lastIndex = end
  }
  return out
}

/** Locate one ref, resolving its line through the shared index this file already builds for symbols rather than by measuring the prefix again per ref. Copying and splitting `content.slice(0, offset)` costs the whole prefix on every call, so extraction was quadratic in the number of refs: a FlexiPage with 10,000 component references, a shape a large org really produces, copied several gigabytes of string -- 2.8 s here and over 132 s on a slower machine, past the suite's own per-test timeout. The curve measured exactly quadratic, 46, 177, 693 and 2794 ms as the count doubled from 1,250 to 10,000. Reading the line start out of the index costs a binary search instead, and a single `indexOf` bounds the context slice to one line rather than to everything after it. */
function makeRef(content: string, lineIndex: readonly number[], filePath: string, name: string, offset: number): RefEntry {
  const line = offsetToLine(lineIndex, offset)
  const lineStart = lineIndex[line - 1] ?? 0
  // The next line's start, not a search for the next newline: on a document written as one long line -- which is how a generated FlexiPage or a serialized Flow usually arrives -- there is no newline to find, so each search ran to the end of the file and put the quadratic straight back, at the same cost as the prefix slice this replaced.
  const nextStart = lineIndex[line] ?? content.length + 1
  const sourceLine = content.slice(lineStart, nextStart - 1)
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
  lineIndex: readonly number[],
  filePath: string,
  tags: readonly string[],
): void {
  for (const tag of tags) {
    for (const block of elementBlocks(content, tag)) {
      const name = decodeXml(block.inner.trim())
      if (name !== '') emitRef(refs, seen, makeRef(content, lineIndex, filePath, name, block.offset))
    }
  }
}

function metadataName(filePath: string, content: string, suffix: string): string {
  return xmlText(content, 'fullName') ?? basenameWithout(filePath, suffix)
}

export function addFlowElements(
  symbols: SymbolEntry[],
  seen: Set<string>,
  content: string,
  filePath: string,
  flowName: string,
): void {
  const lineIndex = buildLineIndex(content)
  const tagAlternation = Object.keys(FLOW_TAG_KIND).join('|')
  // `\s*>` on the close for the same XML 1.0 reason as xmlText: a `</variables >` that failed to close here merged this flow element with the next one of the same tag, so the second element lost its symbol and the first's span swallowed it.
  // The opening tag carries the same namespace prefix and attribute allowance as the close, and as both sibling matchers (xmlText, elementBlocks) already did. Without them this one required a bare `<variables>`: measured, a flow whose element was written `<variables xsi:type="VariableDef">` or `<md:variables>` indexed the flow itself and not one of its elements, so every `symbol`, `read` and `refs` against those elements answered as if the flow were empty. The backreference is to group 1, which is still the bare tag name, so a prefixed open must be closed by a tag with the same local name -- prefix mismatches are a well-formedness error the indexer does not need to adjudicate.
  // Scanned by hand rather than by one regex with a lazy body: that body re-read the rest of the file from every element start that never closed. Elements of different tags are independent here, so a missing close only settles later starts of the SAME tag (their close search is a part of the one that failed), and a start with no `>` after it ends the scan for all of them.
  const open = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?(${tagAlternation})(?=[\\s>])`, 'g')
  const closeByTag = new Map<string, RegExp>()
  const deadFromByTag = new Map<string, number>()
  const nextGt = gtFinder(content)
  let m: RegExpExecArray | null
  while ((m = open.exec(content)) !== null) {
    if (symbols.length >= MAX_SYMBOLS) return
    const tag = m[1] ?? ''
    const nameEnd = m.index + m[0].length
    const gt = nextGt(nameEnd)
    if (gt < 0) break
    if (gt >= (deadFromByTag.get(tag) ?? Infinity)) continue
    let close = closeByTag.get(tag)
    if (close === undefined) {
      close = tagCloseRe(tag, 'g')
      closeByTag.set(tag, close)
    }
    close.lastIndex = gt + 1
    const c = close.exec(content)
    if (c === null) {
      deadFromByTag.set(tag, gt)
      continue
    }
    const startOffset = m.index
    const endOffset = c.index + c[0].length
    open.lastIndex = endOffset
    const inner = content.slice(gt + 1, c.index).trim()
    const name = directChildText(inner, 'name')
    if (name === null || name === '') continue
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
  // Built once for the whole extraction rather than per branch: two branches below each built their own from this same string, while every ref resolved its line by re-measuring the prefix instead of consulting an index at all.
  const lineIndex = buildLineIndex(content)
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
    addTagRefs(refs, seenRefs, content, lineIndex, filePath, ['actionName', 'flowName'])
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
        emitRef(refs, seenRefs, makeRef(content, lineIndex, filePath, objectName, objectOffset))
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
          emitRef(refs, seenRefs, makeRef(content, lineIndex, filePath, `${objectName}.${fieldName}`, offset))
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
    addTagRefs(refs, seenRefs, content, lineIndex, filePath, ['sobjectType', 'componentName'])
  } else if (base.endsWith('.quickaction-meta.xml')) {
    addTagRefs(refs, seenRefs, content, lineIndex, filePath, ['targetObject', 'lightningComponent'])
  } else if (base.endsWith('.messagechannel-meta.xml')) {
    addTagRefs(refs, seenRefs, content, lineIndex, filePath, ['fieldName'])
  }

  return { symbols, refs }
}
