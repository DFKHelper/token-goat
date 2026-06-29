// Batch B — package-manager filters. Faithful port of the Python NpmInstallFilter, PnpmFilter, YarnFilter, PipFilter, UvFilter, CondaFilter, GemFilter, BundlerFilter, ComposerFilter, NuGetFilter, PubFilter, ConanFilter, VcpkgFilter, NodePackageFilter, and DepListFilter from bash_compress.py (git ref 2098981^).
//
// Each filter subclasses ToolFilter and lives in the PACKAGE_MANAGER_FILTERS export array, which dispatch.ts spreads into TOOL_FILTERS after the Batch-A test-runner filters.

import { ToolFilter } from './base.js'
import { makePackageManagerFilter } from './families.js'
import { ERROR_SIGNAL_RE, capTokens, maybeNote, pathStem, positionalArgs, squeezeBlankLines } from './helpers.js'

// ---------------------------------------------------------------------------
// Internal helpers (package-manager-local; not exported to index)
// ---------------------------------------------------------------------------

/**
 * Deduplicate lines, keeping at most `maxPerKey` occurrences per unique key.
 * Returns [keptLines, droppedCount].
 */
function dedupLines(
  lines: string[],
  maxPerKey = 1,
  keyFn: (line: string) => string = (l) => l.trim(),
): [string[], number] {
  const seen = new Map<string, number>()
  const out: string[] = []
  let dropped = 0
  for (const line of lines) {
    const key = keyFn(line)
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count < maxPerKey) out.push(line)
    else dropped += 1
  }
  return [out, dropped]
}

// ---------------------------------------------------------------------------
// Shared regexes
// ---------------------------------------------------------------------------

// npm install noise
const NPM_DEPRECATED_RE = /^npm warn deprecated\b/i
const NPM_NOTICE_RE = /^npm notice\b/i
const NPM_NOTICE_LOCKFILE_RE = /^npm notice.*lock/i
const NPM_ZERO_VULN_RE = /^found 0 vulnerabilities\b/i
const NPM_FUNDING_RE = /^\d+\s+packages? are looking for funding\b/i
const NPM_FUND_RUN_RE = /^\s*run `npm fund`/i
const NPM_WARN_RE = /^npm warn\b/i
const NPM_VERBOSE_RE = /^npm (?:timing|sill|http fetch|http request|http finish|verb)\b/i
const NPM_REIFY_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/

// yarn classic install noise
const YARN_PEER_DEP_RE = /^warning ".+ > .+" has (?:unmet|incorrect) peer dependency/i
const YARN_PHASE_RE = /^\[\d+\/\d+\]/
const YARN_FETCH_PHASE_RE = /^\[2\/4\]/
const YARN_INFO_RE = /^info\b/i
const YARN_SUCCESS_RE = /^success\b/i
const YARN_WARNING_RE = /^warning\s+/i

// yarn berry noise
const YARN_BERRY_PROGRESS_RE = /^➤\s+YN\d{4}:\s+(?:[│└]\s+)?\S.*(?:\d+\/\d+|\d+\.\d+\s*[KMG]?B)/
const YARN_BERRY_DONE_RE = /^➤\s+YN0000:\s+·\s+Done/
const YARN_BERRY_PREFIX_RE = /^➤\s+YN\d{4}:/

// pnpm install noise (used by NpmInstallFilter for pnpm path + PnpmFilter)
const PNPM_PLUS_BAR_RE = /^\++\s*$/
const PNPM_PROGRESS_RE = /^Progress:/i

// pnpm install resolution progress (used by PnpmFilter)
const PNPM_RESOLVER_PROGRESS_RE =
  /^\s*(?:Resolving|Downloading|Fetching)[:\s].*\d+\/\d+|\s+\d+\s+packages?\s+(?:fetched|resolved|downloaded|linked)/
const PNPM_SUMMARY_RE = /^(?:Packages:|Already up to date|Progress:|WARN|ERR!|added|removed|changed)/i
const PNPM_LOCKFILE_RE = /^\s*(?:Lockfile|Saved|node_modules|symlink)/i

// pip install noise
const PIP_VERBOSE_DEBUG_RE = /^(?:DEBUG|VERBOSE|TRACE)\b/
const PIP_VERBOSE_HTTP_RE =
  /^\s+(?:https?:\/\/|Added \S+ to |Querying |Checking if link|Created temporary directory|Looking up|Skipping link|Local version label|File was already downloaded|\d+ location\(s\) for)\b/

// uv noise
const UV_DOWNLOAD_RE = /^\s*(?:Downloading|Downloaded|Fetching)\s+\S/
const UV_DIFF_LINE_RE = /^\s+[+-]\s+\S/
const UV_FREEZE_THRESHOLD = 50
const UV_FREEZE_SHOW = 20

// conda noise
const CONDA_DOWNLOAD_RE =
  /^\s*(?:[A-Za-z0-9_\-.]+[\d.]+\s+\||\[[-#\s]+\]|\d+%|\d+\s*(?:KB|MB|kB|B)\/s|Downloading and Extracting Packages:)/
const CONDA_PKG_INSTALL_RE = /^\s{2}-\s+\S/
const CONDA_STATUS_RE =
  /^(?:Collecting package metadata|Solving environment|Preparing transaction|Executing transaction|Verifying transaction|done\b)/i
const CONDA_LIST_THRESHOLD = 50
const CONDA_LIST_SHOW = 20

// gem noise
const GEM_FETCH_RE = /^Fetching\s+\S+\s*$/
const GEM_DOC_RE = /^(?:Parsing documentation for|Installing ri documentation for|Done installing documentation for)\s+/
const GEM_SUCCESS_RE = /^Successfully installed\s+\S/
const GEM_ERROR_RE = /^(?:ERROR:|Gem::|You don't have write permissions|gem:)/i

// bundler noise
const BUNDLER_USING_RE = /^Using\s+\S+\s+[\d.]+/
const BUNDLER_FETCH_INSTALL_RE = /^(?:Fetching|Installing)\s+\S+\s+[\d.]+/
// composer noise
const COMPOSER_INSTALL_RE = /^\s+- Installing \S+ \(/
const COMPOSER_DOWNLOADING_RE = /^\s+- Downloading \S+ \(/
const COMPOSER_DOWNLOAD_PROGRESS_RE = /^\s+- (?:Installing|Downloading) .+\(\d+%\)/
const COMPOSER_FUNDING_RE = /^\d+ packages? you are using are looking for funding/
const COMPOSER_WARNING_RE = /^\s*(?:Warning|Deprecation|deprecated|constraint):/i

// nuget noise
const NUGET_INSTALLING_RE = /^\s*Installing\s+\S+\s+\d+\.\d+/i
const NUGET_RESTORING_RE = /^\s*Restoring packages for\b/i
const NUGET_OK_HTTPS_RE = /^\s*OK\s+https?:\/\//i
const NUGET_ALREADY_INSTALLED_RE = /^\s*Package\s+\S+.*\bis already installed/i
const NUGET_SUCCESS_INSTALL_RE = /^\s*Successfully installed\s+/i

// pub
const PUB_KEEP_RE =
  /^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|Downloading packages|Building package executable)/
const PUB_PKG_LINE_RE = /^[+>!]\s+\S+\s+\S+/
const PUB_DOWNLOADING_RE = /^Downloading\s+\S+\s+\S+/

// conan
const CONAN_PKG_PROGRESS_RE =
  /^[\w.+-]+\/[\w.+:-]+(?:@[\w/]+)?\s*:\s+(?:Package\s+'[0-9a-f]+'\s+(?:created|already exists|built)|Calling\s+(?:build|package|package_info|config_options|configure|requirements|package_id|validate|generate|layout)\(\)|Exporting\s+package|Copying|Generating\s+(?:the\s+)?(?:package|generators)|Building\s+(?:the\s+)?package|Decompressing\s+|Downloading|WARN:\s+Build\s+folder\s+is\s+different)/
const CONAN_REQUIREMENT_RE =
  /^(?:Requirement|Graph\s+root|Requirements?:|Packages:|Build\s+requirements?:)/i
const CONAN_DONE_RE =
  /^(?:Install\s+finished|Conan\s+profile:|Cross\s+build\s+from|Package\s+(?:installed|created))/i
const CONAN_DOWNLOAD_RE =
  /^(?:Downloading\s+conan_|Checking\s+checksum|\d+\/\d+\s+bytes\s+downloaded)/i

// vcpkg
const VCPKG_BUILDING_RE = /^Building\s+\S+:\S+\.\.\./
const VCPKG_INSTALLING_RE = /^Installing\s+\S+:\S+\.\.\./
const VCPKG_DETECTING_RE = /^Detecting\s+compiler\s+hash/
const VCPKG_PLAN_RE = /^(?:The\s+following\s+packages\s+will\s+be|Additional\s+packages\s+\(\*\))/i
const VCPKG_ELAPSED_RE = /^Elapsed\s+time\s+for\s+package\s+\S+:\s+\d/
const VCPKG_DONE_RE =
  /^(?:Total\s+install\s+time:|CMake\s+projects\s+should\s+use|All\s+requested\s+packages\s+are\s+currently\s+installed|Package\s+\S+:\S+\s+is\s+already\s+installed)/i
const VCPKG_EXTRACTING_RE =
  /^\s*--\s+(?:Extracting\s+source|Applying\s+patch|Using\s+cached\s+archive|Downloading\s+https?:\/\/|Fetching\s+\S+|Stored\s+binaries\s+in\s+)/i

// NodePackageFilter (legacy/general npm/pnpm/yarn)
const NPM_PROGRESS_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|^npm\s+(?:WARN\s+deprecated|sill|http|verb|timing)\s/
const NPM_DEPRECATED_GENERAL_RE = /\bdeprecated\b/i
const NPM_AUDIT_PKG_RE = /^(?:npm\s+)?(?:found|run `npm audit`|packages are looking for funding)/i
const NPM_ERR_RE = /^npm (?:ERR!|error)/i

// dep-list
const DEP_LIST_THRESHOLD = 30

// ---------------------------------------------------------------------------
// NpmInstallFilter
// ---------------------------------------------------------------------------

/**
 * Compress `npm install` / `yarn install` / `pnpm install` output.
 * Handles all three package managers with per-tool compression paths.
 * Faithful port of Python NpmInstallFilter.
 */
class NpmInstallFilter extends ToolFilter {
  readonly name = 'npm_install'
  override readonly binaries = new Set(['npm', 'yarn', 'pnpm'])

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const pos = positionalArgs(argv.slice(1))
    const subcmd = (pos[0] ?? '').toLowerCase()
    if (stem === 'npm') return new Set(['install', 'i', 'ci']).has(subcmd)
    if (stem === 'yarn') return new Set(['install', 'add', '']).has(subcmd)
    if (stem === 'pnpm') return new Set(['install', 'add', 'i']).has(subcmd)
    return false
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const stem = pathStem(argv[0] ?? '').toLowerCase()
    const merged = this.combineOutput(stdout, stderr)
    if (stem === 'npm') return this._compressNpm(merged)
    if (stem === 'yarn') return this._compressYarn(merged)
    if (stem === 'pnpm') return this._compressPnpm(merged)
    return this.finalize(merged.split('\n'))
  }

  private _compressNpm(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let deprecatedCount = 0
    let deprecatedSuppressed = 0
    let warnCount = 0
    let warnSuppressed = 0
    let verboseSuppressed = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (NPM_DEPRECATED_RE.test(line)) {
        deprecatedCount += 1
        if (deprecatedCount <= 3) kept.push(line)
        else deprecatedSuppressed += 1
        continue
      }
      if (NPM_WARN_RE.test(line)) {
        warnCount += 1
        if (warnCount <= 3) kept.push(line)
        else warnSuppressed += 1
        continue
      }
      if (NPM_VERBOSE_RE.test(line)) { verboseSuppressed += 1; continue }
      if (NPM_REIFY_RE.test(line)) { verboseSuppressed += 1; continue }
      if (NPM_NOTICE_RE.test(line)) {
        if (NPM_NOTICE_LOCKFILE_RE.test(line)) kept.push(line)
        continue
      }
      if (NPM_ZERO_VULN_RE.test(line)) continue
      if (NPM_FUNDING_RE.test(line)) continue
      if (NPM_FUND_RUN_RE.test(line)) continue
      kept.push(line)
    }
    const notes: string[] = []
    if (deprecatedSuppressed) {
      notes.push(
        `suppressed ${deprecatedSuppressed} additional deprecated warnings (showed first 3 of ${deprecatedCount})`,
      )
    }
    if (warnSuppressed) {
      notes.push(
        `suppressed ${warnSuppressed} additional npm warn lines (showed first 3 of ${warnCount})`,
      )
    }
    maybeNote(notes, verboseSuppressed, `suppressed ${verboseSuppressed} verbose/progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressYarn(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let noiseSuppressed = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (YARN_PEER_DEP_RE.test(line)) { noiseSuppressed += 1; continue }
      if (YARN_PHASE_RE.test(line)) { noiseSuppressed += 1; continue }
      if (YARN_INFO_RE.test(line)) { noiseSuppressed += 1; continue }
      if (YARN_SUCCESS_RE.test(line)) { noiseSuppressed += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, noiseSuppressed, `suppressed ${noiseSuppressed} yarn install progress/noise lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressPnpm(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let progressSuppressed = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (PNPM_PLUS_BAR_RE.test(line)) { progressSuppressed += 1; continue }
      if (PNPM_PROGRESS_RE.test(line)) {
        if (/done/i.test(line)) kept.push(line)
        else progressSuppressed += 1
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, progressSuppressed, `suppressed ${progressSuppressed} pnpm progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// PnpmFilter (dedicated pnpm filter with richer install + run label)
// ---------------------------------------------------------------------------

/**
 * Compress `pnpm install` / `pnpm add` / `pnpm run` output.
 * Faithful port of Python PnpmFilter.
 */
class PnpmFilter extends ToolFilter {
  readonly name = 'pnpm'
  override readonly binaries = new Set(['pnpm'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const pos = positionalArgs(argv.slice(1))
    const subcmd = pos[0] ?? ''
    const merged = this.combineOutput(stdout, stderr)
    if (subcmd === 'run' && pos.length >= 2) return this._compressRun(merged, pos[1]!)
    if (subcmd === 'exec' || subcmd === 'dlx') return merged
    return this._compressInstall(merged)
  }

  private _compressInstall(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let progressDropped = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (PNPM_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (PNPM_LOCKFILE_RE.test(line)) { kept.push(line); continue }
      if (PNPM_RESOLVER_PROGRESS_RE.test(line)) { progressDropped += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, progressDropped, `collapsed ${progressDropped} resolver/download progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressRun(text: string, script: string): string {
    const lines = text.split('\n')
    const out: string[] = []
    let labelled = false
    for (const line of lines) {
      if (!labelled && line.trim()) {
        out.push(`pnpm run ${script}: ${line}`)
        labelled = true
      } else {
        out.push(line)
      }
    }
    return this.finalize(out)
  }
}

// ---------------------------------------------------------------------------
// YarnFilter (yarn classic v1 and berry v2+)
// ---------------------------------------------------------------------------

/**
 * Compress `yarn install` output for yarn classic (v1) and berry (v2+).
 * Faithful port of Python YarnFilter.
 */
class YarnFilter extends ToolFilter {
  readonly name = 'yarn'
  override readonly binaries = new Set(['yarn'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    if (YARN_BERRY_PREFIX_RE.test(merged)) return this._compressBerry(merged)
    return this._compressClassic(merged)
  }

  private _compressClassic(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let fetchDropped = 0
    const warningLines: string[] = []
    let inFetchPhase = false
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); inFetchPhase = false; continue }
      if (YARN_WARNING_RE.test(line)) { warningLines.push(line); continue }
      if (YARN_FETCH_PHASE_RE.test(line)) {
        inFetchPhase = true
        kept.push(line)
        continue
      }
      if (YARN_PHASE_RE.test(line)) {
        inFetchPhase = false
        kept.push(line)
        continue
      }
      if (inFetchPhase && line.trim() && !/^\[/.test(line)) {
        fetchDropped += 1
        continue
      }
      kept.push(line)
    }
    let dupWarnings = 0
    if (warningLines.length) {
      const [deduped, dropped] = dedupLines(warningLines, 1, (ln) => ln.slice(0, 60))
      dupWarnings = dropped
      kept.push(...deduped)
    }
    const notes: string[] = []
    maybeNote(notes, fetchDropped, `collapsed ${fetchDropped} individual fetch lines`)
    maybeNote(notes, dupWarnings, `deduplicated ${dupWarnings} repeated warning lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressBerry(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let fetchDropped = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (/^➤\s+YN0001:/.test(line) || YARN_BERRY_DONE_RE.test(line)) { kept.push(line); continue }
      if (YARN_BERRY_PROGRESS_RE.test(line)) { fetchDropped += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, fetchDropped, `collapsed ${fetchDropped} per-package fetch/progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// PipFilter
// ---------------------------------------------------------------------------

/**
 * Compress `pip install` / `pip3 install` / `pipx install` output.
 * Faithful port of Python PipFilter.
 */
class PipFilter extends ToolFilter {
  readonly name = 'pip'
  override readonly binaries = new Set(['pip', 'pip3', 'pipx'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const verbose =
      argv.includes('-v') ||
      argv.includes('--verbose') ||
      argv.some((a) => a.startsWith('-v') && a.slice(1).split('').every((c) => c === 'v'))
    const kept: string[] = []
    let downloads = 0
    let buildNoise = 0
    let collects = 0
    let verboseDropped = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (verbose && (PIP_VERBOSE_DEBUG_RE.test(line) || PIP_VERBOSE_HTTP_RE.test(line))) {
        verboseDropped += 1
        continue
      }
      if (line.startsWith('  Downloading ') || line.startsWith('Downloading ')) { downloads += 1; continue }
      if (line.startsWith('  Using cached ') || line.startsWith('Using cached ')) { downloads += 1; continue }
      if (
        line.startsWith('  Building wheel') ||
        line.startsWith('Building wheel') ||
        line.startsWith('  Created wheel') ||
        line.startsWith('Created wheel') ||
        line.startsWith('  Stored in directory') ||
        line.startsWith('Stored in directory') ||
        line.startsWith('  Installing build dep') ||
        line.startsWith('Installing build dep') ||
        line.startsWith('  Preparing metadata') ||
        line.startsWith('Preparing metadata') ||
        line.startsWith('  Getting requirements') ||
        line.startsWith('Getting requirements') ||
        line.startsWith('  Obtaining file://') ||
        line.startsWith('Obtaining file://') ||
        line.startsWith('Installing collected packages') ||
        line.startsWith('  Installing collected packages')
      ) {
        buildNoise += 1
        continue
      }
      if (line.includes('━') && !ERROR_SIGNAL_RE.test(line)) { downloads += 1; continue }
      if (line.startsWith('Collecting ') || line.startsWith('  Collecting ')) {
        collects += 1
        if (collects <= 5) kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    if (collects > 5) notes.push(`+${collects - 5} more 'Collecting' lines elided`)
    maybeNote(notes, downloads, `dropped ${downloads} download/cache-hit lines`)
    maybeNote(notes, buildNoise, `dropped ${buildNoise} build-wheel/metadata lines`)
    maybeNote(notes, verboseDropped, `dropped ${verboseDropped} verbose debug/trace lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// UvFilter
// ---------------------------------------------------------------------------

/**
 * Compress `uv sync` / `uv add` / `uv pip` / `uv tool` output.
 * Faithful port of Python UvFilter.
 */
class UvFilter extends ToolFilter {
  readonly name = 'uv'
  override readonly binaries = new Set(['uv'])

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem !== 'uv') return false
    const pos = positionalArgs(argv.slice(1))
    if (pos.length === 0) return false
    const first = pos[0]!
    const pmSubcmds = new Set(['sync', 'add', 'remove', 'install', 'uninstall', 'pip', 'lock'])
    if (pmSubcmds.has(first)) return true
    if (first === 'tool' && pos.length >= 2) {
      return new Set(['install', 'upgrade', 'uninstall', 'update']).has(pos[1]!)
    }
    if (first === 'python' && pos.length >= 2) {
      return new Set(['install', 'pin']).has(pos[1]!)
    }
    return false
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const pos = positionalArgs(argv.slice(1))
    const isFreezeOrList =
      pos.length >= 2 && pos[0] === 'pip' && (pos[1] === 'freeze' || pos[1] === 'list')
    const merged = this.combineOutput(stdout, stderr)
    if (isFreezeOrList) return this._compressFreezeList(merged)
    const lines = merged.split('\n')
    const kept: string[] = []
    let downloads = 0
    let diffLines = 0
    for (const line of lines) {
      if (UV_DOWNLOAD_RE.test(line)) { downloads += 1; continue }
      if (UV_DIFF_LINE_RE.test(line)) { diffLines += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, downloads, `dropped ${downloads} Downloading/Fetching progress lines`)
    maybeNote(notes, diffLines, `dropped ${diffLines} per-package +/- diff lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressFreezeList(text: string): string {
    const lines = text.split('\n').filter((l) => l.trim())
    const errorLines = lines.filter((l) => ERROR_SIGNAL_RE.test(l))
    const pkgLines = lines.filter((l) => !ERROR_SIGNAL_RE.test(l))
    if (pkgLines.length <= UV_FREEZE_THRESHOLD) return text.trimEnd()
    const shown = pkgLines.slice(0, UV_FREEZE_SHOW)
    const tail = pkgLines.slice(UV_FREEZE_SHOW)
    const collapsed = [`[token-goat: collapsed ${tail.length} package lines]`]
    const result = [...shown, ...collapsed, ...errorLines]
    return result.join('\n')
  }
}

// ---------------------------------------------------------------------------
// CondaFilter
// ---------------------------------------------------------------------------

/**
 * Compress `conda install` / `conda create` / `conda list` / `conda env export` output.
 * Faithful port of Python CondaFilter.
 */
class CondaFilter extends ToolFilter {
  readonly name = 'conda'
  override readonly binaries = new Set(['conda', 'mamba', 'micromamba'])

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (!this.binaries.has(stem)) return false
    const pos = positionalArgs(argv.slice(1))
    if (pos.length === 0) return true
    return new Set(['install', 'create', 'update', 'upgrade', 'remove', 'uninstall', 'list', 'env']).has(pos[0]!)
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const pos = positionalArgs(argv.slice(1))
    const subcmd = pos[0] ?? ''
    const merged = this.combineOutput(stdout, stderr)
    if (subcmd === 'list') return this._compressPkgList(merged)
    if (subcmd === 'env' && pos.length >= 2 && pos[1] === 'export') return this._compressEnvExport(merged)
    return this._compressInstall(merged)
  }

  private _compressInstall(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let downloadsDropped = 0
    let pkgInstalls = 0
    let inDownloadSection = false
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); inDownloadSection = false; continue }
      if (/^Downloading and Extracting Packages/i.test(line)) {
        inDownloadSection = true
        kept.push(line)
        continue
      }
      if (inDownloadSection) {
        if (!line.trim()) { inDownloadSection = false; kept.push(line); continue }
        if (CONDA_STATUS_RE.test(line)) {
          inDownloadSection = false
          // fall through to normal processing
        } else if (CONDA_DOWNLOAD_RE.test(line) || line.trim().startsWith('|')) {
          downloadsDropped += 1
          continue
        } else if (/^\s{2,}[\w.-]/.test(line)) {
          downloadsDropped += 1
          continue
        } else {
          inDownloadSection = false
        }
      }
      if (CONDA_STATUS_RE.test(line)) { kept.push(line); continue }
      if (CONDA_PKG_INSTALL_RE.test(line)) { pkgInstalls += 1; continue }
      if (CONDA_DOWNLOAD_RE.test(line)) { downloadsDropped += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, downloadsDropped, `collapsed ${downloadsDropped} download/progress lines`)
    maybeNote(notes, pkgInstalls, `collapsed ${pkgInstalls} package install lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressPkgList(text: string): string {
    const lines = text.split('\n')
    const header = lines.filter((l) => l.startsWith('#'))
    const pkgLines = lines.filter((l) => l.trim() && !l.startsWith('#'))
    if (pkgLines.length <= CONDA_LIST_THRESHOLD) return text.trimEnd()
    const shown = [...header, ...pkgLines.slice(0, CONDA_LIST_SHOW)]
    const remaining = pkgLines.length - CONDA_LIST_SHOW
    shown.push(`[token-goat: ${remaining} more packages elided; run conda list for full output]`)
    return shown.join('\n')
  }

  private _compressEnvExport(text: string): string {
    const lines = text.split('\n')
    const depLines: string[] = []
    const otherLines: string[] = []
    let inDeps = false
    for (const ln of lines) {
      if (ln.trim().startsWith('dependencies:')) {
        inDeps = true
        otherLines.push(ln)
      } else if (inDeps && /^\s+-\s/.test(ln)) {
        depLines.push(ln)
      } else {
        if (inDeps) inDeps = false
        otherLines.push(ln)
      }
    }
    if (depLines.length <= CONDA_LIST_THRESHOLD) return text.trimEnd()
    const depStartIdx = otherLines.findIndex((ln) => ln.trim().startsWith('dependencies:'))
    const insertAt = depStartIdx >= 0 ? depStartIdx + 1 : otherLines.length
    const remaining = depLines.length - CONDA_LIST_SHOW
    const result = [
      ...otherLines.slice(0, insertAt),
      ...depLines.slice(0, CONDA_LIST_SHOW),
      `  # [token-goat: ${remaining} more dependencies elided]`,
      ...otherLines.slice(insertAt),
    ]
    return result.join('\n')
  }
}

// ---------------------------------------------------------------------------
// GemFilter
// ---------------------------------------------------------------------------

/**
 * Compress `gem install` / `gem update` output.
 * Faithful port of Python GemFilter.
 */
class GemFilter extends ToolFilter {
  readonly name = 'gem'
  override readonly binaries = new Set(['gem'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const pos = positionalArgs(argv.slice(1))
    const subcommand = (pos[0] ?? '').toLowerCase()
    if (!new Set(['install', 'update', 'upgrade']).has(subcommand)) {
      return capTokens(merged, 1000)
    }
    const lines = merged.split('\n')
    const kept: string[] = []
    let fetching = 0
    let docNoise = 0
    const successLines: string[] = []
    let successInsertIdx = -1
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || GEM_ERROR_RE.test(line)) { kept.push(line); continue }
      if (GEM_FETCH_RE.test(line)) { fetching += 1; continue }
      if (GEM_DOC_RE.test(line)) { docNoise += 1; continue }
      if (GEM_SUCCESS_RE.test(line)) {
        if (successInsertIdx < 0) successInsertIdx = kept.length
        successLines.push(line)
        continue
      }
      kept.push(line)
    }
    if (successLines.length) {
      let collapsed: string[]
      if (successLines.length <= 4) {
        collapsed = [...successLines]
      } else {
        const elided = successLines.length - 3
        collapsed = [
          ...successLines.slice(0, 2),
          `... (${elided} more installed) ...`,
          successLines[successLines.length - 1]!,
        ]
      }
      const insertAt = successInsertIdx >= 0 ? successInsertIdx : kept.length
      kept.splice(insertAt, 0, ...collapsed)
    }
    const notes: string[] = []
    maybeNote(notes, fetching, `dropped ${fetching} Fetching line${fetching !== 1 ? 's' : ''}`)
    maybeNote(notes, docNoise, `dropped ${docNoise} documentation line${docNoise !== 1 ? 's' : ''}`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// BundlerFilter — built via makePackageManagerFilter (line-drop family)
// ---------------------------------------------------------------------------

/**
 * Compress `bundle install` / `bundle update` / `bundler` output.
 * Faithful port of Python BundlerFilter. Uses the `makePackageManagerFilter`
 * line-drop factory: two noise regexes, everything else (completion banners,
 * Gemfile.lock summaries) passes through.
 */
const bundlerFilter = makePackageManagerFilter({
  name: 'bundler',
  binaries: ['bundle', 'bundler'],
  dropRules: [
    {
      re: BUNDLER_USING_RE,
      note: (n) => `collapsed ${n} 'Using gem' lines`,
    },
    {
      re: BUNDLER_FETCH_INSTALL_RE,
      note: (n) => `collapsed ${n} 'Fetching/Installing gem' lines`,
    },
  ],
})

// ---------------------------------------------------------------------------
// ComposerFilter
// ---------------------------------------------------------------------------

/**
 * Compress `composer install` / `composer update` / `composer require` output.
 * Faithful port of Python ComposerFilter.
 */
class ComposerFilter extends ToolFilter {
  readonly name = 'composer'
  override readonly binaries = new Set(['composer', 'composer.phar'])
  override readonly subcommands = new Set(['install', 'update', 'require', 'remove', 'dump-autoload'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let installCount = 0
    let downloadCount = 0
    let droppedProgress = 0
    let droppedFunding = 0
    const warningLines: string[] = []
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (COMPOSER_DOWNLOAD_PROGRESS_RE.test(line)) { droppedProgress += 1; continue }
      if (COMPOSER_FUNDING_RE.test(line)) { droppedFunding += 1; continue }
      if (COMPOSER_INSTALL_RE.test(line)) { installCount += 1; continue }
      if (COMPOSER_DOWNLOADING_RE.test(line)) { downloadCount += 1; continue }
      if (COMPOSER_WARNING_RE.test(line)) { warningLines.push(line); continue }
      kept.push(line)
    }
    let droppedDupWarnings = 0
    if (warningLines.length) {
      const [deduped, dropped] = dedupLines(warningLines, 1)
      droppedDupWarnings = dropped
      kept.push(...deduped)
    }
    const notes: string[] = []
    maybeNote(notes, installCount, `collapsed ${installCount} package install lines`)
    maybeNote(notes, downloadCount, `collapsed ${downloadCount} package download lines`)
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} download-progress lines`)
    maybeNote(notes, droppedFunding, `dropped ${droppedFunding} funding-notice lines`)
    maybeNote(notes, droppedDupWarnings, `deduplicated ${droppedDupWarnings} repeated warnings`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// NuGetFilter
// ---------------------------------------------------------------------------

/**
 * Compress `nuget` / `nuget.exe` / `nuget restore` output.
 * Faithful port of Python NuGetFilter.
 */
class NuGetFilter extends ToolFilter {
  readonly name = 'nuget'
  override readonly binaries = new Set(['nuget', 'nuget.exe'])

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const nameLower = (argv[0]!.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase()
    return stem === 'nuget' || nameLower === 'nuget.exe'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let installingCount = 0
    const restoringPaths: string[] = []
    let okDownloadCount = 0
    let alreadyInstalledCount = 0
    let successInstallCount = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (NUGET_INSTALLING_RE.test(line)) { installingCount += 1; continue }
      if (NUGET_RESTORING_RE.test(line)) { restoringPaths.push(line.trim()); continue }
      if (NUGET_OK_HTTPS_RE.test(line)) { okDownloadCount += 1; continue }
      if (NUGET_ALREADY_INSTALLED_RE.test(line)) { alreadyInstalledCount += 1; continue }
      if (NUGET_SUCCESS_INSTALL_RE.test(line)) { successInstallCount += 1; continue }
      kept.push(line)
    }
    if (restoringPaths.length === 1) {
      kept.unshift(restoringPaths[0]!)
    } else if (restoringPaths.length > 1) {
      kept.unshift(`Restoring packages for ${restoringPaths.length} projects`)
    }
    const notes: string[] = []
    maybeNote(notes, installingCount, `collapsed ${installingCount} package-install lines`)
    maybeNote(notes, okDownloadCount, `collapsed ${okDownloadCount} package-download lines`)
    maybeNote(notes, alreadyInstalledCount, `collapsed ${alreadyInstalledCount} already-installed lines`)
    maybeNote(notes, successInstallCount, `collapsed ${successInstallCount} successfully-installed lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// PubFilter (Dart/Flutter pub) — built via makePackageManagerFilter
// ---------------------------------------------------------------------------

/**
 * Compress `pub get` / `pub upgrade` / `pub publish` output.
 * Faithful port of Python PubFilter. Uses the `makePackageManagerFilter`
 * line-drop factory with a keepRe (PUB_KEEP_RE) so status/summary lines are
 * preserved before the drop rules run.
 */
const pubFilter = makePackageManagerFilter({
  name: 'pub',
  binaries: ['pub'],
  subcommands: ['get', 'upgrade', 'publish', 'add', 'remove'],
  keepRe: PUB_KEEP_RE,
  dropRules: [
    {
      re: PUB_PKG_LINE_RE,
      note: (n) => `collapsed ${n} package lines`,
    },
    {
      re: PUB_DOWNLOADING_RE,
      note: (n) => `collapsed ${n} download lines`,
    },
  ],
})

// ---------------------------------------------------------------------------
// ConanFilter (C/C++ conan package manager)
// ---------------------------------------------------------------------------

/**
 * Compress `conan install` / `conan create` / `conan build` output.
 * Faithful port of Python ConanFilter.
 */
class ConanFilter extends ToolFilter {
  readonly name = 'conan'
  override readonly binaries = new Set(['conan', 'conan2'])
  override readonly errorPassthrough = true

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    // errorPassthrough handled by base class — we override compress to also call the body (base calls compressBody via compress when no error).
    return super.compress(stdout, stderr, exitCode, argv)
  }

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let pkgProgressCount = 0
    let downloadCount = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (CONAN_DONE_RE.test(line)) { kept.push(line); continue }
      if (CONAN_REQUIREMENT_RE.test(line)) { kept.push(line); continue }
      if (CONAN_PKG_PROGRESS_RE.test(line)) { pkgProgressCount += 1; continue }
      if (CONAN_DOWNLOAD_RE.test(line)) { downloadCount += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    const totalDropped = pkgProgressCount + downloadCount
    if (totalDropped) {
      const parts: string[] = []
      if (pkgProgressCount) parts.push(`${pkgProgressCount} package lifecycle`)
      if (downloadCount) parts.push(`${downloadCount} download`)
      notes.push(`collapsed ${totalDropped} conan progress lines (${parts.join(', ')})`)
    }
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// VcpkgFilter (C++ vcpkg package manager)
// ---------------------------------------------------------------------------

/**
 * Compress `vcpkg install` / `vcpkg upgrade` output.
 * Faithful port of Python VcpkgFilter.
 */
class VcpkgFilter extends ToolFilter {
  readonly name = 'vcpkg'
  override readonly binaries = new Set(['vcpkg'])
  override readonly errorPassthrough = true

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    return super.compress(stdout, stderr, exitCode, argv)
  }

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let buildingCount = 0
    let installingCount = 0
    let substepCount = 0
    let timingCount = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (VCPKG_PLAN_RE.test(line) || VCPKG_DONE_RE.test(line)) { kept.push(line); continue }
      if (VCPKG_BUILDING_RE.test(line)) { buildingCount += 1; continue }
      if (VCPKG_INSTALLING_RE.test(line)) { installingCount += 1; continue }
      if (VCPKG_EXTRACTING_RE.test(line)) { substepCount += 1; continue }
      if (VCPKG_ELAPSED_RE.test(line) || VCPKG_DETECTING_RE.test(line)) { timingCount += 1; continue }
      kept.push(line)
    }
    const notes: string[] = []
    if (buildingCount || installingCount) {
      const parts: string[] = []
      if (buildingCount) parts.push(`${buildingCount} Building`)
      if (installingCount) parts.push(`${installingCount} Installing`)
      notes.push(`collapsed ${buildingCount + installingCount} vcpkg port lines (${parts.join(', ')})`)
    }
    maybeNote(notes, substepCount, `collapsed ${substepCount} vcpkg sub-step lines`)
    maybeNote(notes, timingCount, `dropped ${timingCount} vcpkg timing/detection lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// NodePackageFilter (general npm/pnpm/yarn audit + progress compression)
// ---------------------------------------------------------------------------

/**
 * Compress general `npm` / `pnpm` / `yarn` / `bun` package-manager output
 * including `npm audit`. Faithful port of Python NodePackageFilter.
 * Note: `npm install` / `pnpm install` / `yarn install` are intercepted by
 * NpmInstallFilter / PnpmFilter / YarnFilter which appear earlier in dispatch.
 */
class NodePackageFilter extends ToolFilter {
  readonly name = 'npm'
  override readonly binaries = new Set(['npm', 'pnpm', 'yarn', 'bun'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const pos = positionalArgs(argv.slice(1))
    const isAudit = pos.includes('audit')
    if (isAudit) {
      if (argv.includes('--json')) return compressNpmAuditJson(merged)
      return compressNpmAuditHuman(merged)
    }
    const lines = merged.split('\n')
    const kept: string[] = []
    const deprecatedPkgs = new Map<string, number>()
    let auditLinesDropped = 0
    for (const line of lines) {
      if (NPM_PROGRESS_RE.test(line)) continue
      if (NPM_DEPRECATED_GENERAL_RE.test(line) && !NPM_ERR_RE.test(line)) {
        const m = line.match(/\b([a-z0-9@._/-]+)@[\d.]+/)
        const pkg = m ? m[1]! : '<unknown>'
        deprecatedPkgs.set(pkg, (deprecatedPkgs.get(pkg) ?? 0) + 1)
        continue
      }
      if (NPM_AUDIT_PKG_RE.test(line) && !NPM_ERR_RE.test(line)) {
        auditLinesDropped += 1
        continue
      }
      kept.push(line)
    }
    if (deprecatedPkgs.size) {
      const total = Array.from(deprecatedPkgs.values()).reduce((a, b) => a + b, 0)
      const pkgNames = Array.from(deprecatedPkgs.keys()).sort().slice(0, 5)
      kept.push(
        `[token-goat: collapsed ${total} deprecation warnings across ${deprecatedPkgs.size} packages: ${pkgNames.join(', ')}${deprecatedPkgs.size > 5 ? '…' : ''}]`,
      )
    }
    if (auditLinesDropped) {
      kept.push(
        `[token-goat: dropped ${auditLinesDropped} per-package audit lines; run \`npm audit\` for detail]`,
      )
    }
    return this.finalize(kept)
  }
}

function compressNpmAuditJson(text: string): string {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return text
  }
  const vulns = data['vulnerabilities']
  if (!vulns || typeof vulns !== 'object' || Array.isArray(vulns)) return text
  const vulnMap = vulns as Record<string, unknown>
  if (Object.keys(vulnMap).length <= 10) return text
  const keep: Record<string, unknown> = {}
  let collapsedCount = 0
  const collapsedSeverities: Record<string, number> = {}
  for (const [pkg, info] of Object.entries(vulnMap)) {
    const severity = info && typeof info === 'object' && !Array.isArray(info)
      ? String((info as Record<string, unknown>)['severity'] ?? '').toLowerCase()
      : ''
    if (severity === 'critical' || severity === 'high') {
      keep[pkg] = info
    } else {
      collapsedCount += 1
      collapsedSeverities[severity] = (collapsedSeverities[severity] ?? 0) + 1
    }
  }
  if (collapsedCount === 0) return text
  const summary = Object.entries(collapsedSeverities)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ')
  keep['__collapsed__'] = `[token-goat: collapsed ${collapsedCount} lower-severity vulnerabilities (${summary})]`
  const result = { ...data, vulnerabilities: keep }
  return JSON.stringify(result, null, 2)
}

function compressNpmAuditHuman(text: string): string {
  // Keep the first 10 advisory blocks; collapse the rest with a count per severity.
  const lines = text.split('\n')
  const kept: string[] = []
  const severityCounts: Record<string, number> = {}
  let blockCount = 0
  let inBlock = false
  let blockLines: string[] = []
  const SEVERITY_HDR_RE = /^(critical|high|moderate|low)\s+\S/i
  const FOUND_SUMMARY_RE = /^found \d+ vulnerabilit/i
  for (const line of lines) {
    if (FOUND_SUMMARY_RE.test(line)) { kept.push(line); continue }
    if (SEVERITY_HDR_RE.test(line)) {
      if (inBlock && blockLines.length) {
        if (blockCount < 10) kept.push(...blockLines)
        else {
          const sev = (blockLines[0] ?? '').split(/\s+/)[0]!.toLowerCase()
          severityCounts[sev] = (severityCounts[sev] ?? 0) + 1
        }
        blockCount += 1
      }
      inBlock = true
      blockLines = [line]
      continue
    }
    if (inBlock) {
      if (line.trim() === '') {
        blockLines.push(line)
        if (blockCount < 10) kept.push(...blockLines)
        else {
          const sev = (blockLines[0] ?? '').split(/\s+/)[0]!.toLowerCase()
          severityCounts[sev] = (severityCounts[sev] ?? 0) + 1
        }
        blockLines = []
        blockCount += 1
        inBlock = false
      } else {
        blockLines.push(line)
      }
    } else {
      kept.push(line)
    }
  }
  if (inBlock && blockLines.length) {
    if (blockCount < 10) kept.push(...blockLines)
    else {
      const sev = (blockLines[0] ?? '').split(/\s+/)[0]!.toLowerCase()
      severityCounts[sev] = (severityCounts[sev] ?? 0) + 1
    }
  }
  if (Object.keys(severityCounts).length) {
    const parts = Object.entries(severityCounts).map(([s, n]) => `${n} ${s}`)
    kept.push(`[token-goat: collapsed ${Object.values(severityCounts).reduce((a, b) => a + b, 0)} additional advisory blocks (${parts.join(', ')})]`)
  }
  return squeezeBlankLines(kept.join('\n'))
}

// ---------------------------------------------------------------------------
// DepListFilter
// ---------------------------------------------------------------------------

/**
 * Truncate verbose `pip list` / `pip freeze` / `npm list` / `cargo tree` / etc.
 * output at 30 lines. Faithful port of Python DepListFilter.
 * Note: binaries npm/pnpm/yarn/cargo are NOT in the ToolFilter.binaries set
 * (would conflict with their dedicated filters); they are handled via a custom
 * matches() override.
 */
class DepListFilter extends ToolFilter {
  readonly name = 'dep-list'
  override readonly binaries = new Set(['pip', 'pip3', 'uv', 'poetry'])
  override readonly subcommands = new Set(['list', 'freeze', 'show', 'ls', 'tree'])
  override readonly errorPassthrough = true

  private static readonly PKG_MGR_STEMS = new Set(['npm', 'pnpm', 'yarn', 'cargo'])

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (DepListFilter.PKG_MGR_STEMS.has(stem)) {
      return positionalArgs(argv.slice(1)).slice(0, 3).some((tok) => this.subcommands.has(tok))
    }
    return super.matches(argv)
  }

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    while (lines.length > 0 && !(lines[lines.length - 1]!.trimEnd())) lines.pop()
    if (lines.length <= DEP_LIST_THRESHOLD) return lines.join('\n')
    const nMore = lines.length - DEP_LIST_THRESHOLD
    const shown = lines.slice(0, DEP_LIST_THRESHOLD)
    const hint = this._depCmdHint(argv)
    const trailer = `...[${nMore} more packages — use '${hint}' to see full output]`
    return shown.join('\n') + '\n' + trailer
  }

  private _depCmdHint(argv: string[]): string {
    if (argv.length === 0) return 'the original command'
    const stem = pathStem(argv[0]!).toLowerCase()
    const pos = positionalArgs(argv.slice(1))
    if (stem === 'uv' && pos.length >= 2) return `uv ${pos[0]} ${pos[1]}`
    const subcmd = pos[0] ?? ''
    return `${stem} ${subcmd}`.trim()
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Batch B — package-manager filters in dispatch order. The more specific
 * install filters (NpmInstallFilter, PnpmFilter, YarnFilter) come before the
 * general NodePackageFilter that handles `npm audit` and other subcommands.
 * DepListFilter comes last within the batch because it matches a subset of
 * binaries that other filters already claim — it only fires on listing
 * subcommands (list/freeze/tree/show/ls).
 */
export const PACKAGE_MANAGER_FILTERS: readonly ToolFilter[] = [
  new NpmInstallFilter(),
  new PnpmFilter(),
  new YarnFilter(),
  new PipFilter(),
  new UvFilter(),
  new CondaFilter(),
  new GemFilter(),
  bundlerFilter,
  new ComposerFilter(),
  new NuGetFilter(),
  pubFilter,
  new ConanFilter(),
  new VcpkgFilter(),
  new NodePackageFilter(),
  new DepListFilter(),
]
