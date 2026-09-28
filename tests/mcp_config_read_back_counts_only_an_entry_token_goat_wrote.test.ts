// VS Code, Visual Studio, Cursor and Zed each read their own MCP config back to ask whether token-goat is registered there (doctor's checks, `mcp-status`, the cross-scope install checks), and all of them now read it through one managedServerEntry in src/bridges/mcp_servers_json.ts. Two behaviors the six former copies shared were pinned by nothing: dropping the managed-entry predicate or letting a parse failure escape left all 528 tests of the 22 bridge, install and doctor files green. The entries token-goat writes come from each bridge's own producer. FORMAT-DERIVED: the foreign entries use the shapes each bridge module's header documents for its host (`servers` with type/command/args per https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers, shared by VS Code's mcp.json; Cursor's `mcpServers` command/args; Zed's `context_servers` command entry per https://zed.dev/docs/configuring-zed), launching token-goat through npx the way a hand-written entry would. HAND-DERIVED: the truncated and wrong-typed files.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cursorManagedEntry, cursorManagedServer } from '../src/bridges/cursor_install.js'
import { hasManagedServer, managedServer } from '../src/bridges/mcp_servers_json.js'
import { visualStudioManagedEntry } from '../src/bridges/visualstudio_install.js'
import { zedManagedEntry, zedManagedServer } from '../src/bridges/zed_install.js'

interface Surface {
  readonly name: string
  readonly rootKey: string
  /** The entry token-goat itself writes for this host. */
  readonly ours: () => unknown
  /** An entry under the same `token-goat` name that token-goat did not write. */
  readonly foreign: unknown
  /** The read-back this host's callers use, reduced to "found something" (non-null) or null. */
  readonly read: (file: string) => unknown
}

const NPX_ARGS = ['-y', 'token-goat', 'mcp-serve']

const SURFACES: readonly Surface[] = [
  { name: 'VS Code', rootKey: 'servers', ours: managedServer, foreign: { type: 'stdio', command: 'npx', args: NPX_ARGS }, read: (file) => (hasManagedServer(file, 'VS Code') ? true : null) },
  { name: 'Visual Studio', rootKey: 'servers', ours: managedServer, foreign: { type: 'stdio', command: 'npx', args: NPX_ARGS }, read: visualStudioManagedEntry },
  { name: 'Cursor', rootKey: 'mcpServers', ours: cursorManagedServer, foreign: { command: 'npx', args: NPX_ARGS }, read: cursorManagedEntry },
  { name: 'Zed', rootKey: 'context_servers', ours: zedManagedServer, foreign: { command: 'npx', args: NPX_ARGS }, read: zedManagedEntry },
]

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-mcp-read-back-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function configFile(text: string): string {
  const file = path.join(dir, 'mcp.json')
  fs.writeFileSync(file, text)
  return file
}

describe.each(SURFACES)('the $name read-back', (surface) => {
  it('finds the entry token-goat wrote', () => {
    expect(surface.read(configFile(JSON.stringify({ [surface.rootKey]: { 'token-goat': surface.ours() } })))).not.toBeNull()
  })

  it('does not count a token-goat entry token-goat did not write', () => {
    expect(surface.read(configFile(JSON.stringify({ [surface.rootKey]: { 'token-goat': surface.foreign } })))).toBeNull()
  })

  it('reads a file that does not parse as holding no entry, rather than throwing', () => {
    expect(surface.read(configFile(`{ "${surface.rootKey}": { "token-goat": `))).toBeNull()
  })

  it('reads a root key that is not an object as holding no entry, rather than throwing', () => {
    expect(surface.read(configFile(JSON.stringify({ [surface.rootKey]: [] })))).toBeNull()
  })
})

describe('the Visual Studio read-back', () => {
  it('reports the command and bundle path of the entry token-goat wrote', () => {
    const ours = managedServer() as { command: string; args: string[] }
    expect(visualStudioManagedEntry(configFile(JSON.stringify({ servers: { 'token-goat': ours } })))).toEqual({ command: ours.command, bundlePath: ours.args[0] })
  })
})
