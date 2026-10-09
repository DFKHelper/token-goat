/** The bypassPermissions check for Claude Code rule sources no settings file shows (src/claude_hidden_rules.ts): a host that answers prompts itself, a command-line flag that adds or relays rules, a skill, command, agent or plugin that removes a tool by pattern, and a PermissionRequest hook outside the settings files. Facts are FORMAT-DERIVED from claude.exe 2.1.x: hooks get CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT (`cli`, `sdk-cli` under -p, a host's own value otherwise), and gitignored nested skills directories are skipped ("[skills] Skipped gitignored skills dir"). */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { commandLineRuleSource, frontmatterAddsRule, hiddenRuleSource, primeProcessReason, resetHiddenRuleCache, stamp, type HiddenRuleHelpers, type HiddenRuleQuery } from '../src/claude_hidden_rules.js'
import { selfAndAncestors } from '../src/rewrite_permission.js'
import { runGit } from '../src/util.js'

let root: string
const idle: ChildProcess[] = []

/** A long-lived process whose command line stands in for claude's. */
function fakeClaude(args: string[]): string {
  const child = spawn(process.execPath, [path.join(root, 'idle.js'), ...args], { stdio: 'ignore', windowsHide: true })
  idle.push(child)
  return String(child.pid)
}

let plainPid: string
let disallowPid: string
let settingsPid: string

beforeAll(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hidden-rules-')))
  fs.writeFileSync(path.join(root, 'idle.js'), 'setInterval(() => {}, 1 << 30)\n')
  plainPid = fakeClaude(['--resume', 'abc', '--model', 'opus'])
  disallowPid = fakeClaude(['--resume', 'abc', '--disallowedTools', 'Bash(curl *)'])
  settingsPid = fakeClaude(['--settings=extra.json'])
  await new Promise((resolve) => setTimeout(resolve, 300))
})

afterAll(() => {
  for (const child of idle) child.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  resetHiddenRuleCache()
})

interface Box {
  readonly config: string
  readonly project: string
  readonly helpers: HiddenRuleHelpers
}

/** A config dir and a project under one fixture root, with ancestor walks stopped at that root so the developer's own `.claude` is never read. */
function box(name: string): Box {
  const base = path.join(root, name)
  const config = path.join(base, 'config')
  const project = path.join(base, 'proj')
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const helpers: HiddenRuleHelpers = {
    configDir: () => config,
    managedDirs: () => [],
    runGit,
    selfAndAncestors: (d) => selfAndAncestors(d).filter((a) => a.startsWith(base)),
    sourceAllowed: () => true,
  }
  return { config, project, helpers }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Set the modification time of everything under `dirs` an hour back: the scan keeps no clean answer built on a stamp newer than 2 s, so a test that wants the cache to be trusted ages its fixtures first. */
function age(...dirs: string[]): void {
  setTimes(-3_600_000, dirs)
}

/** Set the modification time of everything under `dirs` an hour ahead, so a stamp is too fresh to trust however slow the machine is. */
function postdate(...dirs: string[]): void {
  setTimes(3_600_000, dirs)
}

function setTimes(offsetMs: number, dirs: readonly string[]): void {
  const then = new Date(Date.now() + offsetMs)
  const walk = (p: string): void => {
    if (fs.lstatSync(p).isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name))
    fs.utimesSync(p, then, then)
  }
  for (const d of dirs) if (fs.existsSync(d)) walk(d)
}

function check(b: Box, env: NodeJS.ProcessEnv = {}, query: HiddenRuleQuery = {}): string | null {
  return hiddenRuleSource(b.project, b.project, { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: plainPid, CLAUDE_CODE_SESSION_ID: 's', ...env }, b.helpers, query)
}

/** Make `at` a directory link (or junction) to `target`; false where this machine may not create one. */
function link(target: string, at: string, type: 'dir' | 'junction' = 'dir'): boolean {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  try {
    fs.symlinkSync(target, at, type)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}

const PATTERN_SKILL = '---\nname: s\ndisallowed-tools: Bash(curl *)\n---\n'

describe('frontmatterAddsRule', () => {
  it('a disallowed-tools entry with a pattern adds a rule, in either spelling and list form', () => {
    expect(frontmatterAddsRule('name: x\ndisallowed-tools: Bash(curl *)')).toBe(true)
    expect(frontmatterAddsRule('disallowedTools:\n  - Read\n  - Bash(git push:*)')).toBe(true)
    expect(frontmatterAddsRule('disallowed-tools: "Bash:rm"')).toBe(true)
    expect(frontmatterAddsRule('disallowed-tools: |\n  Bash(x)')).toBe(true)
  })

  it('bare tool names remove the tool, so no call to it reaches a hook: no rule', () => {
    expect(frontmatterAddsRule('disallowed-tools: Bash, WebFetch')).toBe(false)
    expect(frontmatterAddsRule('disallowedTools: [Read, mcp__srv-name__tool]')).toBe(false)
    expect(frontmatterAddsRule('name: x\nallowed-tools: Bash(curl *)')).toBe(false)
  })

  it('a PermissionRequest hook in frontmatter adds session rules', () => {
    expect(frontmatterAddsRule('hooks:\n  PermissionRequest:\n    - hooks: []')).toBe(true)
  })
})

describe('hiddenRuleSource: the claude process', () => {
  it('the terminal CLI with harmless flags and no rule files hides nothing', () => {
    expect(check(box('plain'))).toBeNull()
    expect(check(box('plain-p'), { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBeNull()
  }, 30_000)

  it('any other entry point is a host that may answer prompts itself', () => {
    expect(check(box('sdk'), { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe('entry point sdk-ts')
    expect(check(box('vscode'), { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })).toBe('entry point claude-vscode')
    expect(check(box('none'), { CLAUDE_CODE_ENTRYPOINT: undefined })).toBe('entry point unknown')
  })

  it('a missing or dead claude process cannot be checked', () => {
    expect(check(box('nopid'), { CLAUDE_PID: undefined })).toBe('claude process unknown')
    expect(check(box('badpid'), { CLAUDE_PID: '12; rm' })).toBe('claude process unknown')
  })

  it('a flag that adds or relays rules hides them', () => {
    expect(check(box('disallow'), { CLAUDE_PID: disallowPid })).toBe('claude started with --disallowedtools')
    expect(check(box('settings'), { CLAUDE_PID: settingsPid })).toBe('claude started with --settings')
  }, 30_000)
})

// HAND-DERIVED from the rule that a CLI session's command line is the only place --disallowedTools, --settings and unknown flags live, and that a host is told apart only by an entry point that is set and not the CLI's (claude.exe 2.1.292 names claude-vscode, claude-desktop, local-agent and remote*).
describe('commandLineRuleSource: the claude command line outside bypassPermissions', () => {
  const lineRules = (b: Box, env: NodeJS.ProcessEnv = {}): string | null =>
    commandLineRuleSource({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: plainPid, CLAUDE_CODE_SESSION_ID: 's', ...env })

  it('a CLI session with harmless flags adds none, one with a rule flag or an unknown flag adds some', () => {
    expect(lineRules(box('cl-plain'))).toBeNull()
    expect(lineRules(box('cl-disallow'), { CLAUDE_PID: disallowPid })).toBe('claude started with --disallowedtools')
    expect(lineRules(box('cl-settings'), { CLAUDE_PID: settingsPid })).toBe('claude started with --settings')
  }, 30_000)

  it('a CLI session whose command line cannot be read, or whose pid is unknown, takes the strict path', () => {
    expect(lineRules(box('cl-nopid'), { CLAUDE_PID: undefined })).toBe('claude process unknown')
    expect(lineRules(box('cl-dead'), { CLAUDE_PID: '2147483646' })).toBe('claude command line unreadable')
  }, 30_000)

  it('a missing or empty entry point is no evidence of a host, so it takes the strict path', () => {
    expect(lineRules(box('cl-noentry'), { CLAUDE_CODE_ENTRYPOINT: undefined })).toBe('entry point unknown')
    expect(lineRules(box('cl-emptyentry'), { CLAUDE_CODE_ENTRYPOINT: '' })).toBe('entry point unknown')
  })

  it('an entry point that is set and is not the CLI is a host: today\'s behaviour, no command line rule', () => {
    for (const entry of ['claude-vscode', 'claude-desktop', 'local-agent', 'remote', 'sdk-ts']) {
      expect(lineRules(box(`cl-host-${entry}`), { CLAUDE_CODE_ENTRYPOINT: entry, CLAUDE_PID: disallowPid })).toBeNull()
    }
  })

  // HAND-DERIVED from the threat: a record in a file the same user can write is a record the agent can write, so a planted "no flags" for a claude started with --disallowedTools must not be believed. The planted record has the shape the first version of this check wrote (pid, procStart from Claude Code's own session registry, flags), which is what made it trusted there.
  it('a planted record of no flags for a claude started with --disallowedTools is never believed', () => {
    const home = fs.mkdtempSync(path.join(root, 'home-'))
    const saved = process.env['TOKEN_GOAT_HOME']
    process.env['TOKEN_GOAT_HOME'] = home
    try {
      const b = box('cl-forged')
      write(path.join(b.config, 'sessions', `${disallowPid}.json`), JSON.stringify({ pid: Number(disallowPid), procStart: '111' }))
      write(path.join(home, 'claude_procs', `${disallowPid}.json`), JSON.stringify({ pid: disallowPid, procStart: '111', flags: [] }))
      expect(lineRules(b, { CLAUDE_PID: disallowPid })).toBe('claude started with --disallowedtools')
    } finally {
      if (saved === undefined) delete process.env['TOKEN_GOAT_HOME']
      else process.env['TOKEN_GOAT_HOME'] = saved
    }
  }, 60_000)

  // HAND-DERIVED from observation: on Linux, Node's process.title overwrites the arguments in /proc/<pid>/cmdline and pads the area with NULs (WSL Ubuntu, node 22.11: "claude" followed by NULs, ps shows "claude"); Claude Code sets process.title = "claude" itself (strings in claude.exe 2.1.292). A command line that says nothing of the flags is not a command line with none, so it must read as unreadable; on Windows and macOS the title leaves the command line alone, so the flags are still seen. Either way the session is not approved.
  it('a claude that retitled itself with --disallowedTools is never read as having no flags', async () => {
    fs.writeFileSync(path.join(root, 'retitle.js'), "process.title = 'claude'\nsetInterval(() => {}, 1 << 30)\n")
    const child = spawn(process.execPath, [path.join(root, 'retitle.js'), '--disallowedTools', 'Bash(curl *)'], { stdio: 'ignore', windowsHide: true })
    idle.push(child)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const reason = lineRules(box('cl-retitled'), { CLAUDE_PID: String(child.pid) })
    expect(reason).not.toBeNull()
    if (process.platform === 'linux') expect(reason).toBe('claude command line unreadable')
  }, 30_000)

  // FORMAT-DERIVED from `claude --help` 2.1.294: "--setting-sources <sources>  Comma-separated list of setting sources to load (user, project, local)". A list that leaves one out drops a settings file from what Claude Code reads, so a deny rule this hook does read may not be one it enforces the same way; only the full list, in either spelling, is harmless.
  it('--setting-sources is harmless only when it names user, project and local', async () => {
    const full = fakeClaude(['--setting-sources', 'local,user,project'])
    const fullEq = fakeClaude(['--setting-sources=user,project,local'])
    const noLocal = fakeClaude(['--setting-sources', 'user,project'])
    const noValue = fakeClaude(['--setting-sources'])
    const noValueEq = fakeClaude(['--setting-sources='])
    const next = fakeClaude(['--setting-sources', '--model', 'opus'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(lineRules(box('ss-full'), { CLAUDE_PID: full })).toBeNull()
    expect(lineRules(box('ss-full-eq'), { CLAUDE_PID: fullEq })).toBeNull()
    expect(lineRules(box('ss-no-local'), { CLAUDE_PID: noLocal })).toBe('claude started with --setting-sources without local')
    expect(lineRules(box('ss-no-value'), { CLAUDE_PID: noValue })).toContain('--setting-sources')
    expect(lineRules(box('ss-no-value-eq'), { CLAUDE_PID: noValueEq })).toContain('--setting-sources')
    expect(lineRules(box('ss-next-flag'), { CLAUDE_PID: next })).toContain('--setting-sources')
  }, 60_000)

  // HAND-DERIVED from the same observation as the test above, with a flag that is harmless: a retitled process hides every flag, the harmless ones too, so a command line that was overwritten must read as unreadable wherever the title overwrites it (Linux; macOS ps prints the title in place of the arguments, which the comm check catches). Windows keeps the flags visible. The child is a real node process, so this runs on all three CI platforms.
  it('a claude that retitled itself with only a harmless flag is not read as having no flags where the title hides them', async () => {
    fs.writeFileSync(path.join(root, 'retitle2.js'), "process.title = 'claude'\nsetInterval(() => {}, 1 << 30)\n")
    const child = spawn(process.execPath, [path.join(root, 'retitle2.js'), '--model', 'x'], { stdio: 'ignore', windowsHide: true })
    idle.push(child)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const reason = lineRules(box('cl-retitled-harmless'), { CLAUDE_PID: String(child.pid) })
    if (process.platform === 'win32') expect(reason).toBeNull()
    else expect(reason).toBe('claude command line unreadable')
  }, 30_000)
})

describe('hiddenRuleSource: rule files', () => {
  it('a user skill removing a tool by pattern hides a rule; one with bare names does not', () => {
    const b = box('user-skill')
    write(path.join(b.config, 'skills', 'safe', 'SKILL.md'), '---\nname: safe\ndisallowed-tools: WebFetch\n---\nbody\n')
    expect(check(b)).toBeNull()
    write(path.join(b.config, 'skills', 'net', 'SKILL.md'), '---\nname: net\ndisallowed-tools: Bash(curl *)\n---\nbody\n')
    resetHiddenRuleCache()
    expect(check(b)).toBe(`rule source ${path.join(b.config, 'skills', 'net', 'SKILL.md')}`)
  }, 30_000)

  it('a project agent or command removing a tool by pattern hides a rule', () => {
    const b = box('project-agent')
    write(path.join(b.project, '.claude', 'agents', 'a.md'), '---\nname: a\ndisallowedTools:\n  - Bash(git push:*)\n---\n')
    expect(check(b)).toContain('a.md')
    const c = box('project-command')
    write(path.join(c.project, '.claude', 'commands', 'deep', 'c.md'), '---\ndisallowed-tools: Read(./secrets/**)\n---\n')
    expect(check(c)).toContain('c.md')
  }, 30_000)

  // HAND-DERIVED from the review finding: the scan reads a 256 KB head, so a rule written after more than that many bytes of frontmatter (or JSON) is never seen. The padding is 300 KB, past the head, with the rule after it.
  it('frontmatter whose closing --- lies past the 256 KB head cannot be scanned, so its rules stay hidden', () => {
    const b = box('long-frontmatter')
    const file = path.join(b.config, 'skills', 'big', 'SKILL.md')
    write(file, `---\nname: big\ndescription: ${'x'.repeat(300 * 1024)}\ndisallowed-tools: Bash(curl *)\n---\nbody\n`)
    expect(check(b)).toBe(`cannot scan ${file}: it runs past the first ${256 * 1024} bytes read`)
  }, 30_000)

  it('a long markdown body after short frontmatter, and a short file, are still scanned normally', () => {
    const b = box('long-body')
    write(path.join(b.config, 'skills', 'ok', 'SKILL.md'), `---\nname: ok\ndisallowed-tools: WebFetch\n---\n${'y'.repeat(300 * 1024)}\n`)
    write(path.join(b.config, 'skills', 'plain', 'SKILL.md'), `no frontmatter at all ${'z'.repeat(300 * 1024)}\n`)
    expect(check(b)).toBeNull()
  }, 30_000)

  it('a JSON file that runs past the 256 KB head cannot be scanned, but a small one still can', () => {
    const b = box('long-json')
    const file = path.join(b.config, 'skills', 'big', 'rules.json')
    write(file, JSON.stringify({ pad: 'x'.repeat(300 * 1024), hooks: { PermissionRequest: [] } }))
    expect(check(b)).toBe(`cannot scan ${file}: it runs past the first ${256 * 1024} bytes read`)
    const c = box('short-json')
    write(path.join(c.config, 'skills', 's', 'rules.json'), '{"a":1}')
    expect(check(c)).toBeNull()
  }, 30_000)

  it('an installed plugin with a PermissionRequest hook hides a rule;the plugin listing beside the cache does not', () => {
    const b = box('plugin')
    write(path.join(b.config, 'plugins', 'plugin-directory-cache-v2.json'), '{"description":"answers PermissionRequest events"}')
    write(path.join(b.config, 'plugins', 'marketplaces', 'm', 'p', 'hooks', 'hooks.json'), '{"hooks":{"PermissionRequest":[]}}')
    expect(check(b)).toBeNull()
    write(path.join(b.config, 'plugins', 'cache', 'm', 'p', '1.0.0', 'hooks', 'hooks.json'), '{"hooks":{"PermissionRequest":[]}}')
    resetHiddenRuleCache()
    expect(check(b)).toContain('hooks.json')
  }, 30_000)

  it('a nested skill directory outside a git checkout is found by walking the project', () => {
    const b = box('nested-plain')
    write(path.join(b.project, 'pkg', 'web', '.claude', 'skills', 's', 'SKILL.md'), '---\ndisallowed-tools: Bash(npm publish *)\n---\n')
    expect(check(b)).toContain('SKILL.md')
  }, 30_000)

  it('inside a git checkout a nested skill directory counts unless git ignores it, as Claude Code skips ignored ones', () => {
    const b = box('nested-git')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, '.gitignore'), 'vendor/\n')
    write(path.join(b.project, 'vendor', '.claude', 'skills', 's', 'SKILL.md'), '---\ndisallowed-tools: Bash(curl *)\n---\n')
    expect(check(b)).toBeNull()
    write(path.join(b.project, 'pkg', '.claude', 'skills', 's', 'SKILL.md'), '---\ndisallowed-tools: Bash(curl *)\n---\n')
    resetHiddenRuleCache()
    expect(check(b)).toContain(path.join('pkg', '.claude', 'skills', 's', 'SKILL.md'))
  }, 30_000)

  // HAND-DERIVED: git lists a tracked file in its index whether or not it is still on disk; Claude Code reads skills from disk, so a gone file adds no rule. A tracked path replaced by a directory cannot be opened as a file (EISDIR, not ENOENT) and stays hidden; one whose parent became a file is gone too, which the OS reports as ENOTDIR on Linux and macOS and as ENOENT on Windows (open(2) and CreateFile name those errors for a path component that is not a directory and for one that does not exist), so the test holds on every platform because the scan reads both as missing.
  it('a tracked skill file that is gone adds no rule, and one that cannot be opened stays hidden', () => {
    const b = box('missing-file')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    const gone = path.join(b.project, '.claude', 'skills', 'gone.md')
    const blocked = path.join(b.project, '.claude', 'skills', 'blocked.md')
    write(gone, '---\nname: gone\n---\n')
    write(blocked, '---\nname: blocked\n---\n')
    expect(runGit(['add', '-f', '.claude'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    fs.rmSync(gone)
    expect(check(b)).toBeNull()
    fs.rmSync(blocked)
    fs.mkdirSync(blocked)
    resetHiddenRuleCache()
    expect(check(b)).toBe(`cannot read ${blocked}`)
    fs.rmSync(blocked, { recursive: true })
    const below = path.join(b.project, '.claude', 'skills', 'sub', 'deep.md')
    write(below, '---\nname: deep\n---\n')
    expect(runGit(['add', '-f', '.claude/skills/sub/deep.md'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    fs.rmSync(path.dirname(below), { recursive: true })
    fs.writeFileSync(path.dirname(below), 'a file where the folder was')
    resetHiddenRuleCache()
    expect(check(b)).toBeNull()
  }, 120_000)

  // HAND-DERIVED from the threat: a tracked skill moved away and back between two calls is the same skill, so while it is away the index copy answers for it. A pattern rule in the blob is a reason, bare tool names are none, a path git never listed is none, and a blob git cannot print is strict.
  it('a tracked skill file that is gone is read from the index, and an untracked one adds no rule', () => {
    const b = box('missing-indexed')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    const ruled = path.join(b.project, '.claude', 'skills', 'ruled.md')
    const bare = path.join(b.project, '.claude', 'skills', 'bare.md')
    write(ruled, PATTERN_SKILL)
    write(bare, '---\nname: bare\ndisallowed-tools: Bash, WebFetch\n---\n')
    expect(runGit(['add', '-f', '.claude'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    expect(check(b)).toContain('ruled.md')
    fs.rmSync(bare)
    fs.renameSync(ruled, `${ruled}.away`)
    resetHiddenRuleCache()
    expect(check(b)).toContain('ruled.md')
    fs.rmSync(`${ruled}.away`)
    expect(runGit(['rm', '-q', '--cached', '.claude/skills/ruled.md'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    resetHiddenRuleCache()
    expect(check(b)).toBeNull()
  }, 120_000)

  it('a nested scan that was clean is dropped when a file it read changes, so a rename away and back is not trusted', () => {
    const b = box('nested-rename')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    const skill = path.join(b.project, 'pkg', '.claude', 'skills', 's', 'SKILL.md')
    write(skill, '---\nname: s\n---\n')
    expect(runGit(['add', '-f', 'pkg'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    age(b.project)
    expect(check(b)).toBeNull()
    fs.renameSync(skill, `${skill}.away`)
    fs.renameSync(`${skill}.away`, skill)
    write(skill, PATTERN_SKILL)
    expect(check(b)).toContain('SKILL.md')
  }, 60_000)

  // HAND-DERIVED from the threat: a clean nested answer was kept for the whole minute, so a skill that arrives by untracked add, pull or checkout inside it went unseen. The clock is held at one instant so only the stamps can drop the answer.
  it('a nested scan that was clean sees a skill added to a listed folder, or a new .claude folder, at once', () => {
    const b = box('nested-added')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, 'pkg', '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n')
    expect(runGit(['add', '-f', '.'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    age(b.project)
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(b.project, 'pkg', '.claude', 'skills', 'new', 'SKILL.md'), PATTERN_SKILL)
    expect(check(b, {}, { now: 1_000 })).toContain(path.join('new', 'SKILL.md'))
  }, 60_000)

  it('a nested scan that was clean sees a new .claude folder in a folder it listed at once', () => {
    const b = box('nested-added-folder')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, 'other', 'readme.txt'), 'x\n')
    expect(runGit(['add', '-f', '.'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    age(b.project)
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(b.project, 'other', '.claude', 'agents', 'x.md'), '---\nname: x\ndisallowedTools: Bash(curl *)\n---\n')
    expect(check(b, {}, { now: 1_000 })).toContain('x.md')
  }, 60_000)

  it.for(['plain', 'separate'] as const)('a nested scan that was clean sees a skill that git add or a checkout brings in below the folders it stamps (%s git dir)', { timeout: 60_000 }, (kind) => {
    const b = box(`nested-index-${kind}`)
    const init = kind === 'plain' ? ['init', '-q'] : ['init', '-q', '--separate-git-dir', path.join(root, 'nested-index-gitdir')]
    expect(runGit(init, { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, 'a', 'b', 'c', 'd', 'e', 'x.txt'), 'x\n')
    expect(runGit(['add', '-f', '.'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    age(b.project, path.join(root, 'nested-index-gitdir'))
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    const skill = path.join(b.project, 'a', 'b', 'c', 'd', 'e', '.claude', 'skills', 's', 'SKILL.md')
    write(skill, PATTERN_SKILL)
    expect(runGit(['add', '-f', 'a'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    expect(check(b, {}, { now: 1_000 })).toContain('SKILL.md')
  })

  // HAND-DERIVED from the threat: the stamps are taken after git lists, so a .claude made between the two was baked into the stamp, unseen by the scan, and the clean answer was kept for the minute. The seam creates it right after the last listing call.
  it('a .claude made between the git listing and the stamping is not cached as clean', () => {
    const b = box('nested-race')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, 'other', 'readme.txt'), 'x\n')
    expect(runGit(['add', '-f', '.'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    age(b.project)
    let made = false
    const raced: Box = {
      ...b,
      helpers: {
        ...b.helpers,
        runGit: (args, opts) => {
          const res = b.helpers.runGit(args, opts)
          if (!made && args.includes('-i')) {
            made = true
            write(path.join(b.project, 'other', '.claude', 'agents', 'x.md'), '---\nname: x\ndisallowedTools: Bash(curl *)\n---\n')
          }
          return res
        },
      },
    }
    expect(check(raced, {}, { now: 1_000 })).toBeNull()
    expect(made).toBe(true)
    expect(check(raced, {}, { now: 1_000 })).toContain('x.md')
  }, 60_000)

  // HAND-DERIVED: a stamp newer than 2 s before the scan may be rewritten again in the same clock tick, so its clean answer is not reused (git's racy-index rule).
  it('a nested scan built on a stamp written within the last 2 s is redone on the next call', () => {
    const b = box('nested-racy')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, 'other', 'readme.txt'), 'x\n')
    expect(runGit(['add', '-f', '.'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    postdate(b.project)
    let listings = 0
    const counted: Box = { ...b, helpers: { ...b.helpers, runGit: (args, opts) => (args[0] === 'ls-files' && listings++, b.helpers.runGit(args, opts)) } }
    expect(check(counted, {}, { now: 1_000 })).toBeNull()
    const fresh = listings
    expect(check(counted, {}, { now: 1_000 })).toBeNull()
    expect(listings).toBe(fresh * 2)
    age(b.project)
    expect(check(counted, {}, { now: 1_000 })).toBeNull()
    const aged = listings
    expect(check(counted, {}, { now: 1_000 })).toBeNull()
    expect(listings).toBe(aged)
  }, 60_000)

  // HAND-DERIVED: folders past the stamp cap are not stamped, so a .claude made in one of them was never seen to change and the minute kept the clean answer.
  it('a nested scan with more folders than it stamps is not cached as clean', () => {
    const b = box('nested-cap')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    for (let i = 0; i < 2_100; i++) write(path.join(b.project, `d${i}`, 'f.txt'), 'x')
    age(b.project)
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(b.project, 'd999', '.claude', 'agents', 'x.md'), '---\nname: x\ndisallowedTools: Bash(curl *)\n---\n')
    expect(check(b, {}, { now: 1_000 })).toContain('x.md')
  }, 120_000)

  // HAND-DERIVED: a skill added beside one already listed, far below the project, changes only the folders along its path.
  it('a nested scan that was clean sees a skill added beside a listed one, however deep', () => {
    const b = box('nested-deep')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    const skills = path.join(b.project, 'a', 'b', 'c', 'd', 'e', '.claude', 'skills')
    write(path.join(skills, 's', 'SKILL.md'), '---\nname: s\n---\n')
    age(b.project)
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(skills, 't', 'SKILL.md'), PATTERN_SKILL)
    expect(check(b, {}, { now: 1_000 })).toContain(path.join('t', 'SKILL.md'))
  }, 60_000)

  // HAND-DERIVED from node's contract: statSync on a path holding a NUL byte throws ERR_INVALID_ARG_VALUE on every platform, an error that is neither ENOENT nor ENOTDIR and says nothing about the folder. Only a missing entry, or a parent that is a file, may read as absent.
  it('a stamp is absent only for a missing entry, and unreadable for any other stat failure', () => {
    const b = box('stamp-kinds')
    write(path.join(b.project, 'file.txt'), 'x')
    expect(stamp(path.join(b.project, 'gone'))).toBe('absent')
    expect(stamp(path.join(b.project, 'file.txt', 'below'))).toBe('absent')
    expect(stamp(path.join(b.project, `bad${String.fromCharCode(0)}name`))).toBe('unreadable')
    expect(stamp(b.project)).toMatch(/:dir$/)
  })

  it('a skill tree too large to finish checking counts as hidden', () => {
    const b = box('huge')
    const dir = path.join(b.config, 'skills', 'many')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 20_010; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '')
    expect(check(b)).toBe('too many files to check')
  }, 120_000)

  it('a skill written into a fixed folder counts on the next call, not a minute later', () => {
    const b = box('ttl')
    age(b.config, b.project)
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(b.config, 'skills', 'net', 'SKILL.md'), '---\ndisallowed-tools: Bash(curl *)\n---\n')
    expect(check(b, {}, { now: 1_500 })).toContain('SKILL.md')
    const c = box('ttl-edit')
    const file = path.join(c.project, '.claude', 'skills', 'web', 'SKILL.md')
    write(file, '---\ndisallowed-tools: WebFetch\n---\n')
    expect(check(c, {}, { now: 1_000 })).toBeNull()
    write(file, '---\ndisallowed-tools: WebFetch(domain:x)\n---\n')
    expect(check(c, {}, { now: 1_500 })).toContain('SKILL.md')
  }, 30_000)

  it('the nested search is kept for a minute, then redone', () => {
    const b = box('ttl-nested')
    expect(check(b, {}, { now: 1_000 })).toBeNull()
    write(path.join(b.project, 'pkg', '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    expect(check(b, {}, { now: 30_000 })).toBeNull()
    expect(check(b, {}, { now: 62_000 })).toContain('SKILL.md')
  }, 30_000)
})

// HAND-DERIVED layouts. Claude Code facts: it does not skip node_modules when it discovers nested skills, and skips a directory only when `git check-ignore` exits 0 (FORMAT-DERIVED from claude.exe 2.1.289); check-ignore exits 128 for a path past a directory link and treats a junction as a plain directory (CAPTURE: git 2.53.0.windows.1, 2026-10-06).
describe('hiddenRuleSource: nested skills behind node_modules and links', () => {
  it('a skill directory inside node_modules counts outside a git checkout', () => {
    const b = box('node-modules')
    write(path.join(b.project, 'node_modules', 'pkg', '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    expect(check(b)).toContain(path.join('node_modules', 'pkg', '.claude', 'skills', 's', 'SKILL.md'))
  }, 30_000)

  it('a directory link or junction outside a git checkout is followed', (ctx) => {
    const b = box('link-plain')
    const ext = path.join(root, 'link-plain', 'ext')
    write(path.join(ext, '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    if (!link(ext, path.join(b.project, 'linked'))) return ctx.skip()
    expect(check(b)).toContain('SKILL.md')
    const c = box('junction-plain')
    const ext2 = path.join(root, 'junction-plain', 'ext')
    write(path.join(ext2, '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    expect(link(ext2, path.join(c.project, 'junc'), 'junction')).toBe(true)
    expect(check(c)).toContain('SKILL.md')
  }, 30_000)

  it('a link back up the tree is walked once, not until the depth limit', (ctx) => {
    const b = box('link-loop')
    if (!link(b.project, path.join(b.project, 'self'))) return ctx.skip()
    expect(check(b)).toBeNull()
  }, 30_000)

  it('a link at a .claude or skills directory itself is followed', (ctx) => {
    const b = box('link-claude')
    const ext = path.join(root, 'link-claude', 'ext')
    write(path.join(ext, 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    if (!link(ext, path.join(b.project, 'pkg', '.claude'))) return ctx.skip()
    expect(check(b)).toContain('SKILL.md')
  }, 30_000)

  it.for(['untracked', 'tracked', 'ignored'] as const)('inside a git checkout a %s link counts, as check-ignore never skips past one', { timeout: 30_000 }, (how, ctx) => {
    resetHiddenRuleCache()
    const b = box(`link-git-${how}`)
    const ext = path.join(root, `link-git-${how}`, 'ext')
    write(path.join(ext, '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    expect(runGit(['config', 'core.symlinks', 'true'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    if (how === 'ignored') write(path.join(b.project, '.gitignore'), 'linked\n')
    if (!link(ext, path.join(b.project, 'linked'))) return ctx.skip()
    if (how === 'tracked') expect(runGit(['add', 'linked'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    expect(check(b), how).toContain('SKILL.md')
  })

  it('inside a git checkout a skill directory under an ignored directory still does not count', () => {
    const b = box('git-ignored-dir')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, '.gitignore'), 'node_modules/\n')
    write(path.join(b.project, 'node_modules', 'pkg', '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    expect(check(b)).toBeNull()
  }, 30_000)

  // FORMAT-DERIVED from claude.exe 2.1.291: nested skill discovery runs `git check-ignore -- <folder holding .claude>` and logs "Skipped gitignored skills dir" only when that exits 0; the skill file and the `.claude` folder are never asked about. Ignore patterns HAND-DERIVED; that git lists `c/.claude/` whole and `a/` above an ignored file was CAPTURED from git 2.53.0.windows.1.
  it.each([
    ['a/**/*.md', 'a/.claude/skills/s/SKILL.md'],
    ['b/.claude/skills/s/', 'b/.claude/skills/s/SKILL.md'],
    ['c/.claude/', 'c/.claude/skills/s/SKILL.md'],
    ['d/.claude/skills/', 'd/.claude/skills/s/SKILL.md'],
    ['g/*\n!g/x.txt', 'g/.claude/skills/s/SKILL.md'],
    ['h/.claude/agents/', 'h/.claude/agents/a.md'],
  ] as const)('inside a git checkout an ignored skill or .claude folder counts while the folder holding .claude is not ignored: %j', (ignore, skill) => {
    resetHiddenRuleCache()
    const b = box(`git-ignored-${skill[0]}`)
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, '.gitignore'), `${ignore}\n`)
    write(path.join(b.project, 'g', 'x.txt'), 'kept\n')
    write(path.join(b.project, ...skill.split('/')), PATTERN_SKILL)
    expect(check(b), ignore).toContain(path.join(...skill.split('/')))
  }, 30_000)

  it('inside a git checkout a skill folder under an ignored holder directory does not count', () => {
    resetHiddenRuleCache()
    const b = box('git-ignored-holder')
    expect(runGit(['init', '-q'], { cwd: b.project, timeoutMs: 15_000 }).exitCode).toBe(0)
    write(path.join(b.project, '.gitignore'), 'e/\nf/deep/\n')
    write(path.join(b.project, 'e', 'sub', '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    write(path.join(b.project, 'f', 'deep', '.claude', 'skills', 's', 'SKILL.md'), PATTERN_SKILL)
    write(path.join(b.project, 'f', 'kept.txt'), 'kept\n')
    expect(check(b)).toBeNull()
  }, 60_000)
})

// FORMAT-DERIVED from claude.exe 2.1.291: a hook's `agent_type` is "Agent type name (e.g., "general-purpose", "code-reviewer"). Present when the hook fires from within a subagent"; a markdown agent's type is its frontmatter `name`, and `:` is reserved for a plugin's namespace.
describe('hiddenRuleSource: the subagent a hook fires in', () => {
  it('a built-in agent type removes no tool by pattern', () => {
    const b = box('agent-builtin')
    expect(check(b, {}, { agentType: 'Explore' })).toBeNull()
    expect(check(b, {}, { agentType: 'general-purpose' })).toBeNull()
  }, 30_000)

  it('an agent type no scanned definition names counts as hidden, teammate included', () => {
    const b = box('agent-unknown')
    expect(check(b, {}, { agentType: 'code-reviewer' })).toBe('agent code-reviewer not checked')
    expect(check(b, {}, { agentType: 'teammate' })).toBe('agent teammate not checked')
  }, 30_000)

  it('an agent defined by a file the scan read is known by its frontmatter name, not its file name', () => {
    const b = box('agent-file')
    write(path.join(b.config, 'agents', 'review.md'), '---\nname: "code-reviewer"\ndisallowedTools: WebFetch\n---\n')
    expect(check(b, {}, { agentType: 'code-reviewer' })).toBeNull()
    expect(check(b, {}, { agentType: 'review' })).toBe('agent review not checked')
  }, 30_000)

  it("a plugin's agent is known only by its namespaced type", () => {
    const b = box('agent-plugin')
    write(path.join(b.config, 'plugins', 'cache', 'm', 'tools', '1.0.0', 'agents', 'helper.md'), '---\nname: helper\n---\n')
    expect(check(b, {}, { agentType: 'tools:helper' })).toBeNull()
    expect(check(b, {}, { agentType: 'helper' })).toBe('agent helper not checked')
  }, 30_000)
})

describe('primeProcessReason', () => {
  it('reads the claude command line ahead, so the check later finds it cached', async () => {
    const pid = fakeClaude(['--resume', 'abc'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: pid, CLAUDE_CODE_SESSION_ID: 'prime' }
    const b = box('prime')
    await primeProcessReason(env)
    const child = idle.find((c) => String(c.pid) === pid) as ChildProcess
    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill()
    })
    expect(hiddenRuleSource(b.project, b.project, env, b.helpers)).toBeNull()
    resetHiddenRuleCache()
    expect(hiddenRuleSource(b.project, b.project, env, b.helpers)).toBe('claude command line unreadable')
  }, 30_000)
})
