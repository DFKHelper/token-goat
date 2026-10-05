/** A PreToolUse input rewrite must never change the permission outcome the user's own Claude Code rules give the ORIGINAL call. Claude Code matches its rules against `updatedInput`, so the old unconditional `permissionDecision: "allow"` on every rewrite skipped the prompt for any wrapped command, and a `Bash(curl:*)` deny or a `Read(./private/**)` deny was matched against the wrapper or the temp copy and missed. PROVENANCE: HAND-DERIVED rule matrix: each case's expected verdict is worked out from the rule semantics documented at https://code.claude.com/docs/en/permissions (deny > ask > allow, Bash prefix/wildcard rules, the read-only command set, Read rules on `//`, `~/`, `./` paths) and https://code.claude.com/docs/en/permission-modes (deny blocks in every mode, dontAsk turns a prompt into a denial, bypassPermissions skips prompts), not from the module under test. Settings files are written into a temp tree with an explicit cwd, so no developer or machine settings take part. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decideRewrite, loadPermissionSnapshot, permissionNeutralRewrite, resetPermissionSourceCache, snapshotFromDocs, type RewriteRequest, type SettingsDoc } from '../src/rewrite_permission.js'
import { CAN_JUNCTION } from './helpers/can-symlink.js'
import { shortNameOf } from './helpers/short-name.js'

const CWD = path.join(os.tmpdir(), 'tg-perm-unit-cwd')
const MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const

function wrap(command: string): string {
  return `token-goat compress -f generic --timeout 600 -c '${command}'`
}

function shell(command: string, mode: unknown = 'default', extra: Partial<RewriteRequest> = {}): RewriteRequest {
  return { kind: 'shell-wrap', harness: 'claudecode', mode, cwd: CWD, original: command, rewritten: wrap(command), ...extra }
}

function snap(perms: { allow?: string[]; deny?: string[]; ask?: string[] }, role: SettingsDoc['role'] = 'user', extra: Record<string, unknown> = {}) {
  return snapshotFromDocs([{ role, json: { permissions: { ...perms, ...extra } } }])
}

const NONE = snapshotFromDocs([])

describe('decideRewrite: shell wrap', () => {
  it.each(MODES)('a matching Bash deny rule keeps the original call in %s mode', (mode) => {
    expect(decideRewrite(snap({ deny: ['Bash(curl:*)'] }), shell('curl https://example.com', mode))).toBe('skip')
  })

  it.each(MODES)('a matching Bash ask rule keeps the original call in %s mode', (mode) => {
    expect(decideRewrite(snap({ ask: ['Bash(curl *)'] }), shell('curl https://example.com', mode))).toBe('skip')
  })

  it('a Bash deny rule hidden behind an expansion or a backslash is assumed to match', () => {
    expect(decideRewrite(snap({ deny: ['Bash(wget *)'] }), shell('$TOOL https://example.com'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Bash(wget *)'] }), shell('w\\get https://example.com'))).toBe('skip')
  })

  it('a deny rule for an unrelated command does not cost the compression', () => {
    expect(decideRewrite(snap({ deny: ['Bash(curl:*)'] }), shell('go build ./...'))).toBe('rewrite')
  })

  it('a deny or ask rule that does not parse is assumed to match everything', () => {
    expect(decideRewrite(snap({ deny: ['Bash('] }), shell('go build ./...'))).toBe('skip')
    expect(decideRewrite(snap({ ask: [42 as unknown as string] }), shell('go build ./...'))).toBe('skip')
  })

  it('a Read deny rule applies to a file command inside the shell, which the wrapper would hide', () => {
    expect(decideRewrite(snap({ deny: ['Read(./secrets/**)'] }), shell('cat secrets/key.txt'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Edit(./secrets/**)'] }), shell('npm test > secrets/out.txt'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Read(./secrets/**)'] }), shell('cat ~/notes.txt'))).toBe('skip')
  })

  it('with no rules, an unproven command is rewritten with no decision, so Claude Code still prompts for it', () => {
    expect(decideRewrite(NONE, shell('go build ./...', 'default'))).toBe('rewrite')
    expect(decideRewrite(NONE, shell('go build ./...', undefined))).toBe('rewrite')
    expect(decideRewrite(NONE, shell('go build ./...', 'plan'))).toBe('rewrite')
  })

  it('dontAsk turns the wrapper\'s prompt into a denial, so an unproven command is left alone there', () => {
    expect(decideRewrite(NONE, shell('go build ./...', 'dontAsk'))).toBe('skip')
  })

  it('a mode Claude Code does not document is not guessed at', () => {
    expect(decideRewrite(NONE, shell('go build ./...', 'yolo'))).toBe('skip')
  })

  it('bypassPermissions already runs the original with no prompt, so the rewrite needs no allow and gets none', () => {
    expect(decideRewrite(NONE, shell('go build ./...', 'bypassPermissions'))).toBe('rewrite')
    expect(decideRewrite(NONE, shell('ls -la src', 'bypassPermissions'))).toBe('rewrite')
    expect(decideRewrite(snap({ allow: ['Bash(go build *)'] }), shell('go build ./...', 'bypassPermissions'))).toBe('rewrite')
  })

  // HAND-DERIVED from https://code.claude.com/docs/en/permission-modes ("How auto mode evaluates actions": entering auto mode drops Bash(*), interpreter wildcards and package-manager run rules, and with server-side review read-only shell commands wait for the classifier; plan mode with auto available has the classifier review shell commands).
  it.each(['auto', 'plan'] as const)('%s mode never says allow, so the auto-mode classifier still reviews the call', (mode) => {
    expect(decideRewrite(snap({ allow: ['Bash(npm run *)'] }), shell('npm run build', mode))).toBe('skip')
    expect(decideRewrite(snap({ allow: ['Bash(*)'] }), shell('go build ./...', mode))).toBe('skip')
    expect(decideRewrite(NONE, shell('ls -la src', mode))).toBe('skip')
    expect(decideRewrite(NONE, shell('git status --short', mode))).toBe('skip')
    expect(decideRewrite(NONE, shell('go build ./...', mode))).toBe('rewrite')
  })

  it('a trusted allow rule matching the simple original proves it auto-allowed', () => {
    expect(decideRewrite(snap({ allow: ['Bash(go build *)'] }), shell('go build ./...'))).toBe('approve')
    expect(decideRewrite(snap({ allow: ['Bash(go build:*)'] }), shell('go build ./...', 'dontAsk'))).toBe('approve')
    expect(decideRewrite(snap({ allow: ['Bash(go build:*)'] }), shell('go build ./...', 'acceptEdits'))).toBe('approve')
  })

  it('a project allow rule proves nothing, and since it covers the original the wrapper would add a prompt: left alone', () => {
    expect(decideRewrite(snap({ allow: ['Bash(go build *)'] }, 'project'), shell('go build ./...'))).toBe('skip')
  })

  it('an allow rule on a compound original cannot be proven to cover every part: left alone', () => {
    expect(decideRewrite(snap({ allow: ['Bash(npm test *)'] }), shell('npm test 2>&1'))).toBe('skip')
  })

  it('a wildcard allow rule covering the wrapper would auto-run a command the user never allowed: left alone', () => {
    expect(decideRewrite(snap({ allow: ['Bash(token-goat *)'] }), shell('go build ./...'))).toBe('skip')
  })

  it('an exact allow rule naming the very wrapper is the user approving it, and Claude Code applies it to the wrapper', () => {
    expect(decideRewrite(snap({ allow: [`Bash(${wrap('go build ./...')})`] }), shell('go build ./...'))).toBe('rewrite')
  })

  it('Claude Code\'s read-only commands run with no prompt, so their rewrite may say allow', () => {
    expect(decideRewrite(NONE, shell('ls -la src'))).toBe('approve')
    expect(decideRewrite(NONE, shell('git status --short'))).toBe('approve')
    expect(decideRewrite(NONE, shell('git log --oneline -n20'))).toBe('approve')
  })

  it('a read-only command in a form that can write, or behind a stripped wrapper, is not proven', () => {
    expect(decideRewrite(NONE, shell('find . -name x -delete'))).toBe('skip')
    expect(decideRewrite(NONE, shell('git log --output=x'))).toBe('skip')
    expect(decideRewrite(NONE, shell('timeout 5 go build ./...'))).toBe('rewrite')
  })

  it('a compound of read-only commands may well run with no prompt, so the wrapper is not added', () => {
    expect(decideRewrite(NONE, shell('ls src | head -5'))).toBe('skip')
  })

  it('rm, rmdir and protected paths prompt in every mode whatever a hook answers, so they are never wrapped', () => {
    expect(decideRewrite(NONE, shell('rm -rf build && npm test', 'bypassPermissions'))).toBe('skip')
    expect(decideRewrite(NONE, shell('npm run lint -- .husky', 'bypassPermissions'))).toBe('skip')
  })

  it('blockReadsOutsideWorkingDirectories leaves every shell rewrite alone', () => {
    expect(decideRewrite(snap({}, 'user', { blockReadsOutsideWorkingDirectories: true }), shell('go build ./...', 'bypassPermissions'))).toBe('skip')
  })

  it('unreadable settings leave every rewrite alone', () => {
    expect(decideRewrite(null, shell('ls'))).toBe('skip')
  })

  it('a `*` in the middle of a rule matches any run of text, and a trailing ` *` also matches the bare command', () => {
    expect(decideRewrite(snap({ allow: ['Bash(npm run * --silent)'] }), shell('npm run build --silent'))).toBe('approve')
    expect(decideRewrite(snap({ allow: ['Bash(npm run * --silent)'] }), shell('npm run build --verbose'))).toBe('rewrite')
    expect(decideRewrite(snap({ allow: ['Bash(go build *)'] }), shell('go build'))).toBe('approve')
    expect(decideRewrite(snap({ allow: ['Bash(go build *)'] }), shell('go buildx ./...'))).toBe('rewrite')
  })

  it('a deny rule whose `*` touches a word covers commands that run on past it', () => {
    expect(decideRewrite(snap({ deny: ['Bash(curl*)'] }), shell('curlie https://example.com'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Bash(*secret*)'] }), shell('go run ./cmd/topsecretdump'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Bash(curl *)'] }), shell('curlie https://example.com'))).toBe('rewrite')
  })

  it('a rule with many stars against a long command is decided without catastrophic backtracking', () => {
    const started = Date.now()
    const deny = `Bash(${'*a'.repeat(16)}*b)`
    expect(decideRewrite(snap({ deny: [deny] }), shell(`go build ${'a'.repeat(4000)}`))).toBe('rewrite')
    expect(decideRewrite(snap({ deny: [deny] }), shell(`go build ${'a'.repeat(4000)}b`))).toBe('skip')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a structural query is judged on the original alone, so an allow rule for token-goat does not cost it', () => {
    const req: RewriteRequest = { kind: 'shell-query', harness: 'claudecode', mode: 'default', cwd: CWD, original: 'rg -n foo src', rewritten: 'token-goat search foo' }
    expect(decideRewrite(snap({ allow: ['Bash(token-goat *)'] }), req)).toBe('rewrite')
    expect(decideRewrite(snap({ deny: ['Bash(rg *)'] }), req)).toBe('skip')
  })
})

describe('decideRewrite: image Read', () => {
  const read = (insideCwd: boolean, harness: RewriteRequest['harness'] = 'claudecode'): RewriteRequest => ({ kind: 'read', harness, mode: 'default', cwd: CWD, original: path.join(CWD, 'private', 'shot.png'), rewritten: path.join(os.tmpdir(), 'token-goat-shrink-1-2-x.jpeg'), insideCwd })

  it.each(['deny', 'ask'] as const)('a matching Read %s rule keeps the original Read', (list) => {
    expect(decideRewrite(snap({ [list]: ['Read(./private/**)'] }), read(true))).toBe('skip')
    expect(decideRewrite(snap({ [list]: ['Read(**/*.png)'] }), read(true))).toBe('skip')
    expect(decideRewrite(snap({ [list]: ['Read'] }), read(true))).toBe('skip')
  })

  it('a Read rule for another path does not cost the shrink', () => {
    expect(decideRewrite(snap({ deny: ['Read(./.env)'] }), read(true))).toBe('approve')
  })

  it('with no rules an image inside the working directory is approved, one outside is left to Claude Code\'s prompt', () => {
    expect(decideRewrite(NONE, read(true))).toBe('approve')
    expect(decideRewrite(NONE, read(false))).toBe('skip')
  })

  it('VS Code reads the same rules but is never told allow', () => {
    expect(decideRewrite(NONE, read(false, 'vscode'))).toBe('rewrite')
    expect(decideRewrite(snap({ deny: ['Read(./private/**)'] }), read(true, 'vscode'))).toBe('skip')
  })
})

describe('decideRewrite: Agent prompt', () => {
  const agent: RewriteRequest = { kind: 'agent', harness: 'claudecode', mode: 'default', cwd: CWD, original: 'find the bug', rewritten: 'find the bug\n\nbriefing' }

  it('is never approved, and is left alone when an Agent rule could look at the prompt', () => {
    expect(decideRewrite(NONE, agent)).toBe('rewrite')
    expect(decideRewrite(snap({ deny: ['Agent(Explore)'] }), agent)).toBe('rewrite')
    expect(decideRewrite(snap({ deny: ['Agent(*)'] }), agent)).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Bash('] }), agent)).toBe('skip')
  })
})

// HAND-DERIVED from https://code.claude.com/docs/en/permissions#symlinks: "the permission check covers two paths: the one Claude requested and the file it resolves to", for symbolic links and Windows directory junctions, and a deny rule applies when either matches. The rewrite shows Claude Code neither spelling of the original, so the hook has to check the resolved one itself. A real junction on Windows (Node makes a directory symlink of it on POSIX).
describe.skipIf(!CAN_JUNCTION)('decideRewrite: a link or short name does not hide the real path from a rule', () => {
  let root: string
  let proj: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-perm-link-'))
    proj = path.join(root, 'proj')
    fs.mkdirSync(path.join(proj, 'secrets'), { recursive: true })
    fs.mkdirSync(path.join(proj, 'docs'))
    fs.mkdirSync(path.join(proj, '.git'))
    fs.writeFileSync(path.join(proj, 'secrets', 'shot.png'), 'x')
    fs.writeFileSync(path.join(proj, 'secrets', 'key.txt'), 'x')
    fs.writeFileSync(path.join(proj, 'docs', 'readme.md'), 'x')
    fs.symlinkSync(path.join(proj, 'secrets'), path.join(proj, 'pics'), 'junction')
    fs.symlinkSync(path.join(proj, '.git'), path.join(proj, 'cfg'), 'junction')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const imageRead = (original: string): RewriteRequest => ({ kind: 'read', harness: 'claudecode', mode: 'default', cwd: proj, original, rewritten: path.join(os.tmpdir(), 'token-goat-shrink-1-2-x.jpeg'), insideCwd: true })
  const sh = (command: string): RewriteRequest => ({ kind: 'shell-wrap', harness: 'claudecode', mode: 'default', cwd: proj, original: command, rewritten: wrap(command) })

  it('an image Read through a junction into a denied directory keeps the original Read', () => {
    expect(decideRewrite(snap({ deny: ['Read(./secrets/**)'] }), imageRead(path.join(proj, 'pics', 'shot.png')))).toBe('skip')
    expect(decideRewrite(snap({ ask: ['Read(./secrets/**)'] }), imageRead(path.join(proj, 'pics', 'shot.png')))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Read(./other/**)'] }), imageRead(path.join(proj, 'pics', 'shot.png')))).toBe('approve')
  })

  it('a shell file command through a junction into a denied directory is left alone', () => {
    expect(decideRewrite(snap({ deny: ['Read(./secrets/**)'] }), sh('cat pics/key.txt'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Edit(./secrets/**)'] }), sh('npm test > pics/out.txt'))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Read(./secrets/**)'] }), sh('cat docs/readme.md'))).toBe('approve')
  })

  it('a shell command reaching a protected path through a junction is left alone', () => {
    expect(decideRewrite(NONE, sh('npm run gen > cfg/hooks/pre-commit'))).toBe('skip')
    expect(decideRewrite(NONE, sh('npm run gen > docs/out.txt'))).toBe('rewrite')
  })

  it.runIf(process.platform === 'win32')('an 8.3 short name does not hide the long directory name a rule is written for', (ctx) => {
    const longDir = path.join(proj, 'verylongsecretsfolder')
    fs.mkdirSync(longDir)
    fs.writeFileSync(path.join(longDir, 'shot.png'), 'x')
    const short = shortNameOf(longDir)
    if (short === null) ctx.skip('8dot3 name creation is disabled on this volume, so there is no short name to resolve')
    const viaShort = path.join(proj, short as string, 'shot.png')
    expect(decideRewrite(snap({ deny: ['Read(./verylongsecretsfolder/**)'] }), imageRead(viaShort))).toBe('skip')
    expect(decideRewrite(snap({ deny: ['Read(./verylongsecretsfolder/**)'] }), sh(`cat ${short as string}/shot.png`))).toBe('skip')
  })
})

describe('snapshotFromDocs', () => {
  const allowGo = { permissions: { allow: ['Bash(go build *)'] } }

  it('trusts a managed allow only when one managed source applies', () => {
    expect(decideRewrite(snapshotFromDocs([{ role: 'managed', json: allowGo, managedGroup: 'file' }]), shell('go build ./...'))).toBe('approve')
    expect(decideRewrite(snapshotFromDocs([{ role: 'managed', json: allowGo, managedGroup: 'file' }, { role: 'managed', json: {}, managedGroup: 'hkcu' }]), shell('go build ./...'))).toBe('skip')
  })

  it('stops trusting user and local allow rules under allowManagedPermissionRulesOnly', () => {
    const managed: SettingsDoc = { role: 'managed', json: { allowManagedPermissionRulesOnly: true }, managedGroup: 'file' }
    expect(decideRewrite(snapshotFromDocs([managed, { role: 'user', json: allowGo }]), shell('go build ./...'))).toBe('skip')
    expect(decideRewrite(snapshotFromDocs([managed, { role: 'local', json: allowGo, localTrusted: true }]), shell('go build ./...'))).toBe('skip')
  })

  it('trusts a local allow only when the file is untracked', () => {
    expect(decideRewrite(snapshotFromDocs([{ role: 'local', json: allowGo, localTrusted: true }]), shell('go build ./...'))).toBe('approve')
    expect(decideRewrite(snapshotFromDocs([{ role: 'local', json: allowGo, localTrusted: false }]), shell('go build ./...'))).toBe('skip')
  })

  it('keeps an ancestor directory\'s restrictions and drops its allow rules', () => {
    const s = snapshotFromDocs([{ role: 'ancestor', json: { permissions: { allow: ['Bash(go build *)'], deny: ['Bash(curl:*)'] } } }])
    expect(s.allow).toEqual([])
    expect(s.deny.map((r) => r.raw)).toEqual(['Bash(curl:*)'])
  })

  it('throws on a malformed permissions block', () => {
    expect(() => snapshotFromDocs([{ role: 'user', json: { permissions: { deny: 'Bash(curl:*)' } } }])).toThrow()
    expect(() => snapshotFromDocs([{ role: 'user', json: { permissions: ['x'] } }])).toThrow()
  })
})

describe('loadPermissionSnapshot and permissionNeutralRewrite read the real settings files', () => {
  let root: string
  let project: string
  let configDir: string
  const savedConfigDir = process.env['CLAUDE_CONFIG_DIR']

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-perm-load-'))
    project = path.join(root, 'proj')
    configDir = path.join(root, 'config')
    fs.mkdirSync(path.join(project, 'sub', '.claude'), { recursive: true })
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    fs.mkdirSync(configDir, { recursive: true })
    process.env['CLAUDE_CONFIG_DIR'] = configDir
    resetPermissionSourceCache()
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  const writeJson = (file: string, json: unknown): void => fs.writeFileSync(file, JSON.stringify(json))
  const curl = (cwd: string): RewriteRequest => ({ kind: 'shell-wrap', harness: 'claudecode', mode: 'default', cwd, original: 'curl https://example.com', rewritten: wrap('curl https://example.com') })

  it('a user deny rule suppresses the rewrite', () => {
    writeJson(path.join(configDir, 'settings.json'), { permissions: { deny: ['Bash(curl:*)'] } })
    expect(permissionNeutralRewrite({ command: wrap('curl https://example.com') }, curl(project))).toBeNull()
  })

  it('a project deny rule applies from a subdirectory the session moved into', () => {
    writeJson(path.join(project, '.claude', 'settings.json'), { permissions: { deny: ['Bash(curl:*)'] } })
    expect(permissionNeutralRewrite({ command: wrap('curl https://example.com') }, curl(path.join(project, 'sub')))).toBeNull()
  })

  it('a settings file that will not parse suppresses every rewrite', () => {
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{ "permissions": ')
    expect(loadPermissionSnapshot(project)).toBeNull()
    expect(permissionNeutralRewrite({ command: wrap('go build ./...') }, { ...curl(project), original: 'go build ./...', rewritten: wrap('go build ./...') })).toBeNull()
  })

  it('with no rules the rewrite ships without approval for an unproven command and with it for a read-only one', () => {
    expect(permissionNeutralRewrite({ command: wrap('curl https://example.com') }, curl(project))).toEqual({ hookType: 'rewriteInput', updatedInput: { command: wrap('curl https://example.com') }, approve: false })
    expect(permissionNeutralRewrite({ command: wrap('ls') }, { ...curl(project), original: 'ls', rewritten: wrap('ls') })).toEqual({ hookType: 'rewriteInput', updatedInput: { command: wrap('ls') }, approve: true })
  })

  // HAND-DERIVED: git ls-files --error-unmatch exits 1 for an untracked file inside a repository and 128 outside one or in a repository git refuses (safe.directory); only the first proves Claude Code's untracked-local-file trust.
  const goBuild = (cwd: string): RewriteRequest => ({ ...curl(cwd), original: 'go build ./...', rewritten: wrap('go build ./...') })
  const git = (cwd: string, ...args: string[]): number => spawnSync('git', args, { cwd, stdio: 'ignore' }).status ?? -1

  it('a settings.local.json allow outside any git repository is not trusted to approve', () => {
    expect(git(project, 'rev-parse', '--git-dir')).toBe(128)
    writeJson(path.join(project, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(go build *)'] } })
    expect(permissionNeutralRewrite({ command: wrap('go build ./...') }, goBuild(project))).toBeNull()
  })

  it('an untracked settings.local.json allow inside a git repository approves, and a tracked one does not', () => {
    expect(git(project, 'init', '-q')).toBe(0)
    writeJson(path.join(project, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(go build *)'] } })
    expect(permissionNeutralRewrite({ command: wrap('go build ./...') }, goBuild(project))).toEqual({ hookType: 'rewriteInput', updatedInput: { command: wrap('go build ./...') }, approve: true })
    expect(git(project, 'add', '.claude/settings.local.json')).toBe(0)
    expect(permissionNeutralRewrite({ command: wrap('go build ./...') }, goBuild(project))).toBeNull()
  })

  it('harnesses that never read Claude Code settings get the rewrite with no approval, whatever the files say', () => {
    writeJson(path.join(configDir, 'settings.json'), { permissions: { deny: ['Bash(curl:*)'] } })
    expect(permissionNeutralRewrite({ command: 'x' }, { ...curl(project), harness: 'codex' })).toEqual({ hookType: 'rewriteInput', updatedInput: { command: 'x' }, approve: false })
  })
})
