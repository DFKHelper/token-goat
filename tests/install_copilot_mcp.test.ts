/** `token-goat install --copilot` registers token-goat's MCP server in Copilot CLI's user MCP config, `<COPILOT_HOME>/mcp-config.json`, and `uninstall --copilot` takes it out again. Before this, the README told Copilot users to write that entry by hand, in a shape Copilot does not write itself. PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88_mcp/ holds what GitHub Copilot CLI 1.0.88 itself wrote on Windows, recorded on 2026-09-28 in an isolated COPILOT_HOME, with the console output in transcript.txt beside it: `copilot mcp add other -- echo hi`, then `copilot mcp add token-goat -- "C:/Program Files/nodejs/node.exe" C:/x/dist/token-goat.mjs mcp-serve` (mcp-config-after-add.json), then `copilot mcp remove token-goat` (mcp-config-after-remove.json). The entry token-goat writes must have the key set Copilot gives its own `token-goat` entry, and uninstalling from Copilot's after-add file must leave what Copilot's own remove left. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { copilotCliConfigPath, installCopilotCli, uninstallCopilotCli } from '../src/bridges/copilot_cli_install.js'
import { copilotMcpConfigPath, isCopilotMcpServerInstalled } from '../src/bridges/copilot_mcp_install.js'

const FIXTURES = path.join(__dirname, 'fixtures', 'copilot_cli_1_0_88_mcp')
const AFTER_ADD = fs.readFileSync(path.join(FIXTURES, 'mcp-config-after-add.json'), 'utf8')
const AFTER_REMOVE = fs.readFileSync(path.join(FIXTURES, 'mcp-config-after-remove.json'), 'utf8')

let TMP: string
let origCwd: string
let origCopilotHome: string | undefined

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-mcp-install-')))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(path.join(TMP, 'home'))
  origCopilotHome = process.env['COPILOT_HOME']
  process.env['COPILOT_HOME'] = path.join(TMP, 'copilot-home')
  origCwd = process.cwd()
  fs.mkdirSync(path.join(TMP, 'project'), { recursive: true })
  process.chdir(path.join(TMP, 'project'))
})

afterEach(() => {
  process.chdir(origCwd)
  if (origCopilotHome === undefined) delete process.env['COPILOT_HOME']
  else process.env['COPILOT_HOME'] = origCopilotHome
  fs.rmSync(TMP, { recursive: true, force: true })
})

function servers(): Record<string, Record<string, unknown>> {
  return (JSON.parse(fs.readFileSync(copilotMcpConfigPath(), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers
}

function seed(text: string): void {
  fs.mkdirSync(path.dirname(copilotMcpConfigPath()), { recursive: true })
  fs.writeFileSync(copilotMcpConfigPath(), text)
}

describe('Copilot CLI MCP registration (CAPTURE copilot mcp add/remove, 1.0.88)', () => {
  it('writes <COPILOT_HOME>/mcp-config.json with the entry shape Copilot writes for its own local servers', () => {
    const result = installCopilotCli()
    expect(copilotMcpConfigPath()).toBe(path.join(TMP, 'copilot-home', 'mcp-config.json'))
    expect(result.mcpConfigPath).toBe(copilotMcpConfigPath())
    const ours = servers()['token-goat']!
    const copilots = (JSON.parse(AFTER_ADD) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers['token-goat']!
    expect(Object.keys(ours).sort()).toEqual(Object.keys(copilots).sort())
    expect(ours['type']).toBe(copilots['type'])
    expect(ours['tools']).toEqual(copilots['tools'])
    expect(ours['command']).toBe(process.execPath)
    expect(ours['args']).toHaveLength(2)
    expect(path.basename((ours['args'] as string[])[0]!)).toBe('token-goat.mjs')
    expect((ours['args'] as string[])[1]).toBe('mcp-serve')
    expect(isCopilotMcpServerInstalled()).toBe(true)
    expect(installCopilotCli().alreadyInstalled).toBe(true)
  })

  it('adds itself beside a server Copilot already holds and leaves that server as Copilot wrote it', () => {
    seed(AFTER_REMOVE)
    installCopilotCli()
    const after = servers()
    expect(Object.keys(after).sort()).toEqual(['other', 'token-goat'])
    expect(after['other']).toEqual((JSON.parse(AFTER_REMOVE) as { mcpServers: Record<string, unknown> }).mcpServers['other'])
  })

  it('uninstalls to exactly what `copilot mcp remove token-goat` leaves', () => {
    seed(AFTER_REMOVE)
    installCopilotCli()
    uninstallCopilotCli()
    expect(JSON.parse(fs.readFileSync(copilotMcpConfigPath(), 'utf8'))).toEqual(JSON.parse(AFTER_REMOVE))
  })

  it('removes the entry Copilot itself wrote for `copilot mcp add token-goat -- node token-goat.mjs mcp-serve`, as Copilot would', () => {
    seed(AFTER_ADD)
    expect(uninstallCopilotCli()).toBe(true)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8').trim()).toBe(AFTER_REMOVE.trim())
  })

  it('deletes the file on uninstall when install created it and nothing else is left', () => {
    installCopilotCli()
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(true)
    uninstallCopilotCli()
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(false)
  })

  it('refreshes an entry that names a different Node binary instead of refusing it', () => {
    const stale = JSON.parse(AFTER_ADD) as { mcpServers: Record<string, Record<string, unknown>> }
    stale.mcpServers['token-goat']!['args'] = [path.join(TMP, 'old', 'dist', 'token-goat.mjs'), 'mcp-serve']
    seed(JSON.stringify(stale, null, 2))
    installCopilotCli()
    expect(servers()['token-goat']!['command']).toBe(process.execPath)
    expect(servers()['other']).toEqual(stale.mcpServers['other'])
  })

  it('replaces the hand-written entry the README used to show', () => {
    seed(JSON.stringify({ mcpServers: { 'token-goat': { command: 'token-goat', args: ['mcp-serve'] } } }, null, 2))
    installCopilotCli()
    expect(servers()['token-goat']!['type']).toBe('local')
    expect(isCopilotMcpServerInstalled()).toBe(true)
  })

  it('refuses a token-goat entry it did not write, before writing anything', () => {
    const foreign = JSON.stringify({ mcpServers: { 'token-goat': { type: 'http', url: 'https://example.invalid/mcp' } } }, null, 2)
    seed(foreign)
    expect(() => installCopilotCli()).toThrow(/did not write/)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8')).toBe(foreign)
    expect(fs.existsSync(copilotCliConfigPath())).toBe(false)
  })

  it('leaves mcp-config.json alone on a --local install, since Copilot reads it only at user scope', () => {
    const result = installCopilotCli({ local: true })
    expect(result.mcpConfigPath).toBeUndefined()
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(false)
  })

  it('keeps the entry on `uninstall --copilot --local`, which narrows removal to the project', () => {
    installCopilotCli()
    installCopilotCli({ local: true })
    uninstallCopilotCli({ local: true })
    expect(isCopilotMcpServerInstalled()).toBe(true)
  })
})
