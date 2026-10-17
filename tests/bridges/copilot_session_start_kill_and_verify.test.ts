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
