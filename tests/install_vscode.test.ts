import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installVscode, uninstallVscode, vscodeDecoderConfigured, vscodeUserMcpPath } from '../src/bridges/vscode_install.js'

const savedAppData = process.env['APPDATA']
const savedHome = process.env['HOME']
const savedUserProfile = process.env['USERPROFILE']

afterEach(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  if (savedUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = savedUserProfile
})

// vscodeUserConfigDir() derives the user-scope path from APPDATA on win32 but from
// os.homedir() (which reads HOME on POSIX, USERPROFILE as its win32 fallback) everywhere
// else, so isolating only APPDATA leaves POSIX runs writing into the real developer/CI-runner
// home directory, where state from an earlier test in this file persists and pollutes later
// ones (the "already registered" / stale "configured: true" failures this fixes).
function isolateVscodeUserDir(userDir: string): void {
  process.env['APPDATA'] = userDir
  process.env['HOME'] = userDir
  process.env['USERPROFILE'] = userDir
}

describe('VS Code project-local install', () => {
  it('merges servers and guidance without replacing unrelated content', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-test-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.mkdirSync(path.join(project, '.github'), { recursive: true })
      fs.writeFileSync(path.join(project, '.vscode', 'mcp.json'), JSON.stringify({ other: true, servers: { other: { type: 'stdio' } } }))
      fs.writeFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'user guidance\n')
      const result = installVscode({ project: true, projectRoot: project })
      expect(result.scope).toBe('project')
      const config = JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')) as Record<string, unknown>
      expect(config['other']).toBe(true)
      expect((config['servers'] as Record<string, unknown>)['other']).toEqual({ type: 'stdio' })
      expect((config['servers'] as Record<string, unknown>)['token-goat']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist', 'token-goat.mjs'), 'mcp-serve'],
      })
      const guidance = fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')
      expect(guidance).toContain('user guidance')
      expect(guidance).toContain('servers root key')
      expect(guidance).toContain('does not intercept')
      // The decode contract: without it the model receives a compressed
      // payload with no instruction to call retrieve_text and parrots the blob.
      expect(guidance).toContain('retrieve_text')
      expect(installVscode({ project: true, projectRoot: project }).alreadyInstalled).toBe(true)
      expect(uninstallVscode({ project: true, projectRoot: project })).toBe(true)
      const after = JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')) as Record<string, unknown>
      expect((after['servers'] as Record<string, unknown>)['other']).toEqual({ type: 'stdio' })
      expect((after['servers'] as Record<string, unknown>)['token-goat']).toBeUndefined()
      expect(fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')).toBe('user guidance\n')
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('fails clearly on malformed JSON', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-malformed-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(path.join(project, '.vscode', 'mcp.json'), '{not json')
      expect(() => installVscode({ project: true, projectRoot: project })).toThrow(/malformed VS Code MCP JSON/)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('preserves valid JSONC comments and trailing commas', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-jsonc-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(
        path.join(project, '.vscode', 'mcp.json'),
        '// user comment\n{\n  "servers": {\n    "other": { "type": "stdio" },\n  },\n}\n',
      )
      installVscode({ project: true, projectRoot: project })
      const config = fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')
      expect(config).toContain('// user comment')
      expect(config).toContain('"other"')
      expect(config).toContain('"type": "stdio"')
      expect(config).toContain('"token-goat"')
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('does not overwrite an unrelated server using the token-goat name', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-conflict-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(
        path.join(project, '.vscode', 'mcp.json'),
        JSON.stringify({ servers: { 'token-goat': { type: 'http', url: 'http://example.test/mcp' } } }),
      )
      expect(() => installVscode({ project: true, projectRoot: project })).toThrow(/non-token-goat-managed server/)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('VS Code user-scope install (default, no --project)', () => {
  it('writes to the user-profile mcp.json, not the project-local one, when --project is omitted', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userdir-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userscope-project-'))
    isolateVscodeUserDir(userDir)
    try {
      const result = installVscode({ projectRoot: project })
      expect(result.scope).toBe('user')
      expect(result.mcpPath).toBe(vscodeUserMcpPath())
      expect(fs.existsSync(path.join(project, '.vscode', 'mcp.json'))).toBe(false)
      const config = JSON.parse(fs.readFileSync(result.mcpPath, 'utf8')) as Record<string, unknown>
      expect((config['servers'] as Record<string, unknown>)['token-goat']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist', 'token-goat.mjs'), 'mcp-serve'],
      })
      expect(uninstallVscode({ projectRoot: project })).toBe(true)
      const after = JSON.parse(fs.readFileSync(result.mcpPath, 'utf8')) as Record<string, unknown>
      expect((after['servers'] as Record<string, unknown>)['token-goat']).toBeUndefined()
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('preserves unrelated servers already in the user-profile mcp.json', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userdir-merge-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userscope-project-'))
    isolateVscodeUserDir(userDir)
    try {
      const mcpPath = vscodeUserMcpPath()
      fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
      fs.writeFileSync(mcpPath, JSON.stringify({ servers: { other: { type: 'stdio' } } }))
      installVscode({ projectRoot: project })
      const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as Record<string, unknown>
      expect((config['servers'] as Record<string, unknown>)['other']).toEqual({ type: 'stdio' })
      expect((config['servers'] as Record<string, unknown>)['token-goat']).toBeDefined()
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('refuses to double-register when the other scope already has a managed entry', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userdir-dup-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-project-dup-'))
    isolateVscodeUserDir(userDir)
    try {
      // Install project scope first, then attempt the default (user scope) install.
      installVscode({ project: true, projectRoot: project })
      expect(() => installVscode({ projectRoot: project })).toThrow(/already registered in VS Code project scope/)
      expect(fs.existsSync(vscodeUserMcpPath())).toBe(false)

      // And the reverse: user scope first, then project scope should refuse too.
      uninstallVscode({ project: true, projectRoot: project })
      installVscode({ projectRoot: project })
      expect(() => installVscode({ project: true, projectRoot: project })).toThrow(/already registered in VS Code user scope/)
      const projectMcpPath = path.join(project, '.vscode', 'mcp.json')
      if (fs.existsSync(projectMcpPath)) {
        const config = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8')) as Record<string, unknown>
        const servers = (config['servers'] as Record<string, unknown> | undefined) ?? {}
        expect(servers['token-goat']).toBeUndefined()
      }
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('vscodeDecoderConfigured (extension false-prompt regression)', () => {
  it('reports configured from a user-scope install with no workspace mcp.json and no projectRoot given', () => {
    // This is the exact bug scenario: install --vscode defaults to user scope (9c220be7),
    // so a correctly-installed user has no <project>/.vscode/mcp.json at all. A check that
    // only reads the workspace file must not conclude "not configured" here.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-userdir-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-user-project-'))
    isolateVscodeUserDir(userDir)
    try {
      installVscode({ projectRoot: project })
      expect(vscodeDecoderConfigured().configured).toBe(true)
      expect(vscodeDecoderConfigured().checkedPaths).toEqual([vscodeUserMcpPath()])
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('detects a user-scope install even with no workspace folder open (no projectRoot passed)', () => {
    // A user-scope install is workspace-independent -- it must be detectable with nothing
    // to key a projectRoot off of at all, not just "no mcp.json inside this workspace".
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-nofolder-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-nofolder-project-'))
    isolateVscodeUserDir(userDir)
    try {
      installVscode({ projectRoot: project })
      const status = vscodeDecoderConfigured(undefined)
      expect(status.configured).toBe(true)
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('reports not configured when neither scope has token-goat registered', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-empty-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-empty-project-'))
    isolateVscodeUserDir(userDir)
    try {
      const status = vscodeDecoderConfigured({ projectRoot: project })
      expect(status.configured).toBe(false)
      expect(status.checkedPaths).toEqual([vscodeUserMcpPath(), path.join(project, '.vscode', 'mcp.json')])
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('also reports configured from a project-scope install when projectRoot is given', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-projscope-userdir-'))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-status-projscope-'))
    isolateVscodeUserDir(userDir)
    try {
      installVscode({ project: true, projectRoot: project })
      expect(vscodeDecoderConfigured({ projectRoot: project }).configured).toBe(true)
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
