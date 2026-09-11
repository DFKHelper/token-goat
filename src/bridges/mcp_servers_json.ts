/**
 * Shared reader and writer for the `servers`-keyed MCP JSON files that VS Code (`mcp.json`) and Visual Studio (`.mcp.json`) both read.
 *
 * Both hosts use the same entry shape under the same `servers` root key (not Claude Code's `mcpServers`), so the managed-entry test, the JSONC-preserving edit and the bundle path live here once. Visual Studio's format: https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { ParseError } from 'jsonc-parser'
import type * as JsoncParser from 'jsonc-parser'

// Loaded on first use, not at module scope: cli.ts statically imports the bridge modules, so a top-level require here would run on every invocation of the binary, including every hook and every `--version`.
let jsoncParser: typeof JsoncParser | undefined
export function jsonc(): typeof JsoncParser {
  jsoncParser ??= createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser
  return jsoncParser
}

function bundledCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, 'token-goat.mjs')
  if (fs.existsSync(bundled)) return bundled
  return path.resolve(here, '..', '..', 'dist', 'token-goat.mjs')
}

/** The stdio entry token-goat registers; both hosts launch MCP commands without a shell, so this is Node plus the resolved bundle rather than an npm .cmd shim, which is not executable on Windows. */
export function managedServer(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [bundledCliPath(), 'mcp-serve'],
  }
}

/** True for an entry token-goat wrote: a stdio server whose args are exactly `[<...>/token-goat.mjs, 'mcp-serve']`. */
export function isManagedServer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const args = entry['args']
  return (
    entry['type'] === 'stdio' &&
    Array.isArray(args) &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    path.basename(args[0]).toLowerCase() === 'token-goat.mjs' &&
    args[1] === 'mcp-serve'
  )
}

export interface ServersJsonConfig {
  text: string
  value: Record<string, unknown>
}

/** Reads an MCP JSON file (a missing one reads as `{}`); `label` names the host in the error, e.g. "VS Code". */
export function readServersJson(filePath: string, label: string): ServersJsonConfig {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}\n'
  const errors: ParseError[] = []
  const parsed = jsonc().parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw new Error(`malformed ${label} MCP JSON at ${filePath}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`malformed ${label} MCP JSON at ${filePath}: expected a JSON object`)
  }
  return { text, value: parsed as Record<string, unknown> }
}

/** The file's `servers` object, `{}` when absent; throws when `servers` is present but not an object. */
export function serversOf(config: ServersJsonConfig, filePath: string, label: string): Record<string, unknown> {
  const servers = config.value['servers']
  if (servers === undefined) return {}
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`malformed ${label} MCP JSON at ${filePath}: servers must be an object`)
  }
  return servers as Record<string, unknown>
}

const FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' } as const

/** Applies one jsonc edit unformatted, then formats only the text that edit inserted: formatting through `modify` re-indents the neighboring property too, so an install-then-uninstall would not give the user's bytes back. */
function editAt(text: string, jsonPath: string[], value: unknown): string {
  let out = text
  for (const e of [...jsonc().modify(text, jsonPath, value, {})].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, e.offset) + e.content + out.slice(e.offset + e.length)
    if (e.content.length > 0) out = jsonc().applyEdits(out, jsonc().format(out, { offset: e.offset, length: e.content.length }, FORMAT))
  }
  return out
}

/** Sets (or, with `undefined`, removes) `servers["token-goat"]` in `text`, leaving every other byte, comment and key where it was. */
export function setTokenGoatServer(text: string, value: unknown): string {
  // An empty object (a new file reads as `{}`) has no layout to keep, and a range format of `{}` leaves the braces hugging the insert.
  if (value !== undefined && /^\s*\{\s*\}\s*$/.test(text)) return `${JSON.stringify({ servers: { 'token-goat': value } }, null, 2)}\n`
  return editAt(text, ['servers', 'token-goat'], value)
}

/** Drops a `servers` object left empty by a removal, so a file install only added `servers` to reads back exactly as it was. */
export function dropEmptyServers(text: string): string {
  const parsed: unknown = jsonc().parse(text, [], { allowTrailingComma: true, disallowComments: false })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text
  const servers = (parsed as Record<string, unknown>)['servers']
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length > 0) return text
  return editAt(text, ['servers'], undefined)
}

/** Whether `filePath` holds a token-goat-managed `servers` entry; a missing, unreadable or malformed file reads as false. */
export function hasManagedServer(filePath: string, label: string): boolean {
  if (!fs.existsSync(filePath)) return false
  try {
    const config = readServersJson(filePath, label)
    return isManagedServer(serversOf(config, filePath, label)['token-goat'])
  } catch {
    return false
  }
}
