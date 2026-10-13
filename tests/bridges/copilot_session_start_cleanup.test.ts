/** HAND-DERIVED: real child processes spawned by the test itself; nothing here is a captured wire format. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { alive, cleanupTrees, ownedPids, ownedRoots } from '../helpers/copilot_session_start_tree.js'

const LOOP = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'

function waitFor(path: string): number {
  const deadline = Date.now() + 20_000
  while (!existsSync(path) || readFileSync(path, 'utf8') === '') {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  return Number(readFileSync(path, 'utf8'))
}

it('kills a registered child that ignores SIGTERM and removes its folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-cleanup-row-'))
  ownedRoots.push(root)
  const child = spawn(process.execPath, ['-e', LOOP, join(root, 'registered')], { stdio: 'ignore', windowsHide: true })
  child.unref()
  const pid = child.pid as number
  ownedPids.push(pid)
  expect(alive(pid)).toBe(true)
  cleanupTrees()
  expect(alive(pid)).toBe(false)
  expect(existsSync(root)).toBe(false)
})

it('sweeps a detached grandchild that is not in the kill list, and spares a process outside the fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-cleanup-row-'))
  ownedRoots.push(root)
  const spawner = join(root, 'spawner.cjs')
  const grandPidFile = join(root, 'grand.txt')
  writeFileSync(spawner, [
    'const { spawn } = require("node:child_process")',
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(LOOP)}, ${JSON.stringify(join(root, 'orphan'))}], { detached: true, stdio: "ignore", windowsHide: true })`,
    'g.unref()',
    `require("node:fs").writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid))`,
  ].join('\n'))
  const parent = spawn(process.execPath, [spawner], { stdio: 'ignore', windowsHide: true })
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
