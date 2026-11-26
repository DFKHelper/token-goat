// HAND-DERIVED: expectations follow from kill(2) (ESRCH is no such pid, EPERM is a pid that cannot be signalled), proc(5) (stat is `pid (comm) state ...`, Z and X are dead) and ps(1) (`-o stat=` prints one state column, empty when the pid is not listed), not from processAlive's own branches.
import { describe, expect, it } from 'vitest'

import { processAlive, processAliveWith, type AliveSeam } from './helpers/process_alive.js'

type Signal = 'ok' | 'ESRCH' | 'EPERM'
type Stat = { text: string } | { code: 'ENOENT' | 'EACCES' }
type Ps = { text: string } | { code: 'ENOENT' }

interface Row {
  name: string
  /** Defaults to linux. */
  platform?: NodeJS.Platform
  /** The outcome of each kill(pid, 0) call, in order. */
  signals: Signal[]
  /** Defaults to a running state S. */
  stat?: Stat
  /** Defaults to a listed state S. */
  ps?: Ps
  expected: boolean
  /** How many kill(pid, 0) calls the branch makes; a silent extra or missing probe changes the result, so the count is pinned too. */
  probes: number
  /** How many ps calls the branch makes; defaults to none. */
  psProbes?: number
}

const RUNNING: Stat = { text: '42 (sleeper) S 1 0 0' }
const LISTED_S: Ps = { text: 'S\n' }

function fakeSeam(platform: NodeJS.Platform, signals: Signal[], stat: Stat, ps: Ps): AliveSeam & { signalCalls: () => number; psCalls: () => number } {
  let signalN = 0
  let psN = 0
  return {
    platform,
    signal0(pid) {
      const outcome = signals[signalN++]
      if (outcome === undefined) throw new Error(`unexpected kill(${pid}, 0) probe ${signalN}`)
      if (outcome !== 'ok') throw Object.assign(new Error(outcome), { code: outcome })
    },
    readStat() {
      if ('text' in stat) return stat.text
      throw Object.assign(new Error(stat.code), { code: stat.code })
    },
    ps() {
      psN++
      if ('text' in ps) return ps.text
      throw Object.assign(new Error(ps.code), { code: ps.code })
    },
    signalCalls: () => signalN,
    psCalls: () => psN,
  }
}

const rows: Row[] = [
  // HAND-DERIVED: kill(2) ESRCH means no such pid, reported before any /proc read.
  { name: 'kill reports no such process before /proc is read', signals: ['ESRCH'], expected: false, probes: 1 },
  // HAND-DERIVED: kill(2) EPERM means the pid exists and cannot be signalled, so it is alive.
  { name: 'kill reports EPERM for a pid it cannot signal', signals: ['EPERM'], expected: true, probes: 1 },
  // HAND-DERIVED: proc(5) state S is a running process.
  { name: 'a running state S reads alive', signals: ['ok'], stat: { text: '42 (sleeper) S 1 0 0' }, expected: true, probes: 1 },
  // HAND-DERIVED: proc(5) state Z is a zombie, which is dead.
  { name: 'a zombie state Z reads dead', signals: ['ok'], stat: { text: '42 (sleeper) Z 1 0 0' }, expected: false, probes: 1 },
  // HAND-DERIVED: proc(5) state X is dead.
  { name: 'a dead state X reads dead', signals: ['ok'], stat: { text: '42 (sleeper) X 1 0 0' }, expected: false, probes: 1 },
  // HAND-DERIVED: proc(5) comm may hold parentheses, so the state is the field after the last one.
  { name: 'parentheses inside comm do not move the state', signals: ['ok'], stat: { text: '42 (a) Z (b) S 1 0 0' }, expected: true, probes: 1 },
  // HAND-DERIVED: a stat error other than ENOENT is not re-probed; the pid is read alive.
  { name: 'a stat read error other than ENOENT reads alive without re-probing', signals: ['ok', 'ESRCH'], stat: { code: 'EACCES' }, expected: true, probes: 1 },
  // HAND-DERIVED: ENOENT from /proc with kill(2) still succeeding reads alive.
  { name: 'ENOENT with a successful re-probe reads alive', signals: ['ok', 'ok'], stat: { code: 'ENOENT' }, expected: true, probes: 2 },
  // HAND-DERIVED: kill(2) EPERM on the re-probe still means the pid exists.
  { name: 'ENOENT with a re-probe reporting EPERM reads alive', signals: ['ok', 'EPERM'], stat: { code: 'ENOENT' }, expected: true, probes: 2 },
  // HAND-DERIVED: kill(2) ESRCH on the re-probe means no such pid, so gone.
  { name: 'ENOENT with a re-probe reporting ESRCH reads gone', signals: ['ok', 'ESRCH'], stat: { code: 'ENOENT' }, expected: false, probes: 2 },
  // HAND-DERIVED: ps -o stat= lists a running pid with a state column, so alive; ps is not reached on linux.
  { name: 'ps lists the pid in state S and reads alive', platform: 'darwin', signals: ['ok'], ps: { text: '  S\n' }, expected: true, probes: 1, psProbes: 1 },
  // HAND-DERIVED: ps state Z+ is a zombie, so dead.
  { name: 'ps lists the pid in state Z+ and reads dead', platform: 'darwin', signals: ['ok'], ps: { text: 'Z+\n' }, expected: false, probes: 1, psProbes: 1 },
  // HAND-DERIVED: ps prints nothing for a pid it does not list, so gone.
  { name: 'ps lists nothing for the pid and reads gone', platform: 'darwin', signals: ['ok'], ps: { text: '' }, expected: false, probes: 1, psProbes: 1 },
  // HAND-DERIVED: a ps that cannot run leaves the state unknown, and an unknown state reads alive.
  { name: 'ps that cannot run reads alive, failing closed', platform: 'darwin', signals: ['ok'], ps: { code: 'ENOENT' }, expected: true, probes: 1, psProbes: 1 },
  // HAND-DERIVED: win32 returns alive on a successful kill and never calls ps; the Z state would read dead if ps were called.
  { name: 'win32 reads alive on a successful kill without calling ps', platform: 'win32', signals: ['ok'], ps: { text: 'Z\n' }, expected: true, probes: 1, psProbes: 0 },
  // HAND-DERIVED: win32 kill(2) ESRCH means no such pid, reported before the platform branch.
  { name: 'win32 kill reports no such process and reads gone', platform: 'win32', signals: ['ESRCH'], expected: false, probes: 1, psProbes: 0 },
]

describe('processAlive, one row per probe branch', () => {
  it.each(rows)('$name', (row) => {
    const seam = fakeSeam(row.platform ?? 'linux', row.signals, row.stat ?? RUNNING, row.ps ?? LISTED_S)
    expect(processAliveWith(42, seam), `${row.name}: the reading`).toBe(row.expected)
    expect(seam.signalCalls(), `${row.name}: kill(pid, 0) probes made`).toBe(row.probes)
    expect(seam.psCalls(), `${row.name}: ps probes made`).toBe(row.psProbes ?? 0)
  })

  it('the default seam reads the running test process alive', () => {
    expect(processAlive(process.pid), 'the test process is running, so the shipping default must read it alive').toBe(true)
  })
})
