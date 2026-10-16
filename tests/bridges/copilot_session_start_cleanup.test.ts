/** HAND-DERIVED: real child processes spawned by the test itself; nothing here is a captured wire format. */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { alive, cleanupTrees, ownedPids, ownedRoots } from '../helpers/copilot_session_start_tree.js'

const spawners: ChildProcess[] = []
afterEach(() => { for (const child of spawners.splice(0)) child.kill('SIGKILL') }, 0)
afterEach(cleanupTrees, 0)

const LOOP = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'

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
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(LOOP)}, ${JSON.stringify(join(root, orphan))}], { detached: true, stdio: "ignore", windowsHide: true })`,
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
  const bystander = spawn(process.execPath, ['-e', LOOP, 'tg-cleanup-bystander'], { stdio: 'ignore', windowsHide: true })
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
