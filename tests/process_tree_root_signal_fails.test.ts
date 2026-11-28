// A root that refuses a signal (EPERM) is still running, so ending its tree must report a failure and let the caller fall back to its handle; a root that is already gone (ESRCH) is not a failure. Everything is scripted: `ps` answers a fixed table and `process.kill` is a stand-in that throws the errno under test, so no real process is signalled. The platform is set to linux for the test so the POSIX walk runs on every host. Provenance: FORMAT-DERIVED for the errnos, from kill(2) on Linux and macOS (man7.org/linux/man-pages/man2/kill.2.html: EPERM "the calling process does not have permission to send the signal", ESRCH "the target process or process group does not exist") and Node's documentation of process.kill, which throws on both; HAND-DERIVED for the rule (EPERM on the root is a failure, ESRCH is not).
import type * as ChildProcessModule from 'node:child_process'
import type { TreeEndSeam } from '../src/process_tree.js'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const scripted = ((file: string) => {
    if (file !== 'ps') throw new Error(`unexpected helper ${file}`)
    return { status: 0, stdout: `${ROOT_PID} 1\n${CHILD_PID} ${ROOT_PID}\n`, stderr: '', pid: 0, output: [], signal: null }
  }) as unknown as typeof real.spawnSync
  return { ...real, spawnSync: scripted }
})

const { killProcessTree } = await import('../src/process_tree.js')

const ROOT_PID = 4000
const CHILD_PID = 4001
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', realPlatform)
})

/** The one call that ends ROOT_PID, with the tree end's probes injected; ROOT_PID is a stand-in, see killRootRefusing. */
function endRoot(seam: TreeEndSeam = {}): ReturnType<typeof killProcessTree> {
  return killProcessTree(ROOT_PID, seam)
}

/** Runs the POSIX walk with `process.kill` throwing `code` for the root only (for `onlySignal` alone when given), and returns the result with every signal sent as `pid SIGNAL`. */
function killRootRefusing(code: string, onlySignal?: string): { result: ReturnType<typeof killProcessTree>; sent: string[] } {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' })
  const sent: string[] = []
  const dead = new Set<number>()
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    sent.push(`${pid} ${String(signal)}`)
    if (signal === 0 && dead.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    if (pid === ROOT_PID && (onlySignal === undefined || signal === onlySignal)) throw Object.assign(new Error(`kill ${code}`), { code })
    if (signal === 'SIGKILL') dead.add(pid)
    return true
  }) as typeof process.kill)
  const result = endRoot({ pause: () => {} })
  return { result, sent }
}

describe('a root that refuses a signal', () => {
  it('EPERM is a failed kill that names the errno, so the caller ends the root through its handle', () => {
    const { result } = killRootRefusing('EPERM')
    expect(result.ok, 'a root that refused the signal was read as ended').toBe(false)
    expect(result.note).toContain('EPERM')
    expect(result.note).toContain(String(ROOT_PID))
    expect(result.gone, 'a refusing root is alive, not gone').toBeUndefined()
  })

  it('EPERM on the root does not stop the descendants from being stopped and killed', () => {
    const { sent } = killRootRefusing('EPERM')
    expect(sent).toContain(`${CHILD_PID} SIGSTOP`)
    expect(sent).toContain(`${CHILD_PID} SIGKILL`)
  })

  it('refusing only the stop is not a failure when the kill lands, since the root is ended', () => {
    const { result, sent } = killRootRefusing('EPERM', 'SIGSTOP')
    expect(sent).toContain(`${ROOT_PID} SIGKILL`)
    expect(result, 'a root that took the final kill was reported as a failed kill').toEqual({ ok: true })
  })

  it('ESRCH (already gone) stays quiet', () => {
    expect(killRootRefusing('ESRCH').result).toEqual({ ok: true })
  })
})

describe('a tree end that waits for its members', () => {
  it('resolves only once the root is seen gone, and names the pid it never sees gone', () => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' })
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    let rootChecks = 0
    const aliveForChecks = 3
    const late = endRoot({ isGone: (pid) => pid !== ROOT_PID || ++rootChecks > aliveForChecks, pause: () => {} })
    expect(rootChecks, 'the tree end returned before the root was seen gone').toBeGreaterThan(aliveForChecks)
    expect(late, 'a root seen gone in time was reported as a failure').toEqual({ ok: true })
    const stuck = endRoot({ isGone: (pid) => pid !== ROOT_PID, pause: () => {} })
    expect(stuck.ok, 'a root never seen gone was reported as ended').toBe(false)
    expect(stuck.note, 'the survivor was not named').toContain(String(ROOT_PID))
  })
})
