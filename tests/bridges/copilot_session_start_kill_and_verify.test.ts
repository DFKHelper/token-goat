/** Provenance: HAND-DERIVED. The process table is a fake map of pid to the command line the query would read (null: the query fails on a running process, the way readProcessCommandLine does on a spawn error, a nonzero exit, a timeout or empty output); no real process is signalled, so each case is deterministic and carries no wait. */
import { expect, it } from 'vitest'

import { aliveAs, killAndVerify, type KillSeam } from '../helpers/copilot_session_start_tree.js'

/** A fake process table: `kills` lists every pid a signal reached, and a signalled process leaves the table. */
function world(table: Record<number, string | null>): { seam: KillSeam; kills: number[] } {
  const live = new Map<number, string | null>(Object.entries(table).map(([pid, line]) => [Number(pid), line]))
  const kills: number[] = []
  const readLine = (pid: number): string | null => live.get(pid) ?? null
  const seam: KillSeam = {
    alive: (pid) => live.has(pid),
    readLine,
    killIfCommandLine: (pid, isOurs) => {
      const line = readLine(pid)
      if (line === null || !isOurs(line)) return false
      kills.push(pid)
      live.delete(pid)
      return true
    },
    backstopMs: 0,
  }
  return { seam, kills }
}

it('ends a victim that is still the process it was recorded as, and reports nothing', () => {
  const { seam, kills } = world({ 11: 'node ours.js' })
  expect(() => { killAndVerify(new Map([[11, 'node ours.js']]), seam) }).not.toThrow()
  expect(kills).toEqual([11])
})

it('neither signals nor reports a stranger that took the recorded number', () => {
  const { seam, kills } = world({ 10: 'node stranger.js' })
  expect(() => { killAndVerify(new Map([[10, 'node ours.js']]), seam) }).not.toThrow()
  expect(kills).toEqual([])
})

it('reports a running victim whose command line cannot be read, without signalling it', () => {
  const { seam, kills } = world({ 12: null })
  expect(() => { killAndVerify(new Map([[12, 'node ours.js']]), seam) }).toThrow(/12 node ours\.js/)
  expect(kills).toEqual([])
})

it('reports a live victim recorded with an empty command line, without signalling it', () => {
  const { seam, kills } = world({ 13: 'node whatever.js' })
  expect(() => { killAndVerify(new Map([[13, '']]), seam) }).toThrow(/13 /)
  expect(kills).toEqual([])
})

it('reads a victim that is gone as gone whatever its recorded line', () => {
  const { seam, kills } = world({})
  expect(() => { killAndVerify(new Map([[14, ''], [15, 'node ours.js']]), seam) }).not.toThrow()
  expect(kills).toEqual([])
})

it('counts a live pid as ours when its line cannot be read or was never recorded, and a gone pid as gone', () => {
  const { seam } = world({ 20: null, 21: 'node ours.js', 22: 'node stranger.js' })
  expect(aliveAs(20, 'node ours.js', seam)).toBe(true)
  expect(aliveAs(21, null, seam)).toBe(true)
  expect(aliveAs(22, 'node ours.js', seam)).toBe(false)
  expect(aliveAs(23, 'node ours.js', seam)).toBe(false)
  expect(aliveAs(23, null, seam)).toBe(false)
})

it('re-issues a kill that left the victim alive, and reports nothing once the second call removes it', () => {
  // The first call fails the way a Windows kill on an exiting process does (nothing signalled, pid still there); the backstop is an upper bound the fake never reaches, so no assertion depends on elapsed time.
  const { seam } = world({ 16: 'node ours.js' })
  const calls: number[] = []
  const inner = seam.killIfCommandLine
  seam.killIfCommandLine = (pid, isOurs) => {
    calls.push(pid)
    return calls.length === 1 ? false : (inner?.(pid, isOurs) ?? false)
  }
  seam.backstopMs = 60_000
  expect(() => { killAndVerify(new Map([[16, 'node ours.js']]), seam) }).not.toThrow()
  expect(calls).toEqual([16, 16])
})

// HAND-DERIVED: the fake checked kill throws the way killIfCommandLine does for a live pid whose command line cannot be read (tests/helpers/kill_if_command_line.ts::killIfCommandLine); nothing is signalled for real.
it('signals the other victims when the checked kill cannot decide one, and carries that failure on the survivor error', () => {
  const { seam, kills } = world({ 30: 'node ours.js', 31: 'node ours.js' })
  const inner = seam.killIfCommandLine
  seam.killIfCommandLine = (pid, isOurs) => {
    if (pid === 30) throw new Error('pid 30: its command line could not be read')
    return inner?.(pid, isOurs) ?? false
  }
  let caught: unknown
  try { killAndVerify(new Map([[30, 'node ours.js'], [31, 'node ours.js']]), seam) } catch (error) { caught = error }
  expect((caught as Error).message).toMatch(/30 node ours\.js/)
  expect(((caught as Error).cause as Error).message).toMatch(/pid 30/)
  expect(kills).toEqual([31])
})

it('asks again after the checked kill could not decide, and reports nothing once a later call ends the victim', () => {
  const { seam, kills } = world({ 32: 'node ours.js' })
  const inner = seam.killIfCommandLine
  let calls = 0
  seam.killIfCommandLine = (pid, isOurs) => {
    calls++
    if (calls === 1) throw new Error('pid 32: its command line could not be read')
    return inner?.(pid, isOurs) ?? false
  }
  seam.backstopMs = 60_000
  expect(() => { killAndVerify(new Map([[32, 'node ours.js']]), seam) }).not.toThrow()
  expect(kills).toEqual([32])
})

// HAND-DERIVED: review 3 of this branch. The fake checked kill throws the way killIfCommandLine does for a live pid whose command line cannot be read (tests/helpers/kill_if_command_line.ts::killIfCommandLine); a pid that throws and leaves the table exited while its line was being read. One round only (backstopMs 0), so nothing waits.
function exitingAfterFailure(seam: KillSeam, failing: ReadonlyMap<number, boolean>): void {
  const inner = seam.killIfCommandLine
  const live = seam.alive
  const gone = new Set<number>()
  seam.alive = (pid) => !gone.has(pid) && (live?.(pid) ?? false)
  seam.killIfCommandLine = (pid, isOurs) => {
    const exits = failing.get(pid)
    if (exits === undefined) return inner?.(pid, isOurs) ?? false
    if (exits) gone.add(pid)
    throw new Error(`pid ${pid}: its command line could not be read`)
  }
}

it('puts on the survivor error the failure of the pid that survives, not one of a pid that is gone', () => {
  const { seam } = world({ 40: 'node ours.js', 41: 'node ours.js' })
  exitingAfterFailure(seam, new Map([[40, true], [41, false]]))
  let caught: unknown
  try { killAndVerify(new Map([[40, 'node ours.js'], [41, 'node ours.js']]), seam) } catch (error) { caught = error }
  expect((caught as Error).message).toMatch(/41 node ours\.js/)
  expect((caught as Error).message).not.toMatch(/40 node ours\.js/)
  expect(((caught as Error).cause as Error).message).toMatch(/pid 41/)
})

it('attaches no cause to the survivor error when the only failure was for a pid that is gone', () => {
  const { seam } = world({ 42: 'node ours.js', 43: 'node ours.js' })
  exitingAfterFailure(seam, new Map([[42, true]]))
  seam.killIfCommandLine = ((inner) => (pid, isOurs) => (pid === 43 ? false : inner(pid, isOurs)))(seam.killIfCommandLine as NonNullable<KillSeam['killIfCommandLine']>)
  let caught: unknown
  try { killAndVerify(new Map([[42, 'node ours.js'], [43, 'node ours.js']]), seam) } catch (error) { caught = error }
  expect((caught as Error).message).toMatch(/43 node ours\.js/)
  expect((caught as Error).cause).toBeUndefined()
})
