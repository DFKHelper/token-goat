/**
 * MCP tool result cache — dedup repeated read-only MCP calls within a session.
 */

import * as fs from 'fs/promises'
import { resolve } from 'path'
import { fingerprintContent } from './fingerprint.js'
import { dataDir } from './constants.js'

export const MCP_DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const MCP_MAX_CACHE_BYTES = 2 * 1024 * 1024

/** Metadata associated with a cached MCP result entry. */
export interface McpOutputMeta {
  readonly outputId: string
  readonly toolName: string
  readonly inputPreview: string
  readonly resultBytes: number
  readonly ts: number
}

const MUTABLE_VERBS_RE = /(?:^|_)(?:create|update|delete|send|write|push|post|remove|label|unlabel|merge|modify|draft|fork|reply|move|rename|set|add|run|execute|close|copy|request|upload|insert|revoke|reset|archive|restore|annotate|register|unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban)(?=_|$)/i

const _resultsByHash = new Map<string, { text: string; ts: number }>()
const _metaByOutputId = new Map<string, McpOutputMeta>()

/**
 * Return True when *toolName* is a read-only MCP tool safe to cache.
 * Only `mcp__`-prefixed tools are considered.
 */
export function isMcpReadOnly(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) {
    return false
  }
  const method = toolName.split('__').pop() || ''
  return !MUTABLE_VERBS_RE.test(method)
}

/**
 * Return a 16-char hex hash for the (toolName, toolInput) pair.
 * Input dict is JSON-serialized with sorted keys for stability.
 */
export function mcpHash(toolName: string, toolInput: Record<string, unknown>): string {
  const sortedInput: Record<string, unknown> = {}
  for (const key of Object.keys(toolInput).sort()) {
    sortedInput[key] = toolInput[key]
  }
  const canonical = JSON.stringify({ tool: toolName, input: sortedInput })
  return fingerprintContent(canonical).slice(0, 16)
}

/**
 * Return the sidecar JSON metadata path for *outputId*.
 */
export function sidecarMetaPath(outputId: string): string | null {
  if (!outputId || outputId.includes('..') || outputId.includes('/')) {
    return null
  }
  const baseDir = resolve(dataDir(), 'mcp_outputs')
  return resolve(baseDir, `${outputId}.json`)
}

/**
 * Write *meta* as a JSON sidecar (best-effort).
 */
export async function writeSidecar(meta: McpOutputMeta): Promise<void> {
  try {
    const path = sidecarMetaPath(meta.outputId)
    if (!path) return
    const dir = resolve(path, '..')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path, JSON.stringify(meta, null, 2) + '\n')
    _metaByOutputId.set(meta.outputId, meta)
  } catch {
    // Best-effort; swallow errors
  }
}

/**
 * Return parsed McpOutputMeta from cache or sidecar, or null.
 */
export async function readSidecar(outputId: string): Promise<McpOutputMeta | null> {
  if (_metaByOutputId.has(outputId)) {
    return _metaByOutputId.get(outputId) || null
  }

  try {
    const path = sidecarMetaPath(outputId)
    if (!path) return null
    const content = await fs.readFile(path, 'utf-8')
    const data = JSON.parse(content)
    const meta: McpOutputMeta = {
      outputId: String(data.outputId || outputId),
      toolName: String(data.toolName || ''),
      inputPreview: String(data.inputPreview || ''),
      resultBytes: Number(data.resultBytes || 0),
      ts: Number(data.ts || 0),
    }
    _metaByOutputId.set(outputId, meta)
    return meta
  } catch {
    return null
  }
}

/**
 * Write *resultText* to the MCP output store and return the outputId, or null on error.
 * Returns null when the blob exceeds MCP_MAX_CACHE_BYTES or the write fails.
 */
export async function storeMcpResult(
  sessionId: string,
  toolInputHash: string,
  resultText: string,
  ts?: number,
  opts?: { toolName?: string; inputPreview?: string }
): Promise<string | null> {
  const resultBytes = Buffer.byteLength(resultText, 'utf-8')
  if (resultBytes > MCP_MAX_CACHE_BYTES) {
    return null
  }

  const timestamp = ts ?? Date.now()
  const outputId = `${sessionId}_${toolInputHash}_${Math.floor(timestamp / 1000)}`

  try {
    const dir = resolve(dataDir(), 'mcp_outputs')
    await fs.mkdir(dir, { recursive: true })
    _resultsByHash.set(toolInputHash, { text: resultText, ts: timestamp })

    if (opts?.toolName) {
      const meta: McpOutputMeta = {
        outputId,
        toolName: opts.toolName,
        inputPreview: (opts.inputPreview || '').slice(0, 200),
        resultBytes,
        ts: timestamp,
      }
      await writeSidecar(meta)
    }

    return outputId
  } catch {
    return null
  }
}

/**
 * Return the cached MCP result text for *outputId*, or null.
 */
export async function getMcpResult(sessionId: string, toolInputHash: string): Promise<string | null> {
  if (_resultsByHash.has(toolInputHash)) {
    return _resultsByHash.get(toolInputHash)?.text || null
  }
  return null
}

/**
 * Clear all in-memory caches (for testing).
 */
export function reset(): void {
  _resultsByHash.clear()
  _metaByOutputId.clear()
}
