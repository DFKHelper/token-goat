/**
 * Shared reader and writer for the `servers`-keyed MCP JSON files that VS Code (`mcp.json`) and Visual Studio (`.mcp.json`) both read.
 *
 * Both hosts use the same entry shape under the same `servers` root key (not Claude Code's `mcpServers`), so the managed-entry test, the JSONC-preserving edit and the bundle path live here once. Visual Studio's format: https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers
 *
 * The root-key-agnostic functions below (`serversOf`, `setTokenGoatServer`, `dropEmptyServers`, `hasManagedServer`) take an optional `rootKey` (default `'servers'`) so `./zed_install.ts` can reuse the same JSONC-preserving edit machinery for Zed's `context_servers` root key without duplicating it: Zed's entry *shape* is unrelated (a shell-executed `command` string plus `timeout`, not `type`/`command`/`args`), so `managedServer`/`isManagedServer` stay VS Code/Visual Studio-specific and Zed defines its own pair.
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

/** Resolves the shipping `dist/token-goat.mjs` path from within a bridge module; shared with `./zed_install.ts`'s shim script, which needs the identical bundle path but cannot use `managedServer()`'s stdio-args shape (Zed shell-executes a single `command` string, not `command`+`args`). */
export function bundledCliPath(): string {
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

/** The file's `rootKey` object (`'servers'` unless the caller names another, e.g. Zed's `'context_servers'`), `{}` when absent; throws when present but not an object. */
export function serversOf(config: ServersJsonConfig, filePath: string, label: string, rootKey = 'servers'): Record<string, unknown> {
  const servers = config.value[rootKey]
  if (servers === undefined) return {}
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`malformed ${label} MCP JSON at ${filePath}: ${rootKey} must be an object`)
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

/** Sets (or, with `undefined`, removes) `rootKey["token-goat"]` in `text`, leaving every other byte, comment and key where it was. */
export function setTokenGoatServer(text: string, value: unknown, rootKey = 'servers'): string {
  // An empty object (a new file reads as `{}`) has no layout to keep, and a range format of `{}` leaves the braces hugging the insert.
  if (value !== undefined && /^\s*\{\s*\}\s*$/.test(text)) return `${JSON.stringify({ [rootKey]: { 'token-goat': value } }, null, 2)}\n`
  return editAt(text, [rootKey, 'token-goat'], value)
}

/** Drops a `servers` object left empty by a removal, so a file install only added `servers` to reads back exactly as it was. */
/**
 * True when every key in the parsed config belongs to token-goat: a single server map holding only our own managed entry.
 *
 * This is the one content test uninstall's ownership rule is allowed to make. It is not the
 * "is it empty" reasoning that deleted a user's file, because emptiness is reached by both cases
 * while this shape is reached only by a file token-goat wrote end to end: there is no user data in
 * it to lose. Anything else at all -- a second server, a comment-bearing sibling key, a user's own
 * stub -- fails it, and the file is then never deleted.
 */
export function holdsOnlyManagedServer(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  const root = keys[0]
  if (root !== 'servers' && root !== 'mcpServers') return false
  const servers = value[root]
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return false
  const names = Object.keys(servers as Record<string, unknown>)
  return names.length === 1 && names[0] === 'token-goat' && isManagedServer((servers as Record<string, unknown>)['token-goat'])
}

export function dropEmptyServers(text: string, rootKey = 'servers'): string {
  const parsed = parseObject(text)
  if (parsed === null) return text
  const servers = parsed[rootKey]
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length > 0) return text
  return editAt(text, [rootKey], undefined)
}

function parseObject(text: string): Record<string, unknown> | null {
  const parsed: unknown = jsonc().parse(text, [], { allowTrailingComma: true, disallowComments: false })
  return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ? null : (parsed as Record<string, unknown>)
}

/** Adds `"mcpServers": {}` when `text` has no `mcpServers` key: Claude Code reads every `.mcp.json` from the cwd up to the drive root and rejects one without that key as a fatal config error. */
export function ensureMcpServersKey(text: string): string {
  const parsed = parseObject(text)
  if (parsed === null || 'mcpServers' in parsed) return text
  return editAt(text, ['mcpServers'], {})
}

/** Removes an empty `mcpServers` only when it is the file's last key, so the caller can delete a file that then holds nothing; otherwise `text` comes back unchanged, since a kept `.mcp.json` needs the key for Claude Code. */
export function dropLoneEmptyMcpServers(text: string): string {
  const parsed = parseObject(text)
  if (parsed === null || Object.keys(parsed).length !== 1) return text
  const mcpServers = parsed['mcpServers']
  if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers) || Object.keys(mcpServers).length > 0) return text
  return editAt(text, ['mcpServers'], undefined)
}

/**
 * Whether `filePath` holds a token-goat-managed entry under `rootKey`; a missing, unreadable or
 * malformed file reads as false. `isManaged` defaults to VS Code/Visual Studio's `isManagedServer`;
 * `./zed_install.ts` passes its own `isZedManagedServer` for Zed's unrelated entry shape.
 */
export function hasManagedServer(filePath: string, label: string, rootKey = 'servers', isManaged: (value: unknown) => boolean = isManagedServer): boolean {
  if (!fs.existsSync(filePath)) return false
  try {
    const config = readServersJson(filePath, label)
    return isManaged(serversOf(config, filePath, label, rootKey)['token-goat'])
  } catch {
    return false
  }
}
