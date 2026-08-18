/**
 * Project-local VS Code MCP configuration and routing guidance.
 *
 * This intentionally does not install the extension package. VS Code supports
 * the stdio MCP server through `.vscode/mcp.json`; the extension is separately
 * packaged and installed as a VSIX when desired.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { ParseError } from 'jsonc-parser'
import type * as JsoncParser from 'jsonc-parser'

// Loaded on first use, not at module scope: this module is statically imported by cli.ts, so a
// top-level require here runs on every invocation of the binary -- including every hook and every
// `--version` -- to serve the two VS Code install commands that actually parse JSONC.
let jsoncParser: typeof JsoncParser | undefined
function jsonc(): typeof JsoncParser {
  jsoncParser ??= createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser
  return jsoncParser
}

import { atomicWriteText, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { buildGuidanceBody } from './guidance_block.js'
import { loadConfig } from '../config.js'

const BEGIN = '<!-- token-goat-vscode-begin -->'
const END = '<!-- token-goat-vscode-end -->'

function bundledCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, 'token-goat.mjs')
  if (fs.existsSync(bundled)) return bundled
  return path.resolve(here, '..', '..', 'dist', 'token-goat.mjs')
}

function managedServer(): Record<string, unknown> {
  return {
    type: 'stdio',
    // VS Code launches MCP commands without a shell. Use Node plus the resolved
    // bundle rather than an npm .cmd shim, which is not executable on Windows.
    command: process.execPath,
    args: [bundledCliPath(), 'mcp-serve'],
  }
}

function isManagedServer(value: unknown): boolean {
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

/** Scope selector shared by every VS Code path helper below, mirroring CopilotCliScopeOptions. */
export interface VscodeScopeOptions {
  /** When true, target the project-scoped `<project>/.vscode/mcp.json` instead of the user-scoped profile one. */
  project?: boolean
  /** Only meaningful with `project: true`; defaults to `process.cwd()`. */
  projectRoot?: string
}

/**
 * VS Code's user-profile config directory, mirroring how VS Code itself resolves it
 * (confirmed against VS Code's own docs, not assumed by analogy with another bridge):
 * `%APPDATA%\Code\User` on Windows, `~/Library/Application Support/Code/User` on
 * macOS, `~/.config/Code/User` on Linux. `mcp.json` lives directly inside it, using
 * the same `servers` root key as the project-local file. Like
 * `opencodeGlobalConfigDir` in `./opencode_install.js`, the Windows branch reads
 * `process.env['APPDATA']` directly (falling back to `~/AppData/Roaming` if unset or
 * blank) rather than hardcoding a path, so tests and dogfooding can isolate it the
 * same way they already isolate `HOME`/`USERPROFILE`/`LOCALAPPDATA`.
 */
function vscodeUserConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    const base = appData !== undefined && appData.trim() !== '' ? appData : path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'Code', 'User')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  return path.join(os.homedir(), '.config', 'Code', 'User')
}

export function vscodeUserMcpPath(): string {
  return path.join(vscodeUserConfigDir(), 'mcp.json')
}

export function vscodeProjectMcpPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.vscode', 'mcp.json')
}

/** Resolves the mcp.json path for the requested scope; defaults to user scope, matching every other harness's `-p/--project` convention. */
export function vscodeMcpPath(opts: VscodeScopeOptions = {}): string {
  return opts.project === true ? vscodeProjectMcpPath(opts.projectRoot) : vscodeUserMcpPath()
}

/** The other scope's mcp.json path -- used only to detect a cross-scope duplicate registration. */
function otherScopeMcpPath(opts: VscodeScopeOptions): string {
  return opts.project === true ? vscodeUserMcpPath() : vscodeProjectMcpPath(opts.projectRoot)
}

export function vscodeInstructionsPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.github', 'copilot-instructions.md')
}

interface VscodeConfig {
  text: string
  value: Record<string, unknown>
}

function readConfig(filePath: string): VscodeConfig {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}\n'
  const errors: ParseError[] = []
  const parsed = jsonc().parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw new Error(`malformed VS Code MCP JSON at ${filePath}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`malformed VS Code MCP JSON at ${filePath}: expected a JSON object`)
  }
  return { text, value: parsed as Record<string, unknown> }
}

function updateConfig(text: string, value: unknown): string {
  return jsonc().applyEdits(
    text,
    jsonc().modify(text, ['servers', 'token-goat'], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    }),
  )
}

export interface VscodeInstallResult {
  mcpPath: string
  instructionsPath: string
  alreadyInstalled: boolean
  /** Which scope was actually written: 'project' (`--project`) or 'user' (default). */
  scope: 'project' | 'user'
}

/**
 * Best-effort check for a token-goat-managed entry already sitting in the *other*
 * scope. Writing this scope on top of that would register token-goat twice --
 * VS Code merges user- and workspace-scope `mcp.json` when both name the same
 * server, duplicating all of its tool schemas into the workspace. A malformed or
 * unreadable other-scope file is not this call's problem to raise (that surfaces,
 * loudly, the moment someone actually installs into that scope), so this swallows
 * read/parse failures and reports "no managed entry found" rather than throwing.
 */
export function otherScopeHasManagedServer(opts: VscodeScopeOptions): boolean {
  const otherPath = otherScopeMcpPath(opts)
  if (!fs.existsSync(otherPath)) return false
  try {
    const config = readConfig(otherPath)
    const servers = config.value['servers']
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return false
    return isManagedServer((servers as Record<string, unknown>)['token-goat'])
  } catch {
    return false
  }
}

export interface VscodeDecoderStatus {
  configured: boolean
  checkedPaths: string[]
}

/**
 * Single source of truth for "is the VS Code decoder set up", shared by the extension's
 * ensureDecoderSetup prompt so it can never drift from what installVscode actually writes.
 * Always checks user scope (the default since 9c220be7); also checks the workspace scope
 * when a projectRoot is given, since that is the only case where `.vscode/mcp.json` is
 * relevant at all -- a user-scope install is workspace-independent, so this deliberately
 * does not require projectRoot to report `configured: true`.
 */
export function vscodeDecoderConfigured(opts: { projectRoot?: string } = {}): VscodeDecoderStatus {
  const checkedPaths = [vscodeUserMcpPath()]
  if (opts.projectRoot !== undefined) checkedPaths.push(vscodeProjectMcpPath(opts.projectRoot))
  for (const candidate of checkedPaths) {
    if (!fs.existsSync(candidate)) continue
    try {
      const config = readConfig(candidate)
      const servers = config.value['servers']
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue
      if (isManagedServer((servers as Record<string, unknown>)['token-goat'])) {
        return { configured: true, checkedPaths }
      }
    } catch {
      // Malformed file at this path isn't this check's problem -- it surfaces loudly the
      // moment someone actually installs into that scope. Keep scanning the rest.
    }
  }
  return { configured: false, checkedPaths }
}

function writeGuidance(filePath: string): boolean {
  const body = [
    BEGIN,
    buildGuidanceBody('VS Code’s supported MCP integration and its built-in file-read tools', { gdrive: loadConfig().gdrive.enabled }),
    '',
    '**Compressed payloads:** a message containing a token-goat payload block (recognizable by a `recovery: token-goat retrieve <id>` line) is compressed text, not an answer. Call the MCP tool `retrieve_text` with that id to recover the original text, then answer the question the message asks using the recovered text. Never present the raw payload to the user as the response; if the `retrieve_text` tool is unavailable (the MCP server is not running, or the chat is not in Agent mode), say so plainly and ask the user to switch to Agent mode or run `token-goat install --vscode`.',
    '',
    'VS Code support: token-goat install --vscode configures a stdio MCP server under the servers root key in your user-profile mcp.json by default (add --project for the workspace .vscode/mcp.json instead). VS Code may call these MCP tools when selected; MCP does not intercept VS Code’s built-in file reads.',
    END,
  ].join('\n')
  return upsertDelimitedBlock(filePath, BEGIN, END, body)
}

export function installVscode(opts: VscodeScopeOptions = {}): VscodeInstallResult {
  const scope: 'project' | 'user' = opts.project === true ? 'project' : 'user'
  const mcpPath = vscodeMcpPath(opts)
  const instructionsPath = vscodeInstructionsPath(opts.projectRoot)
  if (otherScopeHasManagedServer(opts)) {
    const otherScope = scope === 'project' ? 'user' : 'project'
    const otherPath = otherScopeMcpPath(opts)
    throw new Error(
      `token-goat is already registered in VS Code ${otherScope} scope (${otherPath}). Installing into ${scope} scope too would register it twice and duplicate its tool schemas in this workspace. Run "token-goat uninstall --vscode${otherScope === 'project' ? ' --project' : ''}" first if you want to move it, or drop --vscode from this run.`,
    )
  }
  const config = readConfig(mcpPath)
  const existingServers = config.value['servers']
  if (existingServers !== undefined && (existingServers === null || typeof existingServers !== 'object' || Array.isArray(existingServers))) {
    throw new Error(`malformed VS Code MCP JSON at ${mcpPath}: servers must be an object`)
  }
  const servers = (existingServers as Record<string, unknown> | undefined) ?? {}
  const current = servers['token-goat']
  if (current !== undefined && !isManagedServer(current)) {
    throw new Error(`VS Code MCP JSON at ${mcpPath} already has a non-token-goat-managed server named "token-goat"`)
  }
  const next = updateConfig(config.text, managedServer())
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
  if (config.text !== next) atomicWriteText(mcpPath, next)
  const guidanceChanged = writeGuidance(instructionsPath)
  return { mcpPath, instructionsPath, alreadyInstalled: config.text === next && !guidanceChanged, scope }
}

export function uninstallVscode(opts: VscodeScopeOptions = {}): boolean {
  const mcpPath = vscodeMcpPath(opts)
  let removed = false
  if (fs.existsSync(mcpPath)) {
    const config = readConfig(mcpPath)
    const servers = config.value['servers']
    if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
      throw new Error(`malformed VS Code MCP JSON at ${mcpPath}: servers must be an object`)
    }
    if (servers && isManagedServer((servers as Record<string, unknown>)['token-goat'])) {
      atomicWriteText(mcpPath, updateConfig(config.text, undefined))
      removed = true
    }
  }
  if (stripDelimitedBlock(vscodeInstructionsPath(opts.projectRoot), BEGIN, END)) removed = true
  return removed
}
