// Regression: --grep clipped a long matched line at 1000 chars before the secret redactor ran, so a secret straddling the clip point leaked as a fragment the redactor no longer recognised. Redaction must run before any truncation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _applyFiltersAndPrint } from '../src/cli_cached_output.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stdout: string[]
let spy: WriteSpy

beforeEach(() => {
  stdout = []
  spy = spyOnWrite(process.stdout, stdout)
})

afterEach(() => {
  spy.mockRestore()
})

// Provenance: FORMAT-DERIVED src/secret_redact.ts aws_access_key pattern /AKIA[0-9A-Z]{16}/ (AKIAIOSFODNN7EXAMPLE is the key AWS documents as its example).
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'

// Provenance: HAND-DERIVED the key starts at char 995 of a line longer than the 1000-char clip window, so a clip at 1000 would keep only its first five chars.
function straddlingLine(): string {
  return 'needle ' + 'x'.repeat(988) + AWS_KEY + ' ' + 'y'.repeat(300)
}

describe('recall --grep redacts before it clips', () => {
  it('leaves no raw fragment of a secret that straddles the clip point', () => {
    const line = straddlingLine()
    expect(line.indexOf(AWS_KEY)).toBe(995)
    const printed = _applyFiltersAndPrint(`first\n${line}\nlast\n`, { grep: 'needle' }, true)
    expect(printed).not.toContain('AKIA')
    expect(printed).toContain('needle')
    expect(stdout.join('')).not.toContain('AKIA')
  })

  it('still redacts a short matched line (must-not-drop: the matched text survives)', () => {
    const printed = _applyFiltersAndPrint(`needle ${AWS_KEY} tail\n`, { grep: 'needle' }, true)
    expect(printed).not.toContain(AWS_KEY)
    expect(printed).toContain('needle')
    expect(printed).toContain('tail')
  })
})
