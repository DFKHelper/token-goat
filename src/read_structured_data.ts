import * as fs from 'fs'
import { FAILSAFE_SCHEMA, loadAll as loadAllYaml, type LoadOptions } from 'js-yaml'

import { formatCsvProfile, formatCsvTable, parseWhereSpecs, profileCsv, queryCsv } from './csv_query.js'
import { displaySafeJson, displaySafeText } from './paths.js'
import {
  extractNodeText,
  formatHtmlOutline,
  lintHtml,
  outlineHtml,
  queryHtml,
  serializeHtmlNode,
} from './html_query.js'
import { UNTRUSTED_HTML_TAG } from './injection_scan.js'
import { formatJsonOutline, noMatchMessage, outlineJson, queryJson } from './json_query.js'
import { parseJsonOrJsonc } from './jsonc_text.js'
import {
  extractOperations,
  findOperation,
  formatOperationDetail,
  formatOpenApiOutline,
  operationLabel,
  parseOpenApiSpec,
} from './openapi_query.js'
import { emitGuarded, guardJsonRows, guardRedactAndFence, readFileText, recordReadStat, sumFileSizes } from './read_commands.js'
import { didYouMean, rankSimilarNames } from './read_suggest.js'
import { CliError, formatCommandError } from './command_error.js'
import { emit, emitErr } from './emit.js'
import { headElidedNotice, traversalLimitNotice } from './query_notices.js'
import { fenceFieldIfMatched, fenceFileFieldIfMatched, fenceFileText, fenceJsonStrings } from './untrusted_fence.js'
import { extractErrorMessage, requireNonNegativeStrictInt } from './util.js'
import {
  formatXmlOutline,
  outlineXml,
  queryXml,
  serializeXmlNode,
  tryDecodeEmbeddedXml,
  xmlNodeToJson,
  type XmlOutlineSummary,
} from './xml_query.js'
import { echoedValue, quotedArg } from './hint_suggestion_guard.js'

/** {@link fenceFieldIfMatched} under the HTML tag, for one string of an html-query or html-outline `--json` envelope. */
function fenceHtmlFieldIfMatched(text: string): string {
  return fenceFieldIfMatched(text, UNTRUSTED_HTML_TAG)
}

export interface CsvQueryCliOptions {
  file: string
  columns?: string
  where?: string[]
  head?: string
  json?: boolean
  delimiter?: string
  noHeader?: boolean
}

export function runCsvQuery(opts: CsvQueryCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  const columns = opts.columns
    ? opts.columns
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }

  try {
    const wheres = parseWhereSpecs(opts.where)
    const result = queryCsv(text, {
      ...(columns !== undefined ? { columns } : {}),
      ...(wheres !== undefined ? { wheres } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
      ...(opts.noHeader === true ? { noHeader: true } : {}),
    })
    if (result.header.length === 0) {
      emit(`No data rows found in ${displaySafeText(opts.file)}`)
      return 0
    }
    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      const keys = result.header.map((h) => fenceFileFieldIfMatched(h))
      const rowsJson = result.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, fenceFileFieldIfMatched(r[i] ?? '')])))
      const headTruncated = result.rows.length < result.totalRows
      const capped = guardJsonRows(rowsJson)
      const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount: result.totalRows, ...(result.totalRows === 0 && result.preFilterRows > 0 ? { filteredFromRows: result.preFilterRows } : {}) }, 0)
      emit(jsonText)
      recordReadStat('csv_query', fullSourceBytes, jsonText, opts.file)
    } else {
      const tableText = fenceFileText(formatCsvTable(result, (opts.where ?? []).map((w) => `--where ${w}`)))
      emit(tableText)
      recordReadStat('csv_query', fullSourceBytes, tableText, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }
}

export interface CsvProfileCliOptions {
  file: string
  delimiter?: string
  noHeader?: boolean
}

export function runCsvProfile(opts: CsvProfileCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }
  try {
    const profiles = profileCsv(text, {
      ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
      ...(opts.noHeader === true ? { noHeader: true } : {}),
    })
    if (profiles.length === 0) {
      emit(`No data rows found in ${displaySafeText(opts.file)}`)
      return 0
    }
    const fullSourceBytes = sumFileSizes([opts.file])
    const profileText = fenceFileText(formatCsvProfile(profiles))
    emit(profileText)
    recordReadStat('csv_profile', fullSourceBytes, profileText, opts.file)
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }
}

export interface JsonOutlineCliOptions {
  file: string
  json?: boolean
  /** Keep only the top-level object keys containing this text, case-insensitively. */
  filter?: string
}

function runOutlineCommand(opts: JsonOutlineCliOptions, parse: (text: string) => unknown, formatLabel: string, kind: string): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let data: unknown
  try {
    data = parse(text)
  } catch {
    emitErr(formatCommandError(`Failed to parse ${formatLabel}: ${opts.file}`))
    return 1
  }

  const outline = outlineJson(data, opts.filter === undefined ? {} : { keyFilter: opts.filter })
  // Named rather than ignored: an array or scalar has no keys to narrow, and an unfiltered listing returned for a filtered request reads as though every entry matched.
  if (opts.filter !== undefined && outline.kind !== 'object') {
    emitErr(formatCommandError(`--filter narrows an object's keys, and the top level of ${opts.file} is ${outline.kind === 'array' ? 'an array' : 'a scalar'}`))
    return 1
  }
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(outline, 0)
    emit(jsonText)
    recordReadStat(kind, fullSourceBytes, jsonText, opts.file)
  } else {
    const text2 = formatJsonOutline(outline)
    emit(text2)
    recordReadStat(kind, fullSourceBytes, text2, opts.file)
  }
  return 0
}

export function runJsonOutline(opts: JsonOutlineCliOptions): number {
  return runOutlineCommand(opts, parseJsonOrJsonc, 'JSON', 'json_outline')
}

export interface JsonQueryCliOptions {
  file: string
  path: string
  head?: string
  json?: boolean
}

function readQueryInput(file: string): string | null {
  if (file === '-') {
    if (process.stdin.isTTY) {
      emitErr(formatCommandError('stdin is a terminal: pipe a document in or pass a file'))
      return null
    }
    let text: string
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (e) {
      emitErr(formatCommandError(`Could not read stdin: ${e instanceof Error ? e.message : String(e)}`))
      return null
    }
    if (text.trim() === '') {
      emitErr(formatCommandError('stdin was empty: pipe a document in or pass a file'))
      return null
    }
    return text
  }
  return readFileText(file)
}

function runQueryCommand(
  opts: JsonQueryCliOptions,
  parse: (text: string) => unknown,
  formatLabel: string,
  guardTag: string,
  kind: string,
): number {
  const text = readQueryInput(opts.file)
  if (text === null) {
    if (opts.file !== '-') {
      emitErr(formatCommandError(`Could not read: ${opts.file}`))
    }
    return 1
  }

  let data: unknown
  try {
    data = parse(text)
  } catch {
    emitErr(formatCommandError(`Failed to parse ${formatLabel}: ${opts.file === '-' ? '<stdin>' : opts.file}`))
    return 1
  }

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }

  try {
    const result = queryJson(data, opts.path)
    const fullSourceBytes = opts.file === '-' ? Buffer.byteLength(text) : sumFileSizes([opts.file])
    const detail = opts.file === '-' ? '<stdin>' : opts.file

    if (!result.fanned) {
      const value = result.items[0]
      const valueText = opts.json === true ? displaySafeJson(value, 0) : displaySafeJson(value)
      emit(valueText)
      recordReadStat(kind, fullSourceBytes, valueText, detail)
      return 0
    }

    const totalCount = result.items.length
    // Zero matches is a miss, exit 1 like a missing key, and xml-query's empty envelope under --json; a search the traversal limit cut short is not conclusive, so it keeps its notice below.
    if (totalCount === 0 && !result.truncated) {
      if (opts.json === true) {
        const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0)
        emit(jsonText)
        recordReadStat(kind, fullSourceBytes, jsonText, detail)
      }
      emitErr(formatCommandError(noMatchMessage(opts.path, result)))
      return 1
    }
    const limited = head !== undefined ? result.items.slice(0, head) : result.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited)
      const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated || result.truncated, totalCount }, 0)
      emit(jsonText)
      recordReadStat(kind, fullSourceBytes, jsonText, detail)
    } else {
      const lines = limited.map((item) => displaySafeJson(item, 0))
      if (headTruncated) {
        lines.push(headElidedNotice(totalCount - limited.length, 'item'))
      }
      if (result.truncated) {
        lines.push(traversalLimitNotice(totalCount))
      }
      const plainText = lines.join('\n')
      emitGuarded(plainText, guardTag)
      recordReadStat(kind, fullSourceBytes, plainText, detail)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }
}

export function runJsonQuery(opts: JsonQueryCliOptions): number {
  return runQueryCommand(opts, parseJsonOrJsonc, 'JSON', 'json-query', 'json_query')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

function resolveYamlMergeKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveYamlMergeKeys)
  if (!isPlainObject(node)) return node
  const merged: Record<string, unknown> = {}
  const mergeVal = node['<<']
  if (mergeVal !== undefined) {
    const sources = Array.isArray(mergeVal) ? mergeVal : [mergeVal]
    for (const src of [...sources].reverse()) {
      const resolved = resolveYamlMergeKeys(src)
      if (isPlainObject(resolved)) Object.assign(merged, resolved)
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '<<') continue
    merged[key] = resolveYamlMergeKeys(value)
  }
  return merged
}

export function parseYamlDocument(text: string): unknown {
  return loadYamlDocument(text)
}

/** The same document with every scalar kept as the text it was written as (`2.0` stays `2.0`, `~` stays `~`), for printing one value back the way the file spells it. */
export function parseYamlDocumentAsWritten(text: string): unknown {
  return loadYamlDocument(text, { schema: FAILSAFE_SCHEMA })
}

function loadYamlDocument(text: string, options?: LoadOptions): unknown {
  const docs = loadAllYaml(text, options).map(resolveYamlMergeKeys)
  // A trailing/leading `---` or a comment-only document parses to an empty (null) document; it must not turn a single real document into a stream.
  const real = docs.filter((d) => d !== null && d !== undefined)
  if (real.length === 0) return docs.length === 1 ? docs[0] : null
  return real.length === 1 ? real[0] : docs
}

export function runYamlOutline(opts: JsonOutlineCliOptions): number {
  return runOutlineCommand(opts, parseYamlDocument, 'YAML', 'yaml_outline')
}

export function runYamlQuery(opts: JsonQueryCliOptions): number {
  return runQueryCommand(opts, parseYamlDocument, 'YAML', 'yaml-query', 'yaml_query')
}

export interface XmlOutlineCliOptions {
  file: string
  json?: boolean
  maxDepth?: number
}

export function runXmlOutline(opts: XmlOutlineCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let summary: XmlOutlineSummary
  try {
    summary = outlineXml(text, { ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}) })
  } catch (e) {
    emitErr(formatCommandError(new CliError([`Failed to parse XML: ${opts.file}`, extractErrorMessage(e)])))
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(summary)
    emit(jsonText)
    recordReadStat('xml_outline', fullSourceBytes, jsonText, opts.file)
  } else {
    const outlineText = formatXmlOutline(summary)
    emitGuarded(outlineText, 'xml-outline')
    recordReadStat('xml_outline', fullSourceBytes, outlineText, opts.file)
  }
  return 0
}

export interface XmlQueryCliOptions {
  file: string
  path?: string
  xpath?: string
  head?: string
  json?: boolean
  withLines?: boolean
  decodeEmbeddedXml?: boolean
}

export function runXmlQuery(opts: XmlQueryCliOptions): number {
  const text = readQueryInput(opts.file)
  if (text === null) {
    if (opts.file !== '-') {
      emitErr(formatCommandError(`Could not read: ${opts.file}`))
    }
    return 1
  }

  const queryPath = (opts.xpath ?? opts.path ?? '').trim()
  if (!queryPath) {
    emitErr(formatCommandError('Must provide a path or --xpath <expression>'))
    return 1
  }

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }

  try {
    const result = queryXml(text, queryPath, { ...(opts.xpath !== undefined ? { xpath: opts.xpath } : {}) })
    const fullSourceBytes = opts.file === '-' ? Buffer.byteLength(text) : sumFileSizes([opts.file])
    const detail = opts.file === '-' ? '<stdin>' : opts.file

    if (result.attributeValues !== undefined) {
      if (result.attributeValues.length === 0) {
        if (opts.json === true) {
          const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0)
          emit(jsonText)
          recordReadStat('xml_query', fullSourceBytes, jsonText, detail)
        } else {
          emitErr(formatCommandError(`No attributes matched path: '${queryPath}'`))
        }
        return 1
      }

      const totalCount = result.attributeValues.length
      const limitedNodes =
        result.attributeNodes !== undefined
          ? head !== undefined
            ? result.attributeNodes.slice(0, head)
            : result.attributeNodes
          : undefined
      const limited = head !== undefined ? result.attributeValues.slice(0, head) : result.attributeValues
      const headTruncated = limited.length < totalCount

      if (!result.fanned && totalCount === 1) {
        let val = limited[0] ?? ''
        if (opts.decodeEmbeddedXml) {
          const decoded = tryDecodeEmbeddedXml(val)
          if (decoded.decoded) val = decoded.text
        }
        let outText = ''
        if (opts.json === true) {
          if (opts.withLines && limitedNodes && limitedNodes[0]) {
            outText = displaySafeJson(
              { value: val, lineStart: limitedNodes[0].node.line, lineEnd: limitedNodes[0].node.lineEnd },
              0,
            )
          } else {
            outText = displaySafeJson(val, 0)
          }
        } else {
          if (opts.withLines && limitedNodes && limitedNodes[0]) {
            outText = `# Line: L${limitedNodes[0].node.line}\n${val}`
          } else {
            outText = val
          }
        }
        emit(outText)
        recordReadStat('xml_query', fullSourceBytes, outText, detail)
        return 0
      }

      if (opts.json === true) {
        let itemsToSerialize: unknown[] = limited
        if (opts.withLines && limitedNodes) {
          itemsToSerialize = limitedNodes.map((an) => {
            let val = an.value
            if (opts.decodeEmbeddedXml) {
              const decoded = tryDecodeEmbeddedXml(val)
              if (decoded.decoded) val = decoded.text
            }
            return {
              value: val,
              lineStart: an.node.line,
              lineEnd: an.node.lineEnd,
            }
          })
        } else if (opts.decodeEmbeddedXml) {
          itemsToSerialize = limited.map((val) => {
            const decoded = tryDecodeEmbeddedXml(val)
            return decoded.decoded ? decoded.text : val
          })
        }
        const capped = guardJsonRows(itemsToSerialize)
        const jsonText = displaySafeJson(
          { items: capped.items, truncated: capped.truncated || headTruncated, totalCount },
          0,
        )
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, detail)
      } else {
        const lines: string[] = []
        for (let i = 0; i < limited.length; i++) {
          let val = limited[i] ?? ''
          if (opts.decodeEmbeddedXml) {
            const decoded = tryDecodeEmbeddedXml(val)
            if (decoded.decoded) val = decoded.text
          }
          const nodeInfo = limitedNodes ? limitedNodes[i] : undefined
          if (opts.withLines && nodeInfo) {
            lines.push(`# Line: L${nodeInfo.node.line}\n${val}`)
          } else {
            lines.push(val)
          }
        }
        if (headTruncated) {
          lines.push(headElidedNotice(totalCount - limited.length, 'item'))
        }
        const plainText = lines.join('\n')
        emitGuarded(plainText, 'xml-query')
        recordReadStat('xml_query', fullSourceBytes, plainText, detail)
      }
      return 0
    }

    if (result.items.length === 0) {
      if (opts.json === true) {
        const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0)
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, detail)
      } else {
        emitErr(formatCommandError(`No elements matched path: '${queryPath}'`))
      }
      return 1
    }

    if (!result.fanned && result.items.length === 1) {
      const node = result.items[0]!
      if (opts.json === true) {
        const jsonVal = xmlNodeToJson(node, {
          ...(opts.withLines ? { withLines: true } : {}),
          ...(opts.decodeEmbeddedXml ? { decodeEmbedded: true } : {}),
        })
        const jsonText = displaySafeJson(jsonVal)
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, detail)
      } else {
        let xmlText = serializeXmlNode(
          node,
          0,
          opts.decodeEmbeddedXml ? { decodeEmbedded: true } : {},
        )
        if (opts.withLines) {
          xmlText = `# Lines: L${node.line}-L${node.lineEnd}\n${xmlText}`
        }
        emitGuarded(xmlText, 'xml-query')
        recordReadStat('xml_query', fullSourceBytes, xmlText, detail)
      }
      return 0
    }

    const totalCount = result.items.length
    const limited = head !== undefined ? result.items.slice(0, head) : result.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const jsonItems = limited.map((n) =>
        xmlNodeToJson(n, {
          ...(opts.withLines ? { withLines: true } : {}),
          ...(opts.decodeEmbeddedXml ? { decodeEmbedded: true } : {}),
        }),
      )
      const capped = guardJsonRows(jsonItems)
      const jsonText = displaySafeJson(
        { items: capped.items, truncated: capped.truncated || headTruncated, totalCount },
        0,
      )
      emit(jsonText)
      recordReadStat('xml_query', fullSourceBytes, jsonText, detail)
    } else {
      const blocks = limited.map((node) => {
        let block = serializeXmlNode(
          node,
          0,
          opts.decodeEmbeddedXml ? { decodeEmbedded: true } : {},
        )
        if (opts.withLines) {
          block = `# Lines: L${node.line}-L${node.lineEnd}\n${block}`
        }
        return block
      })
      if (headTruncated) {
        blocks.push(headElidedNotice(totalCount - limited.length, 'element'))
      }
      const plainText = blocks.join('\n')
      emitGuarded(plainText, 'xml-query')
      recordReadStat('xml_query', fullSourceBytes, plainText, detail)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }
}

export interface HtmlOutlineCliOptions {
  file: string
  json?: boolean
}

export function runHtmlOutline(opts: HtmlOutlineCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  const summary = outlineHtml(text)
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(fenceJsonStrings(summary, fenceHtmlFieldIfMatched))
    emit(jsonText)
    recordReadStat('html_outline', fullSourceBytes, jsonText, opts.file)
  } else {
    const outlineText = formatHtmlOutline(summary)
    emit(guardRedactAndFence(outlineText, 'html-outline', UNTRUSTED_HTML_TAG))
    recordReadStat('html_outline', fullSourceBytes, outlineText, opts.file)
  }
  return 0
}

export interface HtmlQueryCliOptions {
  file: string
  selector: string
  head?: string
  json?: boolean
  text?: boolean
  attr?: string
}

export function runHtmlQuery(opts: HtmlQueryCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }

  try {
    const querySelector = opts.attr ? `${opts.selector}@${opts.attr}` : opts.selector
    const result = queryHtml(text, querySelector)
    const fullSourceBytes = sumFileSizes([opts.file])

    if (result.attributeValues !== undefined) {
      if (result.attributeValues.length === 0) {
        if (opts.json === true) {
          const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0)
          emit(jsonText)
          recordReadStat('html_query', fullSourceBytes, jsonText, opts.file)
        } else {
          emit(`No attributes matched selector: '${displaySafeText(opts.selector)}'`)
        }
        return 0
      }

      const totalCount = result.attributeValues.length
      const limited = head !== undefined ? result.attributeValues.slice(0, head) : result.attributeValues
      const headTruncated = limited.length < totalCount

      if (opts.json === true) {
        const capped = guardJsonRows(limited.map(fenceHtmlFieldIfMatched))
        const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount }, 0)
        emit(jsonText)
        recordReadStat('html_query', fullSourceBytes, jsonText, opts.file)
      } else {
        const lines = limited.map((item) => item)
        if (headTruncated) {
          lines.push(headElidedNotice(totalCount - limited.length, 'item'))
        }
        const plainText = lines.join('\n')
        emit(guardRedactAndFence(plainText, 'html-query', UNTRUSTED_HTML_TAG))
        recordReadStat('html_query', fullSourceBytes, plainText, opts.file)
      }
      return 0
    }

    if (result.elements.length === 0) {
      if (opts.json === true) {
        const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0)
        emit(jsonText)
        recordReadStat('html_query', fullSourceBytes, jsonText, opts.file)
      } else {
        emit(`No elements matched selector: '${displaySafeText(opts.selector)}'`)
      }
      return 0
    }

    const totalCount = result.elements.length
    const limited = head !== undefined ? result.elements.slice(0, head) : result.elements
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const jsonItems = limited.map((n) => fenceJsonStrings({
        tag: n.tag,
        attributes: n.attributes,
        text: extractNodeText(n, text),
        line: n.line,
        endLine: n.endLine,
      }, fenceHtmlFieldIfMatched))
      const capped = guardJsonRows(jsonItems)
      const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount })
      emit(jsonText)
      recordReadStat('html_query', fullSourceBytes, jsonText, opts.file)
    } else if (opts.text === true) {
      const textLines = limited.map((n) => extractNodeText(n, text)).filter(Boolean)
      if (headTruncated) {
        textLines.push(headElidedNotice(totalCount - limited.length, 'element'))
      }
      const plainText = textLines.join('\n\n')
      emit(guardRedactAndFence(plainText, 'html-query', UNTRUSTED_HTML_TAG))
      recordReadStat('html_query', fullSourceBytes, plainText, opts.file)
    } else {
      const blocks = limited.map((node) => serializeHtmlNode(node, 0, text))
      if (headTruncated) {
        blocks.push(headElidedNotice(totalCount - limited.length, 'element'))
      }
      const plainText = blocks.join('\n\n')
      emit(guardRedactAndFence(plainText, 'html-query', UNTRUSTED_HTML_TAG))
      recordReadStat('html_query', fullSourceBytes, plainText, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
    return 1
  }
}

export interface HtmlLintCliOptions {
  file: string
  json?: boolean
  strict?: boolean
}

export function runHtmlLint(opts: HtmlLintCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  const report = lintHtml(text)
  const isClean = opts.strict ? (report.errors.length === 0 && report.warnings.length === 0) : report.errors.length === 0

  if (opts.json === true) {
    emit(displaySafeJson(report))
    return isClean ? 0 : 1
  }

  if (report.errors.length === 0 && report.warnings.length === 0) {
    emit(`✓ ${displaySafeText(opts.file)}: HTML structure is valid (all tags balanced, no duplicate IDs, void elements respected).`)
    return 0
  }

  const lines: string[] = []
  if (report.errors.length > 0) {
    lines.push(`Errors found in ${displaySafeText(opts.file)} (${report.errors.length}):`)
    for (const err of report.errors) {
      lines.push(`  line ${err.line}: [${err.rule}] ${displaySafeText(err.message)}`)
    }
  }

  if (report.warnings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Warnings in ${displaySafeText(opts.file)} (${report.warnings.length}):`)
    for (const warn of report.warnings) {
      lines.push(`  line ${warn.line}: [${warn.rule}] ${displaySafeText(warn.message)}`)
    }
  }

  const unbalanced = Object.entries(report.tagCounts).filter(([, c]) => c.diff !== 0)
  if (unbalanced.length > 0) {
    lines.push('', 'Unbalanced tags:')
    for (const [tag, counts] of unbalanced) {
      lines.push(`  <${tag}>: open=${counts.open}, close=${counts.close}, diff=${counts.diff}`)
    }
  }

  emit(lines.join('\n'))
  return isClean ? 0 : 1
}

export interface OpenApiOutlineCliOptions {
  file: string
  json?: boolean
}

function loadOpenApiOperations(file: string): ReturnType<typeof extractOperations> | null {
  const text = readFileText(file)
  if (text === null) {
    emitErr(formatCommandError(`Could not read: ${file}`))
    return null
  }

  let spec: unknown
  try {
    spec = parseOpenApiSpec(text, file)
  } catch {
    emitErr(formatCommandError(`Failed to parse OpenAPI spec (not valid JSON or YAML): ${file}`))
    return null
  }

  return extractOperations(spec)
}

export function runOpenApiOutline(opts: OpenApiOutlineCliOptions): number {
  const operations = loadOpenApiOperations(opts.file)
  if (operations === null) return 1
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(operations, 0)
    emit(jsonText)
    recordReadStat('openapi_outline', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatOpenApiOutline(operations)
    emitGuarded(text, 'openapi-outline')
    recordReadStat('openapi_outline', fullSourceBytes, text, opts.file)
  }
  return 0
}

export interface OpenApiOpCliOptions {
  file: string
  operation: string
  json?: boolean
}

export function runOpenApiOp(opts: OpenApiOpCliOptions): number {
  const operations = loadOpenApiOperations(opts.file)
  if (operations === null) return 1
  const match = findOperation(operations, opts.operation)

  if (match === undefined) {
    const messages = [`Operation ${echoedValue(opts.operation)} not found in ${echoedValue(opts.file)}`]
    const closes = rankSimilarNames(operations.map(operationLabel), opts.operation)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (operations.length > 0) messages.push(`Try: token-goat openapi-outline ${quotedArg(opts.file)}`)
    emitErr(formatCommandError(new CliError(messages)))
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(match, 0)
    emit(jsonText)
    recordReadStat('openapi_op', fullSourceBytes, jsonText, opts.operation)
  } else {
    const text = formatOperationDetail(match)
    emitGuarded(text, 'openapi-op')
    recordReadStat('openapi_op', fullSourceBytes, text, opts.operation)
  }
  return 0
}
