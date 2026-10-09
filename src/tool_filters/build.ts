// Build-tool filter family (Batch E): make/cmake/bazel/meson/cargo/go here, with the JVM tools in build_jvm.ts, the .NET ones in build_dotnet.ts and the JavaScript ones in build_js.ts. BUILD_FILTERS below orders all seventeen for dispatch.
//
// Each class is a faithful TypeScript port of its Python counterpart in bash_compress.py. Dispatch ordering note: GoFilter must be listed AFTER goTestFilter (which is registered in Batch A) because both match `go`, and goTestFilter's check on the `test` subcommand wins only when it appears first. Within BUILD_FILTERS the ordering is: cargo (all subcommands), go, then the rest.

import { ToolFilter } from './base.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, pathName, positionalArgs, squeezeBlankLines } from './helpers.js'
import { antFilter, gradleFilter, javacFilter, mavenFilter, sbtFilter } from './build_jvm.js'
import { dotnetFilter, msbuildFilter } from './build_dotnet.js'
import { lernaFilter, nxFilter, turboFilter, webpackFilter } from './build_js.js'
import { countNoun } from '../util.js'

// --------------------------------------------------------------------------- MakeFilter ---------------------------------------------------------------------------

const MAKE_RECURSE_RE = /^make\[\d+\]: (?:Entering|Leaving) directory/
const MAKE_PERCENT_RE =
  /^\[\s*\d+%\] (?:Building|Linking|Scanning|Generating|Installing|Compiling)\b/
const MAKE_ECHO_RE =
  /^\s*(?:echo|cc|gcc|clang|g\+\+)\b.*(?<![Ee]rror|[Ww]arning)/
const MAKE_COMPILER_EXT_RE =
  /^\s*(?:clang\+\+|ld|ar|as|nasm|ninja)\b.*(?<![Ee]rror|[Ww]arning)/
const MAKE_NOTHING_TO_DO_RE =
  /^make(?:\[\d+\])?:\s+Nothing to be done/

// configure/autotools probes
const CONFIGURE_CHECKING_RE =
  /^checking (?:for |whether |if )/i
const CONFIGURE_INFO_RE =
  /^configure: (?:creating|loading|running)/i

// go build sub-patterns (reused by MakeFilter when 'go' is the binary)
const GO_BUILD_PKG_HEADER_RE = /^#\s+[a-zA-Z0-9./-]+/
const GO_MOD_DOWNLOADING_RE = /^go: (?:downloading|extracting) /
const GO_VET_PROGRESS_RE = /^go: vet /
const GO_GENERATE_TRIGGER_RE = /^go:generate /
const GO_GET_DOWNLOADING_RE = /^go: (?:downloading|extracting|finding|fetching)\s/

// Shared by MakeFilter (routes 'go' as a catch-all binary) and GoFilter (dedicated go dispatch) -- both filter go build/get/mod/vet output identically; only the notes-emission and finalize() call differ per-instance (protected methods on ToolFilter), so these helpers return the computed {kept, notes} for each caller's own this.emitNotes/finalize.
function goBuildLikeCompress(lines: string[]): { kept: string[]; notes: string[] } {
  const kept: string[] = []
  let droppedHeaders = 0
  let droppedDownloads = 0
  for (const line of lines) {
    if (GO_GET_DOWNLOADING_RE.test(line) || GO_MOD_DOWNLOADING_RE.test(line)) {
      droppedDownloads++
      continue
    }
    if (GO_BUILD_PKG_HEADER_RE.test(line)) {
      droppedHeaders++
      continue
    }
    kept.push(line)
  }
  const notes: string[] = []
  maybeNote(notes, droppedHeaders, `dropped ${droppedHeaders} '# pkg/path' header lines`)
  maybeNote(notes, droppedDownloads, `collapsed ${droppedDownloads} 'go: downloading' lines`)
  return { kept, notes }
}

function goGetCompress(lines: string[]): { kept: string[]; notes: string[] } {
  const kept: string[] = []
  let collapsed = 0
  for (const line of lines) {
    if (GO_GET_DOWNLOADING_RE.test(line) || GO_MOD_DOWNLOADING_RE.test(line)) {
      collapsed++
      continue
    }
    kept.push(line)
  }
  const notes: string[] = []
  maybeNote(notes, collapsed, `collapsed ${collapsed} 'go: downloading/extracting' lines`)
  return { kept, notes }
}

function goModTidyCompress(lines: string[]): { kept: string[]; notes: string[] } {
  const kept: string[] = []
  let collapsed = 0
  for (const line of lines) {
    if (GO_MOD_DOWNLOADING_RE.test(line)) {
      collapsed++
      continue
    }
    kept.push(line)
  }
  const notes: string[] = []
  maybeNote(notes, collapsed, `collapsed ${collapsed} 'go: downloading' lines`)
  return { kept, notes }
}

function goVetLikeCompress(lines: string[]): { kept: string[]; notes: string[] } {
  const kept: string[] = []
  let dropped = 0
  for (const line of lines) {
    if (GO_VET_PROGRESS_RE.test(line) || GO_GENERATE_TRIGGER_RE.test(line)) {
      dropped++
      continue
    }
    kept.push(line)
  }
  const notes: string[] = []
  maybeNote(notes, dropped, `dropped ${dropped} go vet/generate progress lines`)
  return { kept, notes }
}

export class MakeFilter extends ToolFilter {
  name = 'make'
  override binaries = new Set([
    'make', 'gmake', 'ninja', 'buck', 'go', 'goimports',
  ])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    const _pname = pathName(argv[0] ?? "").toLowerCase()
    if (this.binaries.has(stem) || this.binaries.has(_pname)) return true
    // autotools configure / config scripts
    return stem === 'configure' || stem === 'config'
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const stem = pathStem(argv[0] ?? '').toLowerCase()
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')

    // Route to go-specific handlers when appropriate
    const posArgs = positionalArgs(argv.slice(1))
    if (stem === 'go') {
      const sub = posArgs[0] ?? ''
      if (sub === 'get' || (sub === 'mod' && posArgs[1] === 'download')) {
        return this._compressGoGet(lines)
      }
      if (sub === 'mod') {
        return this._compressGoModTidy(lines)
      }
      if (sub === 'vet') {
        return this._compressGoVetLike(lines)
      }
      if (sub === 'generate') {
        return this._compressGoVetLike(lines)
      }
      // build / install / run / clean / fix / env
      return this._compressGoBuildLike(lines)
    }

    // configure / autotools
    if (stem === 'configure' || stem === 'config') {
      return this._compressConfigure(lines)
    }

    // generic make / ninja / etc.
    return this._compressMake(lines)
  }

  private _compressGoBuildLike(lines: string[]): string {
    const { kept, notes } = goBuildLikeCompress(lines)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoGet(lines: string[]): string {
    const { kept, notes } = goGetCompress(lines)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoModTidy(lines: string[]): string {
    const { kept, notes } = goModTidyCompress(lines)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoVetLike(lines: string[]): string {
    const { kept, notes } = goVetLikeCompress(lines)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressConfigure(lines: string[]): string {
    const kept: string[] = []
    let droppedChecking = 0
    let droppedInfo = 0
    for (const line of lines) {
      if (CONFIGURE_CHECKING_RE.test(line)) {
        droppedChecking++
        continue
      }
      if (CONFIGURE_INFO_RE.test(line)) {
        droppedInfo++
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, droppedChecking, `dropped ${droppedChecking} 'checking for/whether/if' probe lines`)
    maybeNote(notes, droppedInfo, `dropped ${droppedInfo} 'configure: creating/loading/running' lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressMake(lines: string[]): string {
    // Pass A: identify lines that must be force-kept (compiler lines before errors)
    const forceKeep = new Set<number>()
    for (let i = 0; i < lines.length; i++) {
      if (ERROR_SIGNAL_RE.test(lines[i] ?? "")) {
        // keep the preceding compiler invocation line (if it exists and looks like one)
        if (i > 0 && (MAKE_ECHO_RE.test(lines[i - 1] ?? "") || MAKE_COMPILER_EXT_RE.test(lines[i - 1] ?? ""))) {
          forceKeep.add(i - 1)
        }
        forceKeep.add(i)
      }
    }

    const kept: string[] = []
    let droppedRecurse = 0
    let droppedPercent = 0
    let droppedEcho = 0
    let droppedDownloads = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (forceKeep.has(i)) {
        kept.push(line)
        continue
      }
      if (MAKE_RECURSE_RE.test(line)) {
        droppedRecurse++
        continue
      }
      if (GO_GET_DOWNLOADING_RE.test(line) || GO_MOD_DOWNLOADING_RE.test(line)) {
        droppedDownloads++
        continue
      }
      if (MAKE_PERCENT_RE.test(line)) {
        droppedPercent++
        continue
      }
      if (MAKE_ECHO_RE.test(line) || MAKE_COMPILER_EXT_RE.test(line)) {
        droppedEcho++
        continue
      }
      if (MAKE_NOTHING_TO_DO_RE.test(line)) {
        // keep "Nothing to be done" as it's informative
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    const dropped = droppedRecurse + droppedPercent + droppedEcho + droppedDownloads
    const noteParts: string[] = []
    if (droppedRecurse) noteParts.push(`${droppedRecurse} make[N]: Entering/Leaving directory`)
    if (droppedPercent) noteParts.push(`${droppedPercent} [N%] build-progress`)
    if (droppedEcho) noteParts.push(`${droppedEcho} compiler invocation`)
    if (droppedDownloads) noteParts.push(`${droppedDownloads} 'go: downloading'`)
    const notes: string[] = []
    if (dropped) notes.push(`dropped ${noteParts.join(', ')} lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- CmakeFilter ---------------------------------------------------------------------------

const CMAKE_DONE_RE = /^-- (?:Configuring done|Generating done|Build files have been written)/
const CMAKE_FOUND_RE = /^-- Found \w/
const CMAKE_CONFIG_RE = /^-- (?:Detecting|Checking|Looking|Testing|Performing)\b/
const CMAKE_LINK_PERCENT_RE = /^\[\s*\d+%\] (?:Linking|Creating library)\b/
const CMAKE_BUILT_TARGET_RE = /^\[\s*\d+%\] Built target\b/
const CMAKE_PERCENT_RE = /^\[\s*\d+%\] Building\b/
const CTEST_PASS_RE = /^\s+\d+\/\d+\s+Test\s+#\d+:.*\.\.\.\s+(?:Passed|passed)/
const CTEST_FAIL_RE = /^\s+\d+\/\d+\s+Test\s+#\d+:.*\.\.\.\s+\*\*\*(?:Failed|Timeout|Exception)/
const CTEST_SUMMARY_RE = /^\d+% tests passed,|\bTotal Test time\b|^Tests passed:|^Tests failed:/

export class CmakeFilter extends ToolFilter {
  name = 'cmake'
  override binaries = new Set(['cmake', 'ccmake', 'ctest', 'cpack'])

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const stem = pathStem(argv[0] ?? '').toLowerCase()
    if (stem === 'ctest') {
      return this._compressCtest(merged)
    }
    return this._compressCmake(merged)
  }

  private _compressCmake(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let foundCount = 0
    let probeCount = 0
    let configProbeKept = 0
    let buildCount = 0
    let lastPercentLine = ''

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (CMAKE_DONE_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (CMAKE_LINK_PERCENT_RE.test(line) || CMAKE_BUILT_TARGET_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (CMAKE_FOUND_RE.test(line)) {
        foundCount++
        continue
      }
      if (CMAKE_CONFIG_RE.test(line)) {
        if (configProbeKept < 5) {
          kept.push(line)
          configProbeKept++
        } else {
          probeCount++
        }
        continue
      }
      if (CMAKE_PERCENT_RE.test(line)) {
        buildCount++
        lastPercentLine = line
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, foundCount, `collapsed ${foundCount} '-- Found …' package lines`)
    maybeNote(
      notes,
      probeCount,
      `collapsed ${probeCount} probe lines (kept first 5)`,
    )
    if (buildCount) {
      notes.push(
        `collapsed ${buildCount} [N%] Building progress lines (last: ${lastPercentLine.trim()})`,
      )
    }
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressCtest(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let passCount = 0

    for (const line of lines) {
      if (CTEST_PASS_RE.test(line)) {
        passCount++
        continue
      }
      if (CTEST_FAIL_RE.test(line) || CTEST_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} PASSED ctest lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- BazelFilter ---------------------------------------------------------------------------

const BAZEL_INFO_KEEP_RE = /^INFO: (?:Analyzed|Found \d+ target)/
const BAZEL_ELAPSED_RE = /^Elapsed time:/
const BAZEL_FAIL_BANNER_RE = /^(?:FAILED|ERROR): /
const BAZEL_BUILD_OK_RE = /^(?:INFO: Build completed successfully|Target .+ up-to-date)/
const BAZEL_INFO_COMPILE_RE = /^INFO: From (?:Compiling|Generating|Linking)/
const BAZEL_INFO_PROGRESS_RE = /^INFO: /
const BAZEL_TEST_RESULT_RE = /^\s+(?:PASSED|FAILED|TIMEOUT|NO STATUS):\s+/
const BAZEL_TEST_PASS_RE = /^\s+PASSED:\s+/

export class BazelFilter extends ToolFilter {
  name = 'bazel'
  override binaries = new Set(['bazel', 'bazelisk'])

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let compileCount = 0
    let infoProgressCount = 0
    let testPassCount = 0

    for (const line of lines) {
      if (BAZEL_INFO_KEEP_RE.test(line) || BAZEL_ELAPSED_RE.test(line) ||
          BAZEL_FAIL_BANNER_RE.test(line) || BAZEL_BUILD_OK_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (BAZEL_INFO_COMPILE_RE.test(line)) {
        compileCount++
        continue
      }
      if (BAZEL_TEST_PASS_RE.test(line)) {
        testPassCount++
        continue
      }
      if (BAZEL_TEST_RESULT_RE.test(line)) {
        // FAILED / TIMEOUT / NO STATUS: keep verbatim
        kept.push(line)
        continue
      }
      if (BAZEL_INFO_PROGRESS_RE.test(line)) {
        infoProgressCount++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} 'INFO: From …' compile-action lines`)
    maybeNote(notes, infoProgressCount, `collapsed ${infoProgressCount} INFO: progress lines`)
    maybeNote(notes, testPassCount, `collapsed ${testPassCount} PASSED test targets`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- MesonFilter ---------------------------------------------------------------------------

const MESON_KEEP_RE = new RegExp(
  '^(?:The Meson build system$' +
  '|Version:\\s' +
  '|Source dir:\\s' +
  '|Build dir:\\s' +
  '|Build type:\\s' +
  '|Project name:\\s' +
  '|Project version:\\s' +
  '|Build targets in project:\\s' +
  '|(?:C|C\\+\\+|Fortran|Rust|D|Go) compiler for the host machine:\\s)',
)
const MESON_COMPILER_DETAIL_RE =
  /^ {2}(?:Compiler|ld|linker|libtool|ar|ranlib|objcopy|objdump|strip|dlltool)\b|^ {4}[a-z]/
const MESON_FOUND_TOOL_RE = /^Found (?:ninja|cmake|pkg-config)\b/
const MESON_PROBE_RE =
  /^(?:Has (?:header|function|type|symbol|member)\s+'|Dependency \S|Program \S[^:]+found:|Library \S)/
const MESON_COMPILE_PROGRESS_RE = /^\[\s*\d+\/\d+\] Compiling /
const MESON_LINK_RE = /^\[\s*\d+\/\d+\] Linking /

export class MesonFilter extends ToolFilter {
  name = 'meson'
  override binaries = new Set(['meson'])
  override errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let compileCount = 0
    let probeCount = 0
    let detailCount = 0
    let foundToolCount = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (MESON_KEEP_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (MESON_LINK_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (MESON_COMPILE_PROGRESS_RE.test(line)) {
        compileCount++
        continue
      }
      if (MESON_COMPILER_DETAIL_RE.test(line)) {
        detailCount++
        continue
      }
      if (MESON_PROBE_RE.test(line)) {
        probeCount++
        continue
      }
      if (MESON_FOUND_TOOL_RE.test(line)) {
        foundToolCount++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} [N/M] Compiling progress lines`)
    maybeNote(notes, probeCount, `collapsed ${probeCount} dependency/probe check lines`)
    maybeNote(notes, detailCount, `suppressed ${detailCount} compiler toolchain detail lines`)
    maybeNote(notes, foundToolCount, `suppressed ${foundToolCount} "Found <tool>" discovery lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- CargoFilter ---------------------------------------------------------------------------

const CARGO_COMPILING_RE = /^\s+Compiling\s+/
const CARGO_CHECKING_RE = /^\s+Checking\s+/
const CARGO_PROGRESS_RE =
  /^\s+(?:Downloading|Downloaded|Fetching|Updating|Documenting|Building|Blocking|Waiting)\s+/
const CARGO_FINISHED_RE = /^\s+Finished\s+/
const CARGO_ERROR_HEADER_RE = /^error(?:\[[A-Z]\d+\]:|: could not compile)/
const CARGO_WARNING_HEADER_RE = /^warning(?:\[[\w-]+\])?:/
const CARGO_DIAG_LOCATION_RE = /^\s*--> /

/** Remove every rustc warning block that carries a `-->` location from `lines` in place and return how many were removed. A block runs from its `warning:` header to the next blank line; location-less warnings (manifest keys, the `generated N warnings` summary) are kept. */
function collapseCargoWarnings(lines: string[]): number {
  const out: string[] = []
  let removed = 0
  let i = 0
  while (i < lines.length) {
    if (!CARGO_WARNING_HEADER_RE.test(lines[i]!)) {
      out.push(lines[i]!)
      i++
      continue
    }
    let end = i + 1
    while (end < lines.length && lines[end]!.trim() !== '') end++
    if (lines.slice(i + 1, end).some((l) => CARGO_DIAG_LOCATION_RE.test(l))) {
      removed++
      // Swallow the blank separator too so the survivors do not gain a gap.
      i = end < lines.length ? end + 1 : end
    } else {
      out.push(...lines.slice(i, end))
      i = end
    }
  }
  lines.length = 0
  lines.push(...out)
  return removed
}

const CARGO_TEST_RUNNING_RE = /^running \d+ tests?/
const CARGO_TEST_PASS_RE = /^test .+ \.\.\. ok$/
const CARGO_TEST_FAIL_RE = /^test .+ \.\.\. FAILED$/
const CARGO_TEST_RESULT_RE = /^test result:/

export class CargoFilter extends ToolFilter {
  name = 'cargo'
  override binaries = new Set(['cargo'])

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    const posArgs = positionalArgs(argv.slice(1))
    const sub = posArgs[0]?.toLowerCase() ?? ''

    if (sub === 'test') return this._compressTest(stdout, stderr)
    if (sub === 'clippy') return this._compressClipy(stdout, stderr)
    if (sub === 'bench') return this._compressBench(stdout, stderr, exitCode)
    // build / check / install / run / fetch / generate-lockfile / etc.
    return this._compressBuild(stdout, stderr, exitCode)
  }

  private _compressBuild(
    stdout: string,
    stderr: string,
    exitCode: number,
    suppressFinished = true,
  ): string {
    // Merge stderr first (cargo puts diagnostics there)
    const merged = stderr
      ? stdout
        ? `${stderr.replace(/\s+$/, '')}\n${stdout.replace(/\s+$/, '')}`
        : stderr
      : stdout

    const lines = merged.split('\n')
    const kept: string[] = []
    const compilingLines: string[] = []
    let droppedProgress = 0

    for (const line of lines) {
      if (CARGO_COMPILING_RE.test(line)) {
        compilingLines.push(line)
        continue
      }
      if (CARGO_CHECKING_RE.test(line) || CARGO_PROGRESS_RE.test(line)) {
        droppedProgress++
        continue
      }
      if (suppressFinished && CARGO_FINISHED_RE.test(line) && exitCode === 0) {
        continue
      }
      kept.push(line)
    }

    // Emit compiling summary
    if (compilingLines.length < 3) {
      kept.unshift(...compilingLines)
    } else {
      kept.unshift(`[compiling ${compilingLines.length} crates…]`)
    }

    const notes: string[] = []
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} Checking/Downloading/progress lines`)
    // A failed build keeps each error whole and collapses the located warning blocks: left in, they crowd the budget and the later middle truncation elides an error's source line and label while keeping a warning's help text.
    const failed = exitCode !== 0 || kept.some((l) => CARGO_ERROR_HEADER_RE.test(l))
    const collapsedWarnings = failed ? collapseCargoWarnings(kept) : 0
    maybeNote(notes, collapsedWarnings, `collapsed ${countNoun(collapsedWarnings, 'warning block')} because the build failed`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(stdout: string, stderr: string): string {
    // Compiler/stderr part: treat as build (keep Compiling, errors, etc.)
    const compilerText = this._compressBuild('', stderr, 0, false)

    const lines = stdout.split('\n')
    const kept: string[] = []
    let passCount = 0
    let _currentSection = ''

    for (const line of lines) {
      if (CARGO_TEST_RUNNING_RE.test(line)) {
        // Flush count for previous section
        if (passCount > 0) {
          kept.push(`[${passCount} tests passed]`)
          passCount = 0
        }
        _currentSection = line
        kept.push(line)
        continue
      }
      if (CARGO_TEST_PASS_RE.test(line)) {
        passCount++
        continue
      }
      if (CARGO_TEST_FAIL_RE.test(line) || CARGO_TEST_RESULT_RE.test(line)) {
        // Flush accumulated passes before a FAIL/result line so the summary reflects passes that happened before it, not after -- otherwise a trailing "[N tests passed]" reads as more tests passing after the run already concluded and reported FAILED.
        if (passCount > 0) {
          kept.push(`[${passCount} tests passed]`)
          passCount = 0
        }
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    // Flush trailing section
    if (passCount > 0) kept.push(`[${passCount} tests passed]`)

    const combined = [compilerText, ...kept].filter(Boolean).join('\n')
    return squeezeBlankLines(combined)
  }

  private _compressClipy(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const compilingLines: string[] = []
    let droppedProgress = 0

    for (const line of lines) {
      if (CARGO_COMPILING_RE.test(line)) {
        compilingLines.push(line)
        continue
      }
      if (CARGO_CHECKING_RE.test(line) || CARGO_PROGRESS_RE.test(line)) {
        droppedProgress++
        continue
      }
      kept.push(line)
    }

    // Keep first 2 + last 2 if more than 4 compiling lines
    let emittedCompiling: string[]
    if (compilingLines.length > 4) {
      emittedCompiling = [
        ...compilingLines.slice(0, 2),
        `[…${compilingLines.length - 4} crates omitted…]`,
        ...compilingLines.slice(-2),
      ]
    } else {
      emittedCompiling = compilingLines
    }
    kept.unshift(...emittedCompiling)

    const notes: string[] = []
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} Checking/progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressBench(stdout: string, stderr: string, exitCode: number): string {
    const compilerText = this._compressBuild('', stderr, exitCode, true)
    const benchLines = stdout.split('\n')
    const kept: string[] = []
    let runnerHeaderCount = 0

    for (const line of benchLines) {
      if (CARGO_TEST_RUNNING_RE.test(line)) {
        runnerHeaderCount++
        if (runnerHeaderCount === 1) kept.push(line)
        continue
      }
      kept.push(line)
    }

    const combined = [compilerText, ...kept].filter(Boolean).join('\n')
    return squeezeBlankLines(combined)
  }
}

// --------------------------------------------------------------------------- GoFilter ---------------------------------------------------------------------------

const GO_SUBCOMMANDS = new Set([
  'build', 'run', 'get', 'mod', 'install', 'clean', 'generate', 'vet', 'env', 'fix',
])

export class GoFilter extends ToolFilter {
  name = 'go'
  override binaries = new Set(['go'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    if (pathStem(argv[0] ?? "").toLowerCase() !== 'go') return false
    const posArgs = positionalArgs(argv.slice(1))
    if (!posArgs.length) return false
    // 'test' is handled by GoTestFilter (Batch A); exclude it here
    return GO_SUBCOMMANDS.has(( posArgs[0] ?? "").toLowerCase())
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const posArgs = positionalArgs(argv.slice(1))
    const sub = posArgs[0]?.toLowerCase() ?? ''

    if (sub === 'get' || (sub === 'mod' && posArgs[1] === 'download')) {
      return this._compressGoGet(merged)
    }
    if (sub === 'mod') {
      return this._compressGoModTidy(merged)
    }
    if (sub === 'vet' || sub === 'generate') {
      return this._compressGoVetLike(merged)
    }
    // build / install / run / clean / fix / env
    return this._compressGoBuildLike(merged)
  }

  private _compressGoBuildLike(merged: string): string {
    const { kept, notes } = goBuildLikeCompress(merged.split('\n'))
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoGet(merged: string): string {
    const { kept, notes } = goGetCompress(merged.split('\n'))
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoModTidy(merged: string): string {
    const { kept, notes } = goModTidyCompress(merged.split('\n'))
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoVetLike(merged: string): string {
    const { kept, notes } = goVetLikeCompress(merged.split('\n'))
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- BUILD_FILTERS registry ---------------------------------------------------------------------------

export const makeFilter = new MakeFilter()
export const cmakeFilter = new CmakeFilter()
export const bazelFilter = new BazelFilter()
export const mesonFilter = new MesonFilter()
export const cargoFilter = new CargoFilter()
export const goFilter = new GoFilter()

/** Ordered build-tool filter registry. CargoFilter handles all cargo subcommands internally; GoFilter must follow goTestFilter in dispatch (registered in Batch A) because both match `go`. */
export const BUILD_FILTERS: ToolFilter[] = [
  cargoFilter,
  goFilter,
  makeFilter,
  cmakeFilter,
  gradleFilter,
  mavenFilter,
  antFilter,
  bazelFilter,
  mesonFilter,
  msbuildFilter,
  dotnetFilter,
  sbtFilter,
  javacFilter,
  nxFilter,
  lernaFilter,
  turboFilter,
  webpackFilter,
]
