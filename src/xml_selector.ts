/** The selector language of `xml-query`: a path such as `catalog/book[@id='101']/@lang` parsed into steps, and the tag, attribute and predicate tests each step applies to a node. `queryXml` in xml_query.ts walks a parsed tree with them. */

import type { XmlNode } from './xml_query.js'

export type XmlPredicate =
  | { kind: 'index'; index: number }
  | { kind: 'all' }
  | { kind: 'attrExists'; name: string }
  | { kind: 'attrEquals'; name: string; value: string; notEqual?: boolean }
  | { kind: 'attrContains'; name: string; value: string }
  | { kind: 'attrStartsWith'; name: string; value: string }
  | { kind: 'textEquals'; value: string; notEqual?: boolean }
  | { kind: 'textContains'; value: string }
  | { kind: 'localNameEquals'; value: string; notEqual?: boolean }
  | { kind: 'childEquals'; tag: string; value: string; notEqual?: boolean }
  | { kind: 'childExists'; tag: string }
  | { kind: 'and'; predicates: XmlPredicate[] }
  | { kind: 'or'; predicates: XmlPredicate[] }

export interface XmlSelectorStep {
  tag: string
  isRecursive: boolean
  predicates?: XmlPredicate[] | undefined
  index?: number | undefined
  allIndices?: boolean | undefined
  attributeFilter?: { name: string; value?: string | undefined; notEqual?: boolean | undefined } | undefined
  attributeSelect?: string | undefined
}

function getLocalName(tag: string): string {
  const idx = tag.indexOf(':')
  return idx === -1 ? tag : tag.slice(idx + 1)
}

export function matchTag(nodeTag: string, targetTag: string): boolean {
  if (targetTag === '*' || targetTag === '') return true
  if (nodeTag.toLowerCase() === targetTag.toLowerCase()) return true
  if (!targetTag.includes(':')) {
    return getLocalName(nodeTag).toLowerCase() === targetTag.toLowerCase()
  }
  return false
}

export function getAttrValue(node: XmlNode, targetAttr: string): string | undefined {
  const clean = targetAttr.startsWith('@') ? targetAttr.slice(1) : targetAttr
  if (clean === '*') {
    const vals = Object.values(node.attributes)
    return vals.length > 0 ? vals[0] : undefined
  }
  if (node.attributes[clean] !== undefined) return node.attributes[clean]
  const lowerClean = clean.toLowerCase()
  for (const [k, v] of Object.entries(node.attributes)) {
    if (k.toLowerCase() === lowerClean) return v
  }
  if (!clean.includes(':')) {
    for (const [k, v] of Object.entries(node.attributes)) {
      if (getLocalName(k).toLowerCase() === lowerClean) return v
    }
  }
  return undefined
}

function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let parenDepth = 0

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!
    if (!quote && (ch === '"' || ch === "'")) {
      quote = ch
      current += ch
    } else if (quote && ch === quote) {
      quote = null
      current += ch
    } else if (!quote && ch === '(') {
      parenDepth++
      current += ch
    } else if (!quote && ch === ')') {
      if (parenDepth > 0) parenDepth--
      current += ch
    } else if (!quote && parenDepth === 0 && str.startsWith(delimiter, i)) {
      parts.push(current.trim())
      current = ''
      i += delimiter.length - 1
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

// XPath 1.0 positions start at 1 (W3C XPath 1.0 section 2.4), while the dotted path syntax counts from 0. `oneBased` selects the XPath convention.
function parseSinglePredicate(predStr: string, oneBased = false): XmlPredicate | null {
  const s = predStr.trim()
  if (!s) return null

  // `or` binds loosest (XPath 1.0 §3.4), so it has to be split first: splitting `and` first parses `@a='1' or @b='2' and @c='3'` as `(A or B) and C` and answers a three-book catalog with one book instead of two. Splitting on the loosest operator first is what puts it at the root of the tree.
  const orParts = splitTopLevel(s, ' or ')
  if (orParts.length > 1) {
    const predicates = orParts.map((p) => parseSinglePredicate(p, oneBased))
    if (predicates.some((p) => p === null)) return null
    return { kind: 'or', predicates: predicates as XmlPredicate[] }
  }

  // A sub-predicate this parser cannot read makes the whole conjunction unreadable. Filtering the nulls out instead would quietly evaluate `@a='1' and not(@b)` as `@a='1'`, widening the match to rows the caller asked to exclude.
  const andParts = splitTopLevel(s, ' and ')
  if (andParts.length > 1) {
    const predicates = andParts.map((p) => parseSinglePredicate(p, oneBased))
    if (predicates.some((p) => p === null)) return null
    return { kind: 'and', predicates: predicates as XmlPredicate[] }
  }

  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10)
    // A position below 1 selects nothing in XPath; a huge index is out of range for any sibling list.
    if (oneBased) return { kind: 'index', index: n >= 1 ? n - 1 : Number.MAX_SAFE_INTEGER }
    return { kind: 'index', index: n }
  }

  if (s === 'last()') {
    return { kind: 'index', index: -1 }
  }

  if (s === '*') {
    return { kind: 'all' }
  }

  const localMatch = /^local-name\(\)\s*(!?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*$/i.exec(s)
  if (localMatch) {
    const val = localMatch[2] !== undefined ? localMatch[2] : localMatch[3] !== undefined ? localMatch[3] : localMatch[4] ?? ''
    return {
      kind: 'localNameEquals',
      value: val,
      ...(localMatch[1] === '!=' ? { notEqual: true } : {}),
    }
  }

  const containsAttrMatch = /^contains\(\s*(@[a-zA-Z0-9_:.\\-]+|\*)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(s)
  if (containsAttrMatch) {
    const attrName = containsAttrMatch[1]!.replace(/^@/, '')
    return { kind: 'attrContains', name: attrName, value: containsAttrMatch[2] ?? containsAttrMatch[3]! }
  }

  const containsTextMatch = /^contains\(\s*(?:text\(\)|\.)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(s)
  if (containsTextMatch) {
    return { kind: 'textContains', value: containsTextMatch[1] ?? containsTextMatch[2]! }
  }

  const startsWithAttrMatch = /^starts-with\(\s*(@[a-zA-Z0-9_:.\\-]+|\*)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(s)
  if (startsWithAttrMatch) {
    const attrName = startsWithAttrMatch[1]!.replace(/^@/, '')
    return { kind: 'attrStartsWith', name: attrName, value: startsWithAttrMatch[2] ?? startsWithAttrMatch[3]! }
  }

  const textMatch = /^(?:text\(\)|\.)\s*(!?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*$/i.exec(s)
  if (textMatch) {
    const val = textMatch[2] !== undefined ? textMatch[2] : textMatch[3] !== undefined ? textMatch[3] : textMatch[4] ?? ''
    return {
      kind: 'textEquals',
      value: val,
      ...(textMatch[1] === '!=' ? { notEqual: true } : {}),
    }
  }

  const compMatch = /^(@?[a-zA-Z0-9_:.\\-]+)\s*(!?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))$/.exec(s)
  if (compMatch) {
    const name = compMatch[1]!
    const op = compMatch[2]!
    const val = compMatch[3] !== undefined ? compMatch[3] : compMatch[4] !== undefined ? compMatch[4] : compMatch[5] ?? ''
    if (name.startsWith('@')) {
      return {
        kind: 'attrEquals',
        name: name.slice(1),
        value: val,
        ...(op === '!=' ? { notEqual: true } : {}),
      }
    }
    return {
      kind: 'childEquals',
      tag: name,
      value: val,
      ...(op === '!=' ? { notEqual: true } : {}),
    }
  }

  if (s.startsWith('@')) {
    return { kind: 'attrExists', name: s.slice(1) }
  }

  if (/^[a-zA-Z0-9_:.\\-]+$/.test(s)) {
    return { kind: 'childExists', tag: s }
  }

  return null
}

export function evalPredicate(node: XmlNode, pred: XmlPredicate, indexInMatch: number, totalMatching: number): boolean {
  switch (pred.kind) {
    case 'index': {
      const targetIdx = pred.index < 0 ? totalMatching + pred.index : pred.index
      return indexInMatch === targetIdx
    }
    case 'all':
      return true
    case 'and':
      return pred.predicates.every((p) => evalPredicate(node, p, indexInMatch, totalMatching))
    case 'or':
      return pred.predicates.some((p) => evalPredicate(node, p, indexInMatch, totalMatching))
    case 'localNameEquals': {
      const local = getLocalName(node.tag)
      const eq = local.toLowerCase() === pred.value.toLowerCase()
      return pred.notEqual ? !eq : eq
    }
    case 'attrExists':
      return getAttrValue(node, pred.name) !== undefined
    case 'attrEquals': {
      const val = getAttrValue(node, pred.name)
      if (val !== undefined) {
        return pred.notEqual ? val !== pred.value : val === pred.value
      }
      const child = node.children.find((c) => matchTag(c.tag, pred.name))
      if (child !== undefined) {
        return pred.notEqual ? child.text.trim() !== pred.value.trim() : child.text.trim() === pred.value.trim()
      }
      return pred.notEqual === true
    }
    case 'attrContains': {
      const val = getAttrValue(node, pred.name)
      if (val === undefined) return false
      return val.toLowerCase().includes(pred.value.toLowerCase())
    }
    case 'attrStartsWith': {
      const val = getAttrValue(node, pred.name)
      if (val === undefined) return false
      return val.toLowerCase().startsWith(pred.value.toLowerCase())
    }
    case 'textEquals': {
      const eq = node.text.trim() === pred.value.trim()
      return pred.notEqual ? !eq : eq
    }
    case 'textContains':
      return node.text.toLowerCase().includes(pred.value.toLowerCase())
    case 'childExists':
      return node.children.some((c) => matchTag(c.tag, pred.tag))
    case 'childEquals': {
      const child = node.children.find((c) => matchTag(c.tag, pred.tag))
      if (!child) return pred.notEqual === true
      return pred.notEqual ? child.text.trim() !== pred.value.trim() : child.text.trim() === pred.value.trim()
    }
  }
}

/** Parses a query selector/path into a sequence of steps. Examples: "catalog/book" "feed.entry[0]" "//item[@id='101']" "//DTS:Executable[@DTS:ExecutableType='Microsoft.ExecuteSQLTask']" "items/item[status=active]" "//entry[title='Example']" */
export function parseXmlPath(pathStr: string, opts: { oneBased?: boolean } = {}): XmlSelectorStep[] {
  const oneBased = opts.oneBased === true
  let normalized = pathStr.trim()
  if (normalized === '' || normalized === '/') return []

  const isGlobalRecursive = normalized.startsWith('//')
  if (isGlobalRecursive) {
    normalized = normalized.slice(2)
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }

  // Split by `/` or `.` (outside of bracketed expressions and quotes)
  const segments: string[] = []
  let inBracket = false
  let quoteChar: string | null = null
  let currentSegment = ''

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!
    if (!quoteChar && (ch === '"' || ch === "'")) {
      quoteChar = ch
      currentSegment += ch
    } else if (quoteChar && ch === quoteChar) {
      quoteChar = null
      currentSegment += ch
    } else if (!quoteChar && ch === '[') {
      inBracket = true
      currentSegment += ch
    } else if (!quoteChar && ch === ']') {
      inBracket = false
      currentSegment += ch
    } else if (!quoteChar && !inBracket && (ch === '/' || ch === '.')) {
      if (currentSegment) {
        segments.push(currentSegment)
        currentSegment = ''
      }
      if (ch === '/' && normalized[i + 1] === '/') {
        segments.push('//')
        i++
      }
    } else {
      currentSegment += ch
    }
  }
  if (currentSegment) segments.push(currentSegment)

  const steps: XmlSelectorStep[] = []
  let nextIsRecursive = isGlobalRecursive

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!
    if (s === '//') {
      nextIsRecursive = true
      continue
    }

    const isRecursive = nextIsRecursive
    nextIsRecursive = false

    const attrSelectMatch = /^@([a-zA-Z0-9_:.\\-]+|\*)$/.exec(s)
    if (attrSelectMatch) {
      steps.push({ tag: '', isRecursive, attributeSelect: attrSelectMatch[1]! })
      continue
    }

    // Extract tag and all bracket predicates [...]
    let tag = ''
    const rawPredicates: string[] = []
    let inB = false
    let qChar: string | null = null
    let curPred = ''

    for (let cIdx = 0; cIdx < s.length; cIdx++) {
      const c = s[cIdx]!
      if (!qChar && (c === '"' || c === "'")) {
        qChar = c
        if (inB) curPred += c
      } else if (qChar && c === qChar) {
        qChar = null
        if (inB) curPred += c
      } else if (!qChar && c === '[') {
        if (!inB) {
          inB = true
          curPred = ''
        } else {
          curPred += c
        }
      } else if (!qChar && c === ']') {
        if (inB) {
          inB = false
          rawPredicates.push(curPred.trim())
          curPred = ''
        }
      } else if (!inB) {
        tag += c
      } else {
        curPred += c
      }
    }

    tag = tag.trim()
    if (!tag) tag = '*'

    // An unclosed predicate (`book[@genre='Fantasy'`) or an unterminated quote inside one leaves the scanner mid-clause at the end of the segment, and the half-read clause is discarded. Dropping it silently turns a typo into no predicate at all, so a filtered query answers with every sibling element as a single confident result. Treat the whole segment as the tag instead: it matches no tag, and the caller is told nothing matched rather than being handed the unfiltered list.
    if (inB || qChar !== null) {
      steps.push({ tag: s, isRecursive })
      continue
    }

    const predicates: XmlPredicate[] = []
    let legacyIndex: number | undefined
    let legacyAllIndices: boolean | undefined
    let legacyAttrFilter: XmlSelectorStep['attributeFilter']

    let unreadablePredicate = false
    for (const rawP of rawPredicates) {
      const parsedP = parseSinglePredicate(rawP, oneBased)
      if (!parsedP) {
        unreadablePredicate = true
        break
      }
      predicates.push(parsedP)
      if (parsedP.kind === 'index') {
        legacyIndex = parsedP.index
      } else if (parsedP.kind === 'all') {
        legacyAllIndices = true
      } else if (parsedP.kind === 'attrEquals' || parsedP.kind === 'childEquals') {
        legacyAttrFilter = {
          name: parsedP.kind === 'attrEquals' ? parsedP.name : parsedP.tag,
          value: parsedP.value,
          ...(parsedP.notEqual ? { notEqual: true } : {}),
        }
      }
    }

    // A predicate this parser does not support (`book[not(@archived)]`) is well-formed XPath, so it reaches here parsed as null. Dropping it leaves the step unfiltered and `//book[not(@archived)]` answers with every book, which is the opposite of what was asked. Fall back to the same treatment an unclosed predicate gets: match nothing, so the caller sees an empty result rather than a wrong one.
    if (unreadablePredicate) {
      steps.push({ tag: s, isRecursive })
      continue
    }

    const hasComplexPredicates =
      rawPredicates.length > 1 ||
      predicates.some(
        (p) =>
          p.kind === 'and' ||
          p.kind === 'or' ||
          p.kind === 'localNameEquals' ||
          p.kind === 'attrContains' ||
          p.kind === 'textContains' ||
          p.kind === 'attrStartsWith' ||
          p.kind === 'textEquals' ||
          p.kind === 'attrExists' ||
          p.kind === 'childExists',
      )

    const step: XmlSelectorStep = {
      tag,
      isRecursive,
      ...(legacyIndex !== undefined ? { index: legacyIndex } : {}),
      ...(legacyAllIndices !== undefined ? { allIndices: legacyAllIndices } : {}),
      ...(legacyAttrFilter !== undefined ? { attributeFilter: legacyAttrFilter } : {}),
      ...(hasComplexPredicates ? { predicates } : {}),
    }

    steps.push(step)
  }

  return steps
}
