/** The one-shot pre-tool hook must not sit behind another process's lock for the 15 s database budget or the old 15 s session-lock budget. A Windows client measured 30.5-34.6 s hooks while stray token-goat processes held global.db, against 0.5 s clean. These tests hold a real lock from a second OS process and run the built `hook` command through its real entry. They assert on events, never on elapsed time: the hook has exited while the holder is still alive, and every busy_timeout the hook process set on a connection (recorded by tests/helpers/sqlite_busy_trace.ts) is a short one. The recording process also ends with status 97 the moment a wait of a second or more is set, so the old 15 s budget fails the case by assertion at once and not through the test timeout. CAPTURE: the 30 s and 15 s stalls were reproduced against the built bundle with this same holder shape (a node:sqlite process in `BEGIN EXCLUSIVE`, and a live-pid `<id>.json.lock` file) before the fix; this file's fixtures are the shapes that run used. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { busyTrace, type BusyTrace } from './helpers/sqlite_busy_trace.js'
import { findGlobalDb } from './helpers/find_global_db.js'

// The holder takes the lock named by argv[3], prints READY, then idles until its stdin closes (the parent exiting closes it too), so it cannot outlive this process.
const HOLDER_SOURCE = [
  "const { DatabaseSync } = require('node:sqlite')",
  'const [, , dbPath, mode] = process.argv',
  "if (mode !== 'idle') {",
  '  const db = new DatabaseSync(dbPath)',
  "  db.exec('PRAGMA busy_timeout = 1000')",
  "  if (mode === 'exclusive') db.exec('PRAGMA locking_mode = EXCLUSIVE')",
  "  db.exec(mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN IMMEDIATE')",
  '}',
  "process.stdout.write('READY\\n')",
  'process.stdin.resume()',
  "process.stdin.on('end', () => process.exit(0))",
].join('\n')

// The library entry the Claude Code, Codex and Copilot CLI shims import: one event in, the decision out. It does not exit by itself, so the script ends the process once the decision is flushed.
const LIB_SCRIPT = [
  "const { pathToFileURL } = require('node:url')",
  'import(pathToFileURL(process.argv[1]).href).then(async (m) => {',
  "  const out = await m.relayInProcess('pre_tool_use', JSON.parse(process.argv[2]))",
  '  process.stdout.write(out, () => process.exit(0))',
  '})',
].join('\n')

type Entry = 'cli' | 'lib'

let root: string
let tgHome: string
let repo: string
let dataBase: string
let holderScript: string
const holders: ChildProcess[] = []
// Any wait of this many milliseconds or more on a hook connection is the long indexing budget, not the hook's.
const LONG_WAIT_MS = 1000
let trace: BusyTrace

function startHolder(dbPath: string, mode: 'exclusive' | 'immediate' | 'idle'): Promise<ChildProcess> {
  const child = spawn(process.execPath, [holderScript, dbPath, mode], { stdio: ['pipe', 'pipe', 'ignore'] })
  holders.push(child)
  return new Promise((resolve, reject) => {
    let seen = ''
    child.stdout!.on('data', (d: Buffer) => {
      seen += d.toString()
      if (seen.includes('READY')) resolve(child)
    })
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`lock holder exited before it was ready: ${seen}`)))
  })
}

interface HookRun { stdout: string; status: number | null; holderAliveAtExit: boolean }

/** Run the built one-shot hook asynchronously and resolve when it exits, recording whether the lock holder was still alive at that moment. */
function runHook(sessionId: string, file: string, holder: ChildProcess | null, entry: Entry = 'cli'): Promise<HookRun> {
  const payload = { session_id: sessionId, tool_name: 'Read', tool_input: { file_path: file }, cwd: repo }
  const args = entry === 'cli'
    ? [BUNDLE, 'hook', 'pre_tool_use']
    : ['-e', LIB_SCRIPT, path.join(path.dirname(BUNDLE), 'token-goat-hook.mjs'), JSON.stringify(payload)]
  const child = spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, ...trace.env, TOKEN_GOAT_HOME: tgHome, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase, TOKEN_GOAT_NO_WORKER_SPAWN: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  holders.push(child)
  let stdout = ''
  child.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
  child.stdin!.on('error', () => {})
  child.stdin!.end(entry === 'cli' ? JSON.stringify(payload) : '')
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status) => {
      resolve({ stdout, status, holderAliveAtExit: holder === null ? true : holder.exitCode === null && holder.signalCode === null })
    })
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hook-waits-'))
  tgHome = path.join(root, 'tg')
  repo = path.join(root, 'repo')
  dataBase = path.join(root, 'data')
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{\n  "compilerOptions": { "strict": true }\n}\n')
  fs.mkdirSync(dataBase, { recursive: true })
  holderScript = path.join(root, 'holder.cjs')
  fs.writeFileSync(holderScript, HOLDER_SOURCE)
  trace = busyTrace(root, { exitAtMs: LONG_WAIT_MS })
})

afterEach(() => {
  for (const child of holders.splice(0)) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort: a just-killed child can still hold a handle on Windows
  }
})

describe('the one-shot hook does not wait out another process\'s lock', () => {
  it.each([['cli', 'immediate'], ['cli', 'exclusive'], ['lib', 'immediate']] as const)('the %s entry completes with its normal decision while another process holds global.db under a %s lock', async (entry, mode) => {
    const tsconfig = path.join(repo, 'tsconfig.json')
    // Unlocked reference for the decision the locked run must reproduce; the same file read twice in one session also exercises the hint ledger writes.
    const first = await runHook('ref', tsconfig, null, entry)
    const reference = await runHook('ref', tsconfig, null, entry)
    expect(first.status).toBe(0)
    expect(reference.status).toBe(0)
    // The recorder is armed: the unlocked runs set at least one wait, and every one was short.
    expect(trace.seen().length).toBeGreaterThan(0)
    const dbPath = findGlobalDb(dataBase)
    expect(dbPath).not.toBeNull()

    const holder = await startHolder(dbPath!, mode)
    const lockedFirst = await runHook('locked', tsconfig, holder, entry)
    const lockedSecond = await runHook('locked', tsconfig, holder, entry)

    expect(lockedFirst.holderAliveAtExit).toBe(true)
    expect(lockedSecond.holderAliveAtExit).toBe(true)
    expect(lockedFirst.status).toBe(0)
    expect(lockedSecond.status).toBe(0)
    expect(lockedFirst.stdout).toBe(first.stdout)
    expect(lockedSecond.stdout).toBe(reference.stdout)
    expect(Math.max(...trace.seen())).toBeLessThan(LONG_WAIT_MS)
  })

  it('skips the session save instead of writing unlocked while another live process holds the session-file lock', async () => {
    const tsconfig = path.join(repo, 'tsconfig.json')
    const boot = await runHook('boot', tsconfig, null)
    expect(boot.status).toBe(0)
    const sessions = path.join(tgHome, 'sessions')
    expect(fs.existsSync(path.join(sessions, 'boot.json'))).toBe(true)

    const holder = await startHolder(findGlobalDb(dataBase)!, 'idle')
    // The lock file names the holder's pid; a live pid is what keeps withFileLock from stealing it.
    fs.writeFileSync(path.join(sessions, 'held.json.lock'), `${holder.pid}:1`)
    const run = await runHook('held', tsconfig, holder)

    expect(run.holderAliveAtExit).toBe(true)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(boot.stdout)
    expect(fs.existsSync(path.join(sessions, 'held.json'))).toBe(false)
  })
})
