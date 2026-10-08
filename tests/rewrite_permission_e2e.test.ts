/** The shipped bundle's PreToolUse rewrites against real Claude Code settings files: a rewrite must never carry `permissionDecision: "allow"` past a rule the user wrote, and must not happen at all where a deny or ask rule could match the original. Claude Code matches its rules against the hook's `updatedInput` (https://code.claude.com/docs/en/hooks, PreToolUse decision control: `updatedInput` "Replaces the entire input object", `allow` "bypasses the permission prompt"), so a `token-goat compress` wrapper or a shrunk image's temp path is what a rule would see. PROVENANCE: FORMAT-DERIVED payload envelope from https://code.claude.com/docs/en/hooks (`session_id`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`); FORMAT-DERIVED settings shape and rule syntax from https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/permissions (`permissions.deny`, `Bash(curl:*)`, `Read(./private/**)`); the image is random noise generated here (HAND-DERIVED). Every child runs with HOME, CLAUDE_CONFIG_DIR and the data dirs inside a temp tree and its cwd in the project there, so no developer settings take part. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let sessionClaude: ChildProcess

// FORMAT-DERIVED from claude.exe 2.1.x, which gives its hooks CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT: every hook here is a call from a terminal Claude Code session, so each sandbox names an idle process with no flags as that session (a hook that cannot read a claude command line no longer approves).
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-perm-e2e-'))
  fs.writeFileSync(path.join(root, 'session.js'), 'setInterval(() => {}, 1 << 30)\n')
  sessionClaude = spawn(process.execPath, [path.join(root, 'session.js'), '--resume', 'abc'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
})

afterAll(() => {
  sessionClaude.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

interface Sandbox {
  readonly home: string
  readonly project: string
  readonly temp: string
  readonly env: NodeJS.ProcessEnv
}

function sandbox(name: string, userSettings?: unknown, projectSettings?: unknown): Sandbox {
  const base = path.join(root, name)
  const home = path.join(base, 'home')
  const project = path.join(base, 'proj')
  const temp = path.join(base, 'tmp')
  const claude = path.join(home, 'claude')
  for (const d of [home, project, temp, claude]) fs.mkdirSync(d, { recursive: true })
  if (userSettings !== undefined) fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(userSettings))
  if (projectSettings !== undefined) {
    fs.mkdirSync(path.join(project, '.claude'))
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(projectSettings))
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKEN_GOAT_HOME: path.join(home, 'tg'),
    LOCALAPPDATA: path.join(home, 'la'),
    XDG_DATA_HOME: path.join(home, 'xd'),
    APPDATA: path.join(home, 'ad'),
    CLAUDE_CONFIG_DIR: claude,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
    TOKEN_GOAT_OCR_ENABLED: 'false',
    TOKEN_GOAT_OFFLINE: '1',
    CLAUDE_PID: String(sessionClaude.pid),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  }
  delete env['TOKEN_GOAT_BASH_COMPRESS']
  return { home, project, temp, env }
}

function hook(box: Sandbox, toolName: string, toolInput: Record<string, unknown>, mode = 'default', env: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  const payload = { session_id: `perm-e2e-${path.basename(path.dirname(box.home))}`, cwd: box.project, permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, ...extra }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env: { ...box.env, ...env }, input: JSON.stringify(payload), encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return (JSON.parse(res.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
}

function shrinkEvents(box: Sandbox): number {
  const res = spawnSync(process.execPath, [BUNDLE, 'stats', '--json'], { cwd: box.project, env: box.env, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  const parsed = JSON.parse(res.stdout) as { by_kind?: Record<string, { events?: number }> }
  return parsed.by_kind?.['image_shrink']?.events ?? 0
}

async function writeNoiseJpeg(file: string): Promise<void> {
  const side = 1600
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer())
}

describe('shell rewrites honor Claude Code permission rules (built bundle)', () => {
  it('a Bash deny rule keeps the original command: no rewrite reaches Claude Code to slip past it', () => {
    const box = sandbox('deny-curl', { permissions: { deny: ['Bash(curl:*)'] } })
    expect(hook(box, 'Bash', { command: 'curl -s https://example.com' })).toBeUndefined()
  })

  it('with no rules the same command is rewritten, with no decision, so Claude Code still asks', () => {
    const box = sandbox('none-curl')
    const hso = hook(box, 'Bash', { command: 'curl -s https://example.com' })
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f curl --timeout 600 -c 'curl -s https://example.com'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })

  it('an unproven build command is rewritten with no permissionDecision', () => {
    const box = sandbox('none-go')
    const hso = hook(box, 'Bash', { command: 'go build ./...' })
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f go --timeout 600 -c 'go build ./...'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })

  it('a user allow rule for the original proves it auto-allowed, so the rewrite may say allow', () => {
    const box = sandbox('allow-go', { permissions: { allow: ['Bash(go build:*)'] } })
    const hso = hook(box, 'Bash', { command: 'go build ./...' })
    expect(hso?.['permissionDecision']).toBe('allow')
  })

})

describe('image Read rewrites honor Claude Code Read rules (built bundle)', () => {
  it('a Read deny rule on the image keeps the original Read, writes no copy and books no saving', async () => {
    const box = sandbox('deny-private', undefined, { permissions: { deny: ['Read(./private/**)'] } })
    const image = path.join(box.project, 'private', 'shot.jpg')
    await writeNoiseJpeg(image)
    expect(hook(box, 'Read', { file_path: image })).toBeUndefined()
    expect(fs.readdirSync(box.temp).filter((n) => n.startsWith('token-goat-shrink-'))).toEqual([])
    expect(shrinkEvents(box)).toBe(0)
  }, 60_000)

  it('with no rules the same image is rewritten to a shrunk copy with allow, and the saving is booked', async () => {
    const box = sandbox('none-private')
    const image = path.join(box.project, 'private', 'shot.jpg')
    await writeNoiseJpeg(image)
    const hso = hook(box, 'Read', { file_path: image })
    expect(hso?.['permissionDecision']).toBe('allow')
    const file = (hso?.['updatedInput'] as Record<string, unknown> | undefined)?.['file_path']
    expect(typeof file === 'string' && path.basename(file).startsWith('token-goat-shrink-')).toBe(true)
    expect(shrinkEvents(box)).toBe(1)
  }, 60_000)
})

// HAND-DERIVED from https://code.claude.com/docs/en/permissions: a Read deny or ask rule applies to Claude Code's Read and Grep tools and to its recognized file commands in Bash (cat, head, sed), but never to a token-goat command those calls are pointed at instead.
describe('read hints honor Claude Code Read rules (built bundle)', () => {
  const lock = JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': { name: 'p' } } }, null, 2)
  const source = Array.from({ length: 400 }, (_, i) => `export function f${i}(a: number): number {\n  return a + ${i}\n}\n`).join('')
  let calls = 0

  function project(name: string, rule: 'deny' | 'ask'): Sandbox {
    const box = sandbox(name, undefined, { permissions: { [rule]: ['Read(./secrets/**)'] } })
    for (const dir of ['secrets', 'open']) {
      fs.mkdirSync(path.join(box.project, dir, 'node_modules', 'x'), { recursive: true })
      fs.writeFileSync(path.join(box.project, dir, 'package-lock.json'), lock)
      fs.writeFileSync(path.join(box.project, dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
      fs.writeFileSync(path.join(box.project, dir, 'app.ts'), source)
    }
    return box
  }

  // The whole answer, since a Claude Code refusal is a top-level decision rather than hookSpecificOutput; each call gets its own session so no once-per-session hint is spent by an earlier one.
  function answer(box: Sandbox, toolName: string, toolInput: Record<string, unknown>): string {
    const payload = { session_id: `read-hint-${calls++}`, cwd: box.project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env: { ...box.env, CLAUDE_PROJECT_DIR: box.project }, input: JSON.stringify(payload), encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    return res.stdout.trim()
  }

  for (const rule of ['deny', 'ask'] as const) {
    it(`a Read ${rule} rule holds back the token-goat hints for a Read, a Grep or a cat under it, and leaves them for the files beside it`, () => {
      const box = project(`read-hint-${rule}`, rule)
      for (const dir of ['secrets', 'open']) {
        const shown = dir === 'open'
        const lockAnswer = answer(box, 'Read', { file_path: path.join(box.project, dir, 'package-lock.json') })
        expect(lockAnswer.includes('token-goat json-outline'), lockAnswer).toBe(shown)
        const modulesAnswer = answer(box, 'Read', { file_path: path.join(box.project, dir, 'node_modules', 'x', 'index.js') })
        expect(modulesAnswer.includes('node_modules is typically noise'), modulesAnswer).toBe(shown)
        const grepAnswer = answer(box, 'Grep', { pattern: '^export function', path: path.join(box.project, dir, 'app.ts') })
        expect(grepAnswer.includes('token-goat skeleton'), grepAnswer).toBe(shown)
        const catAnswer = answer(box, 'Bash', { command: `cat ${dir}/app.ts` })
        expect(catAnswer.includes('token-goat read'), catAnswer).toBe(shown)
        const catLockAnswer = answer(box, 'Bash', { command: `cat ${dir}/package-lock.json` })
        expect(catLockAnswer.includes('token-goat json-query'), catLockAnswer).toBe(shown)
        if (!shown) expect([lockAnswer, modulesAnswer, grepAnswer, catAnswer, catLockAnswer]).toEqual(['{}', '{}', '{}', '{}', '{}'])
      }
    })
  }

  it('a warning about how a command is written still reaches a command naming a covered file', () => {
    const box = project('read-hint-quote', 'deny')
    expect(answer(box, 'Bash', { command: 'cat "secrets/app.ts' })).toContain('unclosed double quote')
  })
})

type Outcome = 'skip' | 'rewrite' | 'approve'

/** What a PreToolUse answer did: no hookSpecificOutput is a skip, an updatedInput with `allow` an approve, one with no decision a rewrite; any other decision fails the test. */
function outcome(hso: Record<string, unknown> | undefined): Outcome {
  if (hso === undefined) return 'skip'
  expect(hso['updatedInput']).toBeDefined()
  if (!('permissionDecision' in hso)) return 'rewrite'
  expect(hso['permissionDecision']).toBe('allow')
  return 'approve'
}

// HAND-DERIVED from the bypass rule (in bypassPermissions the user is never prompted, and auto mode follows the same rule) and from https://code.claude.com/docs/en/permission-modes for the other modes: default, acceptEdits and plan may defer to Claude Code's own prompt, dontAsk turns that prompt into a denial, and nothing ever answers ask. The claude process is stood in for by an idle node process, whose command line the hook reads through CLAUDE_PID (FORMAT-DERIVED from claude.exe 2.1.x, which gives hooks CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT).
describe('rewrites in every permission mode (built bundle)', () => {
  const idle: ChildProcess[] = []
  const spawned: Array<Promise<void>> = []
  let plainPid = ''
  let disallowPid = ''

  function fakeClaude(args: string[]): string {
    const child = spawn(process.execPath, [path.join(root, 'idle.js'), ...args], { stdio: 'ignore', windowsHide: true })
    idle.push(child)
    spawned.push(new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) }))
    return String(child.pid)
  }

  beforeAll(async () => {
    fs.writeFileSync(path.join(root, 'idle.js'), 'setInterval(() => {}, 1 << 30)\n')
    plainPid = fakeClaude(['--resume', 'abc'])
    disallowPid = fakeClaude(['--resume', 'abc', '--disallowedTools', 'Bash(curl *)'])
    // The process has to exist, with its command line readable, before a test asks the hook to inspect it; the child's own spawn event says so, where a fixed sleep guessed.
    await Promise.all(spawned)
  })

  afterAll(() => {
    for (const child of idle) child.kill()
  })

  function claudeEnv(box: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { CLAUDE_PID: plainPid, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PROJECT_DIR: box.project, ...extra }
  }

  const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'] as const
  const CASES: Record<'safe' | 'unprovable' | 'deny' | 'ask', { readonly settings: unknown; readonly command: string; readonly expected: Record<(typeof MODES)[number], Outcome> }> = {
    safe: { settings: { permissions: { allow: ['Bash(go build:*)'] } }, command: 'go build ./...', expected: { default: 'approve', acceptEdits: 'approve', plan: 'skip', dontAsk: 'approve', auto: 'skip', bypassPermissions: 'approve' } },
    unprovable: { settings: {}, command: 'go build ./...', expected: { default: 'rewrite', acceptEdits: 'rewrite', plan: 'rewrite', dontAsk: 'skip', auto: 'skip', bypassPermissions: 'approve' } },
    deny: { settings: { permissions: { deny: ['Bash(curl:*)'] } }, command: 'curl -s https://example.com', expected: { default: 'skip', acceptEdits: 'skip', plan: 'skip', dontAsk: 'skip', auto: 'skip', bypassPermissions: 'skip' } },
    ask: { settings: { permissions: { ask: ['Bash(curl *)'] } }, command: 'curl -s https://example.com', expected: { default: 'skip', acceptEdits: 'skip', plan: 'skip', dontAsk: 'skip', auto: 'skip', bypassPermissions: 'skip' } },
  }

  for (const [name, c] of Object.entries(CASES)) {
    it(`a ${name} Bash command gets the outcome its mode allows, and never a deferred rewrite in auto or bypassPermissions`, () => {
      const box = sandbox(`matrix-${name}`, c.settings)
      const got = Object.fromEntries(MODES.map((mode) => [mode, outcome(hook(box, 'Bash', { command: c.command }, mode, claudeEnv(box)))]))
      expect(got).toEqual(c.expected)
    }, 120_000)
  }

  it('in bypassPermissions a rule source the hook cannot read leaves even a safe command alone', () => {
    const box = sandbox('bypass-hidden', { permissions: { allow: ['Bash(go build:*)'] } })
    const run = (extra: NodeJS.ProcessEnv): Outcome => outcome(hook(box, 'Bash', { command: 'go build ./...' }, 'bypassPermissions', claudeEnv(box, extra)))
    expect(run({})).toBe('approve')
    expect(run({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe('skip')
    expect(run({ CLAUDE_PID: disallowPid })).toBe('skip')
    expect(run({ CLAUDE_PID: '' })).toBe('skip')
    const skill = sandbox('bypass-hidden-skill', { permissions: { allow: ['Bash(go build:*)'] } })
    fs.mkdirSync(path.join(skill.project, '.claude', 'skills', 'net'), { recursive: true })
    fs.writeFileSync(path.join(skill.project, '.claude', 'skills', 'net', 'SKILL.md'), '---\nname: net\ndisallowed-tools: Bash(go build *)\n---\nbody\n')
    expect(outcome(hook(skill, 'Bash', { command: 'go build ./...' }, 'bypassPermissions', claudeEnv(skill)))).toBe('skip')
    const hooked = sandbox('bypass-hidden-hook', { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } })
    expect(outcome(hook(hooked, 'Bash', { command: 'go build ./...' }, 'bypassPermissions', claudeEnv(hooked)))).toBe('skip')
  }, 120_000)

  it('the image Read rewrite is approved in bypassPermissions only with no hidden rule source, and skipped in auto', async () => {
    const box = sandbox('matrix-image')
    const image = path.join(box.project, 'shot.jpg')
    await writeNoiseJpeg(image)
    expect(outcome(hook(box, 'Read', { file_path: image }, 'default', claudeEnv(box)))).toBe('approve')
    expect(outcome(hook(box, 'Read', { file_path: image }, 'auto', claudeEnv(box)))).toBe('skip')
    expect(outcome(hook(box, 'Read', { file_path: image }, 'bypassPermissions', claudeEnv(box, { CLAUDE_CODE_ENTRYPOINT: 'sdk-py' })))).toBe('skip')
    expect(outcome(hook(box, 'Read', { file_path: image }, 'bypassPermissions', claudeEnv(box)))).toBe('approve')
  }, 120_000)

  it('the Agent prompt rewrite defers in default mode, is approved in bypassPermissions only with no hidden rule source, and is skipped in auto', () => {
    const box = sandbox('matrix-agent')
    const spawnAgent = (mode: string, extra: NodeJS.ProcessEnv = {}): Outcome => outcome(hook(box, 'Agent', { subagent_type: 'general-purpose', description: 'd', prompt: 'find the failing test in the parser module' }, mode, claudeEnv(box, extra)))
    // Each spawn gets the subagent briefing, and each later one the near-duplicate advisory as well: either way the prompt is rewritten.
    expect(spawnAgent('default')).toBe('rewrite')
    expect(spawnAgent('auto')).toBe('skip')
    expect(spawnAgent('bypassPermissions', { CLAUDE_PID: disallowPid })).toBe('skip')
    expect(spawnAgent('bypassPermissions')).toBe('approve')
  }, 120_000)

  // FORMAT-DERIVED from claude.exe 2.1.291: a hook fired inside a subagent carries `agent_id` and `agent_type`, the type being a built-in name such as "Explore" or a definition's frontmatter `name`.
  it('in bypassPermissions a call from a subagent no scanned definition names is left alone; a built-in one or one the scan read is approved', async () => {
    const box = sandbox('bypass-agent-type', { permissions: { allow: ['Bash(go build:*)'] } })
    fs.mkdirSync(path.join(box.project, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(box.project, '.claude', 'agents', 'file-name.md'), '---\nname: builder\ndescription: builds\n---\nbody\n')
    const image = path.join(box.project, 'shot.jpg')
    await writeNoiseJpeg(image)
    const calls: Record<string, readonly [string, Record<string, unknown>]> = {
      bash: ['Bash', { command: 'go build ./...' }],
      image: ['Read', { file_path: image }],
      agent: ['Agent', { subagent_type: 'general-purpose', description: 'd', prompt: 'find the failing test in the parser module' }],
    }
    for (const [name, [tool, input]] of Object.entries(calls)) {
      const run = (agentType: string): Outcome => outcome(hook(box, tool, input, 'bypassPermissions', claudeEnv(box), { agent_id: 'a1', agent_type: agentType }))
      expect(run('Explore'), name).toBe('approve')
      expect(run('builder'), name).toBe('approve')
      expect(run('file-name'), name).toBe('skip')
      expect(run('custom'), name).toBe('skip')
    }
  }, 180_000)
})
