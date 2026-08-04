/**
 * Project-local VS Code MCP configuration and routing guidance.
 *
 * This intentionally does not install the extension package. VS Code supports
 * the stdio MCP server through `.vscode/mcp.json`; the extension is separately
 * packaged and installed as a VSIX when desired.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { ParseError } from 'jsonc-parser'
import type * as JsoncParser from 'jsonc-parser'

const jsoncParser = createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser
const { applyEdits, modify, parse } = jsoncParser

import { atomicWriteText, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { buildGuidanceBody } from './guidance_block.js'

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

export function vscodeMcpPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.vscode', 'mcp.json')
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
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw new Error(`malformed VS Code MCP JSON at ${filePath}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`malformed VS Code MCP JSON at ${filePath}: expected a JSON object`)
  }
  return { text, value: parsed as Record<string, unknown> }
}

function updateConfig(text: string, value: unknown): string {
  return applyEdits(
    text,
    modify(text, ['servers', 'token-goat'], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    }),
  )
}

export interface VscodeInstallResult {
  mcpPath: string
  instructionsPath: string
  alreadyInstalled: boolean
}

function writeGuidance(filePath: string): boolean {
  const body = [
    BEGIN,
    buildGuidanceBody('VS Code’s supported MCP integration and its built-in file-read tools'),
    '',
    'VS Code support: token-goat install --vscode configures a project-local stdio MCP server in .vscode/mcp.json under the servers root key. VS Code may call these MCP tools when selected; MCP does not intercept VS Code’s built-in file reads.',
    END,
  ].join('\n')
  return upsertDelimitedBlock(filePath, BEGIN, END, body)
}

export function installVscode(projectRoot = process.cwd()): VscodeInstallResult {
  const mcpPath = vscodeMcpPath(projectRoot)
  const instructionsPath = vscodeInstructionsPath(projectRoot)
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
  return { mcpPath, instructionsPath, alreadyInstalled: config.text === next && !guidanceChanged }
}

export function uninstallVscode(projectRoot = process.cwd()): boolean {
  const mcpPath = vscodeMcpPath(projectRoot)
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
  if (stripDelimitedBlock(vscodeInstructionsPath(projectRoot), BEGIN, END)) removed = true
  return removed
}
