/**
 * HTML structure inspection, querying, and structural linting for token-goat.
 *
 * Provides a lightweight, zero-dependency, security-safe HTML5 parser, CSS selector
 * engine (`html-query`), structural outliner (`html-outline`), and DOM validator/linter
 * (`html-lint`).
 */

import { displaySafeText } from './paths.js'

export interface HtmlNode {
  tag: string
  attributes: Record<string, string>
  children: HtmlNode[]
  parent: HtmlNode | null
  text: string
  rawHtml: string
  startOffset: number
  endOffset: number
  line: number
  endLine: number
  isVoid: boolean
}

export interface HtmlLintIssue {
  line: number
  type: 'error' | 'warning'
  message: string
  rule: string
}

export interface HtmlLintResult {
  valid: boolean
  errors: HtmlLintIssue[]
  warnings: HtmlLintIssue[]
  tagCounts: Record<string, { open: number; close: number; diff: number }>
}

export interface HtmlOutlineSummary {
  title: string | null
  doctype: string | null
  totalElements: number
  uniqueTags: string[]
  maxDepth: number
  headings: Array<{ level: number; text: string; line: number }>
  landmarks: Array<{ tag: string; id?: string | undefined; class?: string | undefined; line: number }>
  tables: Array<{ id?: string | undefined; class?: string | undefined; rows: number; line: number }>
  forms: Array<{ id?: string | undefined; action?: string | undefined; method?: string | undefined; line: number }>
  scripts: number
  styles: number
}

// HTML5 void elements that do not have closing tags
export const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

// Elements whose contents are raw text, not tags
const RAW_TEXT_TAGS = new Set(['script', 'style'])

/**
 * Scan forward to find the closing '>' of an HTML tag, respecting quoted attribute strings.
 */
function findTagEnd(html: string, startPos: number): number {
  let inQuote: '"' | "'" | null = null
  for (let i = startPos + 1; i < html.length; i++) {
    const ch = html[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '>') {
        return i
      } else if (ch === '<') {
        return -1
      }
    }
  }
  return -1
}

/**
 * Scan forward to find the matching closing tag `</tag>` for raw text elements,
 * case-insensitively and without allocating lowercased copies of the document.
 */
function findRawTextEnd(html: string, startPos: number, tag: string): number {
  const target = `</${tag}`
  const targetLen = target.length
  const limit = html.length - targetLen
  for (let i = startPos; i <= limit; i++) {
    if (html[i] === '<' && html[i + 1] === '/') {
      if (html.slice(i, i + targetLen).toLowerCase() === target) {
        const nextChar = html[i + targetLen]
        if (!nextChar || /\s|>|\//.test(nextChar)) {
          return i
        }
      }
    }
  }
  return html.length
}

/**
 * Tokenize and parse HTML into a DOM tree while tracking line numbers.
 */
export function parseHtml(html: string): {
  root: HtmlNode
  issues: HtmlLintIssue[]
  tagCounts: Record<string, { open: number; close: number; diff: number }>
} {
  const issues: HtmlLintIssue[] = []
  const tagCounts: Record<string, { open: number; close: number; diff: number }> = {}
  const root: HtmlNode = {
    tag: '#root',
    attributes: {},
    children: [],
    parent: null,
    text: '',
    rawHtml: '',
    startOffset: 0,
    endOffset: html.length,
    line: 1,
    endLine: 1,
    isVoid: false,
  }

  let currentParent: HtmlNode = root
  let currentLine = 1
  let pos = 0
  const len = html.length

  const seenIds = new Map<string, number>()

  while (pos < len) {
    if (html[pos] === '\n') {
      currentLine++
      pos++
      continue
    }

    // Check for comment: <!-- ... -->
    if (html.startsWith('<!--', pos)) {
      const endComment = html.indexOf('-->', pos + 4)
      const commentEndPos = endComment !== -1 ? endComment + 3 : len
      const commentLines = (html.slice(pos, commentEndPos).match(/\n/g) || []).length
      currentLine += commentLines
      pos = commentEndPos
      continue
    }

    // Check for DOCTYPE: <!DOCTYPE ...>
    if (html.startsWith('<!doctype', pos) || html.startsWith('<!DOCTYPE', pos)) {
      const endDoc = html.indexOf('>', pos)
      const docEndPos = endDoc !== -1 ? endDoc + 1 : len
      const docLines = (html.slice(pos, docEndPos).match(/\n/g) || []).length
      currentLine += docLines
      pos = docEndPos
      continue
    }

    // Raw text inside <script> or <style>
    if (currentParent && RAW_TEXT_TAGS.has(currentParent.tag.toLowerCase())) {
      const closeTag = `</${currentParent.tag}`
      if (!html.slice(pos, pos + closeTag.length).toLowerCase().startsWith(closeTag.toLowerCase())) {
        const rawTextEnd = findRawTextEnd(html, pos, currentParent.tag.toLowerCase())
        const textContent = html.slice(pos, rawTextEnd)
        currentParent.text += textContent
        const textLines = (textContent.match(/\n/g) || []).length
        currentLine += textLines
        pos = rawTextEnd
        continue
      }
    }

    // Tag opening: <
    if (html[pos] === '<') {
      const tagStartLine = currentLine
      const closeBracket = findTagEnd(html, pos)
      if (closeBracket === -1) {
        issues.push({
          line: tagStartLine,
          type: 'warning',
          message: "Unescaped '<' character in text: consider '&lt;'",
          rule: 'unescaped-angle-bracket',
        })
        if (currentParent) {
          currentParent.text += '<'
        }
        pos++
        continue
      }

      const tagSlice = html.slice(pos, closeBracket + 1)
      const sliceLines = (tagSlice.match(/\n/g) || []).length

      // Closing tag: </tag>
      if (html[pos + 1] === '/') {
        const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9_-]*)\s*>$/i.exec(tagSlice.trim())
        if (closeMatch) {
          const closeTag = closeMatch[1]!.toLowerCase()
          if (!tagCounts[closeTag]) tagCounts[closeTag] = { open: 0, close: 0, diff: 0 }
          if (!HTML_VOID_TAGS.has(closeTag)) {
            tagCounts[closeTag].close++
          }
          if (HTML_VOID_TAGS.has(closeTag)) {
            issues.push({
              line: tagStartLine,
              type: 'warning',
              message: `Void tag <${closeTag}> should not have a closing tag </${closeTag}>`,
              rule: 'void-tag-closing',
            })
          } else {
            // Find matching open tag in parent chain
            let matchNode: HtmlNode | null = currentParent
            while (matchNode && matchNode.tag !== '#root' && matchNode.tag.toLowerCase() !== closeTag) {
              matchNode = matchNode.parent
            }

            if (matchNode && matchNode.tag !== '#root') {
              // Close any intervening unclosed tags
              let unclosed = currentParent
              while (unclosed && unclosed !== matchNode) {
                if (!HTML_VOID_TAGS.has(unclosed.tag.toLowerCase())) {
                  issues.push({
                    line: unclosed.line,
                    type: 'error',
                    message: `Unclosed tag <${unclosed.tag}> before closing </${closeTag}> on line ${tagStartLine}`,
                    rule: 'unclosed-tag',
                  })
                }
                unclosed.endLine = tagStartLine
                unclosed.endOffset = pos
                unclosed = unclosed.parent!
              }
              matchNode.endLine = tagStartLine + sliceLines
              matchNode.endOffset = closeBracket + 1
              currentParent = matchNode.parent || root
            } else {
              issues.push({
                line: tagStartLine,
                type: 'error',
                message: `Unexpected closing tag </${closeTag}> with no matching opening tag`,
                rule: 'stray-closing-tag',
              })
            }
          }
        } else {
          issues.push({ line: tagStartLine, type: 'error', message: `Malformed closing tag: ${tagSlice}`, rule: 'syntax' })
        }

        currentLine += sliceLines
        pos = closeBracket + 1
        continue
      }

      // Opening tag: <tag ...>
      let inner = tagSlice.slice(1, -1).trim()
      let selfClosing = false
      if (inner.endsWith('/')) {
        selfClosing = true
        inner = inner.slice(0, -1).trim()
      }
      const spaceIdx = inner.search(/\s/)
      const rawTagName = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)
      const attrStr = spaceIdx === -1 ? '' : inner.slice(spaceIdx + 1)

      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(rawTagName)) {
        const tagName = rawTagName.toLowerCase()
        const isVoid = HTML_VOID_TAGS.has(tagName) || selfClosing

        if (!tagCounts[tagName]) tagCounts[tagName] = { open: 0, close: 0, diff: 0 }
        tagCounts[tagName].open++
        if (isVoid) {
          tagCounts[tagName].close++
        }

        const attributes: Record<string, string> = {}
        const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
        let attrMatch: RegExpExecArray | null
        while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
          const attrName = attrMatch[1]!.toLowerCase()
          const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
          attributes[attrName] = attrVal

          // ID uniqueness check
          if (attrName === 'id' && attrVal) {
            const prevLine = seenIds.get(attrVal)
            if (prevLine !== undefined) {
              issues.push({
                line: tagStartLine,
                type: 'error',
                message: `Duplicate ID '#${attrVal}' previously defined on line ${prevLine}`,
                rule: 'duplicate-id',
              })
            } else {
              seenIds.set(attrVal, tagStartLine)
            }
          }
        }

        const newNode: HtmlNode = {
          tag: tagName,
          attributes,
          children: [],
          parent: currentParent,
          text: '',
          rawHtml: tagSlice,
          startOffset: pos,
          endOffset: closeBracket + 1,
          line: tagStartLine,
          endLine: tagStartLine + sliceLines,
          isVoid,
        }

        currentParent.children.push(newNode)

        if (!isVoid) {
          currentParent = newNode
        }

        currentLine += sliceLines
        pos = closeBracket + 1
        continue
      }

      // If neither closing nor opening tag matched, treat as unescaped '<' in text
      issues.push({
        line: tagStartLine,
        type: 'warning',
        message: "Unescaped '<' character in text: consider '&lt;'",
        rule: 'unescaped-angle-bracket',
      })
      if (currentParent) {
        currentParent.text += '<'
      }
      pos++
      continue
    }

    // Plain text accumulation
    const nextBracket = html.indexOf('<', pos)
    const textChunkEnd = nextBracket !== -1 ? nextBracket : len
    const textChunk = html.slice(pos, textChunkEnd)
    if (textChunk) {
      if (currentParent) {
        currentParent.text += textChunk
      }
      currentLine += (textChunk.match(/\n/g) || []).length
    }
    pos = textChunkEnd
  }

  // Any remaining unclosed non-void tags
  let dangling: HtmlNode | null = currentParent
  while (dangling && dangling.tag !== '#root') {
    if (!HTML_VOID_TAGS.has(dangling.tag.toLowerCase())) {
      issues.push({
        line: dangling.line,
        type: 'error',
        message: `Unclosed tag <${dangling.tag}> at end of document`,
        rule: 'unclosed-tag',
      })
    }
    dangling.endOffset = len
    dangling = dangling.parent
  }

  for (const tag of Object.keys(tagCounts)) {
    const entry = tagCounts[tag]!
    entry.diff = entry.open - entry.close
  }

  root.endLine = currentLine
  return { root, issues, tagCounts }
}

/**
 * Perform full linting on HTML text, calculating tag counts and structural errors.
 */
export function lintHtml(htmlText: string): HtmlLintResult {
  const { issues, tagCounts } = parseHtml(htmlText)
  const errors = issues.filter((i) => i.type === 'error')
  const warnings = issues.filter((i) => i.type === 'warning')

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    tagCounts,
  }
}

/**
 * Generates a structural outline of an HTML file.
 */
export function outlineHtml(htmlText: string): HtmlOutlineSummary {
  const { root } = parseHtml(htmlText)

  let title: string | null = null
  let doctype: string | null = null

  const docMatch = /<!doctype\s+(\S[^>]*)>/i.exec(htmlText)
  if (docMatch) doctype = docMatch[1]!.trim()

  let totalElements = 0
  const uniqueTags = new Set<string>()
  let maxDepth = 0

  const headings: HtmlOutlineSummary['headings'] = []
  const landmarks: HtmlOutlineSummary['landmarks'] = []
  const tables: HtmlOutlineSummary['tables'] = []
  const forms: HtmlOutlineSummary['forms'] = []
  let scripts = 0
  let styles = 0

  const landmarkTags = new Set(['header', 'nav', 'main', 'article', 'section', 'footer', 'aside'])

  function walk(node: HtmlNode, depth: number) {
    if (node.tag !== '#root') {
      totalElements++
      uniqueTags.add(node.tag)
      if (depth > maxDepth) maxDepth = depth

      const tag = node.tag.toLowerCase()
      if (tag === 'title' && !title) {
        title = node.text.trim()
      } else if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1]!, 10)
        headings.push({ level, text: node.text.replace(/\s+/g, ' ').trim().slice(0, 80), line: node.line })
      } else if (landmarkTags.has(tag)) {
        landmarks.push({
          tag,
          id: node.attributes['id'],
          class: node.attributes['class'],
          line: node.line,
        })
      } else if (tag === 'table') {
        const rows = node.children.flatMap((c) => (c.tag === 'tbody' || c.tag === 'thead' ? c.children : [c])).filter((c) => c.tag === 'tr').length
        tables.push({ id: node.attributes['id'], class: node.attributes['class'], rows, line: node.line })
      } else if (tag === 'form') {
        forms.push({ id: node.attributes['id'], action: node.attributes['action'], method: node.attributes['method'], line: node.line })
      } else if (tag === 'script') {
        scripts++
      } else if (tag === 'style') {
        styles++
      }
    }

    for (const child of node.children) {
      walk(child, depth + 1)
    }
  }

  walk(root, 0)

  return {
    title,
    doctype,
    totalElements,
    uniqueTags: Array.from(uniqueTags).sort(),
    maxDepth,
    headings,
    landmarks,
    tables,
    forms,
    scripts,
    styles,
  }
}

/**
 * Format the HTML outline into readable text for agents.
 */
export function formatHtmlOutline(summary: HtmlOutlineSummary): string {
  const lines: string[] = []
  lines.push(`HTML Document (${summary.totalElements} elements, ${summary.uniqueTags.length} unique tags, max depth ${summary.maxDepth})`)
  // Every interpolation below is a string the document's author chose, landing in a summary line
  // token-goat speaks in its own voice, outside any fence. A page titled `[tg] ...` would otherwise
  // put an unescaped authority marker into that line with nothing to say it came from the document.
  if (summary.title) lines.push(`Title: "${displaySafeText(summary.title)}"`)
  if (summary.doctype) lines.push(`DOCTYPE: ${displaySafeText(summary.doctype)}`)
  lines.push(`Assets: ${summary.scripts} scripts, ${summary.styles} stylesheets`)

  if (summary.headings.length > 0) {
    lines.push('', 'Headings:')
    for (const h of summary.headings.slice(0, 30)) {
      lines.push(`  ${'  '.repeat(h.level - 1)}[h${h.level}] ${displaySafeText(h.text)} (line ${h.line})`)
    }
    if (summary.headings.length > 30) {
      lines.push(`  ... (${summary.headings.length - 30} more headings elided)`)
    }
  }

  if (summary.landmarks.length > 0) {
    lines.push('', 'Landmarks:')
    for (const l of summary.landmarks.slice(0, 25)) {
      const idStr = l.id ? `#${displaySafeText(l.id)}` : ''
      const classStr = l.class ? `.${displaySafeText(l.class.trim().split(/\s+/).join('.'))}` : ''
      lines.push(`  <${displaySafeText(l.tag)}${idStr}${classStr}> (line ${l.line})`)
    }
  }

  if (summary.tables.length > 0) {
    lines.push('', 'Tables:')
    for (const t of summary.tables) {
      const idStr = t.id ? `#${displaySafeText(t.id)}` : ''
      lines.push(`  <table${idStr}> with ~${t.rows} rows (line ${t.line})`)
    }
  }

  if (summary.forms.length > 0) {
    lines.push('', 'Forms:')
    for (const f of summary.forms) {
      const idStr = f.id ? `#${displaySafeText(f.id)}` : ''
      lines.push(`  <form${idStr} method="${displaySafeText(f.method || 'GET')}" action="${displaySafeText(f.action || '')}"> (line ${f.line})`)
    }
  }

  return lines.join('\n')
}

interface AttributeQualifier {
  name: string
  op?: string | undefined
  val?: string | undefined
}

interface ParsedCompoundSelector {
  tag?: string | undefined
  ids: string[]
  classes: string[]
  attributes: AttributeQualifier[]
}

/**
 * Split a string by a delimiter character only when outside quotes (' or ") and brackets ([ ]).
 */
function splitTopLevel(str: string, delimiter: string): string[] {
  const results: string[] = []
  let start = 0
  let inQuote: '"' | "'" | null = null
  let bracketDepth = 0

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!
    if (inQuote) {
      if (ch === inQuote) inQuote = null
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '[') {
        bracketDepth++
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--
      } else if (bracketDepth === 0 && ch === delimiter) {
        results.push(str.slice(start, i))
        start = i + 1
      }
    }
  }
  results.push(str.slice(start))
  return results
}

/**
 * Tokenize a sub-selector into compound selectors and combinators (`>`),
 * respecting quotes and brackets inside attribute selectors.
 */
function tokenizeSelector(sel: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = sel.length

  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(sel[i]!)) i++
    if (i >= n) break

    if (sel[i] === '>') {
      tokens.push('>')
      i++
      continue
    }

    // Read a compound selector token until unquoted/unbracketed whitespace or '>'
    const start = i
    let inQuote: '"' | "'" | null = null
    let bracketDepth = 0

    while (i < n) {
      const ch = sel[i]!
      if (inQuote) {
        if (ch === inQuote) inQuote = null
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = ch
        } else if (ch === '[') {
          bracketDepth++
        } else if (ch === ']') {
          if (bracketDepth > 0) bracketDepth--
        } else if (bracketDepth === 0) {
          if (/\s/.test(ch) || ch === '>') {
            break
          }
        }
      }
      i++
    }

    if (i > start) {
      tokens.push(sel.slice(start, i))
    }
  }

  return tokens
}

/**
 * Parse a single compound selector token into its constituent tag, ids, classes, and attributes.
 * Example: `button.btn.primary#submit[data-action="save"][type="button"]`
 */
function parseCompoundSelector(sel: string): ParsedCompoundSelector {
  const result: ParsedCompoundSelector = {
    ids: [],
    classes: [],
    attributes: [],
  }

  let i = 0
  const n = sel.length

  // Optional tag name at start: e.g. `div`, `h1`, `*`
  if (sel[0] !== '#' && sel[0] !== '.' && sel[0] !== '[') {
    const tagMatch = /^([a-zA-Z*][a-zA-Z0-9_-]*)/.exec(sel)
    if (tagMatch) {
      result.tag = tagMatch[1]
      i = tagMatch[0].length
    }
  }

  while (i < n) {
    const ch = sel[i]
    if (ch === '#') {
      i++
      const idMatch = /^([a-zA-Z0-9_-]+)/.exec(sel.slice(i))
      if (idMatch) {
        result.ids.push(idMatch[1]!)
        i += idMatch[0].length
      }
    } else if (ch === '.') {
      i++
      const classMatch = /^([a-zA-Z0-9_-]+)/.exec(sel.slice(i))
      if (classMatch) {
        result.classes.push(classMatch[1]!)
        i += classMatch[0].length
      }
    } else if (ch === '[') {
      // Find matching ']' respecting quotes
      let endBracket = -1
      let inQuote: '"' | "'" | null = null
      for (let j = i + 1; j < n; j++) {
        const c = sel[j]
        if (inQuote) {
          if (c === inQuote) inQuote = null
        } else {
          if (c === '"' || c === "'") inQuote = c
          else if (c === ']') {
            endBracket = j
            break
          }
        }
      }

      if (endBracket === -1) {
        // Unclosed bracket, terminate
        break
      }

      const inner = sel.slice(i + 1, endBracket).trim()
      i = endBracket + 1

      // Parse attribute name, operator, and value: [attr], [attr=val], [attr="val"]
      const attrMatch = /^([a-zA-Z0-9_:-]+)(?:\s*([*^$!~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]]+)))?$/.exec(inner)
      if (attrMatch) {
        const attrName = attrMatch[1]!.toLowerCase()
        const op = attrMatch[2]
        const val = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5]
        result.attributes.push({ name: attrName, op, val })
      }
    } else {
      // Unrecognized char, skip
      i++
    }
  }

  return result
}

/**
 * Match a compound CSS selector against an HTML node.
 */
function matchesCompoundSelector(node: HtmlNode, sel: string): boolean {
  if (!sel || node.tag === '#root') return false
  if (sel === '*') return true

  const parsed = parseCompoundSelector(sel)

  // 1. Tag check
  if (parsed.tag && parsed.tag !== '*') {
    if (node.tag.toLowerCase() !== parsed.tag.toLowerCase()) return false
  }

  // 2. ID check
  for (const id of parsed.ids) {
    if (node.attributes['id'] !== id) return false
  }

  // 3. Class check (all specified classes must be present)
  if (parsed.classes.length > 0) {
    const nodeClasses = (node.attributes['class'] || '').split(/\s+/).filter(Boolean)
    for (const c of parsed.classes) {
      if (!nodeClasses.includes(c)) return false
    }
  }

  // 4. Attribute checks
  for (const attr of parsed.attributes) {
    const hasAttr = Object.prototype.hasOwnProperty.call(node.attributes, attr.name)
    if (!hasAttr) {
      if (attr.op === '!=') continue
      return false
    }
    if (!attr.op) continue

    const actual = node.attributes[attr.name] || ''
    const val = attr.val ?? ''

    if (attr.op === '=') {
      if (actual !== val) return false
    } else if (attr.op === '^=') {
      if (!actual.startsWith(val)) return false
    } else if (attr.op === '$=') {
      if (!actual.endsWith(val)) return false
    } else if (attr.op === '*=') {
      if (!actual.includes(val)) return false
    } else if (attr.op === '~=') {
      if (!actual.split(/\s+/).includes(val)) return false
    } else if (attr.op === '!=') {
      if (actual === val) return false
    }
  }

  return true
}

export interface HtmlQueryResult {
  elements: HtmlNode[]
  attributeValues?: string[] | undefined
  fanned: boolean
  sourceHtml: string
}

/**
 * Query DOM tree by CSS selector. Supports tags, #id, .class, [attr=val], child (>), descendant (space).
 */
export function queryHtml(
  htmlText: string,
  selectorStr: string,
): HtmlQueryResult {
  const { root } = parseHtml(htmlText)

  let selector = selectorStr.trim()
  let targetAttr: string | undefined

  // Check for trailing @attr extraction syntax (e.g. `a@href`, `#main@data-id`)
  const attrAtMatch = /@([a-zA-Z0-9_:-]+)$/.exec(selector)
  if (attrAtMatch) {
    targetAttr = attrAtMatch[1]!.toLowerCase()
    selector = selector.slice(0, selector.length - attrAtMatch[0].length).trim()
    if (!selector) selector = '*'
  }

  // Handle multiple comma-separated selectors (respecting quotes/brackets)
  const rawSubSelectors = splitTopLevel(selector, ',').map((s) => s.trim()).filter(Boolean)
  const matchedSet = new Set<HtmlNode>()

  for (const subSel of rawSubSelectors) {
    // Parse combinators: split by '>' or space respecting quotes and brackets
    const tokens = tokenizeSelector(subSel)

    let currentCandidates: HtmlNode[] = []

    function collectAll(node: HtmlNode) {
      if (node.tag !== '#root') currentCandidates.push(node)
      for (const c of node.children) collectAll(c)
    }
    collectAll(root)

    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]!
      if (token === '>') {
        const nextTarget = tokens[i + 1]
        if (!nextTarget) break
        const nextCandidates: HtmlNode[] = []
        for (const parent of currentCandidates) {
          for (const child of parent.children) {
            if (nextTarget === '*' || matchesCompoundSelector(child, nextTarget)) {
              nextCandidates.push(child)
            }
          }
        }
        currentCandidates = nextCandidates
        i += 2
      } else {
        // Descendant matching
        if (i === 0) {
          currentCandidates = currentCandidates.filter((node) => token === '*' || matchesCompoundSelector(node, token))
        } else {
          const nextSet = new Set<HtmlNode>()
          for (const ancestor of currentCandidates) {
            function findDescendants(node: HtmlNode) {
              for (const child of node.children) {
                if (token === '*' || matchesCompoundSelector(child, token)) {
                  nextSet.add(child)
                }
                findDescendants(child)
              }
            }
            findDescendants(ancestor)
          }
          currentCandidates = Array.from(nextSet)
        }
        i++
      }
    }

    for (const match of currentCandidates) {
      matchedSet.add(match)
    }
  }

  const elements = Array.from(matchedSet)

  if (targetAttr !== undefined) {
    const attributeValues: string[] = []
    for (const el of elements) {
      if (Object.prototype.hasOwnProperty.call(el.attributes, targetAttr)) {
        attributeValues.push(el.attributes[targetAttr]!)
      }
    }
    return { elements, attributeValues, fanned: attributeValues.length > 1, sourceHtml: htmlText }
  }

  return { elements, fanned: elements.length > 1, sourceHtml: htmlText }
}

/**
 * Extract clean, readable in-order text from an HtmlNode.
 * Strips script/style blocks, comments, and tags, decoding standard HTML entities.
 */
export function extractNodeText(node: HtmlNode, sourceHtml?: string): string {
  if (RAW_TEXT_TAGS.has(node.tag.toLowerCase())) return ''

  if (sourceHtml && node.startOffset !== undefined && node.endOffset !== undefined) {
    const raw = sourceHtml.slice(node.startOffset, node.endOffset)
    const clean = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    return clean.replace(/\s+/g, ' ').trim()
  }

  // Fallback when sourceHtml is not available
  const parts: string[] = []
  if (node.text.trim()) parts.push(node.text.trim())
  for (const child of node.children) {
    const t = extractNodeText(child)
    if (t) parts.push(t)
  }
  return parts.join(' ')
}

/**
 * Serialize an HtmlNode back into HTML markup.
 * If sourceHtml is provided and offsets are valid, slices the exact original source verbatim.
 */
export function serializeHtmlNode(node: HtmlNode, indent = 0, sourceHtml?: string): string {
  if (node.tag === '#root') {
    return node.children.map((c) => serializeHtmlNode(c, indent, sourceHtml)).join('\n')
  }

  if (sourceHtml && node.startOffset !== undefined && node.endOffset !== undefined) {
    return sourceHtml.slice(node.startOffset, node.endOffset)
  }

  const pad = '  '.repeat(indent)
  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => (v !== '' ? `${k}="${v.replace(/"/g, '&quot;')}"` : k))
    .join(' ')
  const attrStr = attrs ? ` ${attrs}` : ''

  if (node.isVoid) {
    return `${pad}<${node.tag}${attrStr}>`
  }

  if (node.children.length === 0) {
    const textTrimmed = node.text.trim()
    if (!textTrimmed) {
      return `${pad}<${node.tag}${attrStr}></${node.tag}>`
    }
    if (!textTrimmed.includes('\n') && textTrimmed.length < 80) {
      return `${pad}<${node.tag}${attrStr}>${textTrimmed}</${node.tag}>`
    }
    return `${pad}<${node.tag}${attrStr}>\n${pad}  ${textTrimmed}\n${pad}</${node.tag}>`
  }

  const inner = node.children.map((c) => serializeHtmlNode(c, indent + 1, sourceHtml)).join('\n')
  return `${pad}<${node.tag}${attrStr}>\n${inner}\n${pad}</${node.tag}>`
}
