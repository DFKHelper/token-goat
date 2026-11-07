/** Copilot CLI now uses native hooks instead of token-goat MCP. These tests cover removal of legacy MCP entries by the CLI installer/uninstaller and retain direct coverage of the MCP compatibility helpers. PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88_mcp/ holds what GitHub Copilot CLI 1.0.88 itself wrote on Windows, recorded on 2026-09-28 in an isolated COPILOT_HOME, with the console output in transcript.txt beside it: `copilot mcp add other -- echo hi`, then `copilot mcp add token-goat -- "C:/Program Files/nodejs/node.exe" C:/x/dist/token-goat.mjs mcp-serve` (mcp-config-after-add.json), then `copilot mcp remove token-goat` (mcp-config-after-remove.json). */
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
import {
  copilotMcpConfigPath,
  installCopilotMcpServer,
  isCopilotMcpServerInstalled,
  uninstallCopilotMcpServer,
} from '../src/bridges/copilot_mcp_install.js'

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
  it('does not install MCP for Copilot CLI', () => {
    const result = installCopilotCli()
    expect(copilotMcpConfigPath()).toBe(path.join(TMP, 'copilot-home', 'mcp-config.json'))
    expect(result.mcpConfigPath).toBeUndefined()
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(false)
    expect(isCopilotMcpServerInstalled()).toBe(false)
    expect(installCopilotCli().alreadyInstalled).toBe(true)
  })

  it('removes a previously installed MCP entry during a user-scope hooks install', () => {
    seed(AFTER_ADD)
    const result = installCopilotCli()
    expect(result.mcpConfigPath).toBeUndefined()
    expect(isCopilotMcpServerInstalled()).toBe(false)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8').trim()).toBe(AFTER_REMOVE.trim())
  })

  it('does not add an MCP entry beside a server Copilot already holds', () => {
    seed(AFTER_REMOVE)
    const result = installCopilotCli()
    expect(result.mcpConfigPath).toBeUndefined()
    const after = servers()
    expect(Object.keys(after)).toEqual(['other'])
    expect(after['other']).toEqual((JSON.parse(AFTER_REMOVE) as { mcpServers: Record<string, unknown> }).mcpServers['other'])
  })

  it('writes the captured entry shape only when installCopilotMcpServer is called directly', () => {
    expect(installCopilotMcpServer()).toBe(true)
    expect(copilotMcpConfigPath()).toBe(path.join(TMP, 'copilot-home', 'mcp-config.json'))
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
    expect(installCopilotMcpServer()).toBe(false)
  })

  it('adds the directly installed MCP entry beside a server Copilot already holds', () => {
    seed(AFTER_REMOVE)
    expect(installCopilotMcpServer()).toBe(true)
    const after = servers()
    expect(Object.keys(after).sort()).toEqual(['other', 'token-goat'])
    expect(after['other']).toEqual((JSON.parse(AFTER_REMOVE) as { mcpServers: Record<string, unknown> }).mcpServers['other'])
  })

  it('uninstalls the direct MCP installation to exactly what Copilot leaves', () => {
    seed(AFTER_REMOVE)
    expect(installCopilotMcpServer()).toBe(true)
    expect(uninstallCopilotMcpServer()).toBe(true)
    expect(JSON.parse(fs.readFileSync(copilotMcpConfigPath(), 'utf8'))).toEqual(JSON.parse(AFTER_REMOVE))
  })

  it('uninstall --copilot removes a legacy MCP entry Copilot itself wrote', () => {
    seed(AFTER_ADD)
    expect(uninstallCopilotCli()).toBe(true)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8').trim()).toBe(AFTER_REMOVE.trim())
  })

  it('direct MCP uninstall removes the entry Copilot itself wrote', () => {
    seed(AFTER_ADD)
    expect(uninstallCopilotMcpServer()).toBe(true)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8').trim()).toBe(AFTER_REMOVE.trim())
  })

  it('deletes the file on uninstall when install created it and nothing else is left', () => {
    installCopilotMcpServer()
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(true)
    expect(uninstallCopilotMcpServer()).toBe(true)
    expect(fs.existsSync(copilotMcpConfigPath())).toBe(false)
  })

  it('refreshes an entry that names a different Node binary instead of refusing it', () => {
    const stale = JSON.parse(AFTER_ADD) as { mcpServers: Record<string, Record<string, unknown>> }
    stale.mcpServers['token-goat']!['args'] = [path.join(TMP, 'old', 'dist', 'token-goat.mjs'), 'mcp-serve']
    seed(JSON.stringify(stale, null, 2))
    installCopilotMcpServer()
    expect(servers()['token-goat']!['command']).toBe(process.execPath)
    expect(servers()['other']).toEqual(stale.mcpServers['other'])
  })

  it('replaces the hand-written entry the README used to show', () => {
    seed(JSON.stringify({ mcpServers: { 'token-goat': { command: 'token-goat', args: ['mcp-serve'] } } }, null, 2))
    installCopilotMcpServer()
    expect(servers()['token-goat']!['type']).toBe('local')
    expect(isCopilotMcpServerInstalled()).toBe(true)
  })

  it('leaves a foreign MCP entry alone while installing Copilot hooks', () => {
    const foreign = JSON.stringify({ mcpServers: { 'token-goat': { type: 'http', url: 'https://example.invalid/mcp' } } }, null, 2)
    seed(foreign)
    const result = installCopilotCli()
    expect(result.mcpConfigPath).toBeUndefined()
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8')).toBe(foreign)
    expect(isCopilotMcpServerInstalled()).toBe(false)
  })

  it('refuses a foreign MCP entry when the direct MCP installer is called', () => {
    const foreign = JSON.stringify({ mcpServers: { 'token-goat': { type: 'http', url: 'https://example.invalid/mcp' } } }, null, 2)
    seed(foreign)
    expect(() => installCopilotMcpServer()).toThrow(/did not write/)
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8')).toBe(foreign)
    expect(fs.existsSync(copilotCliConfigPath())).toBe(false)
  })

  it('leaves a user-scope MCP entry alone on a --local hooks install', () => {
    seed(AFTER_ADD)
    const result = installCopilotCli({ local: true })
    expect(result.mcpConfigPath).toBeUndefined()
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8').trim()).toBe(AFTER_ADD.trim())
    expect(isCopilotMcpServerInstalled()).toBe(true)
  })

  it('keeps the entry on `uninstall --copilot --local`, which narrows removal to the project', () => {
    installCopilotMcpServer()
    installCopilotCli({ local: true })
    uninstallCopilotCli({ local: true })
    expect(isCopilotMcpServerInstalled()).toBe(true)
  })
})
