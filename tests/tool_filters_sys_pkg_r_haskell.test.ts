/**
 * Coverage for three filters that ship on by default and whose only existing
 * fixtures were written from their own matcher regexes: `sys-pkg`, `rcmd` and
 * `haskell`. Every fixture here carries a provenance line naming where its
 * bytes came from; a fixture read off our own regex proves only that the
 * matcher matches itself, so none of those appear below.
 *
 * Each case asserts a must-not-drop list of specific lines that have to survive
 * the filter, not a byte ratio: dropping more always improves a ratio, so a
 * ratio floor cannot tell a good collapse from an over-collapse.
 */
import { describe, expect, it } from 'vitest'

import { rCmdFilter, haskellFilter } from '../src/tool_filters/languages.js'
import { sysPackageFilter } from '../src/tool_filters/misc.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

function compress(filter: { compress: (a: string, b: string, c: number, d: string[]) => string }, stdout: string, argv: string[], stderr = '', exitCode = 0): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// ---------------------------------------------------------------------------
// sys-pkg (apt branch)
// ---------------------------------------------------------------------------

// CAPTURE. Verbatim stdout of `apt-get -s install --reinstall coreutils`, apt 2.8.3 (amd64) on
// Ubuntu 24.04.4 LTS, run through WSL on this machine. `-s` simulates: it reads the local package
// lists only and makes no network request. Package names are stock Ubuntu packages; the capture
// carries no account, host or path identifying this machine.
const APT_SIMULATE_CAPTURE = [
  'NOTE: This is only a simulation!',
  '      apt-get needs root privileges for real execution.',
  '      Keep also in mind that locking is deactivated,',
  "      so don't depend on the relevance to the real current situation!",
  'Reading package lists...',
  'Building dependency tree...',
  'Reading state information...',
  'The following package was automatically installed and is no longer required:',
  '  libyuv0',
  "Use 'apt autoremove' to remove it.",
  '0 upgraded, 0 newly installed, 1 reinstalled, 0 to remove and 28 not upgraded.',
  'Inst coreutils [9.4-3ubuntu6.3] (9.4-3ubuntu6.3 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Conf coreutils (9.4-3ubuntu6.3 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  '',
].join('\n')

// CAPTURE. Same apt 2.8.3 / Ubuntu 24.04.4 run, `apt-get -s install tg-no-such-package-xyz`:
// the seven stdout lines above through `Reading state information...`, this single stderr line,
// and exit code 100.
const APT_MISSING_PACKAGE_STDERR = 'E: Unable to locate package tg-no-such-package-xyz\n'

describe('sys-pkg on captured apt output', () => {
  it('routes apt-get through the sys-pkg filter', () => {
    expect(selectFilter(['apt-get', '-s', 'install', '--reinstall', 'coreutils'])?.name).toBe('sys-pkg')
  })

  it('keeps the decision lines of a simulated install', () => {
    const out = compress(sysPackageFilter, APT_SIMULATE_CAPTURE, ['apt-get', '-s', 'install', '--reinstall', 'coreutils'])
    // Must-not-drop: the counts line is the whole answer to "what would this do", and the
    // Inst/Conf pair names the exact version apt picked.
    expect(out).toContain('0 upgraded, 0 newly installed, 1 reinstalled, 0 to remove and 28 not upgraded.')
    expect(out).toContain('Inst coreutils [9.4-3ubuntu6.3]')
    expect(out).toContain('Conf coreutils (9.4-3ubuntu6.3')
    expect(out).toContain('The following package was automatically installed and is no longer required:')
    expect(out).toContain('  libyuv0')
    // Nothing in this capture matches a collapse rule, so no count note may be invented.
    expect(out).not.toContain('token-goat:')
  })

  it('keeps the stderr diagnostic when apt cannot find the package', () => {
    const stdout = APT_SIMULATE_CAPTURE.split('\n').slice(0, 7).join('\n') + '\n'
    const out = compress(sysPackageFilter, stdout, ['apt-get', '-s', 'install', 'tg-no-such-package-xyz'], APT_MISSING_PACKAGE_STDERR, 100)
    // Must-not-drop: the diagnostic is the only line in the whole run that says what went wrong.
    expect(out).toContain('E: Unable to locate package tg-no-such-package-xyz')
  })
})

// ---------------------------------------------------------------------------
// rcmd
// ---------------------------------------------------------------------------

// FORMAT-DERIVED. R is not installed on this machine and cannot be installed here (no network),
// so this is written from the producer's documentation rather than a run: R Core Team, "Writing R
// Extensions", section 1.3 "Checking and building packages", which documents `R CMD check`
// emitting one `* checking <what> ... <result>` line per check with results OK, NOTE, WARNING,
// ERROR or SKIPPED, a `* DONE (<pkg>)` line, and a closing `Status:` summary. It is weaker than a
// CAPTURE: it proves agreement with that documented shape, not that a given R build emits it.
const R_CMD_CHECK_FORMAT = [
  '* using R version 4.4.1 (2024-06-14)',
  "* checking for file 'pkg/DESCRIPTION' ... OK",
  '* checking DESCRIPTION meta-information ... OK',
  '* checking R files for syntax errors ... OK',
  '* checking dependencies in R code ... OK',
  '* checking Rd files ... OK',
  '* checking examples ... OK',
  '* checking tests ... SKIPPED',
  '* checking PDF version of manual ... WARNING',
  'LaTeX errors when creating PDF version.',
  '* DONE (pkg)',
  '',
  'Status: 1 WARNING',
].join('\n')

describe('rcmd on documented R CMD check output', () => {
  it('routes R CMD check through the rcmd filter', () => {
    expect(selectFilter(['R', 'CMD', 'check', 'pkg'])?.name).toBe('rcmd')
  })

  it('keeps a SKIPPED check instead of counting it as an OK one', () => {
    const out = compress(rCmdFilter, R_CMD_CHECK_FORMAT, ['R', 'CMD', 'check', 'pkg'])
    // Must-not-drop: a skipped check is a result, not a pass. It is the only line saying the
    // package's tests never ran, so folding it into the OK tally both deletes it and makes the
    // note an untrue claim about how many checks passed.
    expect(out).toContain('* checking tests ... SKIPPED')
    expect(out).toContain('collapsed 6 R CMD check-OK line(s)')
    expect(out).not.toContain('collapsed 7 R CMD check-OK line(s)')
    // Must-not-drop: the failing check, its explanation, and the closing status summary.
    expect(out).toContain('* checking PDF version of manual ... WARNING')
    expect(out).toContain('LaTeX errors when creating PDF version.')
    expect(out).toContain('* DONE (pkg)')
    expect(out).toContain('Status: 1 WARNING')
    // Still a real collapse: the passing checks are gone.
    expect(out).not.toContain('* checking Rd files ... OK')
  })
})

// ---------------------------------------------------------------------------
// haskell
// ---------------------------------------------------------------------------

// FORMAT-DERIVED. No Haskell toolchain is installed on this machine and none can be installed
// here (no network). Written from the producers' documentation: the GHC User's Guide, "Using GHC
// / Modes of operation", which documents `--make` progress lines of the form
// `[N of M] Compiling <Module> ( <source>, <object> )` followed by `Linking <target> ...`, and
// GHC error diagnostics rendered as `<file>:<line>:<col>: error: [GHC-<code>]` with an indented
// body; plus the Cabal User Guide's `cabal build` output (`Resolving dependencies...`,
// `Configuring <pkg>...`, `Preprocessing library for <pkg>..`, `Building library for <pkg>..`)
// and cabal's `cabal: ` diagnostic prefix. FORMAT-DERIVED, not CAPTURE: it proves agreement with
// the documented shape, not that a shipped cabal build emits exactly these bytes.
const CABAL_BUILD_FAILURE_FORMAT = [
  'Resolving dependencies...',
  'Configuring mypkg-0.1.0.0...',
  'Preprocessing library for mypkg-0.1.0.0..',
  'Building library for mypkg-0.1.0.0..',
  '[1 of 4] Compiling Mypkg.A          ( src/Mypkg/A.hs, dist/build/Mypkg/A.o )',
  '[2 of 4] Compiling Mypkg.B          ( src/Mypkg/B.hs, dist/build/Mypkg/B.o )',
  '[3 of 4] Compiling Mypkg.C          ( src/Mypkg/C.hs, dist/build/Mypkg/C.o )',
  '[4 of 4] Compiling Mypkg            ( src/Mypkg.hs, dist/build/Mypkg.o )',
  'Linking dist/build/mypkg/mypkg ...',
  '',
  'src/Mypkg/B.hs:12:1: error: [GHC-88464]',
  '    Variable not in scope: frobnicate :: Int -> Int',
  '   |',
  '12 | main = frobnicate 3',
  '   |        ^^^^^^^^^^',
  'cabal: Failed to build mypkg-0.1.0.0.',
].join('\n')

describe('haskell on documented cabal/GHC output', () => {
  it('routes cabal build through the haskell filter', () => {
    expect(selectFilter(['cabal', 'build'])?.name).toBe('haskell')
  })

  it('keeps the whole GHC diagnostic and the cabal verdict while collapsing the progress lines', () => {
    const out = compress(haskellFilter, CABAL_BUILD_FAILURE_FORMAT, ['cabal', 'build'])
    // Must-not-drop: the diagnostic header, every line of its indented body (the caret line is
    // what points at the offending token), and cabal's closing verdict on the last line.
    expect(out).toContain('src/Mypkg/B.hs:12:1: error: [GHC-88464]')
    expect(out).toContain('    Variable not in scope: frobnicate :: Int -> Int')
    expect(out).toContain('12 | main = frobnicate 3')
    expect(out).toContain('   |        ^^^^^^^^^^')
    expect(out).toContain('cabal: Failed to build mypkg-0.1.0.0.')
    // Still a real collapse: the per-module progress is replaced by a count.
    expect(out).toContain('collapsed 4 module compilation(s)')
    expect(out).not.toContain('[2 of 4] Compiling Mypkg.B')
  })
})
