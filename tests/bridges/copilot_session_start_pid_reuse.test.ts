/** Provenance: HAND-DERIVED. The recycled pid is forced with a live process of a different command line standing on the recorded number, which is what a reused pid looks like to a reader of that number; the reuse rate itself (36 of 300 sequential spawns on Windows) is the coordinator's measurement and is not asserted here. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

import { readProcessCommandLine } from '../../src/resident_process.js'
import { alive, aliveAs } from '../helpers/copilot_session_start_tree.js'

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

function sleeper(tag: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)', tag], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

/** The child's command line as the query reads it; a null here would mean the query cannot see a running process, which fails the test rather than passing it. */
function lineOf(child: ChildProcess): string {
  const pid = child.pid ?? 0
  const line = readProcessCommandLine(pid)
  expect(line, `command line of ${pid}`).not.toBeNull()
  return line ?? ''
}

it('reads a live process as the process it was recorded as, and nothing else', () => {
  const recorded = sleeper('recorded-owner')
  const stranger = sleeper('stranger-that-took-the-number')
  const ownerLine = lineOf(recorded)
  const strangerLine = lineOf(stranger)
  expect(ownerLine).not.toBe(strangerLine)
  expect(aliveAs(recorded.pid ?? 0, ownerLine)).toBe(true)
  // The recorded owner is gone and a stranger stands on its number: the bare probe still says alive, which is the false "survived teardown".
  expect(alive(stranger.pid ?? 0)).toBe(true)
  expect(aliveAs(stranger.pid ?? 0, ownerLine)).toBe(false)
  expect(aliveAs(stranger.pid ?? 0, strangerLine)).toBe(true)
})

it('reads an owner that was never recorded alive, or has exited, as gone', async () => {
  const owner = sleeper('exits-first')
  const pid = owner.pid ?? 0
  const line = lineOf(owner)
  const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()))
  owner.kill('SIGKILL')
  await exited
  expect(aliveAs(pid, line)).toBe(false)
  expect(aliveAs(pid, null)).toBe(false)
})
