// Language-runtime compression filter family (Batch K1).
//
// Faithful TypeScript port of the Python bash_compress.py language/compiler filter sub-family. Dispatch note: NodeFilter uses an eval-only custom matches() so `node script.js` falls through to GenericFilter; all other entries are distinct enough (unique binaries or subcommand gates) that the ordering within LANGUAGE_FILTERS is safe as long as this slice is appended AFTER SHELL_FILE_FILTERS in dispatch.ts.
//
// Factory usage: ErlangFilter, CrystalFilter, HaskellFilter, ElmFilter, JuliaFilter, PowerShellFilter use makeLanguageFilter (shared loop skeleton). SwiftLintFilter uses makeLinterFilter. The remaining 12 are bespoke classes.

import { ToolFilter } from './base.js'
import {
  makeLanguageFilter,
  type AiCliCountedRule,
} from './families.js'
import {
  ERROR_SIGNAL_RE,
  capTokens,
  headTailCompress,
  maybeNote,
  pathStem,
  pathName,
  positionalArgs,
  squeezeBlankLines,
} from './helpers.js'

// ===========================================================================
// NodeFilter
// ===========================================================================

const NODE_INTERNAL_FRAME_RE = /^\s{4}at\s+(?:node:|.+\s+\(node:)/
const NODE_MODULES_FRAME_RE = /^\s{4}at\s+.*[/\\]node_modules[/\\]/

export class NodeFilter extends ToolFilter {
  readonly name = 'node'
  override readonly binaries = new Set(['node', 'nodejs'])

  /** Only match explicit eval/print probes; `node script.js` falls through. */
  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (!this.binaries.has(stem)) return false
    // positionalArgs strips flags, so check raw argv for the eval/print flags.
    return argv.slice(1).some((a) => ['-e', '--eval', '-p', '--print'].includes(a))
  }

  override compress(stdout: string, stderr: string, exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    if (exitCode === 0) {
      return capTokens(merged, 500)
    }
    // Failure: compact stack trace — collapse node_modules and node: internal frames.
    const lines = merged.split('\n')
    const kept: string[] = []
    let collapsedInternal = 0
    let collapsedModules = 0
    for (const line of lines) {
      if (NODE_INTERNAL_FRAME_RE.test(line)) { collapsedInternal++; continue }
      if (NODE_MODULES_FRAME_RE.test(line)) { collapsedModules++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, collapsedInternal, `collapsed ${collapsedInternal} node: internal frame(s)`)
    maybeNote(notes, collapsedModules, `collapsed ${collapsedModules} node_modules frame(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const nodeFilter = new NodeFilter()

// ===========================================================================
// PythonFilter
// ===========================================================================

const PYTHON_FRAME_RE = /^\s+File\s+"[^"]+",\s+line\s+\d+/
const PYTHON_WARNING_RE = /^\s*.*Warning:\s/

export class PythonFilter extends ToolFilter {
  readonly name = 'python'
  override readonly binaries = new Set(['python', 'python3', 'python3.11', 'python3.12', 'python3.13'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (!this.binaries.has(stem)) return false
    // Don't shadow the pytest filter — check raw argv (positionalArgs strips flags).
    const rest = argv.slice(1)
    const mIdx = rest.indexOf('-m')
    if (mIdx !== -1 && rest[mIdx + 1] === 'pytest') return false
    return true
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const afterTraceback = this._compressTraceback(lines)
    const afterDedup = this._dedupeRepeatedLines(afterTraceback)
    const afterWarnings = this._compressWarnings(afterDedup)
    return this.finalize(afterWarnings)
  }

  private _compressTraceback(lines: string[]): string[] {
    const out: string[] = []
    let inTraceback = false
    // Each element is one whole frame: a `File "...", line N, in func` header
    // line plus every trailing context line (source line, and — on Python
    // 3.11+ — a PEP 657 caret-annotation block) up to the next header. Grouping
    // by frame (not raw line) lets us truncate without tearing a frame's
    // header away from its context, or vice versa.
    let frameGroups: string[][] = []
    let headerLine = ''

    const flushFrames = () => {
      if (!inTraceback) return
      inTraceback = false
      if (headerLine) out.push(headerLine)
      if (frameGroups.length <= 10) {
        for (const group of frameGroups) out.push(...group)
      } else {
        for (const group of frameGroups.slice(0, 2)) out.push(...group)
        out.push(`    ... [${frameGroups.length - 5} more frames elided by token-goat]`)
        for (const group of frameGroups.slice(frameGroups.length - 3)) out.push(...group)
      }
      frameGroups = []
      headerLine = ''
    }

    for (const line of lines) {
      if (line.startsWith('Traceback (most recent call last):')) {
        flushFrames()
        inTraceback = true
        headerLine = line
        continue
      }
      if (inTraceback) {
        if (PYTHON_FRAME_RE.test(line)) {
          frameGroups.push([line])
          continue
        }
        if (line.startsWith('    ')) {
          const lastGroup = frameGroups[frameGroups.length - 1]
          if (lastGroup) {
            lastGroup.push(line)
          } else {
            frameGroups.push([line])
          }
          continue
        }
        flushFrames()
        out.push(line)
        continue
      }
      out.push(line)
    }
    flushFrames()
    return out
  }

  private _dedupeRepeatedLines(lines: string[]): string[] {
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      let j = i + 1
      while (j < lines.length && lines[j] === line) j++
      const count = j - i
      if (count >= 5) {
        out.push(line)
        out.push(`[token-goat: previous line repeated ${count - 1} more time(s)]`)
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]!)
      }
      i = j
    }
    return out
  }

  private _compressWarnings(lines: string[]): string[] {
    const out: string[] = []
    const warnCounts = new Map<string, number>()
    for (const line of lines) {
      if (PYTHON_WARNING_RE.test(line)) {
        // Key on the full Warning class + message (not the file:line prefix) so the same warning repeated across different source locations is deduplicated. The key must NOT be truncated: a fixed-length cap makes two DISTINCT warnings that share a long leading substring collide, so one is silently suppressed (and mislabelled as a repeat) once the other fills the keep quota.
        const warnIdx = line.search(/\w+Warning:/)
        const key = warnIdx !== -1 ? line.slice(warnIdx) : line.trim()
        const n = (warnCounts.get(key) ?? 0) + 1
        warnCounts.set(key, n)
        if (n <= 3) out.push(line)
      } else {
        out.push(line)
      }
    }
    let totalSuppressed = 0
    for (const count of warnCounts.values()) {
      if (count > 3) totalSuppressed += count - 3
    }
    if (totalSuppressed > 0) {
      out.push(
        `[token-goat: ${totalSuppressed} repeated warning(s) suppressed; run without TOKEN_GOAT_BASH_COMPRESS for full list]`,
      )
    }
    return out
  }
}

export const pythonFilter = new PythonFilter()

// ===========================================================================
// RubyFilter
// ===========================================================================

const RSPEC_PROGRESS_RE = /^[.FE*]+$/
const RSPEC_SUMMARY_RE = /^\d+ examples?,\s+\d+ failures?/
const RSPEC_FINISHED_RE = /^Finished in \d/
const RSPEC_FAILURE_SECTION_RE = /^Failures:\s*$/
const MINITEST_SUMMARY_RE = /^\d+ runs?,\s+\d+ assertions?/

export class RubyFilter extends ToolFilter {
  readonly name = 'ruby'
  override readonly binaries = new Set(['ruby', 'rspec', 'minitest', 'rake', 'rspec2'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const stem = pathStem(argv[0] ?? '').toLowerCase()

    if (stem === 'rake') {
      return squeezeBlankLines(merged)
    }

    const lines = merged.split('\n')
    const kept: string[] = []
    let dotCount = 0
    let inFailureSection = false
    let summaryLine = ''

    for (const line of lines) {
      if (RSPEC_SUMMARY_RE.test(line) || MINITEST_SUMMARY_RE.test(line)) {
        summaryLine = line
        continue
      }
      if (RSPEC_FINISHED_RE.test(line)) { kept.push(line); continue }
      if (RSPEC_FAILURE_SECTION_RE.test(line)) { inFailureSection = true; kept.push(line); continue }
      if (RSPEC_PROGRESS_RE.test(line)) {
        dotCount += (line.match(/\./g) ?? []).length
        const failures = line.replace(/\./g, '').replace(/\s/g, '')
        if (failures) kept.push(failures)
        continue
      }
      if (inFailureSection || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, dotCount, `collapsed ${dotCount} passing test dot(s)`)
    if (summaryLine) kept.push(summaryLine)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const rubyFilter = new RubyFilter()

// ===========================================================================
// BunFilter
// ===========================================================================

const BUN_DOWNLOAD_RE = /^\s+(?:↕|↑|↓)\s+\S+@\S+|\s+(?:\[downloading\]|\[installed\]|\[cached\])/i
const BUN_INSTALL_SUMMARY_RE =
  /^\s*(?:Saved\s+lockfile|No\s+changes|installed|packages\s+installed|Resolving|Resolved|\d+\s+package[s]?\s+(?:installed|removed|updated|added)|bun\s+install\s+v)/i
const BUN_TEST_HEADER_RE =
  /^bun\s+test\s+v\d|^---+\s*$|^\s*\d+\s+tests?\s+(?:passed|failed|skipped)|\d+\s+(?:pass|fail|skip)/i
const BUN_TEST_PASS_RE = /^\s*✓\s+/
const BUN_TEST_FAIL_RE = /^\s*(?:✗|×|FAIL|✕)\s+/i
const BUN_BUILD_ASSET_RE =
  /^\s+(?:chunk|asset|dist\/|build\/|\.\/)\S+\s+[\d.]+\s+(?:kB|MB|B)/i
const BUN_BUILD_SUMMARY_RE =
  /^\s*\[\d+\]\s+\[[\d.]+\s*(?:kB|MB|B)\]|^\s*\d+\s+file[s]?\s+built|Done in|Build succeeded|Build failed/i

export class BunFilter extends ToolFilter {
  readonly name = 'bun'
  override readonly binaries = new Set(['bun', 'bunx'])
  override readonly subcommands = new Set(['install', 'add', 'remove', 'update', 'test', 'build', 'run'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'install' || sub === 'add' || sub === 'remove' || sub === 'update') {
      return this._compressInstall(lines)
    }
    if (sub === 'test') return this._compressTest(lines)
    if (sub === 'build') return this._compressBuild(lines)

    const nonEmpty = lines.filter((l) => l.trim())
    if (nonEmpty.length <= 80) return this.finalize(lines)
    return headTailCompress(lines, 60, 20, 'lines')
  }

  private _compressInstall(lines: string[]): string {
    const kept: string[] = []
    let downloadCount = 0
    for (const line of lines) {
      if (BUN_DOWNLOAD_RE.test(line)) { downloadCount++; continue }
      if (BUN_INSTALL_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, downloadCount, `collapsed ${downloadCount} package download/install line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let passCount = 0
    for (const line of lines) {
      if (BUN_TEST_PASS_RE.test(line)) { passCount++; continue }
      if (BUN_TEST_FAIL_RE.test(line) || BUN_TEST_HEADER_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} passing test(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressBuild(lines: string[]): string {
    const assetLines: string[] = []
    const kept: string[] = []
    for (const line of lines) {
      if (BUN_BUILD_ASSET_RE.test(line)) { assetLines.push(line); continue }
      if (BUN_BUILD_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const flushed = this._flushAssets(assetLines)
    return this.finalize([...flushed, ...kept])
  }

  private _flushAssets(assets: string[]): string[] {
    if (assets.length <= 10) return assets
    const extra = assets.length - 10
    return [
      ...assets.slice(0, 10),
      `[token-goat: ${extra} more asset/chunk line(s) elided; run 'bun build' for full output]`,
    ]
  }
}

export const bunFilter = new BunFilter()

// ===========================================================================
// DenoFilter
// ===========================================================================

const DENO_TEST_PASS_RE = /^\s*(?:ok\s+\||\bpassed\b|✓)\s+/i
const DENO_TEST_FAIL_RE = /^\s*(?:FAILED|not\s+ok\s+\||✗|failed)\s*/i
const DENO_TEST_SUMMARY_RE = /^test\s+result:|^(?:ok\.|FAILED\.)\s+\d+\s+passed/i
const DENO_CHECK_PROGRESS_RE = /^Check\s+(?:file:\/\/|https?:\/\/)/i
const DENO_PERM_WARN_RE = /^(?:Deno\s+requests|Warning:\s+(?:--allow-|Deno\.|Granted))/i
const DENO_DOWNLOAD_RE = /^Download\s+https?:\/\//i
const DENO_COMPILE_RE = /^Compile\s+/i

export class DenoFilter extends ToolFilter {
  readonly name = 'deno'
  override readonly binaries = new Set(['deno'])
  override readonly subcommands = new Set([
    'test', 'compile', 'bundle', 'check', 'lint', 'fmt', 'run', 'cache', 'install', 'task',
  ])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'test') return this._compressTest(lines)
    if (sub === 'compile' || sub === 'bundle') return this._compressCompile(lines)
    if (sub === 'check' || sub === 'lint' || sub === 'fmt') return this._compressCheck(lines)
    return this._compressGeneric(lines)
  }

  private _compressTest(lines: string[]): string {
    const nonEmpty = lines.filter((l) => l.trim())
    if (nonEmpty.length <= 30) return this.finalize(lines)

    const kept: string[] = []
    let passCount = 0
    for (const line of lines) {
      if (DENO_TEST_PASS_RE.test(line)) { passCount++; continue }
      if (DENO_TEST_FAIL_RE.test(line) || DENO_TEST_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} passing test(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressCompile(lines: string[]): string {
    const kept: string[] = []
    let downloadCount = 0
    for (const line of lines) {
      if (DENO_DOWNLOAD_RE.test(line)) { downloadCount++; continue }
      if (DENO_COMPILE_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, downloadCount, `collapsed ${downloadCount} download line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressCheck(lines: string[]): string {
    const nonEmpty = lines.filter((l) => l.trim())
    if (nonEmpty.length <= 30) return this.finalize(lines)

    const kept: string[] = []
    let progressCount = 0
    let permWarnCount = 0
    for (const line of lines) {
      if (DENO_CHECK_PROGRESS_RE.test(line)) { progressCount++; continue }
      if (DENO_PERM_WARN_RE.test(line)) { permWarnCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, progressCount, `collapsed ${progressCount} check-progress line(s)`)
    maybeNote(notes, permWarnCount, `collapsed ${permWarnCount} permission warning(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGeneric(lines: string[]): string {
    const nonEmpty = lines.filter((l) => l.trim())
    if (nonEmpty.length <= 30) return this.finalize(lines)
    return headTailCompress(lines, 40, 20, 'lines')
  }
}

export const denoFilter = new DenoFilter()

// ===========================================================================
// FlutterFilter
// ===========================================================================

const FLUTTER_COMPILING_RE = /^Compiling\s+lib\//
const FLUTTER_BUILT_RE = /^[✓✔]\s+Built\s+\S/
const FLUTTER_FONT_ASSET_RE = /^Font asset\s/
const FLUTTER_GRADLE_RE = /^Running Gradle task\s/
const FLUTTER_TEST_PROGRESS_RE = /^\d{2}:\d{2}\s+[+\d]/
const FLUTTER_TEST_SUMMARY_RE = /(?:All tests passed!|\d+\s+test[s]?\s+(?:passed|failed))/
const FLUTTER_PUB_KEEP_RE =
  /^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|Downloading packages|Building package executable|Package\s+\w+\s+is)/
const FLUTTER_PUB_PKG_LINE_RE = /^\+\s+\S+\s+\S+/

export class FlutterFilter extends ToolFilter {
  readonly name = 'flutter'
  override readonly binaries = new Set(['flutter'])
  override readonly subcommands = new Set(['build', 'test', 'run', 'pub'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'build') return this._compressBuild(lines)
    if (sub === 'test') return this._compressTest(lines)
    if (sub === 'pub') return this._compressPub(lines)
    return this.finalize(lines)
  }

  private _compressBuild(lines: string[]): string {
    const kept: string[] = []
    let compilingCount = 0
    let fontAssetCount = 0
    for (const line of lines) {
      if (FLUTTER_COMPILING_RE.test(line)) { compilingCount++; continue }
      if (FLUTTER_FONT_ASSET_RE.test(line)) { fontAssetCount++; continue }
      if (FLUTTER_GRADLE_RE.test(line) || FLUTTER_BUILT_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, compilingCount, `collapsed ${compilingCount} Dart source compilation(s)`)
    maybeNote(notes, fontAssetCount, `collapsed ${fontAssetCount} font asset line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let progressCount = 0
    for (const line of lines) {
      if (FLUTTER_TEST_PROGRESS_RE.test(line)) { progressCount++; continue }
      if (FLUTTER_TEST_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, progressCount, `collapsed ${progressCount} test-progress line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressPub(lines: string[]): string {
    const kept: string[] = []
    let pkgCount = 0
    for (const line of lines) {
      if (FLUTTER_PUB_PKG_LINE_RE.test(line)) { pkgCount++; continue }
      if (FLUTTER_PUB_KEEP_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, pkgCount, `collapsed ${pkgCount} package line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const flutterFilter = new FlutterFilter()

// ===========================================================================
// DartFilter
// ===========================================================================

const DART_ANALYZING_RE = /^Analyzing\s/
const DART_ANALYZE_RESULT_RE = /^(?:No issues found!|\d+ issue[s]? found\.|warning -|error -|info -|hint -)/
const DART_TEST_PROGRESS_RE = /^\d{2}:\d{2}\s+[+\d]|^[.]+$/
const DART_COMPILE_DONE_RE = /^(?:Generated:\s|Compiling\s)/
const DART_TEST_SUMMARY_RE = /(?:All tests passed\.?|\d+\s+test[s]?\s+(?:passed|failed))/
const PUB_KEEP_RE =
  /^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|Downloading packages|Building package executable)/
const PUB_PKG_LINE_RE = /^[+>!]\s+\S+\s+\S+/
const PUB_DOWNLOADING_RE = /^Downloading\s+\S+\s+\S+/

export class DartFilter extends ToolFilter {
  readonly name = 'dart'
  override readonly binaries = new Set(['dart'])
  override readonly subcommands = new Set(['compile', 'test', 'pub', 'analyze', 'run', 'format'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'analyze') return this._compressAnalyze(lines)
    if (sub === 'test') return this._compressTest(lines)
    if (sub === 'pub') return this._compressPub(lines)
    return this._compressGeneric(lines)
  }

  private _compressAnalyze(lines: string[]): string {
    const kept: string[] = []
    let analyzingCount = 0
    for (const line of lines) {
      if (DART_ANALYZING_RE.test(line)) { analyzingCount++; continue }
      if (DART_ANALYZE_RESULT_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, analyzingCount, `collapsed ${analyzingCount} analysis-progress line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let progressCount = 0
    for (const line of lines) {
      if (DART_TEST_PROGRESS_RE.test(line)) { progressCount++; continue }
      if (DART_TEST_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, progressCount, `collapsed ${progressCount} test-progress line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressPub(lines: string[]): string {
    const kept: string[] = []
    let pkgCount = 0
    let downloadCount = 0
    for (const line of lines) {
      if (PUB_PKG_LINE_RE.test(line)) { pkgCount++; continue }
      if (PUB_DOWNLOADING_RE.test(line)) { downloadCount++; continue }
      if (PUB_KEEP_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, pkgCount, `collapsed ${pkgCount} package line(s)`)
    maybeNote(notes, downloadCount, `collapsed ${downloadCount} download line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressGeneric(lines: string[]): string {
    const kept: string[] = []
    let compileCount = 0
    for (const line of lines) {
      if (DART_COMPILE_DONE_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (/^Compiling\s/i.test(line)) { compileCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} compilation step(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const dartFilter = new DartFilter()

// ===========================================================================
// SwiftFilter
// ===========================================================================

const SWIFT_COMPILE_RE =
  /^\s*(?:CompileSwift|CompileSwiftSources|MergeSwiftModule|PhaseScriptExecution|CpResource|CpHeader|ProcessInfoPlistFile|Ld\s|CodeSign\s|Touch\s|note:\s+compile\s+Swift\s+module)\s/
const SWIFT_TEST_PASS_RE = /^Test Case\s+.+\s+passed\s+\(/
const SWIFT_TEST_START_RE = /^Test Case\s+.+\s+started\.$/
const SWIFT_TEST_FAIL_RE = /^Test Case\s+.+\s+failed\s+\(/
const SWIFT_SUITE_RE = /^Test Suite\s+.+\s+(?:passed|failed)\s+at\b/
const SWIFT_RESULTS_RE = /^Executed \d+ test/
const SWIFT_BUILD_COMPLETE_RE =
  /^\*\*\s*BUILD SUCCEEDED\s*\*\*|\*\*\s*BUILD FAILED\s*\*\*|^Build complete!/
const SWIFT_DIAG_RE = /^.*:\d+:\d+:\s+(?:warning|error):\s/

export class SwiftFilter extends ToolFilter {
  readonly name = 'swift'
  override readonly binaries = new Set(['swift'])
  override readonly subcommands = new Set(['build', 'test', 'run', 'package'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'test') return this._compressTest(lines)
    return this._compressBuild(lines)
  }

  private _compressBuild(lines: string[]): string {
    const kept: string[] = []
    let compileCount = 0
    for (const line of lines) {
      if (SWIFT_COMPILE_RE.test(line)) { compileCount++; continue }
      if (SWIFT_BUILD_COMPLETE_RE.test(line) || SWIFT_DIAG_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} compile/link step(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let passCount = 0
    let startCount = 0
    for (const line of lines) {
      if (SWIFT_TEST_PASS_RE.test(line)) { passCount++; continue }
      if (SWIFT_TEST_START_RE.test(line)) { startCount++; continue }
      if (
        SWIFT_TEST_FAIL_RE.test(line) ||
        SWIFT_SUITE_RE.test(line) ||
        SWIFT_RESULTS_RE.test(line) ||
        SWIFT_DIAG_RE.test(line) ||
        ERROR_SIGNAL_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, passCount + startCount, `collapsed ${passCount + startCount} test-pass/start line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const swiftFilter = new SwiftFilter()


// ===========================================================================
// XcodeFilter
// ===========================================================================

const XCODE_SECTION_RE = /^=== .+ ===$/
const XCODE_COMPILE_RE =
  /^\s*(?:CompileSwiftSources|CompileSwift|CompileC|CpHeader|ProcessInfoPlistFile|CopySwiftLibs|GenerateDSYMFile|Ld\s|CodeSign\s|Touch\s|PhaseScriptExecution\s|MergeSwiftModule\s|CompileAssetCatalog\s|RegisterWithLaunchServices\s|Validate\s|CreateBuildDirectory\s)\s*/
const XCODE_STATUS_RE =
  /^\*\*\s*BUILD (?:SUCCEEDED|FAILED)\s*\*\*|\*\*\s*TEST (?:SUCCEEDED|FAILED)\s*\*\*|\*\*\s*RUN (?:SUCCEEDED|FAILED)\s*\*\*/
const XCODE_DIAG_RE = /^.+:\d+:\d+:\s+(?:warning|error):\s/
const XCODE_TASK_BODY_RE = /^\s{4,}/

export class XcodeFilter extends ToolFilter {
  readonly name = 'xcode'
  override readonly binaries = new Set(['xcodebuild'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let compileCount = 0
    let taskBodyCount = 0

    for (const line of lines) {
      if (
        ERROR_SIGNAL_RE.test(line) ||
        XCODE_SECTION_RE.test(line) ||
        XCODE_STATUS_RE.test(line) ||
        XCODE_DIAG_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (XCODE_COMPILE_RE.test(line)) { compileCount++; continue }
      if (XCODE_TASK_BODY_RE.test(line)) { taskBodyCount++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, compileCount, `collapsed ${compileCount} compile/link step(s)`)
    maybeNote(notes, taskBodyCount, `collapsed ${taskBodyCount} task-body line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const xcodeFilter = new XcodeFilter()

// ===========================================================================
// MixFilter  (Elixir)
// ===========================================================================

const MIX_GETTING_DEP_RE = /^\* Getting (\S+)\s/
const MIX_COMPILING_RE = /^Compiling \d+ file/
const MIX_GENERATED_RE = /^Generated \S+ app$/
const MIX_WARNING_RE = /^\s*warning:/
const MIX_TEST_DOTS_RE = /^[.EF*]+\s*$/
const MIX_TEST_SUMMARY_RE = /^\d+ tests?, \d+ failure/
const MIX_TEST_FINISHED_RE = /^Finished in \d/
const MIX_TEST_FAILURE_HEADER_RE = /^\s+\d+\)/
const MIX_MIGRATION_RE = /== (?:Running|Migrated)/

export class MixFilter extends ToolFilter {
  readonly name = 'mix'
  override readonly binaries = new Set(['mix'])
  override readonly subcommands = new Set([
    'compile', 'test', 'deps.get', 'phx.server', 'ecto.migrate', 'ecto.create',
    'ecto.drop', 'ecto.rollback', 'run', 'release',
  ])

  /** Allow `mix` with no subcommand to match too. */
  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem !== 'mix') return false
    const pos = positionalArgs(argv.slice(1))
    if (!pos.length) return true
    return this.subcommands.has(pos[0]!)
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const pos = positionalArgs(argv.slice(1))
    const sub = pos[0] ?? ''

    if (sub === 'deps.get') return this._compressDepsGet(lines)
    if (sub === 'compile') return this._compressCompile(lines)
    if (sub === 'test') return this._compressTest(lines)
    if (sub.startsWith('ecto.')) return this._compressEcto(lines)
    return this.finalize(lines)
  }

  private _compressDepsGet(lines: string[]): string {
    const kept: string[] = []
    let depCount = 0
    for (const line of lines) {
      if (MIX_GETTING_DEP_RE.test(line)) { depCount++; continue }
      if (MIX_GENERATED_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, depCount, `collapsed ${depCount} dependency fetch line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressCompile(lines: string[]): string {
    const kept: string[] = []
    let compilingCount = 0
    for (const line of lines) {
      if (MIX_COMPILING_RE.test(line)) { compilingCount++; continue }
      if (MIX_WARNING_RE.test(line) || MIX_GENERATED_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, compilingCount, `collapsed ${compilingCount} compilation batch(es)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let dotCount = 0
    for (const line of lines) {
      if (MIX_TEST_DOTS_RE.test(line)) {
        dotCount += (line.match(/\./g) ?? []).length
        const failures = line.replace(/\./g, '').replace(/\s/g, '')
        if (failures) kept.push(failures)
        continue
      }
      if (
        MIX_TEST_SUMMARY_RE.test(line) ||
        MIX_TEST_FINISHED_RE.test(line) ||
        MIX_TEST_FAILURE_HEADER_RE.test(line) ||
        ERROR_SIGNAL_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, dotCount, `collapsed ${dotCount} passing test dot(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressEcto(lines: string[]): string {
    for (const line of lines) {
      if (!MIX_MIGRATION_RE.test(line) && !ERROR_SIGNAL_RE.test(line) && line.trim()) {
        // fall through to full output for simple ecto commands
      }
    }
    return this.finalize(lines)
  }
}

export const mixFilter = new MixFilter()

// ===========================================================================
// ZigFilter
// ===========================================================================

const ZIG_BUILD_STEP_RE = /^\s*\[\d+\/\d+\]\s+/
const ZIG_BUILD_SUMMARY_RE = /^\s*Build\s+Summary:|\s*\d+\s+step[s]?\s+(?:succeeded|failed)/i
const ZIG_DIAG_RE = /^(.+\.zig):(\d+):(\d+):\s+(?:error|note|warning):\s+/i
const ZIG_TEST_LINE_RE = /^\s*test\s+"[^"]*"\.\.\./i
const ZIG_TEST_PASS_RE = /\.\.\.\s+OK\s*$/i
const ZIG_TEST_SUMMARY_RE =
  /^\s*(?:All \d+ tests? passed|\d+\s+test[s]?\s+(?:passed|failed)|Tests run:\s*\d|FAIL\s*\()/i
const ZIG_FETCH_RE = /^\s*(?:fetching|fetch\s+https?:\/\/|info:\s+Found\s+cached)|\bzig\s+fetch\b/i
const ZIG_INFO_NOISE_RE = /^\s*info:\s+(?:Resolving|Downloading|Checking|Extracting|Cached)\b/i
const ZIG_STEP_SAMPLE = 5

export class ZigFilter extends ToolFilter {
  readonly name = 'zig'
  override readonly binaries = new Set(['zig'])
  override readonly subcommands = new Set(['build', 'test', 'fmt', 'run', 'fetch'])

  override compress(stdout: string, stderr: string, exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const stepSample: string[] = []
    let stepCount = 0
    let testPassCount = 0
    let fetchCount = 0
    let infoNoiseCount = 0

    for (const line of lines) {
      if (
        ZIG_BUILD_SUMMARY_RE.test(line) ||
        ZIG_DIAG_RE.test(line) ||
        ZIG_TEST_SUMMARY_RE.test(line) ||
        ERROR_SIGNAL_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (ZIG_BUILD_STEP_RE.test(line)) {
        stepCount++
        if (stepCount <= ZIG_STEP_SAMPLE) stepSample.push(line)
        continue
      }
      if (ZIG_TEST_LINE_RE.test(line)) {
        if (ZIG_TEST_PASS_RE.test(line)) { testPassCount++; continue }
        kept.push(line)
        continue
      }
      if (ZIG_FETCH_RE.test(line)) { fetchCount++; continue }
      if (ZIG_INFO_NOISE_RE.test(line) && exitCode === 0) { infoNoiseCount++; continue }
      kept.push(line)
    }

    // Output: step_sample first, then "+N more" note, then kept body
    const out: string[] = [...stepSample]
    if (stepCount > ZIG_STEP_SAMPLE) {
      out.push(`[token-goat: +${stepCount - ZIG_STEP_SAMPLE} more build step(s)...]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, testPassCount, `collapsed ${testPassCount} passing test(s)`)
    maybeNote(notes, fetchCount, `collapsed ${fetchCount} fetch line(s)`)
    maybeNote(notes, infoNoiseCount, `dropped ${infoNoiseCount} info-noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const zigFilter = new ZigFilter()

// ===========================================================================
// RCmdFilter  (R CMD check / Rscript)
// ===========================================================================

const R_CHECKING_RE = /^\s*\*\s+checking\s+\S/i
const R_CHECKING_OK_RE = /^\s*\*\s+checking\s+.*\s+(?:OK|SKIPPED)\s*$/i
const R_DONE_RE = /^\s*\*\s+DONE\s*\(/i
const R_STATUS_RE =
  /^\s*(?:Status:\s+|R\s+CMD\s+check\s+results?|0\s+errors\s+\||\d+\s+errors?\s+\||\d+\s+warning[s]?\s+\||\d+\s+note[s]?\s+\|)/i
const R_ISSUE_RE = /^\s*(?:\*\s+)?(?:ERROR|WARNING|NOTE)[\s:]/i
const R_LOADING_RE =
  /^\s*(?:\*\s+(?:using\s+R|installing\s+the\s+package|loading\s+the\s+package|preparing\s+'|running\s+'DESCRIPTION'|running\s+'configure')|Loading\s+required\s+(?:package|namespace):\s+\S+|Attaching\s+package:\s+\S+)/i
const R_RUNNING_RE =
  /^\s*(?:\*\s+(?:running\s+(?:examples|tests|vignettes?|R\s+code|docstest)|checking\s+(?:examples?|test\s+files)))/i
const R_SECTION_HEADER_RE =
  /^\s*\*{1,2}\s+(?:building\s+|preparing\s+|testing\s+|installing\s+|byte.compiling|creating\s+)\S/i

export class RCmdFilter extends ToolFilter {
  readonly name = 'rcmd'
  override readonly binaries = new Set(['r', 'rscript'])
  override readonly errorPassthrough = true

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const name = pathName(argv[0]!).toLowerCase()
    if (stem === 'rscript' || name === 'rscript.exe') return true
    if (stem === 'r' || name === 'r.exe') {
      const pos = positionalArgs(argv.slice(1))
      return pos.length > 0 && pos[0]!.toUpperCase() === 'CMD'
    }
    return false
  }

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let okCount = 0
    let installSectionCount = 0

    for (const line of lines) {
      if (R_CHECKING_RE.test(line)) {
        if (R_CHECKING_OK_RE.test(line)) okCount++
        else kept.push(line)
        continue
      }
      if (R_DONE_RE.test(line) || R_STATUS_RE.test(line) || R_ISSUE_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (R_LOADING_RE.test(line) || R_RUNNING_RE.test(line)) { installSectionCount++; continue }
      if (R_SECTION_HEADER_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }

    const prepend: string[] = []
    if (okCount) prepend.push(`[token-goat: collapsed ${okCount} R CMD check-OK line(s)]`)
    if (installSectionCount) prepend.push(`[token-goat: collapsed ${installSectionCount} package installation/loading line(s)]`)
    return this.finalize([...prepend, ...kept])
  }
}

export const rCmdFilter = new RCmdFilter()

// ===========================================================================
// Factory-built filters (makeLanguageFilter)
// ===========================================================================

// ---------------------------------------------------------------------------
// ErlangFilter  (rebar3 / rebar)
// ---------------------------------------------------------------------------

const REBAR3_COMPILING_RE = /^===>\s+\S+\s+\(compile\)|^Compiling\s+\S+\.erl\b/i
const REBAR3_FETCH_RE =
  /^(?:Fetching|Downloading|Resolving|Locking)\s+\S|^\s*Already\s+up-to-date\b|^\s*All\s+dependencies\s+already\s+locked\b/i
const REBAR3_STEP_NOISE_RE =
  /^===>\s+(?:Verifying\s+dependencies|Analyzing\s+applications|Building\s+rebar3\b|Compiling\s+rebar3\b|Using\s+locked\s+dependencies|Updating\s+base\s+application\b)/i
const REBAR3_EUNIT_PASS_RE = /^\s+\S+_tests?:\S+\.\.\.(ok|passed)\s*$/i
const REBAR3_CT_PASS_RE =
  /^\s+(?:tc_passed|PASSED|ok)\s+\S+\s*$|^\s+\d+\s+tests?,\s+\d+\s+(?:passed|ok)\b/i
const REBAR3_SUMMARY_RE =
  /^===>\s+(?:Tests?\s+passed|Done\.|Finished\.|\d+\s+tests?\s+passed|All\s+\d+\s+tests?\s+passed)|^\s*All\s+\d+\s+tests?\s+passed\b|^\s*\d+\s+tests?,\s+\d+\s+(?:failed|errors?)\b|Test\s+Summary\s*:.*passed\b/i
const REBAR3_FAILURE_RE =
  /^===>\s+(?:ERROR|FAILED|Test\s+Failed|Tests?\s+Failed)|^\s*(?:FAILED|ERROR|failed|error)\s*$|^\s*\*{3}/i

export const erlangFilter = makeLanguageFilter({
  name: 'rebar3',
  binaries: ['rebar3', 'rebar'],
  subcommands: [
    'compile', 'test', 'ct', 'eunit', 'escriptize', 'release', 'deps', 'unlock',
    'update', 'as', 'dialyzer', 'xref', 'cover', 'clean', 'check', 'do',
  ],
  errorPassthrough: true,
  alwaysKeepRe: new RegExp(
    [ERROR_SIGNAL_RE.source, REBAR3_SUMMARY_RE.source, REBAR3_FAILURE_RE.source].join('|'),
    'i',
  ),
  countedRules: [
    {
      re: REBAR3_COMPILING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} Erlang module compilation(s)]`,
    },
    {
      re: REBAR3_FETCH_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} dependency fetch/resolve line(s)]`,
    },
    {
      re: REBAR3_STEP_NOISE_RE,
      position: 'note',
      note: (n) => `dropped ${n} rebar3 build-step line(s)`,
    },
    {
      res: [REBAR3_EUNIT_PASS_RE, REBAR3_CT_PASS_RE],
      position: 'note',
      note: (n) => `collapsed ${n} test-pass line(s)`,
    },
  ] as AiCliCountedRule[],
})

// ---------------------------------------------------------------------------
// CrystalFilter  (crystal / shards)
// ---------------------------------------------------------------------------

const CRYSTAL_COMPILING_RE =
  /^\s*(?:Compiling\s+\S+|Linking\s+crystal\s+spec|crystal\s+spec\s+\S+\.cr\b)/i
const CRYSTAL_SPEC_PASS_RE = /^\s*(?:\.\s*)+$|^\s*✓\s+.+\(\d+/i
const CRYSTAL_DOT_PROGRESS_RE = /^\s*[.]+\s*$/
const CRYSTAL_SUMMARY_RE =
  /^\s*(?:Finished\s+in\s+[\d.]+\s+(?:second|millisecond)|\d+\s+example[s]?[,\s]|Pending:\s+\d+|\d+\s+failure[s]?|(?:All\s+)?\d+\s+spec[s]?\s+(?:passed|failed))/i
const CRYSTAL_FAILURE_HEADER_RE = /^\s*(?:Failures:|Errors:|\d+\)\s+\S)/i
const CRYSTAL_SHARDS_PROGRESS_RE =
  /^\s*(?:Using\s+\S+\s+\(|Writing\s+shard\.lock|Fetching\s+https?:\/\/|Cloning\s+\S+|Resolving\s+\S+|Updating\s+\S+\s+\(|Installed\s+\S+|Installing\s+\S+)/i
const CRYSTAL_SHARDS_DONE_RE =
  /^\s*(?:Shards\s+are\s+up\s+to\s+date|\d+\s+shard[s]?\s+(?:installed|updated)|Dependencies\s+installed)/i

export const crystalFilter = makeLanguageFilter({
  name: 'crystal',
  binaries: ['crystal', 'shards'],
  errorPassthrough: true,
  alwaysKeepRe: new RegExp(
    [
      ERROR_SIGNAL_RE.source,
      CRYSTAL_SUMMARY_RE.source,
      CRYSTAL_FAILURE_HEADER_RE.source,
      CRYSTAL_SHARDS_DONE_RE.source,
    ].join('|'),
    'i',
  ),
  countedRules: [
    {
      re: CRYSTAL_COMPILING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} Crystal compiling/linking step(s)]`,
    },
    {
      re: CRYSTAL_SHARDS_PROGRESS_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} shards dependency operation(s)]`,
    },
    {
      re: CRYSTAL_SPEC_PASS_RE,
      position: 'note',
      note: (n) => `collapsed ${n} spec-pass line(s)`,
    },
    {
      re: CRYSTAL_DOT_PROGRESS_RE,
      position: 'note',
      note: (n) => `collapsed ${n} progress dot(s)`,
    },
  ] as AiCliCountedRule[],
})

// ---------------------------------------------------------------------------
// HaskellFilter  (cabal / stack / ghc)
// ---------------------------------------------------------------------------

const HASKELL_RESOLVING_RE =
  /^\s*(?:Resolving\s+dependencies|Downloading\s+\S+\s+from\s+Hackage|Downloading\s+\S+\s+\.\.\.|Fetching\s+package|Configuring\s+\S+\.\.\.|Preprocessing\s+\S+\s+for|Starting\s+to\s+install)/i
const HASKELL_COMPILING_RE =
  /^\s*(?:\[\s*\d+\s+of\s+\d+\]\s+Compiling\s+\S+|Compiling\s+\S+(?:\s+\(\s*\S+,\s*\S+\))?\.\.\.?)/
const HASKELL_LINKING_RE =
  /^\s*(?:Linking\s+\S+|Building\s+all\s+executables|Building\s+library\s+for\s+|Building\s+executable|Installed\s+\S+(?:\s+\d+\.\d+)?)/i
const HASKELL_INSTALLING_RE =
  /^\s*(?:Installing\s+(?:library|executable)\s+in|Registering\s+library|Updating\s+package\s+list|Reading\s+available\s+packages)/i
const HASKELL_SUCCESS_RE =
  /^\s*(?:Completed\s+\d+\s+action|Build\s+completed|Finished\s+building\s+package|All\s+\d+\s+tests\s+passed|Test\s+suite\s+\S+:\s+PASS|\d+\s+out\s+of\s+\d+\s+test\s+suites\s+\(|Tests\s+complete\b)/i
const HASKELL_TEST_FAIL_RE =
  /^\s*(?:Test\s+suite\s+\S+:\s+FAIL|FAILURES:|failures:|\d+\s+test\s+(?:case[s]?\s+)?(?:failed|FAILED))/i
const HASKELL_WARNING_RE = /^\s*(?:Warning:\s+|Module\s+'?\S+'?\s+does\s+not\s+export|Defined\s+but\s+not\s+used:)/
const HASKELL_ERROR_PREFIX_RE = /^\s*(?:cabal:|stack:|ghc:|error:|Error:)\s+/i

export const haskellFilter = makeLanguageFilter({
  name: 'haskell',
  binaries: ['cabal', 'stack', 'ghc', 'runghc', 'runhaskell'],
  errorPassthrough: true,
  alwaysKeepRe: new RegExp(
    [
      ERROR_SIGNAL_RE.source,
      HASKELL_SUCCESS_RE.source,
      HASKELL_TEST_FAIL_RE.source,
      HASKELL_ERROR_PREFIX_RE.source,
      HASKELL_INSTALLING_RE.source,
    ].join('|'),
    'i',
  ),
  countedRules: [
    {
      re: HASKELL_RESOLVING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} dependency resolve/download line(s)]`,
    },
    {
      re: HASKELL_COMPILING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} module compilation(s)]`,
    },
    {
      re: HASKELL_LINKING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} linking/building step(s)]`,
    },
  ] as AiCliCountedRule[],
  dedupeRules: [
    {
      re: HASKELL_WARNING_RE,
      maxPerKey: 3,
      keyLen: 40,
      note: (n) => `deduplicated ${n} repeated warning(s)`,
    },
  ],
})

// ---------------------------------------------------------------------------
// ElmFilter
// ---------------------------------------------------------------------------

const ELM_DOWNLOADING_RE =
  /^\s*(?:Starting downloads\.\.\.|Downloading\s+\S+\s+\(\d+\.\d+\.\d+\))/i
const ELM_FETCH_SUCCESS_RE =
  /^\s*(?:Success!\s+Fetched\s+\d+\s+package|Packages\s+configured\s+successfully)/i
const ELM_DOT_PROGRESS_RE = /^\s*[.]+\s*$/
const ELM_DEPS_PROGRESS_RE =
  /^\s*(?:Building dependencies|Verifying\s+(?:dependencies|packages)|Updating\s+package\s+catalog|Solving\s+dependencies)/i
const ELM_COMPILING_RE = /^\s*(?:Compiling\s+\S+\.elm|Starting\s+compilation)/i
const ELM_SUCCESS_RE =
  /^\s*(?:Success!|Successfully\s+generated|Compilation\s+complete|Done!\s+Compiled\s+\d+)/i
const ELM_ERROR_HEADER_RE = /^\s*--\s+[A-Z][A-Z0-9 _]+[A-Z0-9]\s*(?:-+|in\s+\S+)?\s*$/
const ELM_ERROR_SUMMARY_RE =
  /^\s*(?:Detected\s+\d+\s+error|I\s+ran\s+into\s+\d+\s+problem|\d+\s+error[s]?\s+found)/i

export const elmFilter = makeLanguageFilter({
  name: 'elm',
  binaries: ['elm'],
  errorPassthrough: true,
  alwaysKeepRe: new RegExp(
    [
      ERROR_SIGNAL_RE.source,
      ELM_SUCCESS_RE.source,
      ELM_FETCH_SUCCESS_RE.source,
      ELM_ERROR_HEADER_RE.source,
      ELM_ERROR_SUMMARY_RE.source,
    ].join('|'),
    'i',
  ),
  countedRules: [
    {
      re: ELM_DOWNLOADING_RE,
      position: 'prepend',
      note: (n) =>
        `[token-goat: Downloaded ${n} Elm package(s); disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
    },
    {
      re: ELM_COMPILING_RE,
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} Elm source file compilation(s)]`,
    },
  ] as AiCliCountedRule[],
  dropRules: [ELM_DOT_PROGRESS_RE, ELM_DEPS_PROGRESS_RE],
  droppedNoiseNote: (n) => `dropped ${n} dependency-progress line(s)`,
})

// ---------------------------------------------------------------------------
// JuliaFilter
// ---------------------------------------------------------------------------

const JULIA_PKG_RESOLVING_RE =
  // eslint-disable-next-line no-control-regex
  /^\s*(?:\x1b\[[0-9;]*m)?\s*(?:Resolving|Updating|Fetching|Precompiling|Downgrading|Upgrading|Cloning|Archiving)\s+/i
const JULIA_PKG_DEP_LINE_RE =
  // eslint-disable-next-line no-control-regex
  /^\s*(?:\x1b\[[0-9;]*m)?\s*\[[0-9a-f]{8}\]\s+(?:[+\-↑↓~→⇒✓]|\w)/
// eslint-disable-next-line no-control-regex
const JULIA_PKG_INSTALLED_RE = /^\s*(?:\x1b\[[0-9;]*m)?\s*Installed\s+\S+\s+/i
const JULIA_PKG_BUILDING_RE =
  // eslint-disable-next-line no-control-regex
  /^\s*(?:\x1b\[[0-9;]*m)?\s*Building\s+\S+\s*(?:→|->|─+)?\s*/i
// eslint-disable-next-line no-control-regex
const JULIA_PKG_STATUS_RE = /^\s*(?:\x1b\[[0-9;]*m)?\s*Status\s+`/i
const JULIA_TEST_SUMMARY_RE =
  /^\s*(?:Test\s+Summary:|Tests\s+run:|\d+\s+test[s]?\s+(?:passed|failed)|ALL_TESTS_PASS|Testing\s+\S+\s+done|No\s+tests\s+failed)/i
const JULIA_TEST_PASS_RE = /^\s*(?:✓|PASS:|Test\s+Passed)\s+/i
// eslint-disable-next-line no-control-regex
const JULIA_TESTING_HEADER_RE = /^\s*(?:\x1b\[[0-9;]*m)?\s*Testing\s+\S+/i
const JULIA_PRECOMPILE_RE =
  // eslint-disable-next-line no-control-regex
  /^\s*(?:\x1b\[[0-9;]*m)?\s*\d+\s+(?:package[s]?\s+being\s+precompiled|dependency\s+precompil)/i

export const juliaFilter = makeLanguageFilter({
  name: 'julia',
  binaries: ['julia'],
  errorPassthrough: true,
  alwaysKeepRe: new RegExp(
    [ERROR_SIGNAL_RE.source, JULIA_TEST_SUMMARY_RE.source, JULIA_TESTING_HEADER_RE.source].join('|'),
    'i',
  ),
  countedRules: [
    {
      res: [JULIA_PKG_DEP_LINE_RE, JULIA_PKG_STATUS_RE],
      position: 'prepend',
      note: (n) =>
        `[token-goat: ${n} Julia package operation(s); disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
    },
    {
      res: [JULIA_PKG_RESOLVING_RE, JULIA_PKG_INSTALLED_RE, JULIA_PKG_BUILDING_RE, JULIA_PRECOMPILE_RE],
      position: 'prepend',
      note: (n) => `[token-goat: collapsed ${n} Pkg progress banner(s)]`,
    },
    {
      re: JULIA_TEST_PASS_RE,
      position: 'note',
      note: (n) => `collapsed ${n} test-pass line(s)`,
    },
  ] as AiCliCountedRule[],
})

// ---------------------------------------------------------------------------
// PowerShellFilter
// ---------------------------------------------------------------------------

const PWSH_VERBOSE_RE = /^VERBOSE:\s/i
const PWSH_DEBUG_RE = /^DEBUG:\s/i
const PWSH_WARNING_RE = /^WARNING:\s/i
const PWSH_INSTALL_MODULE_RE = /^(?:Install-Module:|PackageManagement\\|Installing package)\s/i
const PWSH_PROGRESS_RECORD_RE =
  /^(?:Processing record\s+\d+\s+of\s+\d+|PROGRESS:\s+\d+%)/i

// A CommandNotFoundException ErrorRecord is PowerShell's well-documented,
// version-stable error-record shape for "command not found" -- most commonly
// hit here when Git-Bash pre-expands an unescaped `$_` (bash's own "last arg
// of previous command") before pwsh/powershell ever sees the -Command string,
// mangling it into a bogus binary name. The ErrorRecord itself is what is
// noisy (a multi-KB stack trace for a one-line diagnosis), so detection keys
// on the two stable markers -- `+ CategoryInfo ... ObjectNotFound:` and
// `+ FullyQualifiedErrorId : CommandNotFoundException` -- rather than the $_
// cause specifically; the shape is noise regardless of what produced it.
const PS_CNF_ERROR_RE =
  /^(\S.*?) : (?:The term '.*?' is|.*? is) not recognized as the name of a cmdlet, function, script file, or operable program\.\r?\n(?:.*\r?\n)*?[ \t]*\+ CategoryInfo\s*:\s*ObjectNotFound:\s*\(([^:]*):String\)\s*\[\],\s*CommandNotFoundException\r?\n[ \t]*\+ FullyQualifiedErrorId\s*:\s*CommandNotFoundException\r?\n?/gm

export class PowerShellErrorFilter extends ToolFilter {
  readonly name = 'powershell'
  override readonly binaries = new Set(['pwsh', 'powershell', 'powershell.exe'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const collapsed = this._collapseCommandNotFound(merged)
    const lines = collapsed.split('\n')
    const kept: string[] = []
    let noiseCount = 0
    const warnSeen = new Map<string, number>()
    let warnElided = 0

    for (const line of lines) {
      if (
        PWSH_VERBOSE_RE.test(line) ||
        PWSH_DEBUG_RE.test(line) ||
        PWSH_INSTALL_MODULE_RE.test(line) ||
        PWSH_PROGRESS_RECORD_RE.test(line)
      ) {
        noiseCount++
        continue
      }
      if (PWSH_WARNING_RE.test(line)) {
        const key = line.slice(0, 40)
        const n = (warnSeen.get(key) ?? 0) + 1
        warnSeen.set(key, n)
        if (n <= 1) kept.push(line)
        else warnElided++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    if (noiseCount > 0) notes.push(`collapsed ${noiseCount} verbose/debug/install-progress line(s)`)
    if (warnElided > 0) notes.push(`deduplicated ${warnElided} repeated WARNING(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  /** Replace each matched CommandNotFoundException ErrorRecord block with one summary line. */
  private _collapseCommandNotFound(text: string): string {
    return text.replace(PS_CNF_ERROR_RE, (match: string, headerCmd: string, categoryCmd: string) => {
      const cmd = (categoryCmd || headerCmd || '').trim()
      const elidedLines = match.replace(/\r?\n$/, '').split(/\r?\n/).length
      return (
        `PowerShell CommandNotFoundException: '${cmd}' not found (elided ${elidedLines} lines of stack trace). ` +
        'If invoked from Bash/Git-Bash and the command used $_, bash pre-expands it before PowerShell sees it -- ' +
        'escape as `$_` (backtick) or single-quote the whole -Command string.'
      )
    })
  }
}

export const powerShellFilter: ToolFilter = new PowerShellErrorFilter()

// ===========================================================================
// Registry
// ===========================================================================

/**
 * All language-runtime filters in dispatch order.
 *
 * NodeFilter is first because it has a narrow custom matches() (eval-only)
 * and must not be shadowed.  SwiftLintFilter, XcodeFilter, and the rest use
 * unique enough binaries that ordering within this slice is safe as long as
 * the slice is appended AFTER SHELL_FILE_FILTERS in dispatch.ts.
 */
export const LANGUAGE_FILTERS: readonly ToolFilter[] = [
  nodeFilter,
  xcodeFilter,
  denoFilter,
  flutterFilter,
  dartFilter,
  swiftFilter,
  mixFilter,
  erlangFilter,
  pythonFilter,
  rubyFilter,
  elmFilter,
  crystalFilter,
  haskellFilter,
  juliaFilter,
  zigFilter,
  rCmdFilter,
  powerShellFilter,
]
