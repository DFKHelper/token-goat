/** The bypassPermissions check for Claude Code rule sources no settings file shows (src/claude_hidden_rules.ts): a host that answers prompts itself, a command-line flag that adds or relays rules, a skill, command, agent or plugin that removes a tool by pattern, and a PermissionRequest hook outside the settings files. Facts are FORMAT-DERIVED from claude.exe 2.1.x: hooks get CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT (`cli`, `sdk-cli` under -p, a host's own value otherwise), and gitignored nested skills directories are skipped ("[skills] Skipped gitignored skills dir"). */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { frontmatterAddsRule, hiddenRuleSource, resetHiddenRuleCache, type HiddenRuleHelpers } from '../src/claude_hidden_rules.js'
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

function check(b: Box, env: NodeJS.ProcessEnv = {}): string | null {
  return hiddenRuleSource(b.project, b.project, { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: plainPid, CLAUDE_CODE_SESSION_ID: 's', ...env }, b.helpers)
}

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

  it('an installed plugin with a PermissionRequest hook hides a rule; the plugin listing beside the cache does not', () => {
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

  it('a skill tree too large to finish checking counts as hidden', () => {
    const b = box('huge')
    const dir = path.join(b.config, 'skills', 'many')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 20_010; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '')
    expect(check(b)).toBe('too many files to check')
  }, 120_000)

  it('the scan is cached for a minute, then redone', () => {
    const b = box('ttl')
    const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: plainPid, CLAUDE_CODE_SESSION_ID: 's' }
    expect(hiddenRuleSource(b.project, b.project, env, b.helpers, 1_000)).toBeNull()
    write(path.join(b.config, 'skills', 'net', 'SKILL.md'), '---\ndisallowed-tools: Bash(curl *)\n---\n')
    expect(hiddenRuleSource(b.project, b.project, env, b.helpers, 30_000)).toBeNull()
    expect(hiddenRuleSource(b.project, b.project, env, b.helpers, 62_000)).toContain('SKILL.md')
  }, 30_000)
})
