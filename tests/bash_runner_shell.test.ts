// End-to-end regression for the bash_compress Windows-shell fix, driving the REAL production
// path: bashRunner.run() -> wrapAndCompress -> spawnSync({ shell: wrappedShell() }). Before the
// fix, spawnSync `shell: true` on Windows was cmd.exe, so a bash construct like arithmetic
// expansion `$((6*7))` was echoed literally instead of evaluated. After the fix it runs under
// Git-Bash and evaluates to 42.
//
// Windows-only by nature: the whole point is that the wrapper no longer falls through to
// cmd.exe. On POSIX both `shell: true` (/bin/sh) and any bash evaluate `$((6*7))`, so there is
// nothing to discriminate — the cross-platform locateBashOnPath tests in tests/shell.test.ts
// carry the platform-independent coverage. Tri-state: assert on Windows-with-bash, skip only
// when no bash is installed, never silently pass.
import { describe, expect, it } from 'vitest'

import * as bashRunner from '../src/bash_runner.js'
import { resolveWindowsBash } from '../src/shell.js'

describe('compress runs the inner command under bash on Windows', () => {
  it('evaluates a bash-only arithmetic expansion instead of echoing it literally', () => {
    if (process.platform !== 'win32') return // POSIX cannot regress this way
    if (resolveWindowsBash() === null) return // no Git-Bash installed: absent, not broken

    let captured = ''
    const exit = bashRunner.run('echo answer=$((6*7))', {
      filterName: 'generic',
      writeStdout: (s) => {
        captured += s
      },
    })

    expect(exit).toBe(0)
    // Under bash: "answer=42". Under the old cmd.exe path: "answer=$((6*7))" (literal) or an error.
    expect(captured).toContain('answer=42')
    expect(captured).not.toContain('$((6*7))')
  })
})
