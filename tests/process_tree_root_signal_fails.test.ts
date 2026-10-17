// A root that refuses a signal (EPERM) is still running, so ending its tree must report a failure and let the caller fall back to its handle; a root that is already gone (ESRCH) is not a failure. Everything is scripted: `ps` answers a fixed table and `process.kill` is a stand-in that throws the errno under test, so no real process is signalled. The platform is set to linux for the test so the POSIX walk runs on every host. Provenance: FORMAT-DERIVED for the errnos, from kill(2) on Linux and macOS (man7.org/linux/man-pages/man2/kill.2.html: EPERM "the calling process does not have permission to send the signal", ESRCH "the target process or process group does not exist") and Node's documentation of process.kill, which throws on both; HAND-DERIVED for the rule (EPERM on the root is a failure, ESRCH is not).
import type * as ChildProcessModule from 'node:child_process'

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

/** Runs the POSIX walk with `process.kill` throwing `code` for the root only (for `onlySignal` alone when given), and returns the result with every signal sent as `pid SIGNAL`. */
function killRootRefusing(code: string, onlySignal?: string): { result: ReturnType<typeof killProcessTree>; sent: string[] } {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' })
  const sent: string[] = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    sent.push(`${pid} ${String(signal)}`)
    if (pid === ROOT_PID && (onlySignal === undefined || signal === onlySignal)) throw Object.assign(new Error(`kill ${code}`), { code })
    return true
  }) as typeof process.kill)
  const result = killProcessTree(ROOT_PID)
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
