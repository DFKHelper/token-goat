/** HAND-DERIVED: real child processes spawned by the test itself; nothing here is a captured wire format. */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { alive, cleanupTrees, ownedPids, ownedRoots } from '../helpers/copilot_session_start_tree.js'

const spawners: ChildProcess[] = []
afterEach(() => { for (const child of spawners.splice(0)) child.kill('SIGKILL') }, 0)
afterEach(cleanupTrees, 0)

// The folders the fixtures watch; removed after each test so a fixture that outlived its test ends on its own.
const lifelines: string[] = []
afterEach(() => { for (const dir of lifelines.splice(0)) rmSync(dir, { recursive: true, force: true }) }, 0)

function lifeline(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cleanup-life-'))
  lifelines.push(dir)
  return dir
}

// The fixture ignores SIGTERM, which is what the cleanup under test must cope with, so its own death condition is the only thing that ends it when the test's cleanup never runs: argv[2] is a folder and argv[3] a pid, and it exits within a quarter second of the folder being gone or that process being gone. The poll is the fixture's own, not the test's.
const LOOP = 'process.on("SIGTERM",()=>{});const fs=require("node:fs");const gone=()=>{if(!fs.existsSync(process.argv[2]))return true;try{process.kill(Number(process.argv[3]),0);return false}catch(e){return e.code==="ESRCH"}};setInterval(()=>{if(gone())process.exit(0)},250)'

function waitFor(path: string): number {
  const deadline = Date.now() + 20_000
  while (!existsSync(path) || readFileSync(path, 'utf8') === '') {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  return Number(readFileSync(path, 'utf8'))
}

/** Writes a script that starts a detached SIGTERM-ignoring node process marked by `orphan`, records its pid in grand.txt and exits, so that process is no child of the test. */
function writeSpawner(root: string, orphan: string): { spawner: string; grandPidFile: string } {
  const spawner = join(root, 'spawner.cjs')
  const grandPidFile = join(root, 'grand.txt')
  writeFileSync(spawner, [
    'const { spawn } = require("node:child_process")',
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(LOOP)}, ${JSON.stringify(join(root, orphan))}, ${JSON.stringify(lifeline())}, ${JSON.stringify(String(process.pid))}], { detached: true, stdio: "ignore", windowsHide: true })`,
    'g.unref()',
    `require("node:fs").writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid))`,
  ].join('\n'))
  return { spawner, grandPidFile }
}

// The registered process must not be a direct child of the test. cleanupTrees blocks this thread, so Node cannot reap a killed direct child; it stays a zombie, and kill(pid, 0) calls a zombie alive for the whole wait. An orphan is reaped by init. The orphan's args carry join(root, 'registered'), so the root-marker sweep in cleanupTrees would also kill it: this test pins that the process dies and the folder goes, not that the kill list alone did it.
it('kills a registered child that ignores SIGTERM and removes its folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-cleanup-row-'))
  ownedRoots.push(root)
  const { spawner, grandPidFile } = writeSpawner(root, 'registered')
  const parent = spawn(process.execPath, [spawner], { stdio: 'ignore', windowsHide: true })
  spawners.push(parent)
  // The spawner has exited once it closes, so the kernel has already handed its child to init.
  await new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('close', () => resolve()) })
  const pid = waitFor(grandPidFile)
  ownedPids.push(pid)
  expect(alive(pid)).toBe(true)
  cleanupTrees()
  expect(alive(pid)).toBe(false)
  expect(existsSync(root)).toBe(false)
})

it('sweeps a detached grandchild that is not in the kill list, and spares a process outside the fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-cleanup-row-'))
  ownedRoots.push(root)
  const { spawner, grandPidFile } = writeSpawner(root, 'orphan')
  const parent = spawn(process.execPath, [spawner], { stdio: 'ignore', windowsHide: true })
  spawners.push(parent)
  const grandchild = waitFor(grandPidFile)
  const bystander = spawn(process.execPath, ['-e', LOOP, 'tg-cleanup-bystander', lifeline(), String(process.pid)], { stdio: 'ignore', windowsHide: true })
  const bystanderPid = bystander.pid as number
  try {
    expect(parent.pid).toBeGreaterThan(0)
    expect(alive(grandchild)).toBe(true)
    cleanupTrees()
    expect(alive(grandchild)).toBe(false)
    expect(alive(bystanderPid)).toBe(true)
    expect(existsSync(root)).toBe(false)
  } finally {
    bystander.kill('SIGKILL')
  }
})

// HAND-DERIVED: a root that does not exist makes the pid-file recovery phase throw ENOENT; the orphan and the second folder are real, so the later sweep and delete phases have something to do.
it('still sweeps the orphans and removes the folders when an earlier phase throws', () => {
  const missing = join(tmpdir(), `tg-cleanup-missing-${String(process.pid)}-${String(Date.now())}`)
  const root = mkdtempSync(join(tmpdir(), 'tg-cleanup-row-'))
  ownedRoots.push(missing, root)
  const { spawner, grandPidFile } = writeSpawner(root, 'orphan')
  const parent = spawn(process.execPath, [spawner], { stdio: 'ignore', windowsHide: true })
  spawners.push(parent)
  const grandchild = waitFor(grandPidFile)
  expect(alive(grandchild)).toBe(true)
  expect(() => { cleanupTrees() }).toThrow(/ENOENT/)
  expect(alive(grandchild)).toBe(false)
  expect(existsSync(root)).toBe(false)
})

// HAND-DERIVED: the fixture is the real LOOP script run as a direct child, and the wait is its own 'exit' event. Without the death condition it never exits and the row waits for the test timeout.
describe('the SIGTERM-ignoring fixture ends without the test cleanup running', () => {
  it.each(['its folder is removed', 'its owner process is gone'])('exits once %s', async (when) => {
    const folder = lifeline()
    // owner: this test; dies on its own after 60 s, and afterEach ends it through its handle sooner.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    spawners.push(owner)
    await new Promise<void>((resolve, reject) => { owner.once('error', reject); owner.once('spawn', () => resolve()) })
    // owner: this test; dies on its own once its folder or owner is gone, and afterEach ends it through its handle sooner.
    const fixture = spawn(process.execPath, ['-e', LOOP, 'tg-cleanup-row-death', folder, String(owner.pid)], { stdio: 'ignore', windowsHide: true })
    spawners.push(fixture)
    await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.once('spawn', () => resolve()) })
    const exited = new Promise<void>((resolve) => { fixture.once('exit', () => resolve()) })
    expect(fixture.exitCode, 'the fixture runs while its folder and owner exist').toBeNull()
    if (when === 'its folder is removed') {
      rmSync(folder, { recursive: true, force: true })
    } else {
      owner.kill('SIGKILL')
    }
    await exited
    expect(fixture.exitCode, 'the fixture ended itself').toBe(0)
  })
})
