/** Copilot CLI MCP-server registration: the `mcpServers.token-goat` entry in `<COPILOT_HOME>/mcp-config.json` (else `~/.copilot/mcp-config.json`), which `token-goat install --copilot` writes and `uninstall --copilot` removes. The entry shape is the one Copilot CLI 1.0.88 writes itself for `copilot mcp add token-goat -- <node> <token-goat.mjs> mcp-serve`: `{"tools":["*"],"type":"local","command":...,"args":[...]}` under a top-level `mcpServers` object (captured with an isolated COPILOT_HOME; `copilot mcp remove token-goat` then left every other server in place, see tests/install_copilot_mcp.test.ts). Copilot reads this file only at user scope, so a `--local` install leaves it alone. Every other server, key and formatting choice in the file is preserved through `./mcp_servers_json.ts`'s JSONC-preserving edit, and an entry token-goat did not write is never overwritten, with one exception: the hand-written form this project's README told Copilot users to add before install did it (`{"command":"token-goat","args":["mcp-serve"]}`) is replaced, since it names this same server. Uninstall removes only the entry install writes. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { recordCreatedConfig, removeCreatedBackups, takeCreatedConfig } from './created_configs.js'
import { bundledCliPath, dropEmptyServers, hasManagedServer, noteRootKeyCreation, readServersJson, serversOf, setTokenGoatServer } from './mcp_servers_json.js'
import { copilotCliUserRoot } from '../copilot_home.js'
import { atomicWriteText, backupFile, ensureDirSync, removeFileInScope } from '../util.js'

const MCP_SERVERS_KEY = 'mcpServers'
const TOKEN_GOAT_ENTRY_KEY = 'token-goat'
const LABEL = 'Copilot CLI'

/** `<COPILOT_HOME>/mcp-config.json`, else `~/.copilot/mcp-config.json`. */
export function copilotMcpConfigPath(): string {
  return path.join(copilotCliUserRoot(), 'mcp-config.json')
}

/** The entry token-goat writes, in the shape `copilot mcp add` writes. */
export function copilotManagedServer(): { tools: string[]; type: 'local'; command: string; args: [string, string] } {
  return { tools: ['*'], type: 'local', command: process.execPath, args: [bundledCliPath(), 'mcp-serve'] }
}

/** True for an entry token-goat wrote: a `local` server whose `args` are exactly `[<...>/token-goat.mjs, 'mcp-serve']`. The Node binary in `command` is not compared: after a Node upgrade or a switch of version manager the entry still names this server, and install must refresh it rather than refuse it as someone else's. */
export function isCopilotManagedServer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const args = entry['args']
  return (
    entry['type'] === 'local' &&
    typeof entry['command'] === 'string' &&
    Array.isArray(args) &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    path.basename(args[0]).toLowerCase() === 'token-goat.mjs' &&
    args[1] === 'mcp-serve'
  )
}

/** The entry the README's manual Copilot CLI instructions showed: `{"command":"token-goat","args":["mcp-serve"]}` and nothing else. */
function isReadmeServer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const args = entry['args']
  return Object.keys(entry).every((k) => k === 'command' || k === 'args') && entry['command'] === 'token-goat' && Array.isArray(args) && args.length === 1 && args[0] === 'mcp-serve'
}

/** Merge the managed entry into mcp-config.json. Returns true when the file changed. Throws before any write on a file that does not parse, or on a `token-goat` entry token-goat did not write. */
export function installCopilotMcpServer(): boolean {
  const mcpPath = copilotMcpConfigPath()
  const fileExisted = fs.existsSync(mcpPath)
  const config = readServersJson(mcpPath, LABEL)
  const current = serversOf(config, mcpPath, LABEL, MCP_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY]
  if (current !== undefined && !isCopilotManagedServer(current) && !isReadmeServer(current)) {
    throw new Error(`Copilot CLI mcp-config.json already has a "${TOKEN_GOAT_ENTRY_KEY}" MCP server entry token-goat did not write, at ${mcpPath}; remove it manually first`)
  }
  const nextText = setTokenGoatServer(config.text, copilotManagedServer(), MCP_SERVERS_KEY)
  if (nextText === config.text) return false
  ensureDirSync(path.dirname(mcpPath))
  if (!fileExisted) recordCreatedConfig(mcpPath)
  backupFile(mcpPath)
  atomicWriteText(mcpPath, nextText)
  noteRootKeyCreation(mcpPath, config, MCP_SERVERS_KEY)
  return true
}

/** Remove the managed entry, and the file itself when token-goat created it and nothing else is left. Returns true when an entry was removed. */
export function uninstallCopilotMcpServer(): boolean {
  const mcpPath = copilotMcpConfigPath()
  if (!fs.existsSync(mcpPath)) return false
  const config = readServersJson(mcpPath, LABEL)
  if (!isCopilotManagedServer(serversOf(config, mcpPath, LABEL, MCP_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY])) return false
  const next = dropEmptyServers(setTokenGoatServer(config.text, undefined, MCP_SERVERS_KEY), mcpPath, MCP_SERVERS_KEY)
  if (/^\s*\{\s*\}\s*$/.test(next) && takeCreatedConfig(mcpPath)) {
    removeFileInScope(mcpPath)
  } else {
    backupFile(mcpPath)
    atomicWriteText(mcpPath, next)
  }
  removeCreatedBackups(mcpPath)
  return true
}

/** Whether mcp-config.json holds the managed entry. */
export function isCopilotMcpServerInstalled(): boolean {
  return hasManagedServer(copilotMcpConfigPath(), LABEL, MCP_SERVERS_KEY, isCopilotManagedServer)
}
