// JavaScript workspace and bundler filters (Batch E): the nx, lerna and turbo task runners, and webpack, which also takes esbuild and `vite build`. Each is a faithful TypeScript port of its Python counterpart in bash_compress.py, and BUILD_FILTERS in build.ts sets its dispatch position.

import { ToolFilter } from './base.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, pathName } from './helpers.js'

// --------------------------------------------------------------------------- NxFilter ---------------------------------------------------------------------------

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
    let taskHeadersDropped = 0

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
        } else {
          // A task header names the target that ran, so dropping it loses real information: on a green run every one goes, and on a red run every one past the sample cap does. Counting them says so rather than leaving the reader to assume the run did less work than it did.
          taskHeadersDropped++
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
    maybeNote(notes, taskHeadersDropped, `dropped ${taskHeadersDropped} task header lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- LernaFilter ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- TurboFilter ---------------------------------------------------------------------------

const TURBO_SCOPE_RE = /^• Packages in scope:/
const TURBO_RUNNING_RE = /^• Running /
// The token splits at its first colon after the first character, so the halves cannot trade colons back and forth: the same tokens and the same group as `\S+:\S+`, in linear time.
const TURBO_TASK_LINE_RE = /^(\S[^\s:]*:\S+)\s+(?:cache (?:miss|hit)|building)/
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

// --------------------------------------------------------------------------- WebpackFilter ---------------------------------------------------------------------------

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

export const nxFilter = new NxFilter()
export const lernaFilter = new LernaFilter()
export const turboFilter = new TurboFilter()
export const webpackFilter = new WebpackFilter()
