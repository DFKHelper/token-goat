/** Makes a consumed test retry visible instead of silent. `vitest.config.ts` sets `retry: 1` under CI to absorb genuinely infra-level flakes (a shared runner's worker RPC losing a heartbeat), and the workflow wraps the whole suite in nick-fields/retry on top of that. Both are deliberate -- without them one slow test sinks the run -- but both are also, by construction, flake-hiding mechanisms: a test that fails and then passes is reported exactly like a test that passed first time. A real flake can therefore live in the suite indefinitely without anyone learning it exists. This reporter does not fail the build. Failing on a consumed retry would re-create the problem the retry was added to solve. It only makes the retry impossible to miss: a greppable block on stderr, and (when running under GitHub Actions) an entry in the job summary, so a flake is noticed the first time rather than after it has degraded. Nothing is emitted when no test was retried, so a clean run's output is byte-identical to today. Written against vitest 4's reporter API and verified end-to-end against a genuinely retried test, not just a hand-built task tree: the hook is `onTestRunEnd` (`onFinished` is never called), and the retry facts live on `test.diagnostic()`, NOT on `test.result()`. An earlier draft of this file guessed `result.retryCount` and `state === 'pass'`; its unit tests all passed against that guess while the reporter never once fired on a real retry. */
import { appendFileSync } from 'node:fs'
import * as path from 'node:path'

/** A test that passed only after being retried, identified for a human to go fix. */
export interface RetriedTest {
  name: string
  file: string
  retryCount: number
  /** The failed attempt's error message and where it was thrown. A retry that passes prints no error anywhere else in the run, so without this a flake arrives as a name and nothing to root-cause it with. */
  firstFailure?: string
}

/** Minimal shape this reporter reads; vitest's own types carry far more. */
interface TestLike {
  name?: string
  diagnostic?: () => { retryCount?: number; flaky?: boolean } | undefined
  result?: () => { errors?: ReadonlyArray<ErrorLike> } | undefined
}

interface ErrorLike {
  message?: string
  stacks?: ReadonlyArray<{ file?: string; line?: number; column?: number }>
}

/** Longest failure message kept; an assertion diffing two large values would otherwise paste both into the warning. */
const MAX_FAILURE_CHARS = 600

/** Describe the first error vitest kept from the failed attempt. It keeps them on a test that passed on retry (vitest 4's runner never clears `result.errors` between attempts, and `result()` hands them back for a passed test), which is the only record of what went wrong. */
function describeFirstFailure(test: TestLike): string | undefined {
  const err = test.result?.()?.errors?.[0]
  if (err === undefined) return undefined
  const message = (err.message ?? '(no message)').trim()
  const clipped = message.length > MAX_FAILURE_CHARS ? `${message.slice(0, MAX_FAILURE_CHARS)}...` : message
  const frame = err.stacks?.[0]
  const where = frame?.file !== undefined ? ` at ${path.relative(process.cwd(), frame.file)}:${frame.line ?? '?'}:${frame.column ?? '?'}` : ''
  return `${clipped}${where}`
}

interface TestModuleLike {
  relativeModuleId?: string
  moduleId?: string
  children?: { allTests?: () => Iterable<TestLike> }
}

/** Collect every test that ultimately passed but needed at least one retry to do it. Keyed on vitest's own `flaky` flag, which it sets precisely for "failed, then passed on a retry" -- a test that retried and still failed has `flaky: false` and is excluded deliberately, since it is already reported as a failure and naming it here would double-report a red build. */
export function collectRetriedTests(testModules: Iterable<TestModuleLike>): RetriedTest[] {
  const found: RetriedTest[] = []
  for (const mod of testModules) {
    const file = mod.relativeModuleId ?? mod.moduleId ?? '(unknown file)'
    for (const test of mod.children?.allTests?.() ?? []) {
      const diag = test.diagnostic?.()
      if (diag?.flaky === true) {
        const firstFailure = describeFirstFailure(test)
        found.push({ name: test.name ?? '(unnamed)', file, retryCount: diag.retryCount ?? 0, ...(firstFailure !== undefined ? { firstFailure } : {}) })
      }
    }
  }
  return found
}

/** Render the human-facing block. Kept separate from the reporter so it can be asserted directly. */
export function formatRetryReport(retried: RetriedTest[]): string {
  return [
    '',
    'FLAKE WARNING — these tests failed once and passed on retry:',
    ...retried.flatMap((r) => [
      `   ${r.file} > ${r.name} (retries: ${r.retryCount})`,
      ...(r.firstFailure !== undefined ? [`      first failure: ${r.firstFailure.replace(/\n/g, '\n      ')}`] : []),
    ]),
    '   A consumed retry means the suite hid a failure. Root-cause it rather than leaving it to the retry budget.',
    '',
  ].join('\n')
}

export default class RetryVisibilityReporter {
  onTestRunEnd(testModules: Iterable<TestModuleLike> = []): void {
    const retried = collectRetriedTests(testModules)
    if (retried.length === 0) return
    process.stderr.write(formatRetryReport(retried))
    // Surface it in the Actions job summary too: a green run's log is ~46k lines, so a block only on stderr is easy to never see.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (summaryPath !== undefined && summaryPath !== '') {
      const md = [
        '### Flake warning',
        '',
        'These tests failed once and passed on retry:',
        '',
        ...retried.flatMap((r) => [
          `- \`${r.file}\` > ${r.name} (retries: ${r.retryCount})`,
          ...(r.firstFailure !== undefined ? ['', '  ```', `  ${r.firstFailure.replace(/\n/g, '\n  ')}`, '  ```'] : []),
        ]),
        '',
      ].join('\n')
      try {
        appendFileSync(summaryPath, `${md}\n`)
      } catch {
        // A summary write failing must never take down an otherwise-green run.
      }
    }
  }
}
