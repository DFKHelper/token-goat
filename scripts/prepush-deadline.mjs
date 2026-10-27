#!/usr/bin/env node
// What a pre-push leg learns when its fill files are cut by the wall-clock deadline (scripts/prepush-deadline-reporter.mjs): which selected files ran to completion, which did not, and whether the leg is green. Pure functions plus one CLI, `summarize OUT`, that the leg scripts call after a vitest run; built-in modules only.
import { readFileSync } from 'node:fs'
import { isMainModule } from './is-main-module.mjs'

/** The reason the reporter gives vitest.cancelCurrentRun, and the reason printed beside each file the cut left unrun. */
export const DEADLINE_REASON = 'wall-clock deadline reached (host load)'
// The note vitest 5 writes on every test it skips because the run was cancelled (TestRunAbortError message, node_modules/vitest/dist/chunks/run.*.js markPendingTasksAsSkipped); read from a 5.0.4 run on 2026-10-26.
const CANCEL_NOTE = /aborted by the user/i
// Unhandled errors that cancelling itself produces in a worker; they say nothing about a file.
const CANCEL_NOISE = /aborted by the user|closing rpc|rpc is closed|TestRunAbortError/i

/** @param {string} moduleState vitest's TestModule state @param {{state: string, note?: string}[]} tests the module's test results @param {boolean} [cancelled] true when the deadline cancelled the run @returns {'done' | 'failed' | 'unfinished'} a failed test or a failed collection is failed, even in a file the cancel cut short, so a real failure is never deferred; otherwise a file that never ran (state pending), had a test cut by the cancel, or (in a cancelled run) has no test at all is unfinished, else done */
export function moduleOutcome(moduleState, tests, cancelled = false) {
  if (moduleState === 'failed' || tests.some((t) => t.state === 'failed')) return 'failed'
  if (tests.some((t) => t.state === 'pending' || (t.state === 'skipped' && CANCEL_NOTE.test(t.note ?? '')))) return 'unfinished'
  if (moduleState === 'pending') return 'unfinished'
  if (cancelled && tests.length === 0) return 'unfinished'
  return 'done'
}

/** @param {unknown} error an unhandled error vitest reports for the run @param {boolean} [cancelled] true when the deadline cancelled the run @returns {boolean} false only for the cancel's own noise in a run the deadline cancelled; the same text in a run nobody cancelled can be a worker crash, so it is real */
export function isRealError(error, cancelled = false) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error?.message ?? error)
  return !(cancelled && CANCEL_NOISE.test(text))
}

/** @param {string} text the reporter's out file: `done|failed|unfinished<TAB>file` per module, `errors<TAB>n`, `cancelled<TAB>reason`, `end` @returns {{done: string[], failed: string[], unfinished: string[], errors: number, cancelled: boolean, ended: boolean}} */
export function parseOut(text) {
  const r = { done: [], failed: [], unfinished: [], errors: 0, cancelled: false, ended: false }
  for (const line of text.split(/\r?\n/)) {
    const [kind, value = ''] = line.split('\t')
    if (kind === 'done' || kind === 'failed' || kind === 'unfinished') r[kind].push(value)
    else if (kind === 'errors') r.errors += Number(value) || 0
    else if (kind === 'cancelled') r.cancelled = true
    else if (kind === 'end') r.ended = true
  }
  return r
}

/** @param {ReturnType<typeof parseOut>} out @returns {'green' | 'red' | 'plain'} a run the deadline cut is green when every completed file passed and no real error was reported, red otherwise; a run it did not cut (or that never wrote its end) is plain: vitest's own exit status decides */
export function legVerdict(out) {
  if (!out.cancelled || !out.ended) return 'plain'
  return out.failed.length === 0 && out.errors === 0 ? 'green' : 'red'
}

/** @param {string} outFile @param {string[]} [selected] the files the vitest call was given: after a cut, one vitest never listed is unfinished too @returns {string} the summary lines `STATUS<TAB>green|red|plain`, `UNFINISHED<TAB>file` and `FAILED<TAB>file` */
export function summarize(outFile, selected = []) {
  let text = ''
  try {
    text = readFileSync(outFile, 'utf8')
  } catch {
    // no out file: the reporter never ran, so vitest's exit status decides
  }
  const out = parseOut(text)
  const verdict = legVerdict(out)
  const seen = new Set([...out.done, ...out.failed, ...out.unfinished])
  const unfinished = verdict === 'plain' ? [] : [...out.unfinished, ...selected.filter((f) => !seen.has(f))]
  return [`STATUS\t${verdict}`, ...unfinished.map((f) => `UNFINISHED\t${f}`), ...(verdict === 'plain' ? [] : out.failed.map((f) => `FAILED\t${f}`))].join('\n') + '\n'
}

/** @param {string} focusText the focus list, one file per line (already thinned of files green on this tree) @param {string} planText the plan: the deadline in epoch ms, then the fill files in priority order @returns {{deadlineAtMs: number, floor: string[], fill: string[]}} the fill files that are still in the focus list, in plan order, and every other focus file as the floor, in focus order; a deadline that is not whole milliseconds is 0, which cuts all of the fill */
export function splitPlan(focusText, planText) {
  const focus = focusText.split(/\r?\n/).filter((f) => f !== '')
  const [first = '', ...rest] = planText.split(/\r?\n/)
  const inFocus = new Set(focus)
  const fill = rest.filter((f) => f !== '' && inFocus.has(f))
  const inFill = new Set(fill)
  return { deadlineAtMs: /^[0-9]+$/.test(first) ? Number(first) : 0, floor: focus.filter((f) => !inFill.has(f)), fill }
}

/** @param {string[]} files the files a deadline cut @returns {string} the deferred-to-CI report line and list, in the form scripts/prepush-select.mjs gives the files its estimate cut */
export function cutReport(files) {
  return `deferred to CI: ${files.length} files (${DEADLINE_REASON})\n${files.map((f) => `  ${f}`).join('\n')}`
}

if (isMainModule(import.meta.url)) {
  const [cmd, arg, ...selected] = process.argv.slice(2)
  if (cmd === 'summarize' && arg) {
    process.stdout.write(summarize(arg, selected))
  } else if (cmd === 'split' && arg && selected.length === 1) {
    const s = splitPlan(readFileSync(arg, 'utf8'), readFileSync(selected[0], 'utf8'))
    process.stdout.write([`DEADLINE\t${s.deadlineAtMs}`, ...s.floor.map((f) => `FLOOR\t${f}`), ...s.fill.map((f) => `FILL\t${f}`)].join('\n') + '\n')
  } else if (cmd === 'report' && arg) {
    process.stdout.write(`${cutReport(readFileSync(arg, 'utf8').split(/\r?\n/).filter((f) => f !== ''))}\n`)
  } else {
    process.stderr.write('usage: node scripts/prepush-deadline.mjs summarize OUT_FILE [SELECTED_FILE...] | split FOCUS_FILE PLAN_FILE | report LIST_FILE\n')
    process.exitCode = 2
  }
}
