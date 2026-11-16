import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cmdInstall } from '../src/cli_install.js'
import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { codexHookScriptPath } from '../src/bridges/codex_install.js'
import { installHooks, settingsPath } from '../src/install.js'
import { installedLauncher } from '../src/cli_upgrade.js'
import { assertHookEntryAllowed, isDevCheckoutEntry, packageRootOf } from '../src/install_entry.js'

let TMP: string
let origCwd: string
let origArgv1: string
let origHome: string | undefined
let origUserProfile: string | undefined
let origExecFormOverride: string | undefined
let origAppData: string | undefined
let origCodexHome: string | undefined
let origClaudeConfigDir: string | undefined
let origCopilotHome: string | undefined

/** A git checkout laid out like the repo: dist/token-goat.mjs beside .git (a directory, or a file in a linked worktree). */
function makeCheckout(name: string, gitIsFile: boolean): string {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'token-goat.mjs'), '// checkout build\n')
  if (gitIsFile) fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere\n')
  else fs.mkdirSync(path.join(root, '.git'))
  return path.join(root, 'dist', 'token-goat.mjs')
}

/** A global install laid out like npm's: <prefix>/token-goat/dist/token-goat.mjs with no .git beside it. */
function makeGlobalEntry(): string {
  const entry = path.join(TMP, 'global', 'token-goat', 'dist', 'token-goat.mjs')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '// global build\n')
  return entry
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-entry-'))
  origCwd = process.cwd()
  origArgv1 = process.argv[1] ?? ''
  process.chdir(TMP)
  // installHooks writes the generated shim under os.homedir(); pin the home dir so the real ~/.claude is never touched.
  origHome = process.env['HOME']
  origUserProfile = process.env['USERPROFILE']
  const fakeHome = path.join(TMP, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  // Pin string-form hooks so the assertions do not depend on the machine's claude binary version.
  origExecFormOverride = process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']
  process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
  // The VS Code and Codex homes can resolve outside HOME; pin them so the repair rows never reach the real profile.
  origAppData = process.env['APPDATA']
  origCodexHome = process.env['CODEX_HOME']
  process.env['APPDATA'] = path.join(fakeHome, 'AppData', 'Roaming')
  process.env['CODEX_HOME'] = path.join(fakeHome, '.codex')
  origClaudeConfigDir = process.env['CLAUDE_CONFIG_DIR']
  origCopilotHome = process.env['COPILOT_HOME']
  process.env['CLAUDE_CONFIG_DIR'] = path.join(fakeHome, '.claude')
  process.env['COPILOT_HOME'] = path.join(fakeHome, '.copilot')
})

afterEach(() => {
  process.argv[1] = origArgv1
  if (origAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = origAppData
  if (origCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = origCodexHome
  if (origClaudeConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = origClaudeConfigDir
  if (origCopilotHome === undefined) delete process.env['COPILOT_HOME']
  else process.env['COPILOT_HOME'] = origCopilotHome
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  if (origUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = origUserProfile
  if (origExecFormOverride === undefined) delete process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']
  else process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = origExecFormOverride
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('packageRootOf', () => {
  it('walks up from dist/token-goat.mjs to the package root', () => {
    expect(packageRootOf(path.join('C:', 'pkg', 'dist', 'token-goat.mjs'))).toBe(path.join('C:', 'pkg'))
  })
})

describe('isDevCheckoutEntry', () => {
  it('is true when the package root holds a .git directory', () => {
    expect(isDevCheckoutEntry(makeCheckout('dir-checkout', false))).toBe(true)
  })

  it('is true for a linked worktree, where .git is a file', () => {
    expect(isDevCheckoutEntry(makeCheckout('wt-checkout', true))).toBe(true)
  })

  it('is false for an entry whose package root has no .git', () => {
    expect(isDevCheckoutEntry(makeGlobalEntry())).toBe(false)
  })

  it('is false for an unset entry', () => {
    expect(isDevCheckoutEntry(undefined)).toBe(false)
  })

  it('is false for a package whose ancestor directory holds a .git, since only the package root counts', () => {
    fs.mkdirSync(path.join(TMP, '.git'))
    const entry = makeGlobalEntry()
    expect(isDevCheckoutEntry(entry)).toBe(false)
    expect(() => assertHookEntryAllowed(entry, { dev: false, globalEntry: () => null })).not.toThrow()
  })
})

describe('assertHookEntryAllowed', () => {
  it('refuses a checkout entry without dev and names the global entry in the error', () => {
    const checkout = makeCheckout('refused', false)
    const globalBuild = makeGlobalEntry()
    expect(() => assertHookEntryAllowed(checkout, { dev: false, globalEntry: () => globalBuild })).toThrow(globalBuild)
  })

  it('refuses a checkout entry without dev with a fallback when no global install exists', () => {
    const checkout = makeCheckout('no-global', false)
    expect(() => assertHookEntryAllowed(checkout, { dev: false, globalEntry: () => null })).toThrow('npm install -g token-goat')
  })

  it('allows a checkout entry when dev is set', () => {
    const checkout = makeCheckout('dev-allowed', false)
    expect(() => assertHookEntryAllowed(checkout, { dev: true, globalEntry: () => null })).not.toThrow()
  })

  it('allows an entry that is not a checkout', () => {
    expect(() => assertHookEntryAllowed(makeGlobalEntry(), { dev: false, globalEntry: () => null })).not.toThrow()
  })
})

describe('installHooks and the checkout guard', () => {
  it('refuses to register a checkout entry without dev and writes no settings', () => {
    process.argv[1] = makeCheckout('install-refused', false)
    expect(() => installHooks('project')).toThrow('--dev')
    expect(fs.existsSync(settingsPath('project'))).toBe(false)
  })

  it('registers a checkout entry with dev and writes the settings text', () => {
    const checkout = makeCheckout('install-dev', false)
    process.argv[1] = checkout
    installHooks('project', { dev: true })
    const text = fs.readFileSync(settingsPath('project'), 'utf8')
    expect(text).toContain(JSON.stringify(checkout).slice(1, -1))
  })

  it('repoints the wired hooks at the running install when it runs from the global entry', () => {
    const checkout = makeCheckout('repoint', false)
    const globalBuild = makeGlobalEntry()
    process.argv[1] = checkout
    installHooks('project', { dev: true })
    process.argv[1] = globalBuild
    installHooks('project')
    const text = fs.readFileSync(settingsPath('project'), 'utf8')
    expect(text).toContain(JSON.stringify(globalBuild).slice(1, -1))
    expect(text).not.toContain(JSON.stringify(checkout).slice(1, -1))
  })
})

describe('isDevCheckoutEntry through a symlinked bin', () => {
  it('is false for a link in a git-tracked home that points at a global build', () => {
    const home = path.join(TMP, 'home')
    fs.mkdirSync(path.join(home, '.git'))
    const globalBuild = makeGlobalEntry()
    fs.symlinkSync(path.dirname(globalBuild), path.join(home, 'bin'), 'junction')
    expect(isDevCheckoutEntry(path.join(home, 'bin', 'token-goat.mjs'))).toBe(false)
  })

  it('is true for a link that points at a checkout build', () => {
    const checkout = makeCheckout('linked-checkout', false)
    fs.symlinkSync(path.dirname(checkout), path.join(TMP, 'home', 'dev'), 'junction')
    expect(isDevCheckoutEntry(path.join(TMP, 'home', 'dev', 'token-goat.mjs'))).toBe(true)
  })
})

describe('repairHarnessHooks and the checkout guard', () => {
  it('refuses to rewrite a stale Codex hook shim from a checkout entry and records why', () => {
    const shim = codexHookScriptPath()
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, '// stale shim\n')
    process.argv[1] = makeCheckout('repair-refused', false)
    const result = repairHarnessHooks(TMP)
    expect(result.repairs).toEqual([])
    expect(result.errors.join('\n')).toContain('refusing to register')
    expect(fs.readFileSync(shim, 'utf8')).toBe('// stale shim\n')
  })

  it('still repairs the same stale Codex shim from the global entry', () => {
    const shim = codexHookScriptPath()
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, '// stale shim\n')
    process.argv[1] = makeGlobalEntry()
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toContain('Repaired Codex CLI hooks and shim')
  })

  it('still refuses a stale Codex shim from a checkout when dev is explicitly false, and writes nothing', () => {
    const shim = codexHookScriptPath()
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, '// stale shim\n')
    process.argv[1] = makeCheckout('repair-no-dev', false)
    const result = repairHarnessHooks(TMP, { dev: false })
    expect(result.repairs).toEqual([])
    expect(result.errors.join('\n')).toContain('refusing to register')
    expect(fs.readFileSync(shim, 'utf8')).toBe('// stale shim\n')
    expect(fs.existsSync(settingsPath('user'))).toBe(false)
  })

  it('repairs a stale Codex shim from a checkout when dev is set', () => {
    const shim = codexHookScriptPath()
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, '// stale shim\n')
    process.argv[1] = makeCheckout('repair-dev', false)
    const result = repairHarnessHooks(TMP, { dev: true })
    expect(result.errors).toEqual([])
    expect(result.repairs).toContain('Repaired Codex CLI hooks and shim')
    expect(fs.readFileSync(shim, 'utf8')).not.toBe('// stale shim\n')
  })
})

describe('cmdInstall and the checkout guard', () => {
  it('lets install --detect run from a checkout entry', async () => {
    process.argv[1] = makeCheckout('detect', false)
    await expect(cmdInstall({ detect: true })).resolves.toBeUndefined()
  })

  it('still refuses install --auto from a checkout entry', async () => {
    process.argv[1] = makeCheckout('auto', false)
    await expect(cmdInstall({ auto: true })).rejects.toThrow('refusing to register')
  })

  it('install --dev from a checkout repairs a stale harness hook instead of refusing', async () => {
    const shim = codexHookScriptPath()
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, '// stale shim\n')
    process.argv[1] = makeCheckout('install-dev-repair', false)
    await cmdInstall({ dev: true })
    expect(fs.readFileSync(shim, 'utf8')).not.toBe('// stale shim\n')
  })
})

describe('installedLauncher deadline', () => {
  it('gives up on an npm root -g that runs past its deadline', () => {
    const root = path.join(TMP, 'npm-root')
    fs.mkdirSync(path.join(root, 'token-goat', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'token-goat', 'dist', 'token-goat.mjs'), '// global build\n')
    const slowNpm = path.join(TMP, 'slow-npm.cjs')
    fs.writeFileSync(slowNpm, `setTimeout(() => process.stdout.write(${JSON.stringify(root)}), 10000)\n`)
    expect(installedLauncher({ file: process.execPath, prefix: [slowNpm] }, { timeoutMs: 1000 })).toBeNull()
  })
})
