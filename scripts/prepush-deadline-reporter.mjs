// A vitest reporter that holds a run to a wall-clock deadline. When the deadline passes it calls vitest.cancelCurrentRun, so no further file starts, then records which files ran to completion, which failed and which did not finish, for scripts/prepush-deadline.mjs. Armed by TG_PREPUSH_DEADLINE_AT (epoch ms) and TG_PREPUSH_DEADLINE_OUT (the out file); with either missing it does nothing. The cancel is made once the first file is queued, not at onInit or onTestRunStart: vitest clears its cancel state when it schedules the run, so an earlier cancel is lost (measured on vitest 5.0.4, 2026-10-26).
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { DEADLINE_REASON, isRealError, moduleOutcome } from './prepush-deadline.mjs'

export const DEADLINE_AT_ENV = 'TG_PREPUSH_DEADLINE_AT'
export const DEADLINE_OUT_ENV = 'TG_PREPUSH_DEADLINE_OUT'

/** Holds a vitest run to a deadline; `now`, `setTimer` and `clearTimer` are seams for tests. */
export class DeadlineReporter {
  /** @param {{ deadlineAt: number | null, outFile: string | null, now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (t: unknown) => void }} o */
  constructor(o) {
    this.deadlineAt = o.deadlineAt
    this.outFile = o.outFile
    this.now = o.now ?? Date.now
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t))
    this.armed = false
    this.cancelled = false
    this.timer = null
    this.vitest = null
  }

  onInit(vitest) {
    this.vitest = vitest
  }

  /** The run is live once a file is queued: arm the deadline there, and cancel at once when it has passed already. */
  onTestModuleQueued() {
    if (this.armed || this.deadlineAt === null || this.outFile === null) return
    this.armed = true
    const left = this.deadlineAt - this.now()
    if (left <= 0) this.fire()
    else this.timer = this.setTimer(() => this.fire(), left)
  }

  fire() {
    this.timer = null
    this.cancelled = true
    // Not awaited: cancelCurrentRun resolves when the run ends, and the reporter has to stay free to see it end.
    void this.vitest?.cancelCurrentRun(DEADLINE_REASON)
  }

  onTestRunEnd(testModules, unhandledErrors) {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    if (!this.armed || this.outFile === null) return
    const root = this.vitest?.config?.root ?? process.cwd()
    const lines = []
    for (const m of testModules) {
      const rel = path.relative(root, m.moduleId).replace(/\\/g, '/')
      const tests = [...m.children.allTests()].map((t) => {
        const r = t.result()
        return { state: r.state, note: r.state === 'skipped' ? r.note : undefined }
      })
      lines.push(`${moduleOutcome(m.state(), tests, this.cancelled)}\t${rel}`)
    }
    lines.push(`errors\t${unhandledErrors.filter((e) => isRealError(e, this.cancelled)).length}`)
    if (this.cancelled) lines.push(`cancelled\t${DEADLINE_REASON}`)
    lines.push('end')
    appendFileSync(this.outFile, `${lines.join('\n')}\n`)
  }
}

/** @param {Record<string, string | undefined>} env @returns {{deadlineAt: number | null, outFile: string | null}} */
export function optionsFromEnv(env) {
  const raw = env[DEADLINE_AT_ENV]
  const at = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : null
  const out = env[DEADLINE_OUT_ENV]
  return { deadlineAt: at, outFile: out === undefined || out === '' ? null : out }
}

export default class PrepushDeadlineReporter extends DeadlineReporter {
  constructor() {
    super(optionsFromEnv(process.env))
  }
}
