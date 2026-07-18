/**
 * Narrow structural summary + single-operation extraction for `token-goat openapi-outline` /
 * `openapi-op`, so a multi-thousand-line OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) never
 * needs a full `Read` just to answer "what operations exist" or "what does operation X take
 * and return". Mirrors json_query.ts's split: pure parsing/extraction/formatting here, CLI I/O
 * (readFileText, emit/emitErr, overflow guard) in read_commands.ts.
 */

import * as path from 'node:path'
import { load as loadYaml } from 'js-yaml'

import { stripBom } from './util.js'

/** The HTTP-method keys OpenAPI/Swagger recognize as operations under a path item. Any other
 * key on a path item (`parameters`, `summary`, `$ref`, `servers`, ...) is not an operation. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/**
 * Parses spec text as JSON or YAML. `.json` forces the JSON parser (a clear parse error beats a
 * YAML parser silently accepting malformed JSON as a bare scalar/string). `.yaml`/`.yml` forces
 * the YAML parser. Any other extension tries JSON first (stricter, so a JSON file with an
 * unusual extension still gets a useful native-parser error) and falls back to YAML -- valid
 * JSON is also valid YAML, but the reverse isn't true, so this ordering never masks a real JSON
 * syntax error behind a YAML fallback that happens to succeed on a truncated document.
 */
export function parseOpenApiSpec(text: string, filePath: string): unknown {
  text = stripBom(text)
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.yaml' || ext === '.yml') return loadYaml(text)
  if (ext === '.json') return JSON.parse(text)
  try {
    return JSON.parse(text)
  } catch {
    return loadYaml(text)
  }
}

export interface OpenApiOperation {
  method: string
  path: string
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters: unknown[]
  requestBody?: unknown
  responses: Record<string, unknown>
}

/**
 * Flattens `spec.paths` into one entry per (path, method) operation, sorted by path then method
 * so the outline reads the same regardless of the spec author's own key order. Path-level
 * `parameters` (shared across every method on that path item, per the OpenAPI spec) are merged
 * ahead of each operation's own `parameters` so a caller sees the full applicable parameter set
 * without re-deriving the merge themselves. Malformed input (no object, no `paths`, a
 * non-object path item) degrades to an empty list rather than throwing -- "0 operations found"
 * is a more useful signal than a crash for a spec that parsed but isn't shaped like OpenAPI.
 */
export function extractOperations(spec: unknown): OpenApiOperation[] {
  if (typeof spec !== 'object' || spec === null) return []
  const paths = (spec as Record<string, unknown>)['paths']
  if (typeof paths !== 'object' || paths === null) return []

  const operations: OpenApiOperation[] = []
  for (const [route, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (typeof pathItemRaw !== 'object' || pathItemRaw === null) continue
    const pathItem = pathItemRaw as Record<string, unknown>
    const pathLevelParams = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : []

    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method]
      if (typeof opRaw !== 'object' || opRaw === null) continue
      const op = opRaw as Record<string, unknown>
      const ownParams = Array.isArray(op['parameters']) ? op['parameters'] : []
      const tags = Array.isArray(op['tags']) ? op['tags'].filter((t): t is string => typeof t === 'string') : undefined

      operations.push({
        method: method.toUpperCase(),
        path: route,
        ...(typeof op['operationId'] === 'string' ? { operationId: op['operationId'] } : {}),
        ...(typeof op['summary'] === 'string' ? { summary: op['summary'] } : {}),
        ...(typeof op['description'] === 'string' ? { description: op['description'] } : {}),
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
        parameters: [...pathLevelParams, ...ownParams],
        ...(op['requestBody'] !== undefined ? { requestBody: op['requestBody'] } : {}),
        responses: typeof op['responses'] === 'object' && op['responses'] !== null ? (op['responses'] as Record<string, unknown>) : {},
      })
    }
  }

  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  return operations
}

/** Compact "method path [operationId] - summary (tags)" listing, one line per operation. */
export function formatOpenApiOutline(operations: readonly OpenApiOperation[]): string {
  if (operations.length === 0) return '(no operations found)'
  return operations
    .map((op) => {
      const parts = [op.method.padEnd(6), op.path]
      if (op.operationId !== undefined) parts.push(`[${op.operationId}]`)
      if (op.summary !== undefined) parts.push(`- ${op.summary}`)
      if (op.tags !== undefined && op.tags.length > 0) parts.push(`(${op.tags.join(', ')})`)
      return parts.join('  ')
    })
    .join('\n')
}

/**
 * Resolves an `openapi-op` lookup key to exactly one operation. Tries an exact `operationId`
 * match first (the more specific, unambiguous identifier when present), then falls back to a
 * `METHOD /path` match (method matched case-insensitively, path matched exactly) -- mirroring
 * `read`/`symbol`'s exact-then-fallback resolution shape elsewhere in this codebase. Returns
 * `undefined` on no match; the caller is responsible for a "not found" + did-you-mean message.
 */
export function findOperation(operations: readonly OpenApiOperation[], key: string): OpenApiOperation | undefined {
  const trimmed = key.trim()
  const byId = operations.find((op) => op.operationId === trimmed)
  if (byId !== undefined) return byId

  const m = /^(\S+)\s+(\S+)$/.exec(trimmed)
  if (m === null) return undefined
  const method = (m[1] as string).toUpperCase()
  const opPath = m[2] as string
  return operations.find((op) => op.method === method && op.path === opPath)
}

/** Display label for a not-found "did you mean" suggestion list: prefers `operationId` (with
 * the method+path alongside for context) and falls back to `METHOD path` when no operationId
 * exists. */
export function operationLabel(op: OpenApiOperation): string {
  return op.operationId !== undefined ? `${op.operationId}  (${op.method} ${op.path})` : `${op.method} ${op.path}`
}

function indentedJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => indent + line)
    .join('\n')
}

/** Full detail for one operation: summary/description/tags, every parameter (name, location,
 * required, description, schema), the request body schema, and the response schema per status
 * code -- everything `openapi-op` promises instead of the compact `openapi-outline` listing. */
export function formatOperationDetail(op: OpenApiOperation): string {
  const lines: string[] = [`${op.method} ${op.path}`]
  if (op.operationId !== undefined) lines.push(`operationId: ${op.operationId}`)
  if (op.summary !== undefined) lines.push(`summary: ${op.summary}`)
  if (op.description !== undefined) lines.push(`description: ${op.description}`)
  if (op.tags !== undefined && op.tags.length > 0) lines.push(`tags: ${op.tags.join(', ')}`)

  if (op.parameters.length > 0) {
    lines.push('', 'parameters:')
    for (const paramRaw of op.parameters) {
      if (typeof paramRaw !== 'object' || paramRaw === null) continue
      const param = paramRaw as Record<string, unknown>
      const name = typeof param['name'] === 'string' ? param['name'] : '(unnamed)'
      const location = typeof param['in'] === 'string' ? param['in'] : '?'
      const required = param['required'] === true ? ' required' : ''
      const description = typeof param['description'] === 'string' ? ` - ${param['description']}` : ''
      lines.push(`  ${name} (${location})${required}${description}`)
      if (param['schema'] !== undefined) lines.push(indentedJson(param['schema'], '    '))
    }
  }

  if (op.requestBody !== undefined) {
    lines.push('', 'requestBody:')
    lines.push(indentedJson(op.requestBody, '  '))
  }

  const responseEntries = Object.entries(op.responses)
  if (responseEntries.length > 0) {
    lines.push('', 'responses:')
    for (const [status, body] of responseEntries) {
      lines.push(`  ${status}:`)
      lines.push(indentedJson(body, '    '))
    }
  }

  return lines.join('\n')
}
