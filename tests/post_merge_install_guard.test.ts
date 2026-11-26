// CAPTURE: runs the real dist/token-goat.mjs in a throwaway checkout with a scratch HOME.
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'

import { POST_MERGE_DOCTOR_DEV_ARGV } from './helpers/post_merge_argv.js'
import { stopOwnedChild, trackOwnedChild } from './helpers/stop_owned_child.js'
import { tempDir } from './helpers/temp-config.js'

const REPO_ROOT = path.resolve(__dirname, '..')
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts')
const REAL_DIST = path.join(REPO_ROOT, 'dist')
const GUARD_MESSAGE = 'refusing to register'
// Every event HOOK_EVENT_MAP wires in src/install.ts:64-73.
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart']

interface Checkout {
  base: string
  root: string
  home: string
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

const made: Checkout[] = []

afterEach(async () => {
  for (const checkout of made.splice(0)) {
    // Stops the worker and hook server this run started, under the same scratch HOME.
    await runBundle(checkout, ['worker', 'stop'], {}, false)
    await runBundle(checkout, ['hook-server', 'stop'], {}, false)
    fs.rmSync(checkout.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
}

function makeCheckout(): Checkout {
  const base = tempDir()
  const checkout = { base, root: path.join(base, 'checkout'), home: path.join(base, 'home') }
  made.push(checkout)
  fs.mkdirSync(checkout.root, { recursive: true })
  fs.mkdirSync(checkout.home, { recursive: true })
  git(checkout.root, ['init'])
  git(checkout.root, ['commit', '--allow-empty', '-m', 'init'])
  fs.cpSync(SCRIPTS_DIR, path.join(checkout.root, 'scripts'), { recursive: true })
  // The bundle is a loader over sibling chunks and native files, so the whole dist directory is copied.
  fs.cpSync(REAL_DIST, path.join(checkout.root, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(checkout.root, 'package.json'))
  // Index only lists tracked files, so the copied tree is committed.
  git(checkout.root, ['add', '-A'])
  git(checkout.root, ['commit', '-m', 'copy'])
  return checkout
}

/** HAND-DERIVED: a user-scope hook entry naming a bundle path; the shape is not captured from install output. */
function seedUserEntry(checkout: Checkout, bundle: string): void {
  const file = path.join(checkout.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const command = `"${process.execPath}" "${bundle}"`
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }))
}

function scratchEnv(checkout: Checkout, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^npm_execpath$/i.test(key) || /^tg_post_merge_sync$/i.test(key)) delete env[key]
  }
  // RUSTUP_HOME and CARGO_HOME stay real: they are inherited, never overridden.
  return {
    ...env,
    HOME: checkout.home,
    USERPROFILE: checkout.home,
    LOCALAPPDATA: path.join(checkout.home, 'local'),
    XDG_DATA_HOME: path.join(checkout.home, 'data'),
    XDG_CONFIG_HOME: path.join(checkout.home, 'config'),
    XDG_CACHE_HOME: path.join(checkout.home, 'cache'),
    TOKEN_GOAT_HOME: path.join(checkout.home, 'token-goat'),
    CLAUDE_CONFIG_DIR: path.join(checkout.home, '.claude'),
    CODEX_HOME: path.join(checkout.home, 'codex'),
    COPILOT_HOME: path.join(checkout.home, 'copilot'),
    TOKEN_GOAT_OFFLINE: '1',
    ...extra,
  }
}

/** Runs `node <script> <args>`; every exit path, including vitest's test timeout, ends the whole tree. */
async function runNode(
  script: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; backstop: boolean },
): Promise<RunResult> {
  const child = spawn(process.execPath, [script, ...args], { cwd: opts.cwd, env: opts.env, windowsHide: true })
  trackOwnedChild(child)
  if (opts.backstop) onTestFinished(() => stopOwnedChild(child, { graceful: false }))
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const timer = setTimeout(() => void stopOwnedChild(child, { graceful: false }), opts.timeoutMs)
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    return { status, stdout, stderr }
  } finally {
    clearTimeout(timer)
    await stopOwnedChild(child, { graceful: false })
  }
}

function runBundle(checkout: Checkout, args: string[], extra: Record<string, string> = {}, backstop = true): Promise<RunResult> {
  return runNode(path.join(checkout.root, 'dist', 'token-goat.mjs'), args, {
    cwd: checkout.root,
    env: scratchEnv(checkout, extra),
    timeoutMs: 120_000,
    backstop,
  })
}

function output(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}${res.stderr}`
}

describe('post-merge registers a checkout bundle with --dev only where an entry already names it (real bundle)', () => {
  it('an entry at another checkout: install without --dev refuses and leaves the settings bytes alone', async () => {
    // stub row 'passes no --dev when the user entry names another checkout' asserts argv: install
    const checkout = makeCheckout()
    const userSettings = path.join(checkout.home, '.claude', 'settings.json')
    seedUserEntry(checkout, path.join(checkout.base, 'other-checkout', 'dist', 'token-goat.mjs'))
    const before = fs.readFileSync(userSettings, 'utf8')

    const plain = await runBundle(checkout, ['install'])
    expect(plain.status, output(plain)).not.toBe(0)
    expect(output(plain)).toContain(GUARD_MESSAGE)
    expect(fs.readFileSync(userSettings, 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(checkout.root, '.claude', 'settings.json'))).toBe(false)
  })

  it('doctor --dev without --repair is refused, not accepted as a silent no-op', async () => {
    // stub row 'a project hook gap under an entry naming this checkout: the doctor repair carries --dev'
    const checkout = makeCheckout()
    const res = await runBundle(checkout, ['doctor', '--dev'])
    expect(res.status, output(res)).not.toBe(0)
    expect(output(res)).toContain('doctor --dev applies to a repair')
  })

  it('a project hook gap under an entry naming this checkout: the post-merge doctor argv writes the missing project hooks', async () => {
    // stub row 'a project hook gap under an entry naming this checkout' asserts the same argv
    const checkout = makeCheckout()
    const installed = await runBundle(checkout, ['install', '--dev'])
    expect(installed.status, output(installed)).toBe(0)
    // Project scope gets only the real user entry's SessionStart group, so the other events are a gap.
    const userSettings = JSON.parse(fs.readFileSync(path.join(checkout.home, '.claude', 'settings.json'), 'utf8')) as { hooks: { SessionStart: unknown } }
    const projectSettings = path.join(checkout.root, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true })
    fs.writeFileSync(projectSettings, JSON.stringify({ hooks: { SessionStart: userSettings.hooks.SessionStart } }))

    const res = await runBundle(checkout, [...POST_MERGE_DOCTOR_DEV_ARGV])
    expect(res.status, output(res)).toBe(0)
    expect(output(res)).not.toContain(GUARD_MESSAGE)
    const hooks = JSON.parse(fs.readFileSync(projectSettings, 'utf8')).hooks as Record<string, unknown>
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) expect(JSON.stringify(hooks[event]), event).toContain('token-goat')
  })
})
