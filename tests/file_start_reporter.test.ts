import { describe, expect, it } from 'vitest'

import { ciSet, isCiRun } from './setup/ci-run.js'
import FileStartReporter from './setup/file-start-reporter.js'

describe('FileStartReporter', () => {
  /** Run the reporter with stdout captured and return what it wrote. */
  function capture(run: (reporter: FileStartReporter) => void, now: Date): string {
    let written = ''
    const orig = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = (s: string) => { written += s; return true }
    try {
      run(new FileStartReporter(() => now))
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = orig
    }
    return written
  }

  // FORMAT-DERIVED: vitest 5.0.4 node_modules/vitest/dist/chunks/plugin.d.C8mmycim.d.ts:270 relativeModuleId
  const when = new Date('2026-01-02T03:04:05.000Z')

  it('writes one line per test file as it starts, naming the file and an ISO time', () => {
    const written = capture((r) => {
      r.onTestModuleStart({ relativeModuleId: 'tests/a.test.ts' })
      r.onTestModuleStart({ relativeModuleId: 'tests/b.test.ts' })
    }, when)
    expect(written).toBe(
      '[file-start] tests/a.test.ts started 2026-01-02T03:04:05.000Z\n' +
        '[file-start] tests/b.test.ts started 2026-01-02T03:04:05.000Z\n',
    )
  })

  it('writes nothing until a file starts', () => {
    expect(capture(() => undefined, when)).toBe('')
  })
})

// HAND-DERIVED: rows follow the gate rule (GitHub Actions sets CI to the string 'true'); no CI run was captured.
describe('isCiRun', () => {
  it('turns on when CI is the string true', () => {
    expect(isCiRun({ CI: 'true' })).toBe(true)
  })

  it('stays off when CI is the string false', () => {
    expect(isCiRun({ CI: 'false' })).toBe(false)
  })

  it('stays off when CI is empty', () => {
    expect(isCiRun({ CI: '' })).toBe(false)
  })

  it('stays off when CI is unset', () => {
    expect(isCiRun({})).toBe(false)
  })

  // HAND-DERIVED: CI=1 is truthy but not the string 'true', so the strict gate stays off.
  it('stays off when CI is 1', () => {
    expect(isCiRun({ CI: '1' })).toBe(false)
  })
})

// HAND-DERIVED: rows follow the coverage-guard rule (any CI value except unset, empty, false or 0 is a CI run).
describe('ciSet', () => {
  // HAND-DERIVED: CI unset is not a CI run, so the coverage guards stay off.
  it('stays off when CI is unset', () => {
    expect(ciSet({})).toBe(false)
  })

  // HAND-DERIVED: CI empty is not a CI run.
  it('stays off when CI is empty', () => {
    expect(ciSet({ CI: '' })).toBe(false)
  })

  // HAND-DERIVED: CI=false is an explicit opt-out.
  it('stays off when CI is the string false', () => {
    expect(ciSet({ CI: 'false' })).toBe(false)
  })

  // HAND-DERIVED: CI=0 is an explicit opt-out.
  it('stays off when CI is the string 0', () => {
    expect(ciSet({ CI: '0' })).toBe(false)
  })

  // HAND-DERIVED: CI=1 is a CI run, so the coverage guards fail loud instead of skipping.
  it('turns on when CI is 1', () => {
    expect(ciSet({ CI: '1' })).toBe(true)
  })

  // HAND-DERIVED: CI=true is a CI run.
  it('turns on when CI is the string true', () => {
    expect(ciSet({ CI: 'true' })).toBe(true)
  })
})
