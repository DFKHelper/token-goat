/** Replacing the data-dir copy of tg-hook while a hook call is still running it. Windows refuses to overwrite or delete an executable image that is mapped by a live process (measured: a plain overwrite of a running tg-hook.exe fails with EBUSY, so an install during any hook call left the old binary wired), but it does allow renaming one, which is what syncNativeCopy relies on: the running copy is moved aside to `.<tag>.old` and the new one renamed into place, and the `.old` file is reclaimed by the next sync once nothing runs it. Provenance: HAND-DERIVED. The binary is the real one scripts/build-native.mjs builds; the replacement is that binary with bytes appended (an overlay both PE and ELF loaders ignore), written by this test, so the two differ and both still run. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { syncNativeCopy } from '../src/native_hook.js'
import { buildNative } from './helpers/native_bin.js'

const WIN = process.platform === 'win32'
let built: string
let root: string
let running: ChildProcess | undefined

beforeAll(() => {
  built = buildNative()
}, 600_000)

afterEach(async () => {
  if (running !== undefined && running.exitCode === null && running.signalCode === null) {
    const done = new Promise((resolve) => running!.once('close', resolve))
    running.kill()
    await done
  }
  running = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

/** Starts `bin` as a hook call that blocks reading stdin, so its image stays mapped until the test ends it. */
async function startBlocked(bin: string): Promise<ChildProcess> {
  const env = { ...process.env, TOKEN_GOAT_HOOK_SERVER: '0', LOCALAPPDATA: root, XDG_DATA_HOME: root, TOKEN_GOAT_HOME: root }
  const child = spawn(bin, ['--harness', 'claudecode', '--event', 'pre-tool-use', '--entry', path.join(root, 'none.mjs'), '--', process.execPath, path.join(root, 'none.cjs'), 'pre-tool-use'], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return child
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => /\.[0-9a-f]+\.(?:old|new)$/.test(n))
}

describe('syncNativeCopy', () => {
  it('replaces a copy that a hook call is running, and reclaims the old image once nothing runs it', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-copy-'))
    const dest = path.join(root, 'native', 'abc', path.basename(built))
    expect(syncNativeCopy(built, dest)).toBe(true)
    expect(fs.readFileSync(dest).equals(fs.readFileSync(built))).toBe(true)

    running = await startBlocked(dest)
    const next = path.join(root, `next-${path.basename(built)}`)
    fs.writeFileSync(next, Buffer.concat([fs.readFileSync(built), Buffer.from('tg-native-copy-overlay')]))

    expect(syncNativeCopy(next, dest)).toBe(true)
    expect(fs.readFileSync(dest).equals(fs.readFileSync(next))).toBe(true)
    // The replacement is a working binary, and the call that was running when it landed is still running.
    expect(spawnSync(dest, ['--selftest'], { windowsHide: true }).status).toBe(0)
    expect(running.exitCode).toBeNull()
    // On Windows the running image could only be moved aside; elsewhere the rename replaced it outright.
    const aside = leftovers(path.dirname(dest))
    expect(aside.length).toBe(WIN ? 1 : 0)

    const done = new Promise((resolve) => running!.once('close', resolve))
    running.kill()
    await done
    // Another sync (content differs again) reclaims the image the finished call left behind. It may leave one of its own when a scanner still holds the binary the self-test just ran, which the sync after it reclaims in turn, so this checks the earlier name rather than an empty directory.
    fs.appendFileSync(next, 'again')
    expect(syncNativeCopy(next, dest)).toBe(true)
    expect(fs.readFileSync(dest).equals(fs.readFileSync(next))).toBe(true)
    const after = leftovers(path.dirname(dest))
    expect(after.filter((n) => aside.includes(n))).toEqual([])
    expect(after.length).toBeLessThanOrEqual(1)
  }, 120_000)
})
