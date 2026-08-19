/**
 * XML structure inspection and querying for token-goat.
 *
 * Provides lightweight, generic, security-safe XML parsing without external entity resolution (XXE safe)
 * for structural outlining (`xml-outline`) and tag/path querying (`xml-query`).
 *
 * Deliberately generic and schema-agnostic: makes no assumptions about specific XML vocabularies,
 * namespaces, or domain models.
 */

export interface XmlNode {
  tag: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
  line: number
}

export interface XmlOutlineSummary {
  rootTag: string
  namespaces: Record<string, string>
  doctype: string | null
  totalElements: number
  uniqueTags: string[]
  maxDepth: number
  tree: XmlOutlineElement
}

export interface XmlOutlineElement {
  tag: string
  attributes: Record<string, string>
  childCount: number
  children: XmlOutlineElement[]
  textLength: number
}

/** Decodes standard XML entities and numeric character references. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:quot|apos|lt|gt|amp|#x([0-9a-fA-F]+)|#([0-9]+));/g, (match, hex, dec) => {
    if (match === '&quot;') return '"'
    if (match === '&apos;') return "'"
    if (match === '&lt;') return '<'
    if (match === '&gt;') return '>'
    if (match === '&amp;') return '&'
    if (hex !== undefined) {
      const code = parseInt(hex, 16)
      try {
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      } catch {
        return match
      }
    }
    if (dec !== undefined) {
      const code = parseInt(dec, 10)
      try {
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      } catch {
        return match
      }
    }
    return match
  })
}

/** Escapes text for XML element text content. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escapes text for XML attribute values. */
export function escapeXmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Fast, generic, secure XML tokenizer and tree builder without external entity loading.
 * Handles elements, attributes, self-closing tags, CDATA, comments, processing instructions, and DOCTYPE.
 */
export function parseXml(xmlText: string): XmlNode {
  const { root } = parseXmlTree(xmlText)
  if (!root) {
    throw new Error('No valid XML root element found')
  }
  return root
}

export function parseXmlTree(xmlText: string): {
  root: XmlNode | null
  namespaces: Record<string, string>
  doctype: string | null
  totalElements: number
} {
  let text = xmlText.trim()
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // Strip BOM

  let doctype: string | null = null
  const namespaces: Record<string, string> = {}
  let totalElements = 0

  // Match DOCTYPE if present
  const doctypeMatch = /<!DOCTYPE\s+([^>[\]]+(?:\[[\s\S]*?\])?\s*)>/i.exec(text)
  if (doctypeMatch) {
    doctype = doctypeMatch[1]?.trim() ?? null
  }

  function parseAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    const attrRegex = /([a-zA-Z0-9_:.\\-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let m: RegExpExecArray | null
    while ((m = attrRegex.exec(attrString)) !== null) {
      const name = m[1]!
      const rawVal = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] ?? ''
      const val = decodeXmlEntities(rawVal)
      attrs[name] = val
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        namespaces[name] = val
      }
    }
    return attrs
  }

  // Tokenize elements, comments, CDATA, and processing instructions
  const tagRegex =
    /<(\/)?([a-zA-Z0-9_:.\\-]+)([^>]*?)(\/)?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/gi

  const stack: XmlNode[] = []
  let rootNode: XmlNode | null = null
  let match: RegExpExecArray | null
  let lastIndex = 0

  while ((match = tagRegex.exec(text)) !== null) {
    const fullMatch = match[0]!
    const isClosing = match[1] === '/'
    const tagName = match[2]
    const attrText = match[3] ?? ''
    const isSelfClosing = match[4] === '/' || fullMatch.endsWith('/>')
    const cdataContent = match[5]

    // Capture text preceding the tag
    if (stack.length > 0 && match.index > lastIndex) {
      const textChunk = decodeXmlEntities(text.slice(lastIndex, match.index).trim())
      if (textChunk) {
        stack[stack.length - 1]!.text += (stack[stack.length - 1]!.text ? ' ' : '') + textChunk
      }
    }

    if (cdataContent !== undefined) {
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += (stack[stack.length - 1]!.text ? ' ' : '') + cdataContent.trim()
      }
      lastIndex = tagRegex.lastIndex
      continue
    }

    if (!tagName) {
      // Comment, PI, or DOCTYPE
      lastIndex = tagRegex.lastIndex
      continue
    }

    const line = (text.slice(0, match.index).match(/\n/g) || []).length + 1

    if (isClosing) {
      if (stack.length > 0) {
        let popIdx = stack.length - 1
        while (popIdx >= 0 && stack[popIdx]!.tag !== tagName) {
          popIdx--
        }
        if (popIdx >= 0) {
          while (stack.length > popIdx) {
            stack.pop()
          }
        }
      }
    } else {
      totalElements++
      const attrs = parseAttributes(attrText)
      const newNode: XmlNode = {
        tag: tagName,
        attributes: attrs,
        children: [],
        text: '',
        line,
      }

      if (stack.length === 0) {
        if (!rootNode) rootNode = newNode
      } else {
        stack[stack.length - 1]!.children.push(newNode)
      }

      if (!isSelfClosing) {
        stack.push(newNode)
      }
    }

    lastIndex = tagRegex.lastIndex
  }

  return { root: rootNode, namespaces, doctype, totalElements }
}

/**
 * Builds a structural outline of an XML document bounded by maxDepth.
 */
export function outlineXml(xmlText: string, opts: { maxDepth?: number } = {}): XmlOutlineSummary {
  const maxDepth = opts.maxDepth ?? 4
  const { root, namespaces, doctype, totalElements } = parseXmlTree(xmlText)
  if (!root) {
    throw new Error('No valid XML root element found')
  }

  const uniqueTags = new Set<string>()
  let maxTreeDepth = 1

  function buildElementOutline(node: XmlNode, currentDepth: number): XmlOutlineElement {
    uniqueTags.add(node.tag)
    if (currentDepth > maxTreeDepth) maxTreeDepth = currentDepth

    const keyAttrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(node.attributes)) {
      if (!k.startsWith('xmlns')) {
        keyAttrs[k] = v
      }
    }

    const children: XmlOutlineElement[] = []
    if (currentDepth < maxDepth) {
      const tagCounts: Record<string, number> = {}
      for (const child of node.children) {
        tagCounts[child.tag] = (tagCounts[child.tag] || 0) + 1
      }

      for (const child of node.children) {
        const count = tagCounts[child.tag] || 0
        const existingWithTag = children.filter((c) => c.tag === child.tag).length
        if (count > 5 && existingWithTag >= 3) {
          if (existingWithTag === 3) {
            children.push({
              tag: `... (${count - 3} more <${child.tag}> elements)`,
              attributes: {},
              childCount: 0,
              children: [],
              textLength: 0,
            })
          }
          continue
        }
        children.push(buildElementOutline(child, currentDepth + 1))
      }
    }

    return {
      tag: node.tag,
      attributes: keyAttrs,
      childCount: node.children.length,
      children,
      textLength: node.text.length,
    }
  }

  const tree = buildElementOutline(root, 1)

  return {
    rootTag: root.tag,
    namespaces,
    doctype,
    totalElements,
    uniqueTags: Array.from(uniqueTags).sort(),
    maxDepth: maxTreeDepth,
    tree,
  }
}

/**
 * Formats an XML outline into a clean, human-readable hierarchy.
 */
export function formatXmlOutline(summary: XmlOutlineSummary): string {
  const lines: string[] = []
  lines.push(
    `Root element: <${summary.rootTag}> (${summary.totalElements} total elements, ${summary.uniqueTags.length} unique tags, max depth ${summary.maxDepth})`,
  )

  if (summary.doctype) {
    lines.push(`DOCTYPE: ${summary.doctype}`)
  }

  const nsKeys = Object.keys(summary.namespaces)
  if (nsKeys.length > 0) {
    lines.push('Namespaces:')
    for (const [k, v] of Object.entries(summary.namespaces)) {
      lines.push(`  ${k}: ${v}`)
    }
  }

  lines.push('')
  lines.push('Element hierarchy:')

  function renderNode(node: XmlOutlineElement, indent: number) {
    const pad = '  '.repeat(indent)
    const attrParts: string[] = []
    const attrKeys = Object.keys(node.attributes)

    for (const [k, v] of Object.entries(node.attributes)) {
      if (
        ['id', 'name', 'type', 'key', 'class', 'code', 'status', 'value'].includes(k.toLowerCase()) ||
        attrKeys.length <= 3
      ) {
        const valPreview = v.length > 35 ? `${v.slice(0, 32)}...` : v
        attrParts.push(`${k}="${valPreview}"`)
      }
    }

    const attrStr = attrParts.length > 0 ? ` [${attrParts.join(' ')}]` : ''
    const countStr =
      node.childCount > 0
        ? ` (${node.childCount} children)`
        : node.textLength > 0
          ? ` (~${node.textLength} chars text)`
          : ' (empty)'

    lines.push(`${pad}<${node.tag}>${attrStr}${countStr}`)

    for (const child of node.children) {
      renderNode(child, indent + 1)
    }
  }

  renderNode(summary.tree, 0)

  return lines.join('\n')
}

export interface XmlSelectorStep {
  tag: string
  isRecursive: boolean
  index?: number | undefined
  allIndices?: boolean | undefined
  attributeFilter?: { name: string; value?: string | undefined; notEqual?: boolean | undefined } | undefined
  attributeSelect?: string | undefined
}

export interface XmlQueryResult {
  items: XmlNode[]
  attributeValues?: string[]
  fanned: boolean
}

/**
 * Parses a query selector/path into a sequence of steps.
 * Examples:
 *   "catalog/book"
 *   "feed.entry[0]"
 *   "//item[@id='101']"
 *   "items/item[status=active]"
 *   "//entry[title='Example']"
 */
export function parseXmlPath(pathStr: string): XmlSelectorStep[] {
  let normalized = pathStr.trim()
  if (normalized === '' || normalized === '/') return []

  const isGlobalRecursive = normalized.startsWith('//')
  if (isGlobalRecursive) {
    normalized = normalized.slice(2)
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }

  // Split by `/` or `.` (outside of bracketed expressions)
  const segments: string[] = []
  let inBracket = false
  let currentSegment = ''

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!
    if (ch === '[') {
      inBracket = true
      currentSegment += ch
    } else if (ch === ']') {
      inBracket = false
      currentSegment += ch
    } else if (!inBracket && (ch === '/' || ch === '.')) {
      if (currentSegment) {
        segments.push(currentSegment)
        currentSegment = ''
      }
      if (ch === '/' && normalized[i + 1] === '/') {
        // Handle intermediate `//` descendant selector
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

    const indexMatch = /\[(-?\d+)\]$/.exec(s)
    const wildcardMatch = /\[\*\]$/.exec(s)
    const attrMatch = /\[@?([a-zA-Z0-9_:.\\-]+)(?:(!?=)\s*["']?([^"'\]]*)["']?)?\]$/.exec(s)

    let tag = s.replace(/\[.*\]$/, '')
    if (!tag) tag = '*'

    let index: number | undefined
    let allIndices: boolean | undefined
    let attributeFilter: XmlSelectorStep['attributeFilter']

    if (indexMatch) {
      index = parseInt(indexMatch[1]!, 10)
    } else if (wildcardMatch) {
      allIndices = true
    } else if (attrMatch) {
      const [, attrName, op, attrVal] = attrMatch
      attributeFilter = {
        name: attrName!,
        ...(attrVal !== undefined ? { value: attrVal } : {}),
        ...(op === '!=' ? { notEqual: true } : {}),
      }
    }

    const step: XmlSelectorStep = { tag, isRecursive }
    if (index !== undefined) step.index = index
    if (allIndices !== undefined) step.allIndices = allIndices
    if (attributeFilter !== undefined) step.attributeFilter = attributeFilter
    steps.push(step)
  }

  return steps
}

/**
 * Serializes an XmlNode back to a formatted XML string.
 */
export function serializeXmlNode(node: XmlNode, indent = 0): string {
  const pad = '  '.repeat(indent)
  const attrParts: string[] = []
  for (const [k, v] of Object.entries(node.attributes)) {
    attrParts.push(`${k}="${escapeXmlAttr(v)}"`)
  }
  const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : ''

  if (node.children.length === 0 && !node.text) {
    return `${pad}<${node.tag}${attrStr}/>`
  }

  if (node.children.length === 0) {
    return `${pad}<${node.tag}${attrStr}>${escapeXmlText(node.text)}</${node.tag}>`
  }

  const lines: string[] = []
  lines.push(`${pad}<${node.tag}${attrStr}>`)
  if (node.text) {
    lines.push(`${pad}  ${escapeXmlText(node.text)}`)
  }
  for (const child of node.children) {
    lines.push(serializeXmlNode(child, indent + 1))
  }
  lines.push(`${pad}</${node.tag}>`)
  return lines.join('\n')
}

function getAllDescendants(node: XmlNode): XmlNode[] {
  const desc: XmlNode[] = []
  function walk(n: XmlNode) {
    for (const c of n.children) {
      desc.push(c)
      walk(c)
    }
  }
  walk(node)
  return desc
}

/**
 * Converts an XmlNode into a clean JSON-serializable object/value.
 */
export function xmlNodeToJson(node: XmlNode): unknown {
  const hasAttrs = Object.keys(node.attributes).length > 0
  const hasChildren = node.children.length > 0

  if (!hasChildren && !hasAttrs) {
    return node.text
  }

  if (!hasChildren) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node.attributes)) {
      result[`@${k}`] = v
    }
    if (node.text) {
      result['#text'] = node.text
    }
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.attributes)) {
    result[`@${k}`] = v
  }

  // Group children by tag
  const childGroups = new Map<string, XmlNode[]>()
  for (const child of node.children) {
    const existing = childGroups.get(child.tag)
    if (existing !== undefined) {
      existing.push(child)
    } else {
      childGroups.set(child.tag, [child])
    }
  }

  for (const [tag, group] of childGroups) {
    if (group.length === 1) {
      result[tag] = xmlNodeToJson(group[0]!)
    } else {
      result[tag] = group.map(xmlNodeToJson)
    }
  }

  if (node.text) {
    result['#text'] = node.text
  }

  return result
}

/**
 * Queries XML nodes matching the path selector.
 */
export function queryXml(xmlText: string, pathStr: string): XmlQueryResult {
  const { root } = parseXmlTree(xmlText)
  if (!root) {
    throw new Error('No valid XML root element found')
  }

  const steps = parseXmlPath(pathStr)
  if (steps.length === 0) {
    return { items: [root], fanned: false }
  }

  let currentCandidates: XmlNode[] = [root]
  let hasFanned = false
  let isAtRootLevel = true

  for (let sIdx = 0; sIdx < steps.length; sIdx++) {
    const step = steps[sIdx]!

    if (step.attributeSelect !== undefined) {
      const attrVals: string[] = []
      const attrName = step.attributeSelect
      for (const cand of currentCandidates) {
        if (attrName === '*') {
          attrVals.push(...Object.values(cand.attributes))
        } else if (cand.attributes[attrName] !== undefined) {
          attrVals.push(cand.attributes[attrName]!)
        }
      }
      return {
        items: currentCandidates,
        attributeValues: attrVals,
        fanned: hasFanned || attrVals.length > 1,
      }
    }

    const nextCandidates: XmlNode[] = []

    // If first non-recursive step explicitly targets root (e.g. `catalog` or `*`), evaluate against root itself
    const evaluateOnCurrentNode =
      isAtRootLevel &&
      !step.isRecursive &&
      (step.tag === '*' || step.tag.toLowerCase() === root.tag.toLowerCase())
    isAtRootLevel = false

    for (const cand of currentCandidates) {
      let targets: XmlNode[]
      if (evaluateOnCurrentNode) {
        targets = [cand]
      } else if (step.isRecursive) {
        targets = [cand, ...getAllDescendants(cand)]
      } else {
        targets = cand.children
      }

      let matching = targets.filter((c) => step.tag === '*' || c.tag.toLowerCase() === step.tag.toLowerCase())

      if (step.attributeFilter) {
        const af = step.attributeFilter
        matching = matching.filter((c) => {
          // Check attributes first
          const attrVal = c.attributes[af.name]
          if (attrVal !== undefined) {
            if (af.value === undefined) return true
            return af.notEqual ? attrVal !== af.value : attrVal === af.value
          }
          // Also check child elements whose tag matches af.name
          const childElem = c.children.find((child) => child.tag.toLowerCase() === af.name.toLowerCase())
          if (childElem !== undefined) {
            if (af.value === undefined) return true
            return af.notEqual ? childElem.text !== af.value : childElem.text === af.value
          }
          return af.notEqual === true
        })
      }

      if (step.index !== undefined) {
        const idx = step.index < 0 ? matching.length + step.index : step.index
        if (idx >= 0 && idx < matching.length) {
          nextCandidates.push(matching[idx]!)
        }
      } else {
        if (step.allIndices || matching.length > 1 || step.attributeFilter !== undefined) {
          hasFanned = true
        }
        nextCandidates.push(...matching)
      }
    }

    currentCandidates = nextCandidates
  }

  return { items: currentCandidates, fanned: hasFanned || currentCandidates.length > 1 }
}

