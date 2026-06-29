// Build-tool filter family (Batch E): make/cmake/gradle/maven/ant/bazel/meson/ msbuild/dotnet/sbt/javac/cargo/go/nx/lerna/turbo/webpack.
//
// Each class is a faithful TypeScript port of its Python counterpart in bash_compress.py. Dispatch ordering note: GoFilter must be listed AFTER goTestFilter (which is registered in Batch A) because both match `go`, and goTestFilter's check on the `test` subcommand wins only when it appears first. Within BUILD_FILTERS the ordering is: cargo (all subcommands), go, then the rest.

import { ToolFilter } from './base.js'
import {
  ERROR_SIGNAL_RE,
  headTailCompress,
  maybeNote,
  pathStem,
  pathName,
  positionalArgs,
  squeezeBlankLines,
  dedupeCombinedOutput,
} from './helpers.js'

// ---------------------------------------------------------------------------
// MakeFilter
// ---------------------------------------------------------------------------

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

export class MakeFilter extends ToolFilter {
  name = 'make'
  override binaries = new Set([
    'make', 'gmake', 'ninja', 'gradle', 'mvn', 'maven', 'bazel', 'buck', 'go', 'goimports',
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoGet(lines: string[]): string {
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoModTidy(lines: string[]): string {
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoVetLike(lines: string[]): string {
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

// ---------------------------------------------------------------------------
// CmakeFilter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GradleFilter
// ---------------------------------------------------------------------------

const GRADLE_SUBCOMMANDS = new Set([
  'build', 'test', 'check', 'assemble', 'verify', 'clean', 'run',
  'jar', 'war', 'bootjar', 'bootrun', 'dependencies', 'deps', 'tasks',
])

const GRADLE_TASK_PROGRESS_RE = /^> Task :/
const GRADLE_TASK_FAILED_RE = /^> Task :.+ FAILED/
const GRADLE_DOWNLOAD_RE = /^Download(?:ing)?\s+https?:/i
const GRADLE_DAEMON_RE = /^(?:Starting a Gradle Daemon|Daemon will be stopped)/
const GRADLE_BUILD_SCAN_RE = /^(?:Publishing a build scan|https:\/\/gradle\.com\/)/
const GRADLE_DEPRECATION_RE = /^(?:w:|W: )?(?:deprecated|Deprecated)\b/i
const GRADLE_TEST_METHOD_RE = /^\s+\w+(?:Test)?\.\w+ > .+ (?:PASSED|SKIPPED)$/
const GRADLE_TEST_COMPLETION_RE = /^\s+\d+ tests? completed,\s+/
const GRADLE_TEST_SUMMARY_RE = /^Results: /
const GRADLE_BUILD_RESULT_RE = /^BUILD (?:SUCCESSFUL|FAILED)/
const GRADLE_FAILURE_BLOCK_RE = /^FAILURE:\s|^\* What went wrong:|^\* Try:/
const GRADLE_EXCEPTION_CLASS_RE = /^\s+\w+Exception\b|\s+Caused by:/
const GRADLE_ERROR_LINE_RE = /error:\s/i
const GRADLE_STACK_FRAME_RE = /^\s+at \w/

export class GradleFilter extends ToolFilter {
  name = 'gradle'
  override binaries = new Set(['gradle', 'gradlew'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    if (!this.binaries.has(stem)) return false
    const posArgs = positionalArgs(argv.slice(1))
    if (!posArgs.length) return true
    // case-insensitive subcommand match (Gradle uses camelCase like bootJar)
    return GRADLE_SUBCOMMANDS.has(( posArgs[0] ?? "").toLowerCase())
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const posArgs = positionalArgs(argv.slice(1))
    const sub = posArgs[0]?.toLowerCase() ?? ''

    if (sub === 'dependencies' || sub === 'deps') {
      return headTailCompress(merged.split('\n'), 10, 10, 'lines')
    }
    if (sub === 'tasks') {
      return headTailCompress(merged.split('\n'), 20, 5, 'lines')
    }
    return this._compressBuild(merged)
  }

  private _compressBuild(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let stackFrameCount = 0
    const MAX_STACK_FRAMES = 10

    for (const line of lines) {
      // Always keep: build result, failure block headers, exception class lines, error lines
      if (
        GRADLE_BUILD_RESULT_RE.test(line) ||
        GRADLE_FAILURE_BLOCK_RE.test(line) ||
        GRADLE_EXCEPTION_CLASS_RE.test(line) ||
        GRADLE_ERROR_LINE_RE.test(line)
      ) {
        kept.push(line)
        stackFrameCount = 0
        continue
      }
      // Task FAILED lines
      if (GRADLE_TASK_FAILED_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Test completion / summary
      if (GRADLE_TEST_COMPLETION_RE.test(line) || GRADLE_TEST_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Stack frames — keep up to MAX_STACK_FRAMES per trace
      if (GRADLE_STACK_FRAME_RE.test(line)) {
        if (stackFrameCount < MAX_STACK_FRAMES) {
          kept.push(line)
          stackFrameCount++
        }
        continue
      }
      // Drop: task-progress lines without FAILED, downloads, daemon messages, build scan, deprecation
      if (
        GRADLE_TASK_PROGRESS_RE.test(line) ||
        GRADLE_DOWNLOAD_RE.test(line) ||
        GRADLE_DAEMON_RE.test(line) ||
        GRADLE_BUILD_SCAN_RE.test(line) ||
        GRADLE_DEPRECATION_RE.test(line) ||
        GRADLE_TEST_METHOD_RE.test(line)
      ) {
        continue
      }
      kept.push(line)
      stackFrameCount = 0
    }

    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// MavenFilter
// ---------------------------------------------------------------------------

const MAVEN_DOWNLOAD_RE = /^\[INFO\] Downloading(?:From)?:/
const MAVEN_SEPARATOR_RE = /^\[INFO\] -[-]+/
const MAVEN_INFO_BOILERPLATE_RE =
  /^\[INFO\] (?:Scanning for projects|Using the MultiThreadedBuilder|--- |Reactor (?:Build Order|Summary):\s*$|\s*$)/
const MAVEN_REACTOR_RE = /^\[INFO\] Reactor Build Order:/
const MAVEN_TEST_SUMMARY_RE =
  /^\[INFO\] Tests run:|Tests run:|\[ERROR\] Tests run:/
const MAVEN_BUILD_RESULT_RE =
  /^\[INFO\] BUILD (?:SUCCESS|FAILURE)|^\[ERROR\] BUILD (?:SUCCESS|FAILURE)/

export class MavenFilter extends ToolFilter {
  name = 'maven'
  override binaries = new Set(['mvn', 'mvnw', './mvnw'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    const _pname = pathName(argv[0] ?? "").toLowerCase()
    return this.binaries.has(stem) || this.binaries.has(_pname) || stem === 'mvnw'
  }

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')

    // On failure: extract ERROR lines and return last 20 + errors
    if (exitCode !== 0) {
      const errorLines = lines.filter(l => l.startsWith('[ERROR]'))
      const tail = lines.slice(-20)
      const combined = [...tail, ...errorLines.filter(l => !tail.includes(l))]
      return this.finalize(combined)
    }

    const posArgs = positionalArgs(argv.slice(1))
    const sub = posArgs[0] ?? ''

    if (sub === 'dependency:tree') {
      return headTailCompress(lines, 10, 10, 'lines')
    }
    if (sub === 'install') {
      return headTailCompress(lines, 5, 30, 'lines')
    }
    if (sub === 'test' || sub === 'verify' || sub === 'package') {
      return this._compressTest(lines)
    }
    return headTailCompress(lines, 10, 10, 'lines')
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let droppedDownloads = 0
    let droppedInfoBoilerplate = 0

    for (const line of lines) {
      if (line.startsWith('[WARNING]') || line.startsWith('[WARN]') || line.startsWith('[ERROR]')) {
        kept.push(line)
        continue
      }
      if (MAVEN_TEST_SUMMARY_RE.test(line) || MAVEN_BUILD_RESULT_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (MAVEN_DOWNLOAD_RE.test(line)) {
        droppedDownloads++
        continue
      }
      if (MAVEN_SEPARATOR_RE.test(line)) {
        droppedInfoBoilerplate++
        continue
      }
      if (MAVEN_INFO_BOILERPLATE_RE.test(line) || MAVEN_REACTOR_RE.test(line)) {
        droppedInfoBoilerplate++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedDownloads, `dropped ${droppedDownloads} download lines`)
    maybeNote(notes, droppedInfoBoilerplate, `collapsed ${droppedInfoBoilerplate} [INFO] boilerplate lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// AntFilter
// ---------------------------------------------------------------------------

const ANT_TASK_ALWAYS_KEEP_RE = /^\s+\[(?:javac)\]\s+(?:error|warning)\b/i
const ANT_BUILD_RESULT_RE = /^BUILD (?:SUCCESSFUL|FAILED)/
const ANT_TASK_LINE_RE = /^\s+\[(\w+)\]\s+/
const ANT_COLLAPSIBLE_TASKS = new Set(['echo', 'mkdir', 'copy', 'delete', 'move', 'chmod', 'touch', 'get'])

export class AntFilter extends ToolFilter {
  name = 'ant'
  override binaries = new Set(['ant'])

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    // task name → count of collapsed lines
    const taskCounts = new Map<string, number>()

    const flushTaskCounts = () => {
      for (const [task, count] of taskCounts) {
        kept.push(`[token-goat: [${task}] ×${count} lines collapsed]`)
      }
      taskCounts.clear()
    }

    for (const line of lines) {
      if (ANT_TASK_ALWAYS_KEEP_RE.test(line) || ANT_BUILD_RESULT_RE.test(line)) {
        flushTaskCounts()
        kept.push(line)
        continue
      }
      const taskMatch = ANT_TASK_LINE_RE.exec(line)
      if (taskMatch) {
        const task = (taskMatch[1] ?? "").toLowerCase()
        if (ANT_COLLAPSIBLE_TASKS.has(task)) {
          taskCounts.set(task, (taskCounts.get(task) ?? 0) + 1)
          continue
        }
        // non-collapsible task: flush accumulated counts then keep
        flushTaskCounts()
        kept.push(line)
        continue
      }
      // non-task line
      flushTaskCounts()
      kept.push(line)
    }
    flushTaskCounts()
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// BazelFilter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MesonFilter
// ---------------------------------------------------------------------------

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
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} [N/M] Compiling progress lines`)
    maybeNote(notes, probeCount, `collapsed ${probeCount} dependency/probe check lines`)
    maybeNote(notes, detailCount, `suppressed ${detailCount} compiler toolchain detail lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// MSBuildFilter
// ---------------------------------------------------------------------------

const MSBUILD_ERROR_RE = /.*\(\d+(?:,\d+)?\)\s*:\s*error\s+/
const MSBUILD_WARNING_RE = /.*\(\d+(?:,\d+)?\)\s*:\s*warning\s+(\w+)/
const MSBUILD_BUILD_STARTED_RE = /^Build started/
const MSBUILD_PROJECT_BUILDING_RE = /^------ Build started: Project:/
const MSBUILD_COPY_RE = /^\s+(?:Copy|CopyFilesToOutputDirectory|CopyToOutputDirectory)\b/
const MSBUILD_MKDIR_RE = /^\s+(?:MakeDir|CreateHardLink)\b/
const MSBUILD_TASK_RE = /^\s{2,4}[A-Z][A-Za-z0-9]+:\s*$/
const MSBUILD_SUMMARY_COUNT_RE = /^\s+\d+ (?:Error|Warning)\(s\)/
const MSBUILD_NOISE_RE =
  /^\s*(?:Done Building Project|Project "[^"]+" \(default targets\)|"[^"]+" \([\w ]+\) ->|Build succeeded\.)/

export class MSBuildFilter extends ToolFilter {
  name = 'msbuild'
  override binaries = new Set(['msbuild', 'msbuild.exe'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    const _pname = pathName(argv[0] ?? "").toLowerCase()
    return stem === 'msbuild' || _pname === 'msbuild.exe'
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let buildStartedCount = 0
    let projectBuildingCount = 0
    let copyCount = 0
    let mkdirCount = 0
    let taskCount = 0
    const seenWarningCodes = new Set<string>()
    let droppedWarningDupes = 0

    for (const line of lines) {
      if (MSBUILD_ERROR_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Deduplicate warnings by code
      const warnMatch = MSBUILD_WARNING_RE.exec(line)
      if (warnMatch) {
        const code = warnMatch[1] ?? ""
        if (!seenWarningCodes.has(code)) {
          seenWarningCodes.add(code)
          kept.push(line)
        } else {
          droppedWarningDupes++
        }
        continue
      }
      if (MSBUILD_BUILD_STARTED_RE.test(line)) {
        if (buildStartedCount === 0) kept.push(line)
        buildStartedCount++
        continue
      }
      if (MSBUILD_PROJECT_BUILDING_RE.test(line)) {
        projectBuildingCount++
        continue
      }
      if (MSBUILD_COPY_RE.test(line)) {
        copyCount++
        continue
      }
      if (MSBUILD_MKDIR_RE.test(line)) {
        mkdirCount++
        continue
      }
      if (MSBUILD_TASK_RE.test(line)) {
        taskCount++
        continue
      }
      if (MSBUILD_SUMMARY_COUNT_RE.test(line)) {
        kept.push(line)
        continue
      }
      // On success: drop noise lines
      if (_exitCode === 0 && MSBUILD_NOISE_RE.test(line)) {
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    if (buildStartedCount > 1) {
      maybeNote(notes, buildStartedCount - 1, `collapsed ${buildStartedCount - 1} repeated 'Build started' lines`)
    }
    maybeNote(notes, projectBuildingCount, `collapsed ${projectBuildingCount} project-building header lines`)
    maybeNote(notes, copyCount, `collapsed ${copyCount} Copy/CopyFiles task lines`)
    maybeNote(notes, mkdirCount, `collapsed ${mkdirCount} MakeDir task lines`)
    maybeNote(notes, taskCount, `collapsed ${taskCount} MSBuild task lines`)
    maybeNote(notes, droppedWarningDupes, `collapsed ${droppedWarningDupes} duplicate warning lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// DotnetFilter
// ---------------------------------------------------------------------------

const DOTNET_BUILD_ARROW_RE = /^\s+\S+ ->\s+/
const DOTNET_RESTORE_RE = new RegExp(
  '^\\s*(?:Determining projects|Writing assets|Restoring packages for|Installing|Generating' +
  '|OK https?://|log\\s+:\\s+Restore[d]? |MSBuild auto-detection|Feeds used:)\\b',
  'i',
)
const DOTNET_BUILD_SUCCEEDED_RE = /^Build succeeded\.\s*$/i
const DOTNET_MSBUILD_NOISE_RE =
  /^\s*(?:Project|Target|Task|Using) "|^\s*MSBuild version/i
const DOTNET_TEST_PASS_RE = /^\s*(?:Passed|passed)\s+\S/
const DOTNET_TEST_FAIL_RE = /^\s*(?:Failed|failed|Error)\s+\S/
const DOTNET_TEST_SUMMARY_RE =
  /^\s*(?:Test Run|Total tests|Passed:|Failed:|Skipped:|Test results file)/
const DOTNET_FORMAT_FILE_RE = new RegExp(
  '^\\s*(?:Formatted code in|Fixed code style violations in|Fixing code style in' +
  '|Fixed whitespace in|Fixing whitespace in' +
  '|Fixing analyzer violations in|Fixed analyzer violations in)\\s+\'',
  'i',
)
const DOTNET_FORMAT_SUMMARY_RE = new RegExp(
  '^\\s*(?:Format complete|Completed format|dotnet-format.*complete' +
  '|\\d+ file\\(s\\) (?:were )?reformatted|No violations found' +
  '|Format.*succeeded|Format.*failed)',
  'i',
)
const DOTNET_RESTORE_EXTRA_RE = new RegExp(
  '^\\s*(?:Resolving conflicts for|Lock file|Acquiring lock|Reading project file' +
  '|Cache file|Checking compatibility|HTTP\\s+GET|HTTP\\s+OK|HTTP\\s+NotFound' +
  '|Source\\s+:\\s+|PackageReference|Writing lock file)\\b',
  'i',
)

export class DotnetFilter extends ToolFilter {
  name = 'dotnet'
  override binaries = new Set(['dotnet'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return pathStem(argv[0] ?? "").toLowerCase() === 'dotnet'
  }

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    if (this.errorPassthrough) {
      // handled structurally per subcommand below
    }
    const posArgs = positionalArgs(argv.slice(1))
    const sub = posArgs[0]?.toLowerCase() ?? ''

    if (sub === 'test') return this._compressTest(stdout, stderr)
    if (sub === 'restore') return this._compressRestore(stdout, stderr)
    if (sub === 'build' || sub === 'publish' || sub === 'pack') return this._compressBuild(stdout, stderr, exitCode)
    if (sub === 'format') return this._compressFormat(stdout, stderr)
    return dedupeCombinedOutput(this.combineOutput(stdout, stderr))
  }

  private _compressRestore(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let dropped = 0
    for (const line of lines) {
      if (DOTNET_RESTORE_RE.test(line) || DOTNET_RESTORE_EXTRA_RE.test(line)) {
        dropped++
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, dropped, `dropped ${dropped} restore/download progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressBuild(stdout: string, stderr: string, _exitCode: number): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedNoise = 0
    let arrowKept = 0
    let lastSucceeded = -1

    // First pass: find last "Build succeeded." line
    for (let i = 0; i < lines.length; i++) {
      if (DOTNET_BUILD_SUCCEEDED_RE.test(lines[i] ?? "")) lastSucceeded = i
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (DOTNET_MSBUILD_NOISE_RE.test(line)) {
        droppedNoise++
        continue
      }
      if (DOTNET_BUILD_ARROW_RE.test(line)) {
        if (arrowKept < 5) {
          kept.push(line)
          arrowKept++
        }
        continue
      }
      // Suppress repeated "Build succeeded." except the last
      if (DOTNET_BUILD_SUCCEEDED_RE.test(line)) {
        if (i === lastSucceeded) kept.push(line)
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedNoise, `dropped ${droppedNoise} MSBuild noise lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let passCount = 0
    let inFailBlock = false

    for (const line of lines) {
      if (DOTNET_TEST_SUMMARY_RE.test(line)) {
        kept.push(line)
        inFailBlock = false
        continue
      }
      if (DOTNET_TEST_FAIL_RE.test(line)) {
        kept.push(line)
        inFailBlock = true
        continue
      }
      if (DOTNET_TEST_PASS_RE.test(line)) {
        passCount++
        inFailBlock = false
        continue
      }
      if (inFailBlock && (line.startsWith(' ') || line.startsWith('\t') || !line.trim())) {
        kept.push(line)
        continue
      }
      inFailBlock = false
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} passed test lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressFormat(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let formattedCount = 0

    for (const line of lines) {
      if (DOTNET_FORMAT_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (DOTNET_FORMAT_FILE_RE.test(line)) {
        formattedCount++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, formattedCount, `collapsed ${formattedCount} per-file format lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// SbtFilter
// ---------------------------------------------------------------------------

const SBT_INFO_COMPILING_RE = /^\[info\]\s+Compiling\s+\d+/
const SBT_INFO_DONE_RE = /^\[info\]\s+Done (?:compiling|packaging)\./
const SBT_INFO_LOADING_RE =
  /^\[info\]\s+(?:Loading|Set current project|Resolving|Resolution|Fetching|Updating|Downloading|Downloaded|Loading settings)/i
const SBT_WARN_RE = /^\[warn\]\s/
const SBT_ERROR_RE = /^\[error\]\s/
const SBT_TEST_PROGRESS_RE = /^\[info\]\s+[.FEI!]+\s*$/
const SBT_SCALATEST_PASS_RE = /^\[info\]\s+[-+✓]\s+(?!.*\*\*\* FAILED \*\*\*)/
const SBT_TOTAL_TIME_RE = /^\[success\]\s+Total time:/
const SBT_SUCCESS_RE = /^\[success\]\s/
const SBT_TEST_SUMMARY_RE = /^\[info\]\s+(?:Tests: succeeded|Run completed|Total number of tests)/
const SBT_MAX_WARN_PER_CATEGORY = 5

export class SbtFilter extends ToolFilter {
  name = 'sbt'
  override binaries = new Set(['sbt'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    const _pname = pathName(argv[0] ?? "").toLowerCase()
    return stem === 'sbt' || _pname === 'sbt'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedLoading = 0
    let droppedTestProgress = 0
    let droppedPassingTests = 0
    const warnCounts = new Map<string, number>()
    let droppedWarnExtra = 0

    for (const line of lines) {
      if (SBT_ERROR_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (SBT_INFO_COMPILING_RE.test(line) || SBT_INFO_DONE_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (SBT_TEST_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (SBT_TOTAL_TIME_RE.test(line) || SBT_SUCCESS_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (SBT_INFO_LOADING_RE.test(line)) {
        droppedLoading++
        continue
      }
      if (SBT_TEST_PROGRESS_RE.test(line)) {
        droppedTestProgress++
        continue
      }
      if (SBT_SCALATEST_PASS_RE.test(line)) {
        droppedPassingTests++
        continue
      }
      if (SBT_WARN_RE.test(line)) {
        const category = line.slice(0, 60).trim()
        const count = warnCounts.get(category) ?? 0
        warnCounts.set(category, count + 1)
        if (count < SBT_MAX_WARN_PER_CATEGORY) {
          kept.push(line)
        } else {
          droppedWarnExtra++
        }
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedLoading, `collapsed ${droppedLoading} [info] loading/resolution lines`)
    maybeNote(notes, droppedTestProgress, `collapsed ${droppedTestProgress} test dot-progress lines`)
    maybeNote(notes, droppedPassingTests, `collapsed ${droppedPassingTests} verbose passing-test lines`)
    maybeNote(notes, droppedWarnExtra, `collapsed ${droppedWarnExtra} duplicate [warn] lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// JavacFilter
// ---------------------------------------------------------------------------

const JAVAC_NOTE_RE = /^Note: .+\.java uses? (?:unchecked|unsafe|preview|deprecated)/
const JAVAC_NOTE_SUMMARY_RE = /^Note: (?:Recompile|Some messages have been simplified)/
const JAVAC_ERROR_WARNING_RE = /\.java:\d+: (?:error|warning):/
const JAVAC_SUMMARY_RE = /^\d+ (?:error|warning)/
const JAVAC_CARET_RE = /^\s*\^\s*$/
const JAVAC_SOURCE_SNIPPET_RE = /^ {4}/  // indented ≥ 4 spaces

export class JavacFilter extends ToolFilter {
  name = 'javac'
  override binaries = new Set(['javac'])

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let noteCount = 0
    let inDiagBlock = false

    for (const line of lines) {
      if (JAVAC_NOTE_SUMMARY_RE.test(line)) {
        // drop the redundant summary note
        continue
      }
      if (JAVAC_NOTE_RE.test(line)) {
        noteCount++
        continue
      }
      if (JAVAC_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (JAVAC_ERROR_WARNING_RE.test(line)) {
        inDiagBlock = true
        kept.push(line)
        continue
      }
      if (inDiagBlock) {
        if (!line.trim()) {
          // blank line closes block
          inDiagBlock = false
          kept.push(line)
          continue
        }
        if (JAVAC_CARET_RE.test(line) || JAVAC_SOURCE_SNIPPET_RE.test(line)) {
          kept.push(line)
          continue
        }
        // non-blank non-snippet line: keep and stay in block
        kept.push(line)
        continue
      }
      // outside diag block: drop blank lines
      if (!line.trim()) continue
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, noteCount, `collapsed ${noteCount} 'Note: … uses unchecked/unsafe/…' lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// CargoFilter
// ---------------------------------------------------------------------------

const CARGO_COMPILING_RE = /^\s+Compiling\s+/
const CARGO_CHECKING_RE = /^\s+Checking\s+/
const CARGO_PROGRESS_RE =
  /^\s+(?:Downloading|Downloaded|Fetching|Updating|Documenting|Building|Blocking|Waiting)\s+/
const CARGO_FINISHED_RE = /^\s+Finished\s+/
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
        if (runnerHeaderCount > 1) kept.push(line)
        continue
      }
      kept.push(line)
    }

    const combined = [compilerText, ...kept].filter(Boolean).join('\n')
    return squeezeBlankLines(combined)
  }
}

// ---------------------------------------------------------------------------
// GoFilter
// ---------------------------------------------------------------------------

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
    const lines = merged.split('\n')
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoGet(merged: string): string {
    const lines = merged.split('\n')
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoModTidy(merged: string): string {
    const lines = merged.split('\n')
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGoVetLike(merged: string): string {
    const lines = merged.split('\n')
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
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// NxFilter
// ---------------------------------------------------------------------------

const NX_HEADER_RE = /^>? NX\s/
const NX_STATUS_RE = /^[\s✔✖✓✗×]\s+(?:\w|@)/
const NX_CACHE_HIT_RE = /(?:cache hit|restored from cache|✔\s+nx run)/i
const NX_SEPARATOR_RE = /^[-─=]{20,}$/
const NX_TASK_HEADER_RE = /^>\s+(?:nx run |NX run )/
const NX_SUMMARY_RE = /^(?:NX\s+)?(?:Successfully ran|Ran target|Failed|✔|✖)/

export class NxFilter extends ToolFilter {
  name = 'nx'
  override binaries = new Set(['nx', 'npx', 'pnpx'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    if (stem === 'nx') return true
    if (stem === 'npx' || stem === 'pnpx') {
      const rest = argv.slice(1).filter(a => !a.startsWith('-'))
      return rest.length > 0 && ( rest[0] ?? "").toLowerCase() === 'nx'
    }
    return false
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const FAIL_TASK_SAMPLE = 5
    let failTaskKept = 0
    let cacheHits = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (NX_SUMMARY_RE.test(line) || NX_HEADER_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Cache-hit check BEFORE task-header (cache lines start like task headers)
      if (NX_CACHE_HIT_RE.test(line)) {
        cacheHits++
        continue
      }
      if (NX_TASK_HEADER_RE.test(line)) {
        if (_exitCode !== 0 && failTaskKept < FAIL_TASK_SAMPLE) {
          kept.push(line)
          failTaskKept++
        }
        continue
      }
      if (NX_STATUS_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (NX_SEPARATOR_RE.test(line)) {
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, cacheHits, `collapsed ${cacheHits} cache-hit task lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// LernaFilter
// ---------------------------------------------------------------------------

const LERNA_VERBOSE_RE = /^(?:lerna )?(?:verb|verbose|timing)\s/i
const LERNA_NOTICE_RE = /^(?:lerna )?notice\s/i
const LERNA_RAN_RE = /^(?:lerna )?info run Ran npm script/i
const LERNA_OUTCOME_RE = /^(?:lerna )?(?:success|error|ERR!)\s/i
const LERNA_INFO_RE = /^(?:lerna )?info\s/i

export class LernaFilter extends ToolFilter {
  name = 'lerna'
  override binaries = new Set(['lerna'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return pathStem(argv[0] ?? "").toLowerCase() === 'lerna'
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const ranSample: string[] = []
    let ranExtra = 0

    for (const line of lines) {
      if (LERNA_VERBOSE_RE.test(line) || LERNA_NOTICE_RE.test(line)) {
        continue
      }
      if (LERNA_RAN_RE.test(line)) {
        if (ranSample.length < 5) {
          ranSample.push(line)
        } else {
          ranExtra++
        }
        continue
      }
      if (LERNA_OUTCOME_RE.test(line) || LERNA_INFO_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...ranSample]
    if (ranExtra) out.push(`[token-goat: …and ${ranExtra} more 'info run Ran' lines]`)
    out.push(...kept)
    return this.finalize(out)
  }
}

// ---------------------------------------------------------------------------
// TurboFilter
// ---------------------------------------------------------------------------

const TURBO_SCOPE_RE = /^• Packages in scope:/
const TURBO_RUNNING_RE = /^• Running /
const TURBO_TASK_LINE_RE = /^(\S+:\S+)\s+(?:cache (?:miss|hit)|building)/
const TURBO_CACHE_HIT_RE = /cache hit/i
const TURBO_SUMMARY_RE =
  /^Tasks:\s+\d+ successful|\bFailed\b|^Time:\s+\d/i
const TURBO_SEPARATOR_RE = /^[-─]{20,}$/

export class TurboFilter extends ToolFilter {
  name = 'turbo'
  override binaries = new Set(['turbo', 'npx', 'pnpx'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    if (stem === 'turbo') return true
    if (stem === 'npx' || stem === 'pnpx') {
      const rest = argv.slice(1).filter(a => !a.startsWith('-'))
      return rest.length > 0 && ( rest[0] ?? "").toLowerCase() === 'turbo'
    }
    return false
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const cacheHitTasks = new Set<string>()
    let inCacheHitTask = false
    let _currentTask = ''

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        inCacheHitTask = false
        continue
      }
      if (TURBO_SUMMARY_RE.test(line) || TURBO_SCOPE_RE.test(line) || TURBO_RUNNING_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (TURBO_SEPARATOR_RE.test(line)) {
        inCacheHitTask = false
        continue
      }

      const taskMatch = TURBO_TASK_LINE_RE.exec(line)
      if (taskMatch) {
        const task = taskMatch[1] ?? ""
        if (TURBO_CACHE_HIT_RE.test(line)) {
          cacheHitTasks.add(task)
          inCacheHitTask = true
          _currentTask = task
          // Drop the cache-hit line itself
          continue
        }
        inCacheHitTask = false
        _currentTask = task
        kept.push(line)
        continue
      }

      // Body lines from cache-hit tasks: drop
      if (inCacheHitTask) continue

      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, cacheHitTasks.size, `collapsed ${cacheHitTasks.size} cache-hit task(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// WebpackFilter
// ---------------------------------------------------------------------------

const VITE_PROGRESS_RE =
  /^\s*(?:transforming|rendering chunks|computing gzip size)\s*\(\d+\)/i
const WEBPACK_MOD_PATH_NODMOD_RE = /^\s+\.\/(node_modules)\//
const WEBPACK_MODULE_LINE_RE = /^\s+\.\/node_modules\//
const WEBPACK_PLUS_MODULES_RE = /^\s+\+\s+\d+\s+modules/
const WEBPACK_RUNTIME_RE = /^\s+runtime modules/

function _invokesViteBuild(args: string[]): boolean {
  const posArgs = args.filter(a => !a.startsWith('-'))
  return posArgs.length > 0 && ( posArgs[0] ?? "").toLowerCase() === 'build'
}

export class WebpackFilter extends ToolFilter {
  name = 'webpack'
  override binaries = new Set(['webpack', 'webpack-cli', 'vite', 'esbuild'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? "").toLowerCase()
    const _pname = pathName(argv[0] ?? "").toLowerCase()

    // Direct webpack/webpack-cli/esbuild invocation
    if (['webpack', 'webpack-cli', 'esbuild'].includes(stem)) return true

    // Vite only matches when invoked with `build` subcommand
    if (stem === 'vite') return _invokesViteBuild(argv.slice(1))

    // npx/pnpx/bunx wrappers
    if (['npx', 'pnpx', 'bunx'].includes(stem)) {
      const rest = argv.slice(1)
      // Scan past flags to find the tool name
      const tool = rest.find(a => !a.startsWith('-'))
      if (!tool) return false
      const toolStem = pathStem(tool).toLowerCase()
      if (['webpack', 'webpack-cli', 'esbuild'].includes(toolStem)) return true
      if (toolStem === 'vite') return _invokesViteBuild(rest.slice(rest.indexOf(tool) + 1))
    }

    return false
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const stem = pathStem(argv[0] ?? '').toLowerCase()

    // Detect vite vs webpack
    if (stem === 'vite' || ((['npx', 'pnpx', 'bunx'].includes(stem)) && argv.some(a => pathStem(a).toLowerCase() === 'vite'))) {
      return this._compressVite(merged)
    }
    return this._compressWebpack(merged)
  }

  private _compressVite(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let dropped = 0
    for (const line of lines) {
      if (VITE_PROGRESS_RE.test(line)) {
        dropped++
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, dropped, `collapsed ${dropped} Vite progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressWebpack(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedNodeMod = 0
    let droppedRuntime = 0
    let inNodeModSection = false

    for (const line of lines) {
      // Enter node_modules section on section header or module line
      if (WEBPACK_MOD_PATH_NODMOD_RE.test(line)) {
        inNodeModSection = true
        droppedNodeMod++
        continue
      }
      if (inNodeModSection) {
        // Exit on non-indented non-blank line or "modules by path ./src/"
        if (line.startsWith('modules by path ./src/')) {
          inNodeModSection = false
          kept.push(line)
          continue
        }
        if (!line.startsWith(' ') && !line.startsWith('\t') && line.trim()) {
          inNodeModSection = false
          kept.push(line)
          continue
        }
        if (WEBPACK_MODULE_LINE_RE.test(line)) {
          droppedNodeMod++
          continue
        }
        if (WEBPACK_PLUS_MODULES_RE.test(line) || WEBPACK_RUNTIME_RE.test(line)) {
          droppedRuntime++
          continue
        }
        kept.push(line)
        continue
      }
      if (WEBPACK_PLUS_MODULES_RE.test(line) || WEBPACK_RUNTIME_RE.test(line)) {
        droppedRuntime++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedNodeMod, `collapsed ${droppedNodeMod} node_modules module lines`)
    maybeNote(notes, droppedRuntime, `collapsed ${droppedRuntime} runtime/+ modules lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// BUILD_FILTERS registry
// ---------------------------------------------------------------------------

export const makeFilter = new MakeFilter()
export const cmakeFilter = new CmakeFilter()
export const gradleFilter = new GradleFilter()
export const mavenFilter = new MavenFilter()
export const antFilter = new AntFilter()
export const bazelFilter = new BazelFilter()
export const mesonFilter = new MesonFilter()
export const msbuildFilter = new MSBuildFilter()
export const dotnetFilter = new DotnetFilter()
export const sbtFilter = new SbtFilter()
export const javacFilter = new JavacFilter()
export const cargoFilter = new CargoFilter()
export const goFilter = new GoFilter()
export const nxFilter = new NxFilter()
export const lernaFilter = new LernaFilter()
export const turboFilter = new TurboFilter()
export const webpackFilter = new WebpackFilter()

/**
 * Ordered build-tool filter registry. CargoFilter handles all cargo
 * subcommands internally; GoFilter must follow goTestFilter in dispatch
 * (registered in Batch A) because both match `go`.
 */
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
