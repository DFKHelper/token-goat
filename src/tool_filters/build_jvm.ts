// JVM build-tool filters (Batch E): gradle, maven, ant, sbt and javac, each a faithful TypeScript port of its Python counterpart in bash_compress.py. BUILD_FILTERS in build.ts sets their dispatch position.

import { countNoun } from '../util.js'
import { ToolFilter } from './base.js'
import { headTailCompress, maybeNote, pathStem, pathName, positionalArgs } from './helpers.js'

// --------------------------------------------------------------------------- GradleFilter ---------------------------------------------------------------------------

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
      return headTailCompress(merged.split('\n'), 10, 10, 'line')
    }
    if (sub === 'tasks') {
      return headTailCompress(merged.split('\n'), 20, 5, 'line')
    }
    return this._compressBuild(merged)
  }

  private _compressBuild(merged: string): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let stackFrameCount = 0
    const MAX_STACK_FRAMES = 10
    let suppressedInTrace = 0
    let droppedTaskProgress = 0
    let droppedDownloads = 0
    let droppedDaemon = 0
    let droppedBuildScan = 0
    let droppedDeprecation = 0
    // PASSED and SKIPPED are separate outcomes and are counted separately: a run where tests were skipped must not read as a run where they passed, since `BUILD SUCCESSFUL` is kept either way.
    let droppedTestPassed = 0
    let droppedTestSkipped = 0

    // A stack trace truncated at MAX_STACK_FRAMES with no marker reads as a trace that genuinely ended there, so record how many frames the cap ate and say so where they were cut.
    const flushSuppressedFrames = () => {
      if (suppressedInTrace > 0) {
        kept.push(`[token-goat: …and ${countNoun(suppressedInTrace, 'more stack frame')}]`)
        suppressedInTrace = 0
      }
    }

    for (const line of lines) {
      // Always keep: build result, failure block headers, exception class lines, error lines
      if (
        GRADLE_BUILD_RESULT_RE.test(line) ||
        GRADLE_FAILURE_BLOCK_RE.test(line) ||
        GRADLE_EXCEPTION_CLASS_RE.test(line) ||
        GRADLE_ERROR_LINE_RE.test(line)
      ) {
        flushSuppressedFrames()
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
        } else {
          suppressedInTrace++
        }
        continue
      }
      // Drop: task-progress lines without FAILED, downloads, daemon messages, build scan, deprecation
      if (GRADLE_TEST_METHOD_RE.test(line)) {
        if (line.endsWith('SKIPPED')) droppedTestSkipped++
        else droppedTestPassed++
        continue
      }
      if (GRADLE_TASK_PROGRESS_RE.test(line)) {
        droppedTaskProgress++
        continue
      }
      if (GRADLE_DOWNLOAD_RE.test(line)) {
        droppedDownloads++
        continue
      }
      if (GRADLE_DAEMON_RE.test(line)) {
        droppedDaemon++
        continue
      }
      if (GRADLE_BUILD_SCAN_RE.test(line)) {
        droppedBuildScan++
        continue
      }
      if (GRADLE_DEPRECATION_RE.test(line)) {
        droppedDeprecation++
        continue
      }
      flushSuppressedFrames()
      kept.push(line)
      stackFrameCount = 0
    }
    flushSuppressedFrames()

    const notes: string[] = []
    maybeNote(notes, droppedTaskProgress, `collapsed ${droppedTaskProgress} '> Task :' progress lines`)
    maybeNote(notes, droppedDownloads, `dropped ${droppedDownloads} download lines`)
    maybeNote(notes, droppedDaemon, `dropped ${droppedDaemon} Gradle daemon lines`)
    maybeNote(notes, droppedBuildScan, `dropped ${droppedBuildScan} build-scan lines`)
    maybeNote(notes, droppedDeprecation, `dropped ${droppedDeprecation} deprecation-warning lines`)
    maybeNote(notes, droppedTestPassed, `collapsed ${droppedTestPassed} PASSED test lines`)
    maybeNote(notes, droppedTestSkipped, `collapsed ${droppedTestSkipped} SKIPPED test lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- MavenFilter ---------------------------------------------------------------------------

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
      return headTailCompress(lines, 10, 10, 'line')
    }
    if (sub === 'install') {
      return headTailCompress(lines, 5, 30, 'line')
    }
    if (sub === 'test' || sub === 'verify' || sub === 'package') {
      return this._compressTest(lines)
    }
    return headTailCompress(lines, 10, 10, 'line')
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

// --------------------------------------------------------------------------- AntFilter ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- SbtFilter ---------------------------------------------------------------------------

const SBT_INFO_COMPILING_RE = /^\[info\]\s+Compiling\s+\d+/
const SBT_INFO_DONE_RE = /^\[info\]\s+Done (?:compiling|packaging)\./
const SBT_INFO_LOADING_RE =
  /^\[info\]\s+(?:Loading|Set current project|Resolving|Resolution|Fetching|Updating|Downloading|Downloaded|Loading settings)/i
const SBT_WARN_RE = /^\[warn\]\s/
const SBT_ERROR_RE = /^\[error\]\s/
const SBT_TEST_PROGRESS_RE = /^\[info\]\s+[.FEI!]+\s*$/
// One whitespace character before the lookahead, not a run: the FAILED marker starts with `*`, so it cannot begin inside the run, and a `\s+` there only gave the lookahead a quadratic number of places to rescan.
const SBT_SCALATEST_PASS_RE = /^\[info\]\s+[-+✓]\s(?!.*\*\*\* FAILED \*\*\*)/
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
        // Do not truncate the key: a fixed-length cap makes two DISTINCT [warn] lines that share a long common prefix (e.g. a long file path) collide, silently dropping one as a false "repeat".
        const category = line.trim()
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

// --------------------------------------------------------------------------- JavacFilter ---------------------------------------------------------------------------

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

export const gradleFilter = new GradleFilter()
export const mavenFilter = new MavenFilter()
export const antFilter = new AntFilter()
export const sbtFilter = new SbtFilter()
export const javacFilter = new JavacFilter()
