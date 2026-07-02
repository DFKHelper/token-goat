/**
 * CLI entrypoint (`token-goat ...`).
 *
 * Wires the surgical-read commands (symbol / read / section / skeleton /
 * outline / map / semantic), the hook relay, and the install / worker
 * lifecycle subcommands onto a Commander program. Every command resolves to a
 * small text payload on stdout and an exit code: 0 on success, 1 on a handled
 * error (missing symbol, unreadable file). Unexpected throws also map to 1.
 *
 * This is the TS analogue of `cli.py::main`; it targets the subset of commands
 * exercised by the TS port rather than the full Python surface.
 */

import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'

import { buildProjectMap, formatProjectMap } from './baseline.js'
import { buildCompactMap, formatMap, getTrackedFiles } from './repomap.js'
import { collectWalkIndexFiles } from './walk_index.js'
import { globalDbPath, VERSION } from './constants.js'
import { getSessionFiles } from './session.js'
import { searchSymbolsFts } from './index_reader.js'
import { indexFileSync } from './parser.js'
import { pruneDeletedFiles } from './index_prune.js'
import { detectLanguage } from './parser_types.js'
import { resolveIndexPath } from './paths.js'
import type { SymbolEntry } from './parser_types.js'
import { relay } from './relay.js'
import { installHooks, uninstallHooks } from './install.js'
import type { HookScope } from './install.js'
import { isWorkerRunning, startDetachedWorker, stopWorker } from './worker.js'
import { getBashOutput } from './bash_output_cache.js'
import { getWebOutput } from './web_cache.js'
import * as bashRunner from './bash_runner.js'
import {
  runSymbol,
  runRead,
  runSection,
  runListSections,
  runRefs,
  runSkeleton,
  runOutline,
  runChanged,
  runConfigGet,
  runExports,
  runImports,
  runFind,
  runGrep,
  extractTranscriptText,
  extractSection,
  findSpecSeparator,
} from './read_commands.js'
import {
  runCallers,
  runCallChain,
  runImpact,
  runDead,
  runDeps,
  runTypes,
  runScope,
  runSimilar,
  runContextFor,
  runTestFor,
  runCoverageGaps,
  runArch,
  runBlame,
  runAsk,
} from './graph_commands.js'
import { contentHash, extractCompactFromMarker, extractNamedSection, formatAge, getSkillFilePath, incrementSkillHit, listOutputs, listSkills, skillOutputsDir, storeCompact, storeOutput } from './skill_cache.js'
import { buildLineDiff } from './hooks_read.js'
import { isWindows, ensureNewline, extractErrorMessage } from './util.js'
import { renderStats } from './stats.js'
import { runDoctorAndExit } from './cli_doctor.js'
import { getDocSections, formatSections, getSectionContent } from './gdrive.js'
import {
  collectFiles,
  collectFromStdin,
  formatPack,
  scanSecrets,
  estimateBudget,
  formatBudgetText,
} from './pack.js'
import { extractFailures, formatFailuresText, formatFailuresJson } from './failures.js'
import { cmdTodo, cmdTrace, cmdLogfold, cmdLockdeps, cmdNote, cmdHot, cmdRecent, cmdIgnores } from './text_commands.js'
import { cmdBashHistory, cmdWebHistory, cmdCleanCache, cmdPruneCache, cmdCacheAudit, cmdResume, cmdCompactHint, cmdSessionSummary, cmdCost, cmdBaseline } from './cache_session_commands.js'
import { cmdConfig, cmdProject, cmdCompactDoc, cmdFetchImage, cmdHistory } from './config_commands.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. */
class CliError extends Error {}

function out(text: string): void {
  process.stdout.write(ensureNewline(text))
}

function err(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/** First `n` lines of a body, for the symbol-search preview. */
function previewLines(body: string, n: number): string {
  return body.split(/\r?\n/).slice(0, n).join('\n')
}

/** `name (kind) — file:start-end` header line for a symbol. */
function symbolHeader(s: SymbolEntry): string {
  return `# ${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}-${s.lineEnd}`
}

// Parses a --limit/--top style numeric CLI flag, rejecting a non-numeric value with a clean
// CliError instead of letting NaN flow into a downstream SQL LIMIT bind (which better-sqlite3
// rejects with an opaque "datatype mismatch" error).
function requireInt(flag: string, raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new CliError(`${flag} must be a number, got: "${raw}"`)
  }
  return n
}

// --- Command handlers -------------------------------------------------------

function cmdSemantic(query: string, opts: { limit?: string }): void {
  const limit = opts.limit !== undefined ? requireInt('--limit', opts.limit) : 20
  // No embeddings table in this port → fall back to FTS over symbol names/bodies.
  const results = searchSymbolsFts(query, Number.isFinite(limit) ? limit : 20)
  if (results.length === 0) {
    throw new CliError(`no matches for '${query}'`)
  }
  const blocks = results.map((s) => `${symbolHeader(s)}\n${previewLines(s.body, 3)}`)
  out(blocks.join('\n\n'))
}

export function cmdIndex(pathArg?: string, opts: { walk?: boolean; dbPath?: string } = {}): void {
  const root = pathArg ?? process.cwd()
  const dbPath = opts.dbPath ?? globalDbPath()
  let files = getTrackedFiles(root)
  if (files.length === 0) {
    if (opts.walk !== true) {
      throw new CliError(
        `no tracked files found under '${root}' (is it a git repo?). ` +
          `Pass --walk to index a non-git folder.`,
      )
    }
    // Opt-in non-git fallback: a bounded directory walk, guarded against over-broad roots / oversized trees and stripped of .env / generated files.
    files = collectWalkIndexFiles(root)
  }
  let indexed = 0
  for (const f of files) {
    // Key on the same canonical absolute-normalized path every reader resolves to via resolveIndexPath. getTrackedFiles returns path.join(root, rel), so a relative root (the natural `token-goat index .`) yields relative paths; normalizePath alone would store a relative key that no reader can match.
    const key = resolveIndexPath(f)
    if (detectLanguage(key) === 'unknown') continue
    indexFileSync(key, dbPath)
    indexed += 1
  }
  const pruned = pruneDeletedFiles(resolveIndexPath(root), dbPath)
  out(`Indexed ${indexed} files into the symbol index.${pruned > 0 ? ` Pruned ${pruned} deleted file(s).` : ''}`)
}

function cmdMap(opts: { compact?: boolean }): void {
  const compact = opts.compact === true
  if (compact) {
    const entries = buildCompactMap(2000, process.cwd())
    out(formatMap(entries, { compact: true }))
  } else {
    const map = buildProjectMap(process.cwd(), { compact: false })
    out(formatProjectMap(map, false))
  }
}

async function cmdHook(event: string): Promise<void> {
  // relay handles its own stdin read / stdout write and never throws on a malformed/unknown event — it emits `{}` and returns.
  await relay(event)
}

async function cmdInstall(opts: { project?: boolean }): Promise<void> {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const result = installHooks(scope)
  out(`Installed token-goat hooks (${scope}) → ${result.settingsPath}`)

  // Pre-generate compacts for all installed skills.
  try {
    const skillDir = path.join(homedir(), '.claude', 'skills')
    if (fs.existsSync(skillDir)) {
      const entries = fs.readdirSync(skillDir, { withFileTypes: true })
      const skillNames: string[] = []
      const sessionFiles = getSessionFiles()
      const sessionId = Array.from(sessionFiles.keys())[0] ?? 'default'

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(skillDir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const body = fs.readFileSync(skillFile, 'utf-8')
          const compact = extractCompactFromMarker(body)
          if (compact === null) continue
          const sourceSha = contentHash(body)
          await storeCompact(sessionId, entry.name, compact, sourceSha)
          skillNames.push(entry.name)
        }
      }

      if (skillNames.length > 0) {
        // Write pregen.json with list of pre-generated skills.
        const dir = skillOutputsDir()
        await fs.promises.mkdir(dir, { recursive: true })
        const pregenPath = path.join(dir, 'pregen.json')
        const pregenData = { ts: Date.now(), names: skillNames }
        await fs.promises.writeFile(pregenPath, JSON.stringify(pregenData, null, 2))
        out(`Pre-generated ${skillNames.length} skill compacts.`)
      }
    }
  } catch {
    // fail-soft: install succeeded even if pre-gen fails
  }
}

function cmdUninstall(opts: { project?: boolean }): void {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const removed = uninstallHooks(scope)
  out(removed ? `Removed token-goat hooks (${scope}).` : `No token-goat hooks to remove (${scope}).`)
}

function cmdWorkerStart(): void {
  if (isWorkerRunning()) {
    out('Worker already running.')
    return
  }
  const pid = startDetachedWorker()
  out(`Worker started (pid ${pid}).`)
}

function cmdWorkerStop(): void {
  const stopped = stopWorker()
  out(stopped ? 'Worker stopped.' : 'No running worker.')
}

function cmdWorkerStatus(): void {
  out(isWorkerRunning() ? 'Worker is running.' : 'Worker is not running.')
}

function cmdStats(): void {
  renderStats({ windowDays: 30 })
}

function cmdDoctor(opts: { context?: boolean }): void {
  const doctorOpts: { dataDir?: string; configPath?: string; context?: boolean } = {}
  if (opts.context === true) {
    doctorOpts.context = true
  }
  const code = runDoctorAndExit(doctorOpts)
  if (code !== 0) {
    throw new CliError('doctor checks failed')
  }
}

function _applyFiltersAndPrint(
  content: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
): void {
  if (opts.section !== undefined) {
    const sectionResult = extractSection(content, opts.section)
    if (sectionResult !== null) {
      content = sectionResult.content
    }
  }

  if (opts.grep !== undefined) {
    let pattern = opts.grep
    // Normalize pattern to handle -E or --extended-regexp prefix
    if (pattern.startsWith('-E ') || pattern.startsWith('--extended-regexp ')) {
      pattern = pattern.replace(/^(?:-E\s+|--extended-regexp\s+)/, '')
    }
    try {
      const re = new RegExp(pattern)
      content = content
        .split(/\r?\n/)
        .filter((line) => re.test(line))
        .join('\n')
    } catch {
      content = content
        .split(/\r?\n/)
        .filter((line) => line.includes(pattern))
        .join('\n')
    }
  }

  if (opts.grep !== undefined && opts.maxMatches !== undefined) {
    const cap = Number.parseInt(opts.maxMatches, 10)
    if (Number.isFinite(cap) && cap > 0) {
      const matched = content === '' ? [] : content.split(/\r?\n/)
      if (matched.length > cap) {
        content = [...matched.slice(0, cap), '[token-goat: showing first ' + cap + ' of ' + matched.length + ' matching lines; raise --max-matches for more]'].join('\n')
      }
    }
  }

  const lines = content.split(/\r?\n/)
  const headN = opts.head ? (() => { const n = Number.parseInt(opts.head, 10); return Number.isFinite(n) && n > 0 ? n : 30 })() : 30
  const tailN = opts.tail ? (() => { const n = Number.parseInt(opts.tail, 10); return Number.isFinite(n) && n > 0 ? n : 80 })() : 80

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN + 1 ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

  let result = lines
  if (opts.head === undefined && opts.tail === undefined && opts.grep === undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
  }

  out(result.join('\n'))
}

function cmdBashOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; file?: string; maxMatches?: string; transcript?: boolean },
): void {
  if (opts.file !== undefined) {
    if (opts.file.includes('\0')) {
      throw new CliError('--file path contains a null byte')
    }
    if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(opts.file) && process.stdin.isTTY) {
      throw new CliError('--file /dev/stdin requires piped input; redirect a file instead')
    }
    let content: string
    try {
      const st = fs.statSync(opts.file)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--file '${opts.file}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      content = fs.readFileSync(opts.file, 'utf-8')
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`cannot read file: ${opts.file}`)
    }
    _applyFiltersAndPrint(opts.transcript === true ? extractTranscriptText(content) : content, opts)
    return
  }

  if (id === undefined) {
    throw new CliError('provide an <id> or --file <path>')
  }

  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached bash output for id: ${id}. If this id is from a background task, recall its output file directly with: token-goat bash-output --file <path-to-output-file>`)
  }

  _applyFiltersAndPrint(entry.output, opts)
}

function cmdWebOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
): void {
  if (id === undefined) {
    throw new CliError('provide a web cache <id>')
  }
  const content = getWebOutput(id)
  if (content === null) {
    throw new CliError(`no cached web output for id: ${id}. The cache may have expired; re-run the WebFetch to repopulate it.`)
  }
  _applyFiltersAndPrint(content, opts)
}

/**
 * Adapter for read_commands `run*` handlers, which print their own output and
 * return an exit code (0 ok, 1 handled error) rather than throwing a CliError.
 * Maps the return code onto `process.exitCode`; an unexpected throw still maps
 * to a stderr line + exit 1, matching the `guard` contract.
 */
function runExit(fn: () => number): void {
  try {
    process.exitCode = fn()
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

// Sets process.exitCode to the wrapped command's exit code (NOT via `guard`, which forces 0 on success — compress must propagate the real code so shell chaining still sees the original failure/success signal).
function cmdCompress(opts: {
  cmd: string
  filter?: string
  timeout?: string
  compress?: boolean
  profile?: string
  maxTokens?: string
}): void {
  try {
    if (opts.compress === false) {
      // Commander maps `--no-compress` to `opts.compress === false`.
      process.exitCode = bashRunner.runRaw(opts.cmd, parseTimeout(opts.timeout))
      return
    }
    const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) || 0 : 0
    process.exitCode = bashRunner.run(opts.cmd, {
      filterName: opts.filter,
      timeout: parseTimeout(opts.timeout),
      maxTokens,
      ...(opts.profile !== undefined ? { compressionProfile: opts.profile } : {}),
    })
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

/** Resolve the --timeout flag (seconds): 0/absent/invalid → the built-in default. */
function parseTimeout(raw: string | undefined): number {
  const sec = raw ? parseInt(raw, 10) : 0
  return Number.isFinite(sec) && sec > 0 ? sec : bashRunner.DEFAULT_TIMEOUT_SECONDS
}

async function cmdSkillBody(name: string, opts: { compact?: boolean }): Promise<void> {
  const filePath = await getSkillFilePath(name)
  if (filePath === null) {
    throw new CliError(`skill '${name}' not found`)
  }

  const body = fs.readFileSync(filePath, 'utf-8')
  if (opts.compact === true) {
    out(extractCompactFromMarker(body) ?? body)
  } else {
    out(body)
  }
  // Increment hit count for skill recall tracking.
  await incrementSkillHit(name)
}

async function cmdSkillCompact(name: string | undefined, opts: { path?: string; all?: boolean }): Promise<void> {
  const sessionFiles = getSessionFiles()
  const sessionId = Array.from(sessionFiles.keys())[0] ?? 'default'

  if (opts.all === true) {
    // Regenerate compacts for all skills, skipping fresh ones.
    const skills = await listSkills(sessionId)
    let regenerated = 0
    let skipped = 0
    for (const skill of skills) {
      const filePath = await getSkillFilePath(skill.name)
      if (!filePath) continue
      const body = fs.readFileSync(filePath, 'utf-8')
      const compact = extractCompactFromMarker(body)
      if (compact === null) continue
      const sourceSha = contentHash(body)
      if (skill.compactStale === false) {
        skipped++
      } else {
        await storeCompact(sessionId, skill.name, compact, sourceSha)
        regenerated++
      }
    }
    out(`Regenerated ${regenerated}, skipped ${skipped} (fresh), total ${skills.length}.`)
    return
  }

  let body: string
  let cacheName: string
  let sourcePath: string

  if (opts.path !== undefined && opts.path !== '') {
    // --path bypasses name resolution: read the body straight from the given file. The cache key is the explicit name when supplied, else the parent directory name (a skill lives in ~/.claude/skills/<name>/SKILL.md, so its parent dir is its name).
    if (!fs.existsSync(opts.path)) {
      throw new CliError(`skill file not found: ${opts.path}`)
    }
    body = fs.readFileSync(opts.path, 'utf-8')
    cacheName = name ?? path.basename(path.dirname(path.resolve(opts.path)))
    sourcePath = path.resolve(opts.path)
  } else {
    if (name === undefined || name === '') {
      throw new CliError('skill-compact requires a <name> or --path <file>')
    }
    const filePath = await getSkillFilePath(name)
    if (filePath === null) {
      throw new CliError(`skill '${name}' not found`)
    }
    body = fs.readFileSync(filePath, 'utf-8')
    cacheName = name
    sourcePath = filePath
  }

  // Persist the body (writes the meta that skill-list surfaces) and the compact slice, so a skill compacted straight from disk is both listable and recallable cross-session, exactly like one loaded via the Skill hook.
  await storeOutput(sessionId, cacheName, body, { sourcePath })
  const compact = extractCompactFromMarker(body)
  if (compact === null) {
    out(`Skill '${cacheName}' has no COMPACT_END marker — nothing to compact.`)
    return
  }
  const sourceSha = contentHash(body)
  await storeCompact(sessionId, cacheName, compact, sourceSha)
  out(`Cached compact for skill '${cacheName}'.`)
}

async function cmdSkillList(opts: { json?: boolean; sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  if (opts.json === true) {
    const json = skills.map((s) => ({
      name: s.name,
      skill_name: s.name,
      body_bytes: s.bodyLen,
      compact_bytes: s.compactLen,
      has_marker: s.hasMarker,
      compact_stale: s.compactStale,
      hit_count: s.hitCount,
      age_ms: s.ageMs,
    }))
    out(JSON.stringify(json, null, 2))
  } else {
    // Human table format with columns: name, body, compact, marker, hit count, age, stale/fresh/no-compact.
    const lines = skills.map((s) => {
      const bodyKb = (s.bodyLen / 1024).toFixed(1)
      const compactKb = s.compactLen > 0 ? (s.compactLen / 1024).toFixed(1) : '-'
      const marker = s.hasMarker ? 'yes' : 'no'
      const staleStatus = s.compactLen === 0 ? '[no-compact]' : (s.compactStale === true ? '[stale]' : s.compactStale === false ? '[fresh]' : '[unknown]')
      const age = formatAge(s.ageMs)
      return `${s.name.padEnd(25)} ${bodyKb.padStart(6)}K  ${compactKb.padStart(6)}K  ${marker}  ${s.hitCount.toString().padStart(3)}  ${age.padStart(3)}  ${staleStatus}`
    })
    const header = `${'Name'.padEnd(25)} ${'Body'.padStart(6)}  ${'Compact'.padStart(6)}  Marker  Hits  Age  Status`
    out([header, ...lines].join('\n'))
  }
}

async function cmdSkillSize(opts: { sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  let totalBody = 0
  let totalCompact = 0
  for (const skill of skills) {
    totalBody += skill.bodyLen
    totalCompact += skill.compactLen
  }
  const lines = [
    `# token-goat skill cache (${skills.length} skills)`,
    `Body:    ${totalBody} bytes`,
    `Compact: ${totalCompact} bytes`,
  ]

  // Add per-skill table.
  lines.push('')
  lines.push('## Per-skill breakdown')
  for (const skill of skills) {
    const bodyKb = (skill.bodyLen / 1024).toFixed(1)
    const compactKb = skill.compactLen > 0 ? (skill.compactLen / 1024).toFixed(1) : '-'
    lines.push(`  ${skill.name.padEnd(25)} body: ${bodyKb.padStart(6)}K  compact: ${compactKb.padStart(6)}K`)
  }

  // Add recommendations for skills without compacts and over ~1500 tokens (6000 bytes).
  const noCompactLargeSkills = skills.filter((s) => s.compactLen === 0 && s.bodyLen > 6000)
  if (noCompactLargeSkills.length > 0) {
    lines.push('')
    lines.push('## Recommendations')
    for (const skill of noCompactLargeSkills) {
      const estimatedTokens = Math.floor(skill.bodyLen / 4)
      lines.push(`  ${skill.name}: add <!-- COMPACT_END --> marker (body ~${estimatedTokens}tok, no compact slice)`)
    }
  }

  out(lines.join('\n'))
}

async function cmdSkillHistory(opts: { json?: boolean }): Promise<void> {
  const metas = (await listOutputs())
    .map((m) => ({ outputId: m.outputId, skillName: m.skillName, bytes: m.bodyBytes, truncated: m.truncated, ts: m.ts }))
    .sort((a, b) => b.ts - a.ts)

  if (opts.json === true) {
    const json = metas.map((m) => ({
      output_id: m.outputId,
      skill_name: m.skillName,
      bytes: m.bytes,
      truncated: m.truncated,
      timestamp: m.ts,
    }))
    out(JSON.stringify(json, null, 2))
  } else {
    const lines = metas.map((m) => {
      const timeStr = new Date(m.ts).toISOString().slice(0, 19)
      const truncMarker = m.truncated ? ' [truncated]' : ''
      return `${m.outputId.padEnd(40)} ${m.skillName.padEnd(25)} ${m.bytes.toString().padStart(8)} bytes  ${timeStr}${truncMarker}`
    })
    const header = `${'Output ID'.padEnd(40)} ${'Skill'.padEnd(25)} ${'Bytes'.padStart(8)}  Timestamp`
    out([header, ...lines].join('\n'))
  }
}

async function cmdSkillDiff(name: string): Promise<void> {
  if (!name) {
    throw new CliError('skill-diff requires a <name>')
  }
  const dir = skillOutputsDir()
  const versions = (await listOutputs())
    .filter((m) => m.skillName === name)
    .sort((a, b) => b.ts - a.ts)

  if (versions.length === 0) {
    out(`no cached versions of '${name}'`)
    return
  }
  if (versions.length < 2) {
    out(`only one cached version of '${name}'`)
    return
  }

  const newer = versions[0]!
  const older = versions[1]!
  const newerBody = await fs.promises.readFile(path.resolve(dir, `${newer.outputId}.txt`), 'utf-8').catch(() => null)
  const olderBody = await fs.promises.readFile(path.resolve(dir, `${older.outputId}.txt`), 'utf-8').catch(() => null)
  if (newerBody === null || olderBody === null) {
    out(`only one cached version of '${name}'`)
    return
  }
  const diff = buildLineDiff(olderBody, newerBody, name)
  out(diff)
}

async function cmdSkillSection(nameHeading: string, headingArg?: string): Promise<void> {
  if (!nameHeading) {
    throw new CliError('skill-section requires "<name>::<heading>" or <name> <heading>')
  }
  let skillName: string
  let heading: string
  if (headingArg) {
    skillName = nameHeading
    heading = headingArg
  } else {
    const sepIdx = findSpecSeparator(nameHeading)
    if (sepIdx === -1) {
      throw new CliError('skill-section requires "<name>::<heading>" format or <name> <heading> arguments')
    }
    skillName = nameHeading.slice(0, sepIdx)
    heading = nameHeading.slice(sepIdx + 2)
  }

  const filePath = await getSkillFilePath(skillName)
  if (!filePath) {
    throw new CliError(`skill '${skillName}' not found`)
  }
  const body = fs.readFileSync(filePath, 'utf-8')
  const extracted = extractNamedSection(body, heading)
  if (!extracted) {
    process.exitCode = 1
    return
  }
  out(extracted)
}

function atomicWriteBuffer(dest: string, data: Buffer): void {
  try {
    if (fs.statSync(dest).isDirectory()) {
      const e = Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${dest}'`), { code: 'EISDIR', path: dest }) as NodeJS.ErrnoException
      throw e
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // Place tmp in same directory as dest so rename is always same-device (avoids EXDEV); include random suffix to eliminate PID-reuse collisions.
  const rnd = Math.random().toString(36).slice(2, 8)
  const tmp = path.join(path.dirname(path.resolve(dest)), `.tmp.${process.pid}.${rnd}`)
  try {
    // mode 0o600 applies on POSIX only; on Windows Node.js ignores it and the tmp file inherits the default ACL.
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    try {
      fs.renameSync(tmp, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        // copyFileSync is non-atomic; EXDEV should not occur normally (tmp is same-dir) but can appear on overlay/bind-mount filesystems.
        fs.copyFileSync(tmp, dest)
        try { fs.unlinkSync(tmp) } catch (ue) {
          process.stderr.write(`token-goat write-file: warning: could not remove temp file ${tmp}: ${(ue as NodeJS.ErrnoException).message}\n`)
        }
      } else {
        throw e
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore cleanup failure */ }
    throw e
  }
}

function mapFsError(e: unknown, src?: string, dest?: string): never {
  const fe = e as NodeJS.ErrnoException
  if (fe.code === 'ENOENT') {
    const errPath = fe.path ?? ''
    const isSource = src !== undefined && path.resolve(errPath) === path.resolve(src)
    if (isSource) throw new CliError(`source file not found: ${src}`)
    // Always show the destination directory, never the internal .tmp path
    const destDir = dest ? path.dirname(path.resolve(dest)) : path.dirname(path.resolve(errPath || '.'))
    throw new CliError(`destination directory does not exist: ${destDir}`)
  }
  if (fe.code === 'ENOTDIR') {
    throw new CliError(`destination path contains a file where a directory was expected: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EISDIR') {
    const errPath = fe.path ?? ''
    // Windows: readFileSync on a directory yields e.path===undefined (atomicWriteBuffer always sets e.path=dest); empty errPath with a src arg means the source was the directory.
    const isSource = src !== undefined && (errPath === '' || path.resolve(errPath) === path.resolve(src))
    if (isSource) throw new CliError(`source is a directory, not a file: ${src}`)
    throw new CliError(`destination is a directory, not a file: ${dest ?? (errPath || '(unknown)')}`)
  }
  if (fe.code === 'EACCES' || fe.code === 'EPERM') {
    throw new CliError(`permission denied writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EROFS') {
    throw new CliError(`filesystem is read-only: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENOSPC') {
    throw new CliError(`no space left on device writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ELOOP') {
    throw new CliError(`too many levels of symbolic links resolving: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENAMETOOLONG') {
    throw new CliError(`path is too long: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EMFILE' || fe.code === 'ENFILE') {
    throw new CliError(`too many open files; close other processes or raise the file-descriptor limit and retry`)
  }
  if (fe.code === 'ETXTBSY') {
    throw new CliError(`file is in use by a running process: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EDQUOT') {
    throw new CliError(`disk quota exceeded writing to: ${dest ?? fe.path ?? ''}`)
  }
  throw e
}

// Windows reserved device names — writes to these are silently discarded or misrouted.
const WIN_RESERVED = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
  'CONIN$','CONOUT$',
])

function cmdWriteFile(dest: string, opts: { from?: string; b64?: string }): Promise<void> | void {
  if (!dest || !dest.trim()) {
    throw new CliError('destination path cannot be empty')
  }
  if (dest.includes('\0')) {
    throw new CliError('destination path contains a null byte')
  }
  if (isWindows()) {
    const base = path.basename(dest)
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase()
    if (WIN_RESERVED.has(stem)) {
      throw new CliError(`destination '${base}' is a reserved Windows device name`)
    }
    if (base.endsWith('.') || base.endsWith(' ')) {
      throw new CliError(`destination filename '${base}' ends with '${base.slice(-1)}' — Windows NTFS silently strips trailing dots and spaces, which would clobber a different file`)
    }
  }
  if (opts.from !== undefined && opts.b64 !== undefined) {
    throw new CliError('cannot use --from and --b64 together')
  }
  if (opts.from !== undefined) {
    if (!opts.from.trim()) {
      throw new CliError('--from path cannot be empty')
    }
    if (opts.from.includes('\0')) {
      throw new CliError('--from path contains a null byte')
    }
    // On POSIX, /dev/stdin blocks forever when the process is attached to a TTY.
    if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(opts.from) && process.stdin.isTTY) {
      throw new CliError('--from /dev/stdin requires piped input; use piped stdin mode or --b64 for interactive use')
    }
    try {
      const st = fs.statSync(opts.from)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--from '${opts.from}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      const maxFromMB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
      if (!Number.isFinite(maxFromMB) || maxFromMB <= 0) {
        throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
      }
      const maxFromBytes = maxFromMB * 1024 * 1024
      if (st.size > maxFromBytes) {
        throw new CliError(`--from source exceeds size limit (${Math.round(st.size / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`)
      }
      atomicWriteBuffer(dest, fs.readFileSync(opts.from))
    } catch (e) {
      if (e instanceof CliError) throw e
      mapFsError(e, opts.from, dest)
    }
    return
  }
  if (opts.b64 !== undefined) {
    // Strip whitespace (newlines from openssl/base64 CLI output) before url-safe normalization
    const normalized = opts.b64.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
    if (opts.b64 !== '' && normalized === '') {
      throw new CliError('--b64 payload contains only whitespace — likely a shell expansion error; pass an empty string explicitly for a zero-byte file')
    }
    const maxB64MB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
    if (!Number.isFinite(maxB64MB) || maxB64MB <= 0) {
      throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
    }
    const maxB64Bytes = maxB64MB * 1024 * 1024
    const decodedSize = Math.floor((normalized.replace(/=+$/, '').length * 3) / 4)
    if (decodedSize > maxB64Bytes) {
      throw new CliError(`--b64 payload would decode to ${Math.round(decodedSize / 1024 / 1024)} MB which exceeds size limit; set TOKEN_GOAT_MAX_STDIN_MB to override`)
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new CliError('--b64 payload contains non-base64 characters — check for shell expansion of $VAR or backticks')
    }
    // A single trailing data character (length % 4 === 1 after stripping padding) is always invalid; Buffer.from silently drops it, producing a corrupt or empty file.
    if (normalized.replace(/=+$/, '').length % 4 === 1) {
      throw new CliError('--b64 payload length is invalid (trailing single base64 character cannot decode to any bytes — payload is likely truncated)')
    }
    try {
      atomicWriteBuffer(dest, Buffer.from(normalized, 'base64'))
    } catch (e) {
      mapFsError(e, undefined, dest)
    }
    return
  }
  if (process.stdin.isTTY) {
    throw new CliError('stdin mode requires piped input; use --b64 or --from for interactive use')
  }
  const maxMB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
  if (!Number.isFinite(maxMB) || maxMB <= 0) {
    throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
  }
  const maxBytes = maxMB * 1024 * 1024
  return new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        if (!settled) {
          settled = true
          cleanup()
          process.stdin.destroy()
          reject(new CliError(`stdin input exceeds size limit (${Math.round(maxBytes / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`))
        }
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try { atomicWriteBuffer(dest, Buffer.concat(chunks)); resolve() }
      catch (e) { try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) } }
    }
    const onError = (e: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) }
    }
    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

async function cmdGdriveSections(fileId: string, opts: { heading?: string }): Promise<void> {
  if (opts.heading !== undefined) {
    const content = await getSectionContent(fileId, opts.heading)
    if (content === null) {
      throw new CliError(`section '${opts.heading}' not found in document ${fileId}`)
    }
    out(`# ${opts.heading}\n${content}`)
  } else {
    const sections = await getDocSections(fileId)
    const formatted = formatSections(sections)
    out(formatted)
  }
}

/** Expand glob patterns in a list of path strings using fs.globSync when available (Node 22+). Literal paths are passed through unchanged. */
function expandGlobs(root: string, patterns: string[]): string[] {
  const out: string[] = []
  const globFn = (fs as unknown as Record<string, unknown>)['globSync'] as
    | ((pattern: string, opts: { cwd: string }) => string[])
    | undefined
  for (const p of patterns) {
    if (globFn !== undefined && (p.includes('*') || p.includes('?') || p.includes('{'))) {
      try {
        const hits = globFn(p, { cwd: root })
        out.push(...hits.map((h) => path.join(root, h)))
        continue
      } catch {
        // fall through to literal path
      }
    }
    out.push(path.isAbsolute(p) ? p : path.join(root, p))
  }
  return out
}

function cmdPack(
  patterns: string[] | undefined,
  opts: {
    format?: string
    lineNumbers?: boolean
    instructionFile?: string
    output?: string
    ignore?: boolean
    stripComments?: boolean
    scanSecrets?: boolean
    budget?: string
  },
): void {
  try {
    const root = process.cwd()
    const style = opts.format === 'xml' ? 'xml' : opts.format === 'text' ? 'plain' : 'markdown'
    const collectOpts = {
      ...(opts.stripComments === true ? { do_strip_comments: true as const } : {}),
    }
    const patternList = patterns ?? []
    const expandedList = patternList.length > 0 ? expandGlobs(root, patternList) : []
    const result =
      expandedList.length > 0
        ? collectFiles(root, expandedList, collectOpts)
        : collectFromStdin(root, collectOpts)
    if (opts.budget !== undefined) {
      const budgetN = Number.parseInt(opts.budget, 10)
      if (result.total_tokens > budgetN) {
        err(`token-goat: pack: token count ${result.total_tokens} exceeds budget ${budgetN}`)
        process.exitCode = 3
        return
      }
    }
    if (opts.scanSecrets === true) {
      const hits = scanSecrets(result.files)
      if (hits.length > 0) {
        for (const hit of hits) {
          err(`token-goat: secret in ${hit.rel_path}:${hit.line}: ${hit.kind}`)
        }
        process.exitCode = 2
        return
      }
    }
    let instruction: string | undefined
    if (opts.instructionFile !== undefined) {
      instruction = fs.readFileSync(opts.instructionFile, 'utf8')
    }
    const formatted = formatPack(result, style, {
      ...(opts.lineNumbers === true ? { line_numbers: true } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
    })
    if (opts.output !== undefined) {
      fs.writeFileSync(opts.output, formatted, 'utf8')
    } else {
      out(formatted)
    }
    process.exitCode = 0
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

function cmdTokens(
  patterns: string[] | undefined,
  opts: { tree?: boolean; top?: string; asc?: boolean; json?: boolean },
): void {
  try {
    const root = process.cwd()
    const result = estimateBudget(root, expandGlobs(root, patterns ?? []))
    let entries = [...result.entries]
    if (opts.asc === true) entries.reverse()
    if (opts.top !== undefined) entries = entries.slice(0, requireInt('--top', opts.top))
    if (opts.json === true) {
      out(JSON.stringify({ entries, total_tokens: result.total_tokens, total_lines: result.total_lines }, null, 2))
      process.exitCode = 0
      return
    }
    if (opts.tree === true) {
      const dirs = new Map<string, typeof entries>()
      for (const e of entries) {
        const dir = path.dirname(e.rel_path)
        if (!dirs.has(dir)) dirs.set(dir, [])
        dirs.get(dir)!.push(e)
      }
      const lines: string[] = []
      for (const [dir, dirEntries] of dirs) {
        const dirTokens = dirEntries.reduce((s, e) => s + e.tokens, 0)
        const pct = result.total_tokens > 0 ? Math.round((dirTokens / result.total_tokens) * 100) : 0
        lines.push(`${dir}/ (${dirTokens} tokens, ${pct}%)`)
        for (const e of dirEntries) {
          lines.push(`  ${path.basename(e.rel_path).padEnd(30)}  ${String(e.tokens).padStart(8)} tokens`)
        }
      }
      out(lines.join('\n'))
      process.exitCode = 0
      return
    }
    if (entries.length === 0) {
      out('No files matched.')
      process.exitCode = 0
      return
    }
    const colW = Math.max(4, Math.max(...entries.map((e) => e.rel_path.length)))
    const lines = [
      `${'File'.padEnd(colW)}  ${'~Tokens'.padStart(8)}  ${'Lines'.padStart(6)}`,
      `${'-'.repeat(colW)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`,
    ]
    for (const e of entries) {
      lines.push(`${e.rel_path.padEnd(colW)}  ${String(e.tokens).padStart(8)}  ${String(e.lines).padStart(6)}`)
    }
    out(lines.join('\n'))
    process.exitCode = 0
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

function cmdBudget(
  patterns: string[],
  opts: { context?: string; json?: boolean },
): void {
  try {
    const root = process.cwd()
    const result = estimateBudget(root, expandGlobs(root, patterns))
    if (opts.json === true) {
      out(JSON.stringify(result, null, 2))
    } else {
      const contextK = opts.context !== undefined ? Number.parseInt(opts.context, 10) : undefined
      out(formatBudgetText(result, contextK))
    }
    process.exitCode = 0
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

function cmdFailures(
  src: string | undefined,
  opts: { runner?: string; json?: boolean },
): void {
  try {
    const text = src !== undefined ? fs.readFileSync(src, 'utf8') : fs.readFileSync(0, 'utf8')
    const result = extractFailures(text, opts.runner !== undefined ? { runner: opts.runner } : {})
    out(opts.json === true ? formatFailuresJson(result) : formatFailuresText(result))
    process.exitCode = 0
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

// --- Program assembly -------------------------------------------------------

/** Build the Commander program. Exported so tests can introspect/parse it. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('token-goat')
    .description('Surgical token-reduction companion for AI coding agents')
    .version(VERSION, '-v, --version', 'print the token-goat version')

  // Each action wraps the (possibly sync) handler so any thrown CliError or unexpected error maps to a stderr line + exit code 1, and success to 0.
  const guard =
    (fn: (...a: never[]) => void | Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      try {
        await fn(...(args as never[]))
        process.exitCode = 0
      } catch (e) {
        const msg = extractErrorMessage(e)
        err(`token-goat: ${msg}`)
        process.exitCode = 1
      }
    }

  program
    .command('symbol <name>')
    .description('search for a symbol by name')
    .option('-l, --limit <n>', 'max results')
    .option('-f, --file <path>', 'restrict to one file')
    .option('-k, --kind <kind>', 'restrict to one kind (function, class, ...)')
    .option('-j, --json', 'output as JSON')
    .action((name: string, opts: { limit?: string; file?: string; kind?: string; json?: boolean }) =>
      runExit(() =>
        runSymbol({
          name,
          limit: opts.limit !== undefined ? requireInt('--limit', opts.limit) : 20,
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('read <spec>')
    .description("read one symbol's full body (spec: file::symbol)")
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runRead({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('section <spec>')
    .description('read one section from a file (spec: file::heading), or list all sections with --list')
    .option('-j, --json', 'output as JSON')
    .option('--list', 'list all section headings in the file instead of reading one')
    .action((spec: string, opts: { json?: boolean; list?: boolean }) =>
      runExit(() =>
        opts.list === true
          ? runListSections({ file: spec, ...(opts.json === true ? { json: true } : {}) })
          : runSection({ spec, ...(opts.json === true ? { json: true } : {}) }),
      ),
    )

  program
    .command('semantic <query>')
    .description('semantic search (falls back to full-text search)')
    .option('-l, --limit <n>', 'max results')
    .action(guard(cmdSemantic))

  program
    .command('skeleton <file>')
    .description('list all symbols in a file without bodies')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .action((file: string, opts: { json?: boolean; minLines?: string }) =>
      runExit(() =>
        runSkeleton({
          file,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.minLines !== undefined ? { minLines: Number.parseInt(opts.minLines, 10) } : {}),
        }),
      ),
    )

  program
    .command('outline <file>')
    .description('list symbols with line ranges and docstrings')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .action((file: string, opts: { json?: boolean; minLines?: string }) =>
      runExit(() =>
        runOutline({
          file,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.minLines !== undefined ? { minLines: Number.parseInt(opts.minLines, 10) } : {}),
        }),
      ),
    )

  program
    .command('refs <spec>')
    .description('find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view)')
    .option('--callers', 'group references by their enclosing caller symbol')
    .option('-l, --limit <n>', 'max results')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { callers?: boolean; limit?: string; json?: boolean }) =>
      runExit(() =>
        runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('index [path]')
    .description('parse all git-tracked files and (re)build the symbol index')
    .option('--walk', 'if not a git repo, index a bounded directory walk instead (skips .env / generated / oversized trees)')
    .action(guard(cmdIndex))

  program
    .command('map')
    .description('project overview')
    .option('-c, --compact', 'compact, low-token summary')
    .action(guard(cmdMap))

  program
    .command('hook <event>')
    .description('hook relay entrypoint (reads JSON on stdin)')
    .action(guard(cmdHook))

  program
    .command('install')
    .description('install hooks into Claude Code settings')
    .option('-p, --project', 'install into project scope instead of user scope')
    .action(guard(cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .action(guard(cmdUninstall))

  const worker = program.command('worker').description('background indexer lifecycle')
  worker.command('start').description('start the background indexer').action(guard(cmdWorkerStart))
  worker.command('stop').description('stop the background indexer').action(guard(cmdWorkerStop))
  worker.command('status').description('check if the indexer is running').action(guard(cmdWorkerStatus))

  program.command('stats').description('show session statistics').action(guard(cmdStats))

  program.command('doctor').description('diagnose token-goat health').option('--context', 'include context footprint analysis').action(guard(cmdDoctor))

  program
    .command('bash-output [id]')
    .description('retrieve cached bash output by ID or file')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the output')
    .option('--file <path>', 'read from raw output file instead of cache')
    .option('--transcript', 'parse the --file as a JSONL agent transcript: keep assistant text blocks in order before filtering')
    .action(guard(cmdBashOutput))

  program
    .command('web-output [id]')
    .description('retrieve a cached WebFetch response body by ID')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the response')
    .action(guard(cmdWebOutput))

  program
    .command('exports <file>')
    .description('list exported (public) symbols in a file')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runExports({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('imports <file>')
    .description('list the modules a file imports')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runImports({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('find <pattern>')
    .description('find files containing a symbol matching a pattern')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results')
    .action((pattern: string, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runFind({
          pattern,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('grep <pattern> [path]')
    .description('regex search over files, caching nothing (session-aware grep)')
    .option('-j, --json', 'output as JSON')
    .option('--max-lines <n>', 'max matching lines to print')
    .option('--no-recursive', 'do not descend into subdirectories')
    .action((pattern: string, pathArg: string | undefined, opts: { json?: boolean; maxLines?: string; recursive?: boolean }) =>
      runExit(() =>
        runGrep({
          pattern,
          ...(pathArg !== undefined ? { path: pathArg } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.maxLines !== undefined ? { maxLines: Number.parseInt(opts.maxLines, 10) } : {}),
          ...(opts.recursive === false ? { recursive: false } : {}),
        }),
      ),
    )

  program
    .command('skill-body <name>')
    .description("retrieve a skill's cached body")
    .option('-c, --compact', 'print compact slice instead of full body')
    .action(guard(cmdSkillBody))

  program
    .command('skill-compact [name]')
    .description('regenerate and cache compact slice for a skill')
    .option('--path <file>', 'read the skill body from this file instead of resolving by name')
    .option('--all', 'regenerate compacts for all skills, skipping fresh ones')
    .action(guard(cmdSkillCompact))

  program
    .command('skill-list')
    .description('list all cached skills with token counts')
    .option('-j, --json', 'output as JSON')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillList))

  program
    .command('skill-size')
    .description('show body/compact token counts per skill')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillSize))

  program
    .command('skill-history')
    .description('list cached skill versions newest-first')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdSkillHistory))

  program
    .command('skill-diff <name>')
    .description('show diff between two cached versions of a skill')
    .action(guard(cmdSkillDiff))

  program
    .command('skill-section <nameHeading> [headingArg]')
    .description('extract a named section from a skill')
    .action(guard(cmdSkillSection))

  program
    .command('callers <symbol>')
    .description('find all callers of a symbol, resolved to their enclosing function')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max references to scan')
    .action((symbol: string, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runCallers({
          symbol,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('call-chain <symbol>')
    .description('transitive callers up toward entry points (BFS, cycle-safe)')
    .option('-d, --depth <n>', 'max BFS depth (default 8)')
    .option('-j, --json', 'output as JSON')
    .action((symbol: string, opts: { depth?: string; json?: boolean }) =>
      runExit(() =>
        runCallChain({
          symbol,
          ...(opts.depth !== undefined ? { depth: Number.parseInt(opts.depth, 10) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('impact <symbol>')
    .description('transitive set of callers impacted by a change (with hop depth)')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .action((symbol: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runImpact({
          symbol,
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('dead')
    .description('symbols with zero references (default kind: function)')
    .option('-k, --kind <kind>', 'symbol kind to check (function, method, class, ...)')
    .option('--include-private', 'include _-prefixed names')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .action((opts: { kind?: string; includePrivate?: boolean; top?: string; json?: boolean }) =>
      runExit(() =>
        runDead({
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('deps <file>')
    .description('one-level imports: resolves relative imports to project files, groups others as external')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runDeps({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('types [file]')
    .description('type-like declarations (type, interface, enum, struct, trait, and Python type classes)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results per kind')
    .action((file: string | undefined, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runTypes({
          ...(file !== undefined ? { file } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('scope <fileColonLine>')
    .description('list symbols enclosing a file:line position, innermost first')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runScope({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('similar <spec>')
    .description('find symbols similar to a given "file::symbol" anchor using FTS')
    .option('--top <n>', 'max results (default 10)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runSimilar({
          spec,
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('context-for <task>')
    .description('suggest token-goat read commands for symbols relevant to a task')
    .option('--top <n>', 'max results (default 12)')
    .option('--budget <n>', 'stop when estimated tokens exceed budget')
    .option('-j, --json', 'output as JSON')
    .action((task: string, opts: { top?: string; budget?: string; json?: boolean }) =>
      runExit(() =>
        runContextFor({
          task,
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.budget !== undefined ? { budget: Number.parseInt(opts.budget, 10) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('test-for <file>')
    .description('list test files that reference symbols defined in a source file')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runTestFor({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('coverage-gaps')
    .description('functions and methods with no references in test files')
    .option('--top <n>', 'limit output to top N results (default 50)')
    .option('--include-private', 'include _-prefixed symbols')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; includePrivate?: boolean; json?: boolean }) =>
      runExit(() =>
        runCoverageGaps({
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('arch')
    .description('internal import graph analysis: hubs, entry points, cycles')
    .option('--top <n>', 'limit hubs and entry points to top N (default 10)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runArch({
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('blame <spec>')
    .description('git blame for the line range of a symbol ("file::symbol")')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runBlame({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('ask <question>')
    .description('(experimental) find relevant code context; synthesize with an LLM if TOKEN_GOAT_ASK_BACKEND is set')
    .option('--top <n>', 'max FTS hits to surface (default 8)')
    .option('-j, --json', 'output as JSON')
    .action((question: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runAsk({
          question,
          ...(opts.top !== undefined ? { top: requireInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('pack [patterns...]')
    .description('bundle matched files into a single LLM-ready output (Markdown, XML, or plain text)')
    .option('--format <style>', 'output style: md (default), xml, or text', 'md')
    .option('--line-numbers', 'prefix each line with its line number')
    .option('--instruction-file <path>', 'append a task prompt from a file')
    .option('--output <path>', 'write output to a file instead of stdout')
    .option('--no-ignore', 'bypass .tokengoatignore patterns')
    .option('--strip-comments', 'remove language-appropriate comments before packing')
    .option('--scan-secrets', 'scan for credentials; exit 2 if any are found')
    .option('--budget <n>', 'exit 3 if the estimated token count exceeds n')
    .action(cmdPack)

  program
    .command('tokens [patterns...]')
    .description('per-file token footprint table, sorted largest-first')
    .option('--tree', 'group by directory with subtotals and percentage of total')
    .option('--top <n>', 'limit to the N biggest files')
    .option('--asc', 'reverse order (ascending)')
    .option('-j, --json', 'output as JSON')
    .action(cmdTokens)

  program
    .command('budget <patterns...>')
    .description('estimate the total token cost of a file set')
    .option('--context <n>', 'context window in thousands of tokens (shows % fill)')
    .option('-j, --json', 'output as JSON')
    .action(cmdBudget)

  program
    .command('failures [src]')
    .description('extract failing test blocks from test runner output (pytest, Jest, Go, Cargo)')
    .option('--runner <name>', 'runner hint: pytest, jest, go, or cargo')
    .option('-j, --json', 'output as JSON')
    .action(cmdFailures)

  program
    .command('todo [patterns...]')
    .description('scan source files for TODO/FIXME/HACK/XXX/NOTE markers')
    .option('--group <by>', 'group output by file or kind (default: file)')
    .option('--kinds <csv>', 'comma-separated marker kinds to include (default: TODO,FIXME,HACK,XXX,NOTE)')
    .option('-j, --json', 'output as JSON')
    .action((patterns: string[], opts: { group?: string; kinds?: string; json?: boolean }) =>
      guard(() => cmdTodo(patterns, opts))(),
    )

  program
    .command('trace [src]')
    .description('condense a Python traceback to project frames only')
    .option('--keep <n>', 'keep last N project frames (default: all)')
    .option('-j, --json', 'output as JSON')
    .action((src: string | undefined, opts: { keep?: string; json?: boolean }) =>
      guard(() => cmdTrace(src, opts))(),
    )

  program
    .command('logfold [src]')
    .description('apply log-noise filters then fold consecutive duplicate lines')
    .option('--tail <n>', 'only process the last N lines of input')
    .option('--no-normalize', 'skip volatile-token normalization (still applies filters and folds)')
    .option('-j, --json', 'output as JSON')
    .action((src: string | undefined, opts: { tail?: string; normalize?: boolean; json?: boolean }) =>
      guard(() => cmdLogfold(src, { tail: opts.tail, noNormalize: opts.normalize === false, json: opts.json }))(),
    )

  program
    .command('lockdeps [path]')
    .description('summarize a dependency lockfile (auto-detects package-lock.json, yarn.lock, poetry.lock, uv.lock, Pipfile.lock, Cargo.lock, requirements*.txt)')
    .option('-j, --json', 'output as JSON')
    .action((filePath: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdLockdeps(filePath, opts))(),
    )

  program
    .command('note <action> [key] [value]')
    .description('per-project key-value notes (actions: set, get, unset, list, clear)')
    .option('-j, --json', 'output as JSON (list action only)')
    .action((action: string, key: string | undefined, value: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdNote(action, key, value, opts))(),
    )

  program
    .command('hot')
    .description('show most-read files across all sessions (current session: use `recent`)')
    .option('-l, --limit <n>', 'max results (default: 20)')
    .option('--project', 'filter to files under the current project root')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; project?: boolean; json?: boolean }) =>
      guard(() => cmdHot(opts))(),
    )

  program
    .command('recent [n]')
    .description('show N most-recently read/edited files in the current session (cross-session: use `hot`)')
    .option('-j, --json', 'output as JSON')
    .action((n: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdRecent(n, opts))(),
    )

  program
    .command('ignores')
    .description('report active file-exclusion settings (walk mode, built-ins, blocked_roots, exclude_tests)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) =>
      guard(() => cmdIgnores(opts))(),
    )


  program
    .command('bash-history')
    .description('list cached bash output entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdBashHistory(opts))())

  program
    .command('web-history')
    .description('list cached web-fetch output entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdWebHistory(opts))())

  program
    .command('clean-cache')
    .description('prune all cache subdirs to default retention limits (200 entries, 24 h)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdCleanCache(opts))())

  program
    .command('prune-cache')
    .description('evict cache entries older than --max-age-hours or beyond --max-count (caller-specified bounds)')
    .option('--max-count <n>', 'max entries to keep per subdir (default: 200)')
    .option('--max-age-hours <h>', 'max age in hours to keep (default: 24)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { maxCount?: string; maxAgeHours?: string; json?: boolean }) => guard(() => cmdPruneCache(opts))())

  program
    .command('cache-audit')
    .description('check settings.json hook installation and env-var gates that defeat token-goat caching')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdCacheAudit(opts))())

  program
    .command('resume <session-id>')
    .description('print a recovery context packet for the given session id')
    .option('-j, --json', 'output as JSON')
    .action((sessionId: string, opts: { json?: boolean }) => guard(() => cmdResume({ sessionId, ...opts }))())

  program
    .command('compact-hint')
    .description('show compact manifest info and context pressure (reuses compact.ts — does not rebuild the manifest)')
    .option('--session-id <id>', 'session id to inspect (default: latest)')
    .option('--trigger <mode>', 'set to "auto" to preview autocompact budget')
    .option('-j, --json', 'output as JSON')
    .action((opts: { sessionId?: string; trigger?: string; json?: boolean }) => guard(() => cmdCompactHint(opts))())

  program
    .command('session-summary')
    .description('one-screen summary of the latest cached session: file counts, top files, session id')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdSessionSummary(opts))())

  program
    .command('cost')
    .description('tokens-saved / cost breakdown (thin framing over stats; --session narrows to current session)')
    .option('--session', 'show session-level file stats only')
    .option('-j, --json', 'output as JSON')
    .action((opts: { session?: boolean; json?: boolean }) => guard(() => cmdCost(opts))())

  program
    .command('baseline')
    .description('emit the project baseline map (file count, languages, top symbols, recent files)')
    .option('--subagent', 'emit terser compact variant for subagent context')
    .option('-j, --json', 'output as JSON')
    .action((opts: { subagent?: boolean; json?: boolean }) => guard(() => cmdBaseline(opts))())

  program
    .command('config <action> [key] [value]')
    .description('manage token-goat config (list|get|set|validate). Operates on the token-goat config.toml, not a project config file.')
    .option('-j, --json', 'output as JSON')
    .action((action: string, key: string | undefined, value: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdConfig({ action, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('project <action> [path]')
    .description('manage indexed project roots (list|exclude|prune). list = active project + blocked roots; exclude <path> = add to block list; prune = remove stale entries.')
    .option('-j, --json', 'output as JSON')
    .action((action: string, pathArg: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdProject({ action, ...(pathArg !== undefined ? { pathArg } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('compact-doc <path>')
    .description('print an extractive compact of a document (note: prints to stdout; hook-serve is a planned future feature)')
    .option('--heading <heading>', 'compact only the named section')
    .option('-j, --json', 'output as JSON')
    .action((filePath: string, opts: { heading?: string; json?: boolean }) =>
      guard(() => cmdCompactDoc({ filePath, ...(opts.heading !== undefined ? { heading: opts.heading } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('fetch-image <url>')
    .description('fetch an image URL and shrink it (saves to --out path or a temp file)')
    .option('--out <path>', 'output file path')
    .option('-j, --json', 'output as JSON')
    .action((url: string, opts: { out?: string; json?: boolean }) =>
      guard(() => cmdFetchImage({ url, ...(opts.out !== undefined ? { out: opts.out } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('history')
    .description('show recent session history: bash commands and web fetches (current-session or recent cache)')
    .option('--limit <n>', 'max entries to show (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdHistory(opts))())

  program
    .command('changed')
    .description('list files or symbols changed since a git ref')
    .option('--since <ref>', 'git ref to compare against (default: HEAD~5)')
    .option('--symbol', 'list symbols instead of files')
    .option('-j, --json', 'output as JSON')
    .action((opts: { since?: string; symbol?: boolean; json?: boolean }) =>
      runExit(() =>
        runChanged({
          ref: opts.since ?? 'HEAD~5',
          ...(opts.symbol === true ? { symbolMode: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('config-get <file> <key>')
    .description('read one value from a config file (TOML/JSON/YAML/INI)')
    .action((file: string, key: string) => runExit(() => runConfigGet({ file, key })))

  program
    .command('write-file <dest>')
    .description('write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping\n\nModes: --b64 PAYLOAD (base64), --from SOURCE (copy file), or piped stdin')
    .option('--from <source>', 'copy bytes from this source file instead of stdin/base64')
    .option('--b64 <payload>', 'decode base64 payload and write to dest')
    .action(guard(cmdWriteFile))

  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .action(guard(cmdGdriveSections))

  program
    .command('compress')
    .description('run a shell command and emit a compressed view of its output')
    .requiredOption('-c, --cmd <command>', 'the shell command to run, as one string')
    .option('-f, --filter <name>', 'filter name (auto-detected from the command when omitted)')
    .option('--timeout <seconds>', 'wall-clock timeout in seconds (0 = built-in default)')
    .option('--no-compress', 'stream output raw without compression (debug the wrapper)')
    .option('--profile <name>', 'compression profile: aggressive | balanced | minimal')
    .option('--max-tokens <n>', 'post-compress token cap (0 = no cap)')
    .action(cmdCompress)

  program
    .command('version')
    .description('print the token-goat version')
    .action(
      guard(() => {
        out(VERSION)
      }),
    )

  return program
}

/**
 * Parse `argv` and dispatch. Sets `process.exitCode`; callers (main.ts) should
 * let the process exit naturally so buffered stdout flushes first.
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram()
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command) instead of letting it call process.exit() mid-flush.
  program.exitOverride()
  try {
    await program.parseAsync(argv)
  } catch (e) {
    // Help / version requests throw with these codes and are not errors.
    const code = (e as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      process.exitCode = 0
      return
    }
    if (code === 'commander.unknownCommand' || code === 'commander.missingArgument') {
      // Commander already wrote its diagnostic to stderr.
      process.exitCode = 1
      return
    }
    const msg = extractErrorMessage(e)
    err(`token-goat: ${msg}`)
    process.exitCode = 1
  }
}
