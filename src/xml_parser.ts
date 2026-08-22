/**
 * Minimal XML reader for the OOXML parts token-goat extracts (.docx, .pptx, .xlsx).
 *
 * This replaces `fast-xml-parser` as a runtime dependency. The motive is supply-chain surface, not
 * dissatisfaction with that library: its 5.x line fans out to six transitive packages
 * (`@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `xml-naming`,
 * `strnum` -> `anynum`) where 4.x had one, and those five extra maintainer surfaces arrived inside a
 * `^5` range that an existing install accepts without anyone deciding to take them on. What we
 * actually consume is one constructor with four options over machine-generated OOXML, so the whole
 * of it is reproducible here in a few hundred lines with nothing underneath it.
 *
 * The output shape is deliberately byte-identical to what
 * `new XMLParser({ ignoreAttributes: false, preserveOrder: false, trimValues: false, parseTagValue: false })`
 * produced, because `ooxml_extract.ts`, `docx_extract.ts`, `pptx_extract.ts` and `xlsx_reader.ts` all
 * read that shape directly:
 *
 *   - an element with no attributes and no children is its text, so `<b>x</b>` is `"x"` and both
 *     `<b></b>` and `<b/>` are `""`;
 *   - anything else is an object holding, in this order, its child elements, then `#text` if it has
 *     any text at all, then its attributes under an `@_` prefix with the name kept verbatim
 *     including any namespace prefix (`@_w:val`, `@_r:id`);
 *   - repeated sibling elements of the same name fold into an array in document order, so
 *     `<b>1</b><c>2</c><b>3</b>` is `{b: ["1", "3"], c: "2"}`;
 *   - text is never trimmed and never coerced to a number, so a cell reading `007` stays `"007"`;
 *   - comments are dropped, CDATA is inlined as text, and a processing instruction becomes a
 *     `?target` key holding its pseudo-attributes.
 *
 * `tests/xml_parser.test.ts` holds a differential test that runs this parser and the real
 * `fast-xml-parser` (kept as a devDependency for exactly this purpose) over the same corpus and
 * requires deep equality, so the claim above is checked rather than asserted.
 *
 * Two deliberate differences from that library, both documented and tested:
 *
 *   1. Numeric character references are decoded. `fast-xml-parser` leaves `&#65;` and `&#x42;`
 *      standing as literal text under these options, which is data corruption of the same kind the
 *      `parseTagValue: false` note in ooxml_extract.ts describes: a document that writes a curly
 *      quote or an em dash as `&#8217;` came back with the escape showing. They are valid XML in
 *      any producer's output and are decoded here.
 *   2. Nesting deeper than MAX_DEPTH is refused. The library has no such limit, but every consumer
 *      of this tree walks it with a recursive function (`collectElements`, `collectTextRuns`), so a
 *      crafted part nesting tens of thousands deep turns into a stack overflow inside the caller
 *      rather than an error here. Real OOXML nests on the order of ten.
 *
 * On malformed input it stays lenient in the same way the library was, because these commands read
 * files produced by other people's software and a slightly broken part should still give up its
 * text rather than fail the whole command. An unclosed element is closed at end of input, a stray
 * closing tag is ignored, and input containing no markup at all yields an empty object.
 *
 * Security: there is no DTD processing and no entity declaration support of any kind. A `<!DOCTYPE>`
 * block is skipped whole, and the only entities recognised are the five XML built-ins plus numeric
 * references. That closes XXE and entity-expansion ("billion laughs") by construction rather than
 * by a limit, because there is no mechanism present that could resolve an external or user-defined
 * entity in the first place.
 */

/**
 * Maximum element nesting. Guards the recursive walkers in ooxml_extract.ts against a crafted part,
 * not any real document: OOXML from Word, PowerPoint, Excel, LibreOffice and Google's exporters
 * nests around ten deep, so this sits three orders of magnitude above anything legitimate.
 */
export const MAX_XML_DEPTH = 512

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

/**
 * Decodes the five XML built-in entities and numeric character references.
 *
 * An unrecognised entity is left exactly as written rather than dropped or replaced: `&nbsp;` is
 * not defined in XML without a DTD, and silently turning it into a space (or into nothing) would
 * invent content the document does not contain. Leaving it standing at least keeps the text
 * faithful and shows what the producer wrote.
 */
export function decodeXmlEntities(text: string): string {
  // Fast path: the overwhelming majority of OOXML text runs contain no entity at all, and indexOf
  // over the raw string is far cheaper than running the regex to find nothing.
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z_][\w.:-]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const isHex = body.charCodeAt(1) === 0x78 /* x */ || body.charCodeAt(1) === 0x58 /* X */
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = parseInt(digits, isHex ? 16 : 10)
      // Reject anything that is not a character XML can hold: out of Unicode range, or a lone
      // surrogate (which String.fromCodePoint accepts and which would produce an unpaired code
      // unit that later breaks JSON encoding and file writes). Left literal rather than throwing,
      // because one bad reference should not fail a whole document.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      return String.fromCodePoint(code)
    }
    const named = NAMED_ENTITIES[body]
    return named ?? whole
  })
}

/** One element being built. `children` is a Map purely for its insertion order, which the output shape depends on. */
interface Frame {
  name: string
  children: Map<string, unknown>
  text: string[]
  attrs: [string, string][]
}

function newFrame(name: string): Frame {
  return { name, children: new Map(), text: [], attrs: [] }
}

/**
 * Collapses a finished element to its output value. The key order here is the shape contract:
 * children first in first-encounter order, then `#text`, then attributes. It is not cosmetic --
 * `collectTextRuns` and `collectElements` walk `Object.entries`, so this ordering is what keeps
 * collected runs in document order.
 */
function finishFrame(frame: Frame): unknown {
  const text = frame.text.join('')
  if (frame.children.size === 0 && frame.attrs.length === 0) return text
  const obj: Record<string, unknown> = {}
  for (const [key, value] of frame.children) obj[key] = value
  if (text.length > 0) obj['#text'] = text
  for (const [key, value] of frame.attrs) obj[`@_${key}`] = value
  return obj
}

/**
 * Attaches a finished child to its parent, folding a repeat into an array. The first occurrence is
 * stored bare and only becomes a one-element array when a second arrives, which is what makes
 * `{b: "x"}` and `{b: ["x", "y"]}` both possible for the same element name and why every consumer
 * has to handle each -- an existing quirk of the shape, preserved.
 */
function addChild(parent: Frame, name: string, value: unknown): void {
  const existing = parent.children.get(name)
  if (existing === undefined && !parent.children.has(name)) {
    parent.children.set(name, value)
    return
  }
  if (Array.isArray(existing)) {
    existing.push(value)
    return
  }
  parent.children.set(name, [existing, value])
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/**
 * Finds the `>` that ends a tag starting at `from`, ignoring any `>` inside a quoted attribute
 * value. Scanning for a bare `indexOf('>')` truncates `<a k="x>y"/>` mid-attribute; OOXML rarely
 * contains one but a document title or a cell's inline string can.
 */
function findTagEnd(src: string, from: number): number {
  let quote = ''
  for (let i = from; i < src.length; i++) {
    const ch = src[i] as string
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

/**
 * Skips a `<!...>` declaration, which in practice is a DOCTYPE. An internal subset (`<!DOCTYPE x [
 * ... ]>`) can itself contain `>`, so the bracket depth is tracked rather than scanning for the
 * first `>`. Nothing inside is read: this is the point at which a DTD's entity declarations would
 * have to be honoured for an XXE to be possible, and they are not honoured because they are never
 * looked at.
 */
function skipDeclaration(src: string, from: number): number {
  let quote = ''
  let inSubset = false
  for (let i = from + 2; i < src.length; i++) {
    const ch = src[i] as string
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[') inSubset = true
    else if (ch === ']') inSubset = false
    else if (ch === '>' && !inSubset) return i + 1
  }
  return src.length
}

/** Splits a tag's interior into an element/target name and its attributes. */
function parseTagBody(body: string): { name: string; attrs: [string, string][] } {
  let i = 0
  while (i < body.length && !WHITESPACE.has(body[i] as string)) i++
  const name = body.slice(0, i)
  const attrs: [string, string][] = []
  while (i < body.length) {
    while (i < body.length && WHITESPACE.has(body[i] as string)) i++
    if (i >= body.length) break
    const nameStart = i
    while (i < body.length && !WHITESPACE.has(body[i] as string) && body[i] !== '=') i++
    const attrName = body.slice(nameStart, i)
    if (attrName.length === 0) {
      i++
      continue
    }
    while (i < body.length && WHITESPACE.has(body[i] as string)) i++
    if (body[i] !== '=') {
      // A valueless attribute is not well-formed XML, but HTML-ish producers emit one occasionally.
      // Recorded as empty rather than dropped, so the attribute's presence is still visible.
      attrs.push([attrName, ''])
      continue
    }
    i++
    while (i < body.length && WHITESPACE.has(body[i] as string)) i++
    const quote = body[i]
    if (quote === '"' || quote === "'") {
      const valueStart = i + 1
      const valueEnd = body.indexOf(quote, valueStart)
      const end = valueEnd === -1 ? body.length : valueEnd
      attrs.push([attrName, decodeXmlEntities(body.slice(valueStart, end))])
      i = end + 1
    } else {
      const valueStart = i
      while (i < body.length && !WHITESPACE.has(body[i] as string)) i++
      attrs.push([attrName, decodeXmlEntities(body.slice(valueStart, i))])
    }
  }
  return { name, attrs }
}

/**
 * Parses one XML document into the plain object tree described at the top of this file.
 *
 * Never throws on malformed markup; the only error it raises is MAX_XML_DEPTH being exceeded.
 */
export function parseXml(xml: string): Record<string, unknown> {
  // A UTF-8 BOM survives TextDecoder and would otherwise become the first character of the first
  // text node, or break the first tag if it sits before `<`.
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml
  const root = newFrame('')
  const stack: Frame[] = [root]
  const len = src.length
  let i = 0

  const top = (): Frame => stack[stack.length - 1] as Frame

  const pushText = (from: number, to: number): void => {
    if (to > from) top().text.push(decodeXmlEntities(src.slice(from, to)))
  }

  const closeElement = (name: string): void => {
    // Find the nearest open element with this name. A closing tag that matches nothing open is
    // ignored rather than treated as an error, and one that matches an outer element closes
    // everything still open inside it -- both are what the previous library did with the same
    // input, and both keep a truncated or slightly broken part readable.
    let target = -1
    for (let k = stack.length - 1; k >= 1; k--) {
      if ((stack[k] as Frame).name === name) {
        target = k
        break
      }
    }
    if (target === -1) return
    while (stack.length > target) {
      const frame = stack.pop() as Frame
      addChild(top(), frame.name, finishFrame(frame))
    }
  }

  while (i < len) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      pushText(i, len)
      break
    }
    pushText(i, lt)

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end === -1 ? len : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      // CDATA is raw by definition: its content is NOT entity-decoded, so `<![CDATA[&amp;]]>` is
      // the five characters `&amp;` and not `&`.
      top().text.push(src.slice(lt + 9, end === -1 ? len : end))
      i = end === -1 ? len : end + 3
      continue
    }
    if (src.startsWith('<!', lt)) {
      i = skipDeclaration(src, lt)
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      const { name, attrs } = parseTagBody(src.slice(lt + 2, end === -1 ? len : end))
      if (name.length > 0) {
        const frame = newFrame(`?${name}`)
        frame.attrs = attrs
        addChild(top(), frame.name, finishFrame(frame))
      }
      i = end === -1 ? len : end + 2
      continue
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2)
      closeElement(src.slice(lt + 2, end === -1 ? len : end).trim())
      i = end === -1 ? len : end + 1
      continue
    }

    const end = findTagEnd(src, lt + 1)
    const tagEnd = end === -1 ? len : end
    let body = src.slice(lt + 1, tagEnd)
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1)
    const { name, attrs } = parseTagBody(body)
    i = end === -1 ? len : end + 1
    if (name.length === 0) continue

    const frame = newFrame(name)
    frame.attrs = attrs
    if (selfClosing) {
      addChild(top(), name, finishFrame(frame))
      continue
    }
    if (stack.length > MAX_XML_DEPTH) {
      throw new Error(`XML nesting deeper than ${MAX_XML_DEPTH} elements; refusing to parse (this file is not something any office application produces)`)
    }
    stack.push(frame)
  }

  // Anything still open at end of input is closed here, so a truncated part still yields whatever
  // it managed to say rather than nothing at all.
  while (stack.length > 1) {
    const frame = stack.pop() as Frame
    addChild(top(), frame.name, finishFrame(frame))
  }
  return Object.fromEntries(root.children)
}
