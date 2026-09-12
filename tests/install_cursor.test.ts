import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cursorManagedServer, cursorMcpPath, installCursor, isCursorInstalled, uninstallCursor } from '../src/bridges/cursor_install.js'
import { checkCursor } from '../src/cli_doctor.js'

let origHome: string | undefined
let origUserProfile: string | undefined
let fakeHome: string

// cursorUserConfigDir() resolves ~/.cursor via os.homedir(), which reads USERPROFILE on Windows and
// HOME on POSIX at each call -- same isolation tests/install.test.ts documents for settingsPath().
beforeEach(() => {
  origHome = process.env['HOME']
  origUserProfile = process.env['USERPROFILE']
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-cursor-userdir-'))
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
})

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  if (origUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = origUserProfile
  if (fakeHome && fs.existsSync(fakeHome)) fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('Cursor install writes an mcpServers entry with no type key', () => {
  it('creates mcp.json with only command and args on the token-goat entry', () => {
    const result = installCursor()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.scope).toBe('user')
    expect(fs.existsSync(result.mcpPath)).toBe(true)

    const parsed = JSON.parse(fs.readFileSync(result.mcpPath, 'utf8')) as Record<string, unknown>
    const servers = parsed['mcpServers'] as Record<string, unknown>
    const entry = servers['token-goat'] as Record<string, unknown>
    // Provenance: CAPTURE -- extracted live from Cursor 3.19.7's own shipped
    // resources/app/out/vs/workbench/workbench.desktop.main.js JSON schema for mcp.json:
    // `zto={...additionalProperties:{...oneOf:[{additionalProperties:!1,properties:{command:...,
    // args:...,env:...}}...`. No `type` field is declared for the stdio variant, and
    // additionalProperties is false, so this file writes command+args only.
    expect(Object.keys(entry).sort()).toEqual(['args', 'command'])
    expect(entry['command']).toBe(process.execPath)
    expect(Array.isArray(entry['args'])).toBe(true)
    expect((entry['args'] as string[])[1]).toBe('mcp-serve')
  })

  it('never has a "type" key, unlike VS Code/Visual Studio managedServer()', () => {
    const entry = cursorManagedServer() as Record<string, unknown>
    expect('type' in entry).toBe(false)
  })

  it('is idempotent: a second install reports alreadyInstalled and does not duplicate the entry', () => {
    installCursor()
    const second = installCursor()
    expect(second.alreadyInstalled).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(second.mcpPath, 'utf8')) as Record<string, unknown>
    const servers = parsed['mcpServers'] as Record<string, unknown>
    expect(Object.keys(servers)).toEqual(['token-goat'])
  })

  it('isCursorInstalled reflects install/uninstall state', () => {
    expect(isCursorInstalled()).toBe(false)
    installCursor()
    expect(isCursorInstalled()).toBe(true)
    uninstallCursor()
    expect(isCursorInstalled()).toBe(false)
  })
})

describe('Cursor project scope', () => {
  it('writes <project>/.cursor/mcp.json instead of the user one, and is isolated from it', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-cursor-project-'))
    try {
      const result = installCursor({ project: true, projectRoot })
      expect(result.scope).toBe('project')
      expect(result.mcpPath).toBe(path.join(projectRoot, '.cursor', 'mcp.json'))
      expect(isCursorInstalled()).toBe(false)
      expect(isCursorInstalled({ project: true, projectRoot })).toBe(true)
      expect(uninstallCursor({ project: true, projectRoot })).toBe(true)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('Cursor install merges surgically into an existing mcp.json', () => {
  it('preserves a user comment, unrelated keys, and another server entry', () => {
    const mcpPath = cursorMcpPath()
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    // Provenance: HAND-DERIVED from Cursor's own documented ~/.cursor/mcp.json shape
    // (root mcpServers, {command,args,env,envFile} per entry).
    const before = ['{', '  // user\'s own server', '  "mcpServers": {', '    "some-other-server": {', '      "command": "/usr/local/bin/other-mcp",', '      "args": ["--flag"]', '    }', '  }', '}', ''].join('\n')
    fs.writeFileSync(mcpPath, before)

    installCursor()

    const after = fs.readFileSync(mcpPath, 'utf8')
    expect(after).toContain("user's own server")
    expect(after).toContain('/usr/local/bin/other-mcp')
    const parsed = JSON.parse(after.replace(/\/\/.*$/gm, '')) as Record<string, unknown>
    const servers = parsed['mcpServers'] as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(['some-other-server', 'token-goat'])
  })

  it('uninstall removes only the token-goat entry, leaving the user file and its other server intact', () => {
    const mcpPath = cursorMcpPath()
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    const before = JSON.stringify({ mcpServers: { 'some-other-server': { command: '/usr/local/bin/other-mcp', args: ['--flag'] } } }, null, 2) + '\n'
    fs.writeFileSync(mcpPath, before)

    installCursor()
    expect(uninstallCursor()).toBe(true)

    expect(fs.existsSync(mcpPath), 'uninstall deleted a file token-goat never created').toBe(true)
    const after = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as Record<string, unknown>
    const servers = after['mcpServers'] as Record<string, unknown>
    expect(Object.keys(servers)).toEqual(['some-other-server'])
  })
})

describe('Cursor uninstall leaves no residue when token-goat created the file', () => {
  it('deletes mcp.json once nothing of the user is left', () => {
    installCursor()
    const mcpPath = cursorMcpPath()
    expect(uninstallCursor()).toBe(true)
    expect(fs.existsSync(mcpPath), 'uninstall left behind a file holding nothing but an empty mcpServers object').toBe(false)
  })

  it('uninstall on a clean system does nothing and returns false', () => {
    expect(uninstallCursor()).toBe(false)
  })
})

describe('checkCursor doctor report', () => {
  it('reports null when nothing is installed', () => {
    expect(checkCursor(cursorMcpPath(), false)).toBeNull()
  })

  it('reports ok and mentions the auto-import when Claude Code hooks are already installed', () => {
    installCursor()
    const result = checkCursor(cursorMcpPath(), true)
    expect(result?.status).toBe('ok')
    expect(result?.message).toContain('~/.claude/settings.json')
    expect(result?.message).toMatch(/imports/)
  })

  it('reports ok but flags that no hooks will fire when Claude Code hooks are not installed', () => {
    installCursor()
    const result = checkCursor(cursorMcpPath(), false)
    expect(result?.status).toBe('ok')
    expect(result?.message).toContain('run "token-goat install"')
  })
})

describe('Cursor install refuses to clobber a foreign token-goat entry', () => {
  it('throws and leaves the file byte-for-byte unchanged', () => {
    const mcpPath = cursorMcpPath()
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    const before = JSON.stringify({ mcpServers: { 'token-goat': { command: '/not/ours', args: ['x'] } } }, null, 2) + '\n'
    fs.writeFileSync(mcpPath, before)

    expect(() => installCursor()).toThrow(/already has a "token-goat" MCP server entry/)
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe(before)
  })

  it('throws before writing on a malformed mcp.json', () => {
    const mcpPath = cursorMcpPath()
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    fs.writeFileSync(mcpPath, '{ not valid json')
    expect(() => installCursor()).toThrow()
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe('{ not valid json')
  })
})
