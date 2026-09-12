import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copilotHooksOwnersPath, installCopilotCli, isCopilotCliInstalled, readCopilotHooksOwners, uninstallCopilotCli } from '../src/bridges/copilot_cli_install.js'
import { installVscode, uninstallVscode, VSCODE_HOOK_FILE_EVENT_KEYS, vscodeDecoderConfigured, vscodeHooksInstalled, vscodeUserMcpPath, vscodeUsesClaudeHooks } from '../src/bridges/vscode_install.js'
import { checkVscodeClaudeHooks, checkVscodeUserScopeHooks } from '../src/cli_doctor.js'

const savedAppData = process.env['APPDATA']
const savedHome = process.env['HOME']
const savedUserProfile = process.env['USERPROFILE']
let defaultUserDir: string

beforeEach(() => {
  defaultUserDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-default-userdir-'))
  isolateVscodeUserDir(defaultUserDir)
})

afterEach(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  if (savedUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = savedUserProfile
  if (defaultUserDir && fs.existsSync(defaultUserDir)) {
    fs.rmSync(defaultUserDir, { recursive: true, force: true })
  }
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

describe('VS Code uninstall leaves no residue, and never deletes a file it did not create', () => {
  // Uninstall used to write back the entry-less config and stop there, leaving behind a file whose
  // whole content was an empty `servers` object. The sibling Visual Studio bridge already dropped the
  // empty key and removed what it had created; this is the same rule, including the half that matters
  // most: emptiness is not evidence of ownership, so only a file this install created is deleted.
  // Provenance: HAND-DERIVED. The `servers` root key and entry shape are the ones the install writes
  // and the sibling tests in this file already assert; the user-authored stub is written for this test.
  it('removes an mcp.json it created once nothing of the user is left in it', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-residue-'))
    try {
      const mcpPath = path.join(project, '.vscode', 'mcp.json')
      installVscode({ project: true, projectRoot: project })
      expect(fs.existsSync(mcpPath)).toBe(true)
      expect(uninstallVscode({ project: true, projectRoot: project })).toBe(true)
      expect(fs.existsSync(mcpPath), 'uninstall left behind a file holding nothing but an empty servers object').toBe(false)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('keeps a user-authored mcp.json even after uninstall empties it', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-vscode-userowned-'))
    try {
      const mcpPath = path.join(project, '.vscode', 'mcp.json')
      fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
      fs.writeFileSync(mcpPath, '{"servers": {}}\n')
      installVscode({ project: true, projectRoot: project })
      expect(uninstallVscode({ project: true, projectRoot: project })).toBe(true)
      expect(fs.existsSync(mcpPath), 'uninstall deleted a file token-goat never created').toBe(true)
      // Survival anchor on the other half: our own entry really was removed, so this cannot pass
      // by uninstall having done nothing at all.
      const after = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as Record<string, unknown>
      expect((after['servers'] as Record<string, unknown> | undefined)?.['token-goat']).toBeUndefined()
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

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
      expect(guidance).toContain('cannot fold or trim what a built-in read returns')
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
      // Nothing of the user's was ever in this file: the install above created it, so uninstall gives
      // the profile directory back as it found it instead of leaving an empty shell. This assertion
      // used to read the file back and check the entry was gone, which the shell also satisfied.
      expect(fs.existsSync(result.mcpPath)).toBe(false)
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

      // The reverse direction is now a MIGRATION, not an error, and the assertion below was
      // changed with the behaviour rather than around a failure. `install --vscode` defaults to
      // project scope because VS Code pins a user-scope hooks file to folders[0] of a multi-root
      // workspace; refusing the first post-upgrade run of the command every existing user already
      // types would make the new default a wall instead of an upgrade. Walking the user-scope
      // install back is also what stops the two firing twice -- VS Code runs every hooks file it
      // discovers, in both scopes (captured live, see src/vscode_duplicate.ts).
      uninstallVscode({ project: true, projectRoot: project })
      installVscode({ projectRoot: project })
      const migrated = installVscode({ project: true, projectRoot: project })
      expect(migrated.migratedFromUserScope).toBe(true)
      expect(migrated.scope).toBe('project')
      const projectMcpPath = path.join(project, '.vscode', 'mcp.json')
      const config = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8')) as Record<string, unknown>
      const servers = (config['servers'] as Record<string, unknown> | undefined) ?? {}
      expect(servers['token-goat']).toBeDefined()
      // The user-scope registration is gone, not merely superseded.
      if (fs.existsSync(vscodeUserMcpPath())) {
        expect(fs.readFileSync(vscodeUserMcpPath(), 'utf8')).not.toContain('token-goat')
      }
      expect(vscodeHooksInstalled()).toBe(false)
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

describe('VS Code agent hooks share the Copilot hooks file (ownership)', () => {
  let project: string
  const originalCwd = process.cwd()

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-hooks-owner-'))
    process.chdir(project)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(project, { recursive: true, force: true })
  })

  const hooksDir = (): string => path.join(project, '.github', 'hooks')
  const configPath = (): string => path.join(hooksDir(), 'token-goat.json')
  const shimPath = (): string => path.join(hooksDir(), 'token-goat-shim.js')

  it('install --vscode -p writes the shared hooks file and shim, whose commands carry only Copilot event names', () => {
    const result = installVscode({ project: true, projectRoot: project })
    expect(result.hooksConfigPath).toBe(configPath())
    expect(fs.existsSync(shimPath())).toBe(true)
    expect(vscodeHooksInstalled({ project: true, projectRoot: project })).toBe(true)
    const config = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { hooks: Record<string, unknown> }
    // VS Code fires these keys from the same file (its hook-type table in 1.136.0's extension.js).
    for (const key of ['sessionStart', 'preToolUse', 'postToolUse', 'agentStop', 'subagentStop', 'userPromptSubmitted']) {
      expect(VSCODE_HOOK_FILE_EVENT_KEYS).toContain(key)
      expect(config.hooks[key], key).toBeDefined()
    }
  })

  it('copilot then vscode: uninstall --vscode leaves the hooks Copilot CLI still needs, and the Copilot uninstall then removes them', () => {
    installCopilotCli({ local: true })
    installVscode({ project: true, projectRoot: project })
    expect([...readCopilotHooksOwners(hooksDir())].sort()).toEqual(['copilot', 'vscode'])

    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.existsSync(configPath())).toBe(true)
    expect(fs.existsSync(shimPath())).toBe(true)
    expect([...readCopilotHooksOwners(hooksDir())]).toEqual(['copilot'])
    expect(isCopilotCliInstalled({ local: true })).toBe(true)

    uninstallCopilotCli({ local: true })
    expect(fs.existsSync(configPath())).toBe(false)
    expect(fs.existsSync(shimPath())).toBe(false)
    expect(fs.existsSync(copilotHooksOwnersPath(hooksDir()))).toBe(false)
  })

  it('vscode then copilot: uninstalling Copilot CLI leaves the hooks VS Code still needs, and isCopilotCliInstalled turns false', () => {
    installVscode({ project: true, projectRoot: project })
    installCopilotCli({ local: true })

    uninstallCopilotCli({ local: true })
    expect(fs.existsSync(configPath())).toBe(true)
    expect(fs.existsSync(shimPath())).toBe(true)
    expect(isCopilotCliInstalled({ local: true })).toBe(false)
    expect(vscodeHooksInstalled({ project: true, projectRoot: project })).toBe(true)

    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.existsSync(configPath())).toBe(false)
    expect(fs.existsSync(shimPath())).toBe(false)
  })

  it('a Copilot install from before the owners file existed counts as owned by copilot, so uninstall --vscode keeps it', () => {
    installCopilotCli({ local: true })
    fs.rmSync(copilotHooksOwnersPath(hooksDir()))
    installVscode({ project: true, projectRoot: project })
    expect([...readCopilotHooksOwners(hooksDir())].sort()).toEqual(['copilot', 'vscode'])
    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.existsSync(configPath())).toBe(true)
    expect(isCopilotCliInstalled({ local: true })).toBe(true)
  })
})

describe('chat.useClaudeHooks double-fire detection', () => {
  it('vscodeUsesClaudeHooks reads a JSONC settings file with comments and trailing commas, true only for a literal true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-settings-'))
    try {
      const settings = path.join(dir, 'settings.json')
      fs.writeFileSync(settings, '{\n  // chat\n  "chat.useClaudeHooks": true,\n}\n')
      expect(vscodeUsesClaudeHooks(settings)).toBe(true)
      fs.writeFileSync(settings, '{ "chat.useClaudeHooks": "true" }')
      expect(vscodeUsesClaudeHooks(settings)).toBe(false)
      fs.writeFileSync(settings, '{ "editor.fontSize": 12 }')
      expect(vscodeUsesClaudeHooks(settings)).toBe(false)
      expect(vscodeUsesClaudeHooks(path.join(dir, 'missing.json'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checkVscodeClaudeHooks warns only when the setting is on and Claude Code hooks are installed', () => {
    expect(checkVscodeClaudeHooks(false, true, true)).toBeNull()
    expect(checkVscodeClaudeHooks(true, false, true)).toBeNull()
    const both = checkVscodeClaudeHooks(true, true, true)
    expect(both?.status).toBe('warn')
    expect(both?.message).toContain('fires twice')
    const claudeOnly = checkVscodeClaudeHooks(true, true, false)
    expect(claudeOnly?.status).toBe('warn')
    expect(claudeOnly?.message).toContain('install --vscode')
  })

  it('checkVscodeUserScopeHooks warns on a user-scope install and names the right fix for each case', () => {
    // Project scope alone is the intended state after the default flipped: nothing to report.
    expect(checkVscodeUserScopeHooks(false, true)).toBeNull()
    expect(checkVscodeUserScopeHooks(false, false)).toBeNull()

    // User scope alone still works, but VS Code pins it to folders[0], so it is blind past the
    // first folder of a multi-root workspace. The fix is to move it.
    const userOnly = checkVscodeUserScopeHooks(true, false)
    expect(userOnly?.status).toBe('warn')
    expect(userOnly?.message).toContain('FIRST folder')
    expect(userOnly?.message).toContain('token-goat install --vscode')
    expect(userOnly?.message).not.toContain('twice')

    // Both scopes: VS Code runs every hooks file it finds, so the fix is to remove one, and it must
    // be the user-scope one -- removing the project copy would leave only the blind install.
    const both = checkVscodeUserScopeHooks(true, true)
    expect(both?.status).toBe('warn')
    expect(both?.message).toContain('twice')
    expect(both?.message).toContain('token-goat uninstall --vscode --user')
  })
})
