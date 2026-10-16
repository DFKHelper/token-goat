// The freeze walk lists the tree and stops what is new, pass after pass, until a pass finds nothing new or the cap is reached, and only then kills. Everything here is scripted: `ps` is a function of the pass number and `process.kill` is a spy, so no real process is signalled and no clock is read. Provenance: HAND-DERIVED. The tables are small trees written down by hand in the `pid ppid` format `ps -A -o pid=,ppid=` prints (procps and BSD ps both accept it), and the expected stops and kills follow from the rule (stop everything, kill after the last stop), not from the implementation's loop.
import type * as ChildProcessModule from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

// The ps output for the n-th listing (1-based); each test installs its own script.
const script = vi.hoisted(() => ({ table: (_pass: number): string => '', lists: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const scripted = ((file: string) => {
    if (file !== 'ps') throw new Error(`unexpected helper ${file}`)
    script.lists += 1
    return { status: 0, stdout: script.table(script.lists), stderr: '', pid: 0, output: [], signal: null }
  }) as unknown as typeof real.spawnSync
  return { ...real, spawnSync: scripted }
})

const { killProcessTree } = await import('../src/process_tree.js')

const ROOT = 4000
const FIRST_DESCENDANT = 4001

afterEach(() => {
  vi.restoreAllMocks()
  script.lists = 0
  script.table = () => ''
})

/** Every signal sent, as `pid SIGNAL`, in order. */
function recordSignals(): string[] {
  const sent: string[] = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    sent.push(`${pid} ${String(signal)}`)
    return true
  }) as typeof process.kill)
  return sent
}

describe.skipIf(process.platform === 'win32')('the freeze walk repeats until the tree stops growing', () => {
  it('stops a member that only appears in a later pass, before anything is killed', () => {
    // The root has one child at first; that child gains a child of its own by the second listing; the third listing shows nothing new.
    script.table = (pass) => (pass === 1 ? `${ROOT} 1\n${FIRST_DESCENDANT} ${ROOT}\n` : `${ROOT} 1\n${FIRST_DESCENDANT} ${ROOT}\n${FIRST_DESCENDANT + 1} ${FIRST_DESCENDANT}\n`)
    const sent = recordSignals()
    const result = killProcessTree(ROOT)
    expect(result).toEqual({ ok: true })
    expect(script.lists, 'the walk stopped listing before a pass found nothing new').toBe(3)
    expect(sent.slice(0, 3)).toEqual([`${ROOT} SIGSTOP`, `${FIRST_DESCENDANT} SIGSTOP`, `${FIRST_DESCENDANT + 1} SIGSTOP`])
    expect(sent.slice(3).sort()).toEqual([`${ROOT} SIGKILL`, `${FIRST_DESCENDANT} SIGKILL`, `${FIRST_DESCENDANT + 1} SIGKILL`].sort())
  })

  it('gives up after 64 passes of a tree that never stops growing, and still kills every member it stopped', () => {
    // Each listing shows one more generation than the last, so every pass finds exactly one new member.
    script.table = (pass) => {
      const rows = [`${ROOT} 1`]
      for (let n = 0; n < pass; n++) rows.push(`${FIRST_DESCENDANT + n} ${n === 0 ? ROOT : FIRST_DESCENDANT + n - 1}`)
      return rows.join('\n') + '\n'
    }
    const sent = recordSignals()
    const result = killProcessTree(ROOT)
    expect(script.lists, 'the pass cap moved').toBe(64)
    expect(result.ok).toBe(false)
    expect(result.note).toMatch(/still growing after 64 passes/)
    const stopped = sent.filter((s) => s.endsWith('SIGSTOP')).map((s) => s.split(' ')[0])
    const killed = sent.filter((s) => s.endsWith('SIGKILL')).map((s) => s.split(' ')[0])
    expect(stopped).toHaveLength(65)
    expect(killed.sort()).toEqual([...stopped].sort())
    expect(sent.findIndex((s) => s.endsWith('SIGKILL')), 'a kill came before the last stop').toBe(65)
  })
})
