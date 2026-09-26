// .NET build-tool filters (Batch E): msbuild and the dotnet CLI, each a faithful TypeScript port of its Python counterpart in bash_compress.py. BUILD_FILTERS in build.ts sets their dispatch position.

import { ToolFilter } from './base.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, pathName, positionalArgs, dedupeCombinedOutput } from './helpers.js'

// --------------------------------------------------------------------------- MSBuildFilter ---------------------------------------------------------------------------

const MSBUILD_ERROR_RE = /.*\(\d+(?:,\d+)?\)\s*:\s*error\s+/
const MSBUILD_WARNING_RE = /(.*?)\((\d+)(?:,(\d+))?\)\s*:\s*warning\s+(\w+)/
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
      // Deduplicate warnings by file path + line + column + code (same code on the same line but a different column -- e.g. two unused-parameter warnings on one declaration line -- is a distinct diagnostic and must never be collapsed, same as a different file or line)
      const warnMatch = MSBUILD_WARNING_RE.exec(line)
      if (warnMatch) {
        const filePath = (warnMatch[1] ?? "").trim()
        const lineNum = warnMatch[2] ?? ""
        const colNum = warnMatch[3] ?? ""
        const code = warnMatch[4] ?? ""
        const dedupKey = `${filePath}|${lineNum}|${colNum}|${code}`
        if (!seenWarningCodes.has(dedupKey)) {
          seenWarningCodes.add(dedupKey)
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

// --------------------------------------------------------------------------- DotnetFilter ---------------------------------------------------------------------------

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
    // No errorPassthrough here on purpose: the base class's passthrough returns the whole raw combined output on any non-zero exit, which for `dotnet build` is exactly the multi-thousand-line MSBuild log this filter exists to cut down. Each `_compress*` below drops only lines its own noise patterns match and keeps everything else, so error and warning text survives a failing run without the raw log being shipped whole.
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

export const msbuildFilter = new MSBuildFilter()
export const dotnetFilter = new DotnetFilter()
