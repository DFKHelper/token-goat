import { vi } from 'vitest'

// One `process.kill` call a test made: the target as passed (negative for a group) and the signal (undefined means the default).
export interface KillCall {
  readonly pid: number
  readonly signal: string | number | undefined
}

export interface KillSpy {
  readonly calls: KillCall[]
  restore(): void
}

/** Replaces `process.kill` with a spy that models death: after a SIGKILL, signal 0 to that pid answers ESRCH once `probesBeforeGone` probes have been answered alive (Infinity: never gone). Other signals are accepted and recorded. Provenance: HAND-DERIVED from the POSIX kill(2) contract (signal 0 probes existence; ESRCH means no such process). */
export function spyProcessKill(options: { probesBeforeGone?: number } = {}): KillSpy {
  const probesBeforeGone = options.probesBeforeGone ?? 0
  const calls: KillCall[] = []
  const killedProbes = new Map<number, number>()
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    calls.push({ pid, signal })
    const target = Math.abs(pid)
    if (signal === 'SIGKILL') killedProbes.set(target, 0)
    if (signal !== 0 || !killedProbes.has(target)) return true
    const probes = (killedProbes.get(target) ?? 0) + 1
    killedProbes.set(target, probes)
    if (probes > probesBeforeGone) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
  return { calls, restore: () => spy.mockRestore() }
}
