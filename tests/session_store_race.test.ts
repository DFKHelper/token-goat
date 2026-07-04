/**
 * Regression test for the session-store read-modify-write race (task #15).
 *
 * Every hook call is a fresh OS process, and saveSessionState() does read-disk -> merge ->
 * atomic-write with no lock or compare-and-swap around the read-merge-write sequence. Two
 * concurrent processes for the same session_id could each read the pre-update disk state,
 * merge it with their own view, and write -- whichever write landed last silently clobbered
 * the other's update, with no error.
 *
 * This spawns two real `tsx` child processes (genuine OS-level concurrency, not simulated
 * interleaving) that each hammer a tight load -> recordFileRead -> save loop against the
 * SAME session file, then asserts every entry from both sides survived on disk.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ROOT } from './helpers/bundle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'fixtures', 'session_race_worker.ts')
// Spawn tsx's own CLI entry via `node`, not the node_modules/.bin/tsx(.cmd) shim -- the
// shim is a shell script / batch file on POSIX/Windows respectively, and Node's spawn()
// cannot exec those directly without shell:true.
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-race-'))
})

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** Spawn one race worker process; resolves on a clean exit, rejects otherwise. */
function runWorker(sessionId: string, prefix: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, WORKER, sessionId, prefix, String(count)], {
      cwd: ROOT,
      env: { ...process.env, TOKEN_GOAT_HOME: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`race worker '${prefix}' exited with code ${code}: ${stderr}`))
    })
  })
}

describe('concurrent saveSessionState across real OS processes', () => {
  it('loses no entries when two processes race to save the same session (task #15)', async () => {
    const sessionId = 'race-1'
    const count = 120

    // Both workers start together and race for real -- nothing here synchronizes their
    // internal load/merge/write steps against each other. That absence of coordination is
    // exactly the production scenario: two hook subprocesses for the same session_id.
    await Promise.all([runWorker(sessionId, 'A', count), runWorker(sessionId, 'B', count)])

    const sessionFile = path.join(tmpHome, 'sessions', `${sessionId}.json`)
    expect(fs.existsSync(sessionFile)).toBe(true)
    const disk = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { files: Array<{ path: string }> }
    const paths = new Set(disk.files.map((f) => f.path))

    const missing: string[] = []
    for (const prefix of ['A', 'B']) {
      for (let i = 0; i < count; i++) {
        const expected = `/race/${prefix}-${i}.ts`
        if (!paths.has(expected)) missing.push(expected)
      }
    }
    expect(missing).toEqual([])
  }, 30_000)
})
