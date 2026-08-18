/**
 * Regression: `token-goat doctor` signed off with "All checks passed" while [WARN] lines were
 * printed directly above it. The verdict counted only `fail`, so a run reporting an oversized
 * database, an empty index for the current project and orphaned Node processes still ended with a
 * clean bill of health contradicting its own list. A warning is not a pass.
 *
 * What a warning means, and the exit code, are deliberately unchanged -- only the summary line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { printDoctorResults } from '../src/cli_doctor.js'
import type { DoctorResult } from '../src/cli_doctor.js'

function capture(results: DoctorResult[]): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    printDoctorResults(results)
    return spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  } finally {
    spy.mockRestore()
  }
}

const ok = (name: string): DoctorResult => ({ name, status: 'ok', message: 'fine' })
const warn = (name: string): DoctorResult => ({ name, status: 'warn', message: 'not fine' })
const fail = (name: string): DoctorResult => ({ name, status: 'fail', message: 'broken' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('doctor verdict line', () => {
  it('does not claim every check passed when some only warned', () => {
    const out = capture([ok('a'), warn('b'), warn('c')])

    expect(out, 'two checks did not pass').not.toContain('All checks passed')
    expect(out).toContain('No failures, but 2 warnings above')
  })

  it('counts a single warning in the singular', () => {
    expect(capture([ok('a'), warn('b')])).toContain('No failures, but 1 warning above')
  })

  it('still says all checks passed when they actually all did', () => {
    const out = capture([ok('a'), ok('b')])

    expect(out).toContain('All checks passed')
    expect(out).not.toContain('warning')
  })

  // A failure still outranks any number of warnings, and the wording is unchanged.
  it('reports failures as failures, warnings alongside them notwithstanding', () => {
    const out = capture([warn('a'), fail('b')])

    expect(out).toContain('FAILURES DETECTED')
    expect(out).not.toContain('All checks passed')
    expect(out).not.toContain('No failures')
  })
})
