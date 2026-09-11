/**
 * install --visualstudio: an MCP entry plus routing guidance for Visual Studio's Copilot agent, and no hooks.
 *
 * PROVENANCE: FORMAT-DERIVED. File locations, the `servers` root key and the `{type:"stdio", command, args}` entry shape are from https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers ; the instructions paths (`.github/copilot-instructions.md`, `%USERPROFILE%\copilot-instructions.md`) from https://learn.microsoft.com/en-us/visualstudio/ide/copilot-chat-context ; "no hooks" from https://docs.github.com/en/copilot/concepts/agents/hooks , which lists hooks only for Copilot cloud agent and Copilot CLI. The `mcpServers` fixture is Claude Code's project `.mcp.json` key, the one cli_mcp_audit.ts reads. No run inside a live Visual Studio is recorded.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { COPILOT_INSTRUCTIONS_BEGIN, COPILOT_INSTRUCTIONS_END, installCopilotCli, uninstallCopilotCli } from '../src/bridges/copilot_cli_install.js'
import {
  installVisualStudio,
  SIBLING_GATE_MARKERS,
  uninstallVisualStudio,
  VISUALSTUDIO_GUIDANCE_BEGIN,
  VISUALSTUDIO_GUIDANCE_END,
  visualStudioProjectMcpPath,
  visualStudioUserMcpPath,
} from '../src/bridges/visualstudio_install.js'
import { installVscode, uninstallVscode, VSCODE_GUIDANCE_BEGIN, VSCODE_GUIDANCE_END } from '../src/bridges/vscode_install.js'
import { BRIDGE_CAPABILITY_MATRIX, bridgesStatusToJson, formatBridgesStatus } from '../src/bridges_status.js'
import { leftoverIntegrations } from '../src/cli.js'
import { checkVisualStudio } from '../src/cli_doctor.js'
import { readMcpConfig } from '../src/cli_mcp_audit.js'
import { BUNDLE } from './helpers/bundle.js'

const ENV_KEYS = ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'USERPROFILE', 'APPDATA', 'HOME', 'COPILOT_HOME'] as const
let saved: Record<string, string | undefined>
let root: string
let home: string
let project: string
const originalCwd = process.cwd()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-visualstudio-'))
  home = path.join(root, 'home')
  project = path.join(root, 'project')
  fs.mkdirSync(home)
  fs.mkdirSync(project)
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  // Everything token-goat keeps for itself lives outside `home`, so `home` holds only what the installer writes there.
  process.env['TOKEN_GOAT_HOME'] = path.join(root, 'tg')
  process.env['LOCALAPPDATA'] = path.join(root, 'localappdata')
  process.env['XDG_DATA_HOME'] = path.join(root, 'localappdata')
  process.env['APPDATA'] = path.join(root, 'appdata')
  process.env['COPILOT_HOME'] = path.join(root, 'copilot-home')
  process.env['USERPROFILE'] = home
  process.env['HOME'] = home
  process.chdir(project)
})

afterEach(() => {
  process.chdir(originalCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** Every file under `dir`, relative and forward-slashed, sorted. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort()
}

function gateCount(text: string): number {
  return text.split('answer one question first').length - 1
}

function blockOf(text: string, begin: string, end: string): string {
  const b = text.indexOf(begin)
  const e = text.indexOf(end)
  expect(b, `${begin} present`).toBeGreaterThanOrEqual(0)
  return text.slice(b, e + end.length)
}

const MANAGED = (): Record<string, unknown> => ({
  type: 'stdio',
  command: process.execPath,
  args: [path.join(originalCwd, 'dist', 'token-goat.mjs'), 'mcp-serve'],
})

describe('install --visualstudio, user scope (default)', () => {
  it('writes exactly %USERPROFILE%\\.mcp.json and %USERPROFILE%\\copilot-instructions.md, no hooks, and nothing in the cwd', () => {
    const result = installVisualStudio()
    expect(result.scope).toBe('user')
    expect(result.mcpPath).toBe(path.join(home, '.mcp.json'))
    expect(result.instructionsPath).toBe(path.join(home, 'copilot-instructions.md'))
    expect(filesUnder(home)).toEqual(['.mcp.json', 'copilot-instructions.md'])
    expect(filesUnder(project)).toEqual([])
    expect(fs.existsSync(path.join(root, 'copilot-home'))).toBe(false)

    const config = JSON.parse(fs.readFileSync(result.mcpPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(config)).toEqual(['servers'])
    expect((config['servers'] as Record<string, unknown>)['token-goat']).toEqual(MANAGED())

    const guidance = fs.readFileSync(result.instructionsPath, 'utf8')
    expect(gateCount(guidance)).toBe(1)
    expect(guidance).toContain('readfile, code_search, and find_references')
    expect(guidance).toContain('Visual Studio runs no token-goat hooks')
    expect(guidance).toContain('retrieve_text')
    // VS Code's claims about hooks must not leak into the Visual Studio text.
    expect(guidance).not.toContain('The hooks can deny')
  })

  it('is idempotent: a second install reports alreadyInstalled and changes no byte', () => {
    const first = installVisualStudio()
    const mcp = fs.readFileSync(first.mcpPath, 'utf8')
    const guidance = fs.readFileSync(first.instructionsPath, 'utf8')
    expect(installVisualStudio().alreadyInstalled).toBe(true)
    expect(fs.readFileSync(first.mcpPath, 'utf8')).toBe(mcp)
    expect(fs.readFileSync(first.instructionsPath, 'utf8')).toBe(guidance)
  })

  it('uninstall deletes the two files it created and leaves the home directory as it found it', () => {
    installVisualStudio()
    expect(uninstallVisualStudio()).toBe(true)
    expect(filesUnder(home)).toEqual([])
    expect(uninstallVisualStudio()).toBe(false)
  })

  it('uninstall restores foreign servers, JSONC comments and user instructions byte for byte', () => {
    const mcpOriginal = '// my servers\n{\n  "servers": {\n    "other": { "type": "stdio", "command": "other-mcp" },\n  },\n  "inputs": []\n}\n'
    const guidanceOriginal = '# My rules\n\nAlways write tests.\n'
    fs.writeFileSync(path.join(home, '.mcp.json'), mcpOriginal)
    fs.writeFileSync(path.join(home, 'copilot-instructions.md'), guidanceOriginal)
    installVisualStudio()
    const during = fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')
    expect(during).toContain('// my servers')
    expect(during).toContain('"other-mcp"')
    expect(fs.readFileSync(path.join(home, 'copilot-instructions.md'), 'utf8').startsWith('# My rules\n\nAlways write tests.\n')).toBe(true)
    uninstallVisualStudio()
    expect(fs.readFileSync(path.join(home, 'copilot-instructions.md'), 'utf8')).toBe(guidanceOriginal)
    const after = fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')
    expect(after).toContain('// my servers')
    expect(after).toContain('"other": { "type": "stdio", "command": "other-mcp" }')
    expect(after).not.toContain('token-goat')
  })

  it('fails clearly on malformed JSON and refuses to replace a foreign server named token-goat', () => {
    fs.writeFileSync(path.join(home, '.mcp.json'), '{not json')
    expect(() => installVisualStudio()).toThrow(/malformed Visual Studio MCP JSON/)
    fs.writeFileSync(path.join(home, '.mcp.json'), JSON.stringify({ servers: { 'token-goat': { type: 'http', url: 'http://example.test/mcp' } } }))
    expect(() => installVisualStudio()).toThrow(/non-token-goat-managed server/)
  })
})

describe('install --visualstudio -p (project scope)', () => {
  it('writes <project>/.mcp.json and <project>/.github/copilot-instructions.md and leaves the home directory alone', () => {
    const result = installVisualStudio({ project: true })
    expect(result.scope).toBe('project')
    expect(filesUnder(project)).toEqual(['.github/copilot-instructions.md', '.mcp.json'])
    expect(filesUnder(home)).toEqual([])
    const config = JSON.parse(fs.readFileSync(visualStudioProjectMcpPath(), 'utf8')) as Record<string, unknown>
    expect((config['servers'] as Record<string, unknown>)['token-goat']).toEqual(MANAGED())
    expect(uninstallVisualStudio({ project: true })).toBe(true)
    expect(filesUnder(project)).toEqual([])
  })

  it("leaves Claude Code's mcpServers key byte-exact through install and uninstall, and registers nothing under it", () => {
    const original = '{\n  "mcpServers": {\n    "mine": { "command": "npx", "args": ["-y", "my-mcp"] }\n  }\n}\n'
    fs.writeFileSync(path.join(project, '.mcp.json'), original)
    installVisualStudio({ project: true })
    const during = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')
    expect(during).toContain('"mine": { "command": "npx", "args": ["-y", "my-mcp"] }')
    const parsed = JSON.parse(during) as { mcpServers: Record<string, unknown>; servers: Record<string, unknown> }
    expect(Object.keys(parsed.mcpServers)).toEqual(['mine'])
    expect(Object.keys(parsed.servers)).toEqual(['token-goat'])
    // What token-goat's own MCP audit sees as Claude Code's servers: the user's one, never ours.
    expect(Object.keys(readMcpConfig(project) ?? {})).toEqual(['mine'])
    uninstallVisualStudio({ project: true })
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).toBe(original)
  })

  it('a .mcp.json holding only Visual Studio servers reads as no Claude Code config, not as a server named "servers"', () => {
    installVisualStudio({ project: true })
    expect(readMcpConfig(project)).toBeNull()
  })

  it('refuses to register twice across scopes, in both directions', () => {
    installVisualStudio({ project: true })
    expect(() => installVisualStudio()).toThrow(/already registered in Visual Studio project scope/)
    expect(fs.existsSync(visualStudioUserMcpPath())).toBe(false)
    uninstallVisualStudio({ project: true })
    installVisualStudio()
    expect(() => installVisualStudio({ project: true })).toThrow(/already registered in Visual Studio user scope/)
    expect(fs.existsSync(visualStudioProjectMcpPath())).toBe(false)
  })
})

describe('sharing .github/copilot-instructions.md with the VS Code and Copilot CLI blocks', () => {
  const instructions = (): string => fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')

  it('the sibling markers are the real VS Code and Copilot CLI markers', () => {
    expect(SIBLING_GATE_MARKERS).toEqual([
      [VSCODE_GUIDANCE_BEGIN, VSCODE_GUIDANCE_END],
      [COPILOT_INSTRUCTIONS_BEGIN, COPILOT_INSTRUCTIONS_END],
    ])
  })

  it('vscode -p then visualstudio -p: one gate in the file, and the Visual Studio block is a short addendum', () => {
    installVscode({ project: true, projectRoot: project })
    const vscodeOnly = instructions()
    installVisualStudio({ project: true })
    const both = instructions()
    expect(gateCount(both)).toBe(1)
    const vsBlock = blockOf(both, VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END)
    expect(vsBlock).toContain('The token-goat gate elsewhere in this file applies in Visual Studio too')
    expect(vsBlock).toContain('Visual Studio runs no token-goat hooks')
    // Uninstalling Visual Studio gives back exactly the VS Code-only file.
    uninstallVisualStudio({ project: true })
    expect(instructions()).toBe(vscodeOnly)
  })

  it('visualstudio -p then vscode -p: installing VS Code shrinks the Visual Studio block, so the gate is still there once', () => {
    installVisualStudio({ project: true })
    expect(gateCount(instructions())).toBe(1)
    installVscode({ project: true, projectRoot: project })
    expect(gateCount(instructions())).toBe(1)
    expect(blockOf(instructions(), VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END)).toContain('elsewhere in this file')
  })

  it('uninstall --vscode -p leaves Visual Studio with the full gate it still needs', () => {
    installVscode({ project: true, projectRoot: project })
    installVisualStudio({ project: true })
    uninstallVscode({ project: true, projectRoot: project })
    const after = instructions()
    expect(after).not.toContain(VSCODE_GUIDANCE_BEGIN)
    expect(gateCount(after)).toBe(1)
    const vsBlock = blockOf(after, VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END)
    expect(gateCount(vsBlock)).toBe(1)
    expect(vsBlock).toContain('readfile, code_search, and find_references tools only pick the *fallback*')
    // The MCP entry VS Code's -p install wrote lives in .vscode/mcp.json; Visual Studio's own entry is untouched.
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(true)
  })

  it('copilot --local shares the file the same way, and uninstall --copilot --local restores the full gate', () => {
    installCopilotCli({ local: true })
    installVisualStudio({ project: true })
    expect(gateCount(instructions())).toBe(1)
    uninstallCopilotCli({ local: true })
    expect(gateCount(instructions())).toBe(1)
    expect(gateCount(blockOf(instructions(), VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END))).toBe(1)
  })
})

describe('doctor, bridges-status and uninstall reporting', () => {
  it('checkVisualStudio is silent when nothing is installed, ok when installed, and warns on a stale bundle path', () => {
    const paths = [visualStudioUserMcpPath(), visualStudioProjectMcpPath()]
    expect(checkVisualStudio(paths)).toBeNull()
    installVisualStudio()
    const ok = checkVisualStudio(paths)
    expect(ok?.status).toBe('ok')
    expect(ok?.message).toContain(visualStudioUserMcpPath())
    expect(ok?.message).toContain('runs no token-goat hooks')
    const stale = { servers: { 'token-goat': { type: 'stdio', command: process.execPath, args: [path.join(root, 'gone', 'token-goat.mjs'), 'mcp-serve'] } } }
    fs.writeFileSync(visualStudioUserMcpPath(), JSON.stringify(stale))
    const warn = checkVisualStudio(paths)
    expect(warn?.status).toBe('warn')
    expect(warn?.message).toContain('no longer exists')
  })

  it('bridges-status has a visualstudio row that wires no hook event and says why', () => {
    const row = BRIDGE_CAPABILITY_MATRIX.find((r) => r.harness === 'visualstudio')
    expect(row?.implemented.size).toBe(0)
    expect(formatBridgesStatus()).toMatch(/visualstudio\s+.*\s0\/10/)
    const json = bridgesStatusToJson().find((r) => r.harness === 'visualstudio')
    expect(Object.values(json?.events ?? { x: true }).every((v) => !v)).toBe(true)
    expect(json?.reasons['pre_tool_use']).toContain('no agent hooks')
  })

  it('uninstall without --visualstudio names the integration it leaves behind', () => {
    installVisualStudio()
    expect(leftoverIntegrations({})).toEqual([{ flag: '--visualstudio', label: 'Visual Studio MCP integration' }])
    expect(leftoverIntegrations({ visualstudio: true })).toEqual([])
  })
})

describe('the built bundle', () => {
  function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(root, 'appdata'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
      COPILOT_HOME: path.join(root, 'copilot-home'),
      TOKEN_GOAT_HOME: path.join(root, 'tg'),
      TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
    }
    const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  it('install --visualstudio writes the two user files, prints the manual steps, and leaves the cwd empty; uninstall removes them', () => {
    const install = run(project, ['install', '--visualstudio'])
    expect(install.status, install.stderr).toBe(0)
    expect(install.stdout).toContain('Installed token-goat Visual Studio MCP integration (user scope)')
    expect(install.stdout).toContain('Enable custom instructions to be loaded from .github/copilot-instructions.md files and added to requests')
    expect(install.stdout).toContain('Tools picker')
    expect(install.stdout).toContain('Visual Studio 2022 17.14')
    expect(install.stdout).not.toMatch(/^Note: .*do not commit them/m)
    expect(filesUnder(project)).toEqual([])
    const config = JSON.parse(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')) as { servers: Record<string, { args: string[] }> }
    expect(path.basename(config.servers['token-goat']?.args[0] ?? '')).toBe('token-goat.mjs')
    expect(fs.readFileSync(path.join(home, 'copilot-instructions.md'), 'utf8')).toContain(VISUALSTUDIO_GUIDANCE_BEGIN)
    expect(fs.existsSync(path.join(home, '.copilot', 'hooks'))).toBe(false)

    const uninstall = run(project, ['uninstall', '--visualstudio'])
    expect(uninstall.status, uninstall.stderr).toBe(0)
    expect(uninstall.stdout).toContain('Removed token-goat Visual Studio MCP integration.')
    expect(fs.existsSync(path.join(home, '.mcp.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'copilot-instructions.md'))).toBe(false)
  })

  it('install -p --visualstudio prints the do-not-commit note, and the Claude Code install and uninstall leave a user mcpServers key byte-exact', () => {
    const original = '{\n  "mcpServers": {\n    "mine": { "command": "npx", "args": ["-y", "my-mcp"] }\n  }\n}\n'
    const mcpPath = path.join(project, '.mcp.json')
    fs.writeFileSync(mcpPath, original)
    const install = run(project, ['install', '-p', '--visualstudio'])
    expect(install.status, install.stderr).toBe(0)
    const note = /^Note: .*do not commit them: list them in \.git\/info\/exclude or \.gitignore\.$/m.exec(install.stdout)?.[0]
    expect(note).toContain(mcpPath)
    const installed = fs.readFileSync(mcpPath, 'utf8')
    expect(installed).toContain('"mine": { "command": "npx", "args": ["-y", "my-mcp"] }')

    // A Claude-Code-only uninstall must not touch the file at all, and says what it left.
    const claudeOnly = run(project, ['uninstall', '-p'])
    expect(claudeOnly.status, claudeOnly.stderr).toBe(0)
    expect(claudeOnly.stdout).toContain('token-goat uninstall --visualstudio')
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe(installed)

    const uninstall = run(project, ['uninstall', '-p', '--visualstudio'])
    expect(uninstall.status, uninstall.stderr).toBe(0)
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe(original)
  })
})
