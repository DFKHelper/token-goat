/**
 * Doctor CLI helpers — diagnose token-goat health.
 *
 * Provides check utilities and the runDoctor() entrypoint for the doctor command.
 */

import { compileCustomPatterns } from './secret_redact.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync, spawnSync } from 'child_process'
import { parse } from 'smol-toml'
import { extractErrorMessage, toKB } from './util.js'
import { isWorkerRunning, dirtyQueuePathFor, drainHeartbeatPathFor, WORKER_HEARTBEAT_STALE_MS } from './worker.js'
import { emptyIndexMessage, getProjectIndexCounts, getEmbeddingCoverage } from './index_health.js'
import { dataDir as defaultDataDir, configPath as defaultConfigPath } from './constants.js'
import { CONFIG_KEY_ENV_OVERRIDES, loadConfig, PROJECT_LOCKED_KEYS, PROJECT_LOCKED_SECTIONS, readConfigSource } from './config.js'
import { envBool } from './env.js'
import type { Config } from './config.js'
import { runContextStats } from './cli_context_stats.js'
import { skillOutputsDir } from './skill_cache.js'
import { copilotCliConfigPath, copilotCliScriptPath } from './bridges/copilot_cli_install.js'
import { findStrayClaudeMdBlocks } from './install.js'
import { isAvailable as tsRefsAvailable, loadError as tsRefsLoadError } from './ts_refs.js'
import { isAvailable as embeddingModelAvailable, embeddingBackendLoadError } from './embeddings.js'
import { checkSymbolBodySize } from './symbol_body_probe.js'
import { getDb } from './db.js'
import { readUnmappedTools } from './stats.js'
import type { DoctorResult } from './doctor_result.js'

// Both live outside this module so hooks_session_start.ts can run the one check it needs without
// pulling cli_doctor.ts's dependency graph into the hook bundle -- see symbol_body_probe.ts. They
// are re-exported here because the doctor command and its tests are the rest of their audience.
export type { DoctorResult } from './doctor_result.js'
export { checkSymbolBodySize, OVERSIZED_BODY_PROBE_SQL } from './symbol_body_probe.js'

export interface ProcessInfo {
  processId: number
  parentProcessId: number
  name: string
  commandLine: string
}

export function globalMcpConfigPath(): string {
  const copilotHome = process.env['COPILOT_HOME']
  const root = copilotHome !== undefined && copilotHome.trim() !== ''
    ? path.resolve(copilotHome)
    : path.join(os.homedir(), '.copilot')
  return path.join(root, 'mcp-config.json')
}

export function checkGlobalMcpConfig(configPath = globalMcpConfigPath()): DoctorResult {
  if (!fs.existsSync(configPath)) {
    return { name: 'Global MCP configuration', status: 'ok', message: `no global Copilot MCP configuration found at ${configPath}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `could not read global Copilot MCP configuration at ${configPath}; unable to audit heavy launchers.`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `global Copilot MCP configuration at ${configPath} has an unsupported format; unable to audit heavy launchers.`,
    }
  }

  const configuredServers = (parsed as Record<string, unknown>)['mcpServers']
  if (typeof configuredServers !== 'object' || configuredServers === null || Array.isArray(configuredServers)) {
    return { name: 'Global MCP configuration', status: 'ok', message: `no global stdio MCP servers configured at ${configPath}` }
  }

  let chromeDevTools = 0
  let playwright = 0
  for (const server of Object.values(configuredServers)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) continue
    const entry = server as Record<string, unknown>
    const rawCommand = entry['command']
    const command = typeof rawCommand === 'string' ? rawCommand : ''
    const args = entry['args']
    if (!/\bnpx(?:\.cmd)?\b/i.test(command) || !Array.isArray(args)) continue
    const invocation = args.filter((arg): arg is string => typeof arg === 'string').join(' ')
    if (/\bchrome-devtools-mcp\b/i.test(invocation)) chromeDevTools += 1
    if (/@playwright[\\/]mcp\b/i.test(invocation)) playwright += 1
  }

  if (chromeDevTools > 0 || playwright > 0) {
    const launchers: string[] = []
    if (chromeDevTools > 0) launchers.push(`${chromeDevTools} Chrome DevTools MCP launcher${chromeDevTools === 1 ? '' : 's'}`)
    if (playwright > 0) launchers.push(`${playwright} Playwright MCP launcher${playwright === 1 ? '' : 's'}`)
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `${launchers.join(' and ')} configured at ${configPath}. Move heavy launchers to project scope or remove them when not actively needed.`,
    }
  }

  return { name: 'Global MCP configuration', status: 'ok', message: `no known heavy global MCP launchers configured at ${configPath}` }
}

export function checkMcpProcessHealth(processes: readonly ProcessInfo[] | null): DoctorResult {
  // `null` means the gather itself failed, which is not the same as "gathered, found nothing".
  // Reporting the ok message for a failed gather is a clean bill of health backed by no data.
  if (processes === null) {
    return {
      name: 'MCP process health',
      status: 'warn',
      message: 'could not read the process list (PowerShell did not answer), so duplicate MCP launchers and orphaned Node processes were not checked',
    }
  }
  const byPid = new Set(processes.map((process) => process.processId))
  const nodeProcesses = processes.filter((process) => process.name.toLowerCase() === 'node.exe')
  const chromeLaunchers = nodeProcesses.filter((process) => /npx-cli\.js.*chrome-devtools-mcp/i.test(process.commandLine))
  const playwrightLaunchers = nodeProcesses.filter((process) => /npx-cli\.js.*@playwright[\\/]mcp/i.test(process.commandLine))
  // token-goat's own indexing daemon is spawned detached, so its parent is gone the moment it
  // starts -- being parentless is what healthy looks like for it, not a symptom. Without this the
  // check warned on nearly every install and advised terminating the very process that keeps the
  // index current. Matched on the daemon flag it is always launched with (see worker.ts).
  const orphanedNodeProcesses = nodeProcesses.filter(
    (process) => !byPid.has(process.parentProcessId) && !/--worker-daemon\b/.test(process.commandLine),
  )
  const launchers = chromeLaunchers.length + playwrightLaunchers.length

  if (launchers > 2 || orphanedNodeProcesses.length > 0) {
    const details: string[] = []
    if (chromeLaunchers.length > 1) details.push(`${chromeLaunchers.length} Chrome DevTools MCP launchers`)
    if (playwrightLaunchers.length > 1) details.push(`${playwrightLaunchers.length} Playwright MCP launchers`)
    if (orphanedNodeProcesses.length > 0) details.push(`${orphanedNodeProcesses.length} orphaned Node process${orphanedNodeProcesses.length === 1 ? '' : 'es'}`)
    return {
      name: 'MCP process health',
      status: 'warn',
      message: `${details.join('; ')} detected. These are host-managed processes; close stale Copilot sessions before terminating a specific confirmed orphan.`,
    }
  }

  return { name: 'MCP process health', status: 'ok', message: 'no duplicate MCP launchers or orphaned Node processes detected' }
}

function runProcessListCommand(): string {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  return execSync(`powershell.exe -NoProfile -NonInteractive -Command "${command}"`, {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
}

/**
 * `null` when the process list could not be read at all, so a caller can tell that apart from an
 * empty machine. `runCommand` exists so a test can force that failure; the default is the real
 * PowerShell call, and the sibling test that supplies no override drives it live.
 */
export function readWindowsProcesses(runCommand: () => string = runProcessListCommand): ProcessInfo[] | null {
  if (process.platform !== 'win32') return []
  try {
    const output = runCommand().trim()
    if (output === '') return []
    const parsed: unknown = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row): ProcessInfo[] => {
      if (typeof row !== 'object' || row === null) return []
      const value = row as Record<string, unknown>
      if (typeof value['ProcessId'] !== 'number' || typeof value['ParentProcessId'] !== 'number' || typeof value['Name'] !== 'string') return []
      return [{
        processId: value['ProcessId'],
        parentProcessId: value['ParentProcessId'],
        name: value['Name'],
        commandLine: typeof value['CommandLine'] === 'string' ? value['CommandLine'] : '',
      }]
    })
  } catch {
    return null
  }
}

/**
 * Check if the token-goat worker process is running for `dataDir`. Accepts an explicit
 * `dataDir` (defaulting to the real install dir via isWorkerRunning's own default) so a
 * caller diagnosing a specific data directory -- as runDoctor does when given a non-default
 * `dataDir`, exactly like checkDbExists/checkSymbolCount/checkDirtyQueueHealth already do --
 * checks that directory's pid file rather than always the real default one.
 */
export function checkWorkerRunning(dataDir?: string): boolean {
  return dataDir !== undefined ? isWorkerRunning(dataDir) : isWorkerRunning()
}

/**
 * Size at which the index DB stops being merely large and starts being a
 * functional problem: write transactions scale with it, and once one outlasts
 * db.ts's 15s `busy_timeout` the failure reaches the user as "database is
 * locked" rather than as anything mentioning size. A healthy index for a large
 * multi-project tree is tens of MB, so 1 GB is well clear of normal use and
 * still catches the pathology early.
 */
const DB_SIZE_WARN_BYTES = 1024 * 1024 * 1024

/**
 * Check if the data directory and database files exist.
 */
export function checkDbExists(dataDir: string): DoctorResult {
  const dbPath = path.join(dataDir, 'global.db')
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'Database',
      status: 'warn',
      message: `global.db not found at ${dbPath}`,
    }
  }
  const sizeBytes = fs.statSync(dbPath).size
  const SQLITE_HEADER = 'SQLite format 3\0'
  let header = ''
  try {
    const fd = fs.openSync(dbPath, 'r')
    try {
      const buf = Buffer.alloc(SQLITE_HEADER.length)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      header = buf.toString('latin1', 0, bytesRead)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // treat an unreadable file as invalid below
  }
  if (header !== SQLITE_HEADER) {
    return {
      name: 'Database',
      status: 'fail',
      message: `global.db at ${dbPath} is not a valid SQLite file (${sizeBytes} bytes) — likely truncated or corrupt`,
    }
  }
  // An index that has grown into the gigabytes is not merely a disk-space matter: every reindex
  // transaction scales with it, and once a write outlasts db.ts's 15s busy_timeout the failure
  // presents to the user as an unexplained "database is locked" plus long stalls during
  // `token-goat index`. Surface the size directly, because the symptom points nowhere near the
  // cause. A healthy index is tens of MB; 1 GB means something is storing far more per symbol
  // than it should (see MAX_SYMBOL_BODY_CHARS in parser.ts).
  if (sizeBytes > DB_SIZE_WARN_BYTES) {
    return {
      name: 'Database',
      status: 'warn',
      message:
        `global.db is ${Math.round(sizeBytes / (1024 * 1024))} MB at ${dbPath} — far larger than a healthy index. ` +
        `Large writes against it can exceed the 15s busy_timeout and appear as "database is locked". ` +
        `Try 'token-goat reclaim-index' first (a plain VACUUM, cheap, can recover a useful amount on its own); ` +
        `only reach for 'token-goat reclaim-index --rebuild' if that isn't enough, since --rebuild reparses and ` +
        `re-embeds every indexed file across every project and can take a long time on a large multi-project index`,
    }
  }
  // Name the resolved path even when healthy. The warn branch above already does, and the
  // asymmetry actively misleads: TOKEN_GOAT_HOME and the data dir resolve independently, so
  // exporting both to point at a scratch directory does NOT guarantee a command reads the
  // isolated index. Without the path here, a dogfood run against the real global index is
  // indistinguishable from an isolated one, and "which index am I actually on" is the first
  // question worth answering when a command returns surprising output.
  return {
    name: 'Database',
    status: 'ok',
    message: `global.db exists (${toKB(sizeBytes)} KB) at ${dbPath}`,
  }
}

/**
 * Check that the index actually contains symbols when it has indexed files.
 *
 * Guards against the worker-draining-to-a-stub-callback failure mode (see
 * CLAUDE.md's "Critical path" section): a release once shipped with the queue
 * drain wired to a default stub, so files were marked indexed in the `files`
 * table while the parser never ran and `symbols` stayed permanently empty —
 * every surgical-read command (`symbol`, `read`, `skeleton`, `outline`,
 * `semantic`) silently returned nothing, and the test suite stayed green
 * because every worker test injected its own callback. Caller passes the same
 * `dbPath` `checkDbExists` validated; if the database doesn't exist yet (or
 * isn't openable), this check quietly no-ops rather than duplicating that
 * failure.
 *
 * `rootDir`, when given, scopes both counts to files under that project root via
 * `getProjectIndexCounts` (index_health.ts), which uses sql_path.ts's `projectScopeClause` --
 * the same helper map/semantic/find/dead already use (see commit
 * 6a5ac228). Without it, `global.db`'s machine-wide sharing across every project ever indexed
 * means an unrelated project's symbols can mask this exact project's own parser being broken:
 * fileCount/symbolCount would count every project's rows, so a project with 0 of its own
 * symbols still reads as healthy as long as some other indexed project has symbols. Omitting
 * `rootDir` falls back to the prior unscoped (whole-database) behavior for callers that
 * genuinely want a global figure.
 */
export function checkSymbolCount(dbPath: string, rootDir?: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Symbols', status: 'ok', message: 'no database yet' }
  }
  try {
    const { fileCount, symbolCount } = getProjectIndexCounts(dbPath, rootDir)
    if (fileCount > 0 && symbolCount === 0) {
      return {
        name: 'Symbols',
        status: 'warn',
        message: `${fileCount} file(s) indexed but 0 symbols extracted — the parser may not be running (check the worker log); try 'token-goat index --force'`,
      }
    }
    // An existing-but-empty index is not healthy, it is unindexed: every surgical-read command
    // (symbol, read, skeleton, semantic) returns nothing, which reads as a real "not found"
    // answer rather than as missing data. This is the failure mode a scratch/isolated
    // TOKEN_GOAT_HOME hits, so say so instead of reporting 0 of everything as ok.
    if (fileCount === 0 && symbolCount === 0) {
      return {
        name: 'Symbols',
        status: 'warn',
        message: emptyIndexMessage(rootDir ?? process.cwd()),
      }
    }
    return {
      name: 'Symbols',
      status: 'ok',
      message: `${symbolCount} symbol(s) across ${fileCount} indexed file(s)`,
    }
  } catch (err) {
    return {
      name: 'Symbols',
      status: 'warn',
      message: `could not query symbol count: ${extractErrorMessage(err)}`,
    }
  }
}

/**
 * Fraction of indexed files that must be reachable by vector search before embedding coverage is
 * reported as healthy. Set low deliberately: some files never embed by design (over
 * `indexing.large_file_symbol_only_kb`, .profile-meta.xml, oversized Salesforce metadata,
 * documents with no extractable text), so a perfectly healthy index is not at 100% and a strict
 * threshold would warn forever on a correct install. A quarter is far enough below any normal
 * install to mean something is systematically excluding files rather than a few skips landing.
 */
const EMBED_COVERAGE_WARN_FRACTION = 0.25

/**
 * Check that `semantic` can actually see the corpus, not just that the corpus was parsed.
 *
 * The symbol side has had `checkSymbolCount` for exactly this reason; the embedding side had
 * nothing, and the two fail independently. Every terminal skip in indexFileEmbeddings (parser.ts)
 * stamps a real embed_sha so the worker stops re-reading the file -- correct individually, and it
 * also means a skipped file is indistinguishable from an embedded one at the freshness gate and
 * will never be retried. Nothing summed those skips, so an index where almost nothing embedded
 * looked identical to a healthy one, and `semantic` answered from the remainder using the same
 * "no matches" wording it uses after searching everything. That is the failure this reports.
 *
 * A low number here is not automatically a defect -- it is usually a threshold doing its job --
 * so the message names `indexing.large_file_symbol_only_kb` and its current value rather than
 * asserting a cause, because that setting is the dominant reason files land in the skip branches
 * and is the one the reader can act on.
 */
export function checkEmbeddingCoverage(dbPath: string, rootDir?: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Embedding coverage', status: 'ok', message: 'no database yet' }
  }
  const cfg = loadConfig()
  if (!cfg.indexing.embeddings_enabled) {
    // Off on purpose is not a health problem, and warning about it would be a warning that can
    // never clear while the setting stands.
    return { name: 'Embedding coverage', status: 'ok', message: 'disabled (indexing.embeddings_enabled = false)' }
  }
  try {
    const { indexedFiles, embeddedFiles } = getEmbeddingCoverage(dbPath, rootDir)
    if (indexedFiles === 0) {
      // An empty index is already reported by the Symbols check; saying it twice adds nothing.
      return { name: 'Embedding coverage', status: 'ok', message: 'no indexed files yet' }
    }
    const pct = Math.round((embeddedFiles / indexedFiles) * 100)
    const sizeKb = cfg.indexing.large_file_symbol_only_kb
    if (embeddedFiles / indexedFiles < EMBED_COVERAGE_WARN_FRACTION) {
      return {
        name: 'Embedding coverage',
        status: 'warn',
        message:
          `only ${embeddedFiles} of ${indexedFiles} indexed file(s) (${pct}%) have embeddings — 'semantic' searches ` +
          `those files only, and reports finding nothing in the same words it uses after searching everything. ` +
          `Files over indexing.large_file_symbol_only_kb (currently ${sizeKb} KB) are indexed for symbols only and ` +
          `are the usual reason; raise it with 'token-goat config set indexing.large_file_symbol_only_kb <KB>' and ` +
          `re-embed with 'token-goat index --force' to widen coverage. Exact symbol lookups are unaffected`,
      }
    }
    return {
      name: 'Embedding coverage',
      status: 'ok',
      message: `${embeddedFiles} of ${indexedFiles} indexed file(s) (${pct}%) have embeddings`,
    }
  } catch (err) {
    return {
      name: 'Embedding coverage',
      status: 'warn',
      message: `could not query embedding coverage: ${extractErrorMessage(err)}`,
    }
  }
}

/** Backlog size above which a nonzero dirty-queue is worth flagging even when the worker is running -- large enough that normal churn (a big rebase, a branch switch) never trips it, small enough to catch a genuinely stalled drain before every surgical-read command in the project is serving stale data. */
const DIRTY_QUEUE_BACKLOG_WARN_THRESHOLD = 500

/** How stale the drain-heartbeat marker (touched at the end of every drainOnce cycle, see drainHeartbeatPathFor) can get before a running worker process is flagged as possibly wedged -- 30x the 2s default poll interval, generous margin against a slow cycle on a large repo. */
/**
 * Check the health of the dirty-reindex queue: how many files are pending, and -- when the
 * worker is running -- whether it's actually still completing drain cycles or has gone quiet
 * without exiting (deadlock, stuck lock, crash loop that keeps restarting the pid but never
 * reaching the end of drainOnce). A worker that's simply not running is already reported by
 * the 'Worker' check; this check focuses on backlog size and on distinguishing "alive" from
 * "actually draining".
 */
export function checkDirtyQueueHealth(dataDir: string): DoctorResult {
  let pendingCount = 0
  try {
    const raw = fs.readFileSync(dirtyQueuePathFor(dataDir), 'utf8')
    pendingCount = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length
  } catch {
    // No queue file yet -- nothing pending.
  }

  if (pendingCount > DIRTY_QUEUE_BACKLOG_WARN_THRESHOLD) {
    return {
      name: 'Dirty queue',
      status: 'warn',
      message: `${pendingCount} file(s) pending reindex -- the worker may be falling behind or stalled; check 'token-goat worker status'`,
    }
  }

  if (!isWorkerRunning(dataDir)) {
    return { name: 'Dirty queue', status: 'ok', message: `${pendingCount} file(s) pending (worker not running)` }
  }

  let heartbeatAgeMs: number | null = null
  try {
    heartbeatAgeMs = Date.now() - fs.statSync(drainHeartbeatPathFor(dataDir)).mtimeMs
  } catch {
    // No heartbeat yet -- worker may not have completed its first drain cycle since starting; not itself a fault.
  }

  if (heartbeatAgeMs !== null && heartbeatAgeMs > WORKER_HEARTBEAT_STALE_MS) {
    return {
      name: 'Dirty queue',
      status: 'warn',
      message: `worker process is running but hasn't completed a drain cycle in ${Math.round(heartbeatAgeMs / 1000)}s -- possibly deadlocked or stuck; check the worker error log`,
    }
  }

  return { name: 'Dirty queue', status: 'ok', message: `${pendingCount} file(s) pending, worker actively draining` }
}

/**
 * Check if token-goat binary is installed and accessible.
 */
export function checkInstall(): DoctorResult {
  try {
    const output = execSync('token-goat --version', { encoding: 'utf-8' })
    return {
      name: 'Installation',
      status: 'ok',
      message: output.trim(),
    }
  } catch {
    return {
      name: 'Installation',
      status: 'fail',
      message: 'token-goat command not found; run: npm install -g token-goat-ts',
    }
  }
}

/**
 * Check whether the optional `typescript` compiler API loaded (`ts_refs.ts`'s type-resolved
 * exact-refs tier needs it). Missing/failed load only degrades `refs` to its name-based tier, so
 * this is a warn, not a fail.
 */
export function checkTsCompiler(): DoctorResult {
  if (tsRefsAvailable()) {
    return { name: 'TypeScript compiler', status: 'ok', message: 'available' }
  }
  const err = tsRefsLoadError()
  return {
    name: 'TypeScript compiler',
    status: 'warn',
    message: err !== null ? `unavailable: ${extractErrorMessage(err)}` : 'unavailable (not attempted)',
  }
}

/**
 * The embedding model is the one optional package a default install no longer carries.
 *
 * It used to arrive with everyone, and it brought the whole `onnxruntime-web` -> `onnx-proto` ->
 * `protobufjs` chain plus its own nested, older `sharp` with it -- five high advisories and one
 * critical, none of them fixable from here, on a feature that most installs never invoke. So it is
 * opt-in now, and the cost of that trade is discoverability: `semantic` keeps working either way,
 * because it always consults keyword search as well, so nothing errors and nothing is empty. The
 * failure is silent by construction, which is exactly the kind doctor exists to make loud.
 *
 * Three states, three different answers. Off by config is not a problem and is reported as fine.
 * Absent is one command away, and the command is the whole point of the line. Present but throwing
 * is a different fault with a different fix, which is why this reads the error rather than the
 * boolean -- see `embeddingBackendLoadError`.
 */
export function checkEmbeddings(config: Config): DoctorResult {
  const name = 'Embeddings'
  // `?? true` rather than `=== true`: the rest of the codebase reads an absent flag as enabled
  // (src/cli.ts and src/worker.ts both spell it this way), and a doctor line that reported
  // "disabled by config" for a config that never mentioned the setting would be a false all-clear.
  if ((config.indexing?.embeddings_enabled ?? true) === false) {
    return { name, status: 'ok', message: 'disabled by config (indexing.embeddings_enabled)' }
  }
  if (embeddingModelAvailable()) return { name, status: 'ok', message: 'available' }
  const err = embeddingBackendLoadError()
  // createRequire goes through Node's CJS loader, so an absent package is MODULE_NOT_FOUND;
  // ERR_MODULE_NOT_FOUND is accepted too rather than assumed away, since the same package reached
  // through an ESM path would report that instead and both mean the same thing to the reader.
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
    return {
      name,
      status: 'warn',
      message:
        'onnxruntime-node is not installed, so semantic falls back to keyword search — ' +
        'install it with: npm install -g onnxruntime-node (drop -g if token-goat is a project dependency)',
    }
  }
  return {
    name,
    status: 'warn',
    message:
      err !== null
        ? `onnxruntime-node is installed but failed to load: ${extractErrorMessage(err)}`
        : 'unavailable (not attempted)',
  }
}

/**
 * Check if config file is valid and readable.
 */
export function checkConfigValid(configPath: string): DoctorResult {
  if (!fs.existsSync(configPath)) {
    return {
      name: 'Config',
      status: 'warn',
      message: `config file not found at ${configPath}`,
    }
  }
  try {
    // Same decoder the loader uses, so doctor agrees with it about a BOM'd file.
    const content = readConfigSource(configPath)
    parse(content)
    return {
      name: 'Config',
      status: 'ok',
      message: `config file valid (${content.length} bytes)`,
    }
  } catch (err) {
    return {
      name: 'Config',
      status: 'fail',
      message: `config invalid: ${extractErrorMessage(err, 'unknown error')}`,
    }
  }
}

/**
 * Format a byte count as a human-readable disk-space string (e.g. "650.0 GB").
 */
function formatDiskSpace(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Below this many free bytes in the data directory (1 GiB), flag `warn` instead of `ok`.
 * The indexer, embeddings DB, and worker queue all live here, and a near-full disk fails
 * writes to any of them silently from this check's point of view otherwise -- without a
 * threshold, `checkDiskSpace` always reported `ok` as long as it could read *some* available
 * figure, even at a few MB free, making it a "check" that could never actually flag the
 * problem it exists to catch. 1 GiB is comfortably above global.db's typical size for a
 * mid-sized project while still well below "nothing to worry about" territory.
 */
const LOW_DISK_WARN_BYTES = 1024 * 1024 * 1024

/**
 * Check available disk space in data directory.
 *
 * Prefers Node's built-in `fs.statfsSync` (Node 18.15+): no subprocess, and it works on
 * stock Windows where there is no `df` binary. Falls back to shelling out to `df` on
 * platforms/Node versions where `statfsSync` isn't available. If neither path works --
 * notably plain Windows without Git Bash/WSL on PATH and an old Node -- reports that
 * explicitly instead of silently claiming "could not determine" every single time.
 */
export function checkDiskSpace(dataDir: string): DoctorResult {
  if (typeof fs.statfsSync === 'function') {
    try {
      const stats = fs.statfsSync(dataDir)
      const availableBytes = stats.bavail * stats.bsize
      const status = availableBytes < LOW_DISK_WARN_BYTES ? 'warn' : 'ok'
      const suffix = status === 'warn' ? ' — running low, indexing/embeddings writes may start failing' : ''
      return { name: 'Disk Space', status, message: `${formatDiskSpace(availableBytes)} available${suffix}` }
    } catch {
      // Fall through to the df-based check below.
    }
  }

  if (process.platform !== 'win32') {
    try {
      // Use spawnSync with an array argv so dataDir cannot inject shell metacharacters.
      // `-k` (not `-h`) so the available-space column is a plain integer KB count this check
      // can compare against LOW_DISK_WARN_BYTES, instead of a human-formatted string like "1.2G"
      // that would need re-parsing (and whose unit suffix varies by platform's df) to threshold at all.
      // `-P` forces POSIX single-line output -- without it, a long filesystem/device name can wrap
      // onto its own line, shifting lines[1] and desyncing the column parse below.
      const result = spawnSync('df', ['-Pk', dataDir], { encoding: 'utf-8' })
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      if (result.error === undefined && result.status === 0 && stdout) {
        const lines = stdout.trim().split('\n')
        if (lines.length >= 2) {
          const parts = lines[1]!.trim().split(/\s+/)
          const availableKb = Number.parseInt(parts[3] ?? '', 10)
          if (Number.isFinite(availableKb)) {
            const availableBytes = availableKb * 1024
            const status = availableBytes < LOW_DISK_WARN_BYTES ? 'warn' : 'ok'
            const suffix = status === 'warn' ? ' — running low, indexing/embeddings writes may start failing' : ''
            return { name: 'Disk Space', status, message: `${formatDiskSpace(availableBytes)} available${suffix}` }
          }
        }
      }
    } catch {
      // Fall through to the explicit "unavailable" result below.
    }
  }

  return { name: 'Disk Space', status: 'warn', message: 'disk space check unavailable on this platform' }
}

/**
 * Checks the installed Copilot CLI hook end-to-end: config is valid JSON with a preToolUse
 * entry, the node binary baked into that entry's command still exists on disk (it goes stale
 * after an nvm/fnm/volta node upgrade removes the old version -- a silent deny-all trigger,
 * since Copilot's command hooks fail closed on a process that never launches), and running
 * the exact command Copilot itself would run -- through a shell, the same win32 cmd.exe path
 * Copilot uses -- against a synthetic preToolUse payload returns exit 0 and parseable JSON.
 *
 * Returns null (not a result) when Copilot CLI integration isn't installed: this is an
 * opt-in feature, not a core component, so silence rather than a permanent 'warn' entry is
 * correct for users who have never touched `--copilot`.
 */
export function checkCopilotCli(configPath: string, scriptPath: string): DoctorResult | null {
  if (!fs.existsSync(configPath) || !fs.existsSync(scriptPath)) {
    return null
  }

  let config: { hooks?: Partial<Record<string, Array<{ command?: string }>>> }
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (err) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook config at ${configPath} is not valid JSON: ${extractErrorMessage(err, 'unknown error')}`,
    }
  }

  const preToolUseCommand = config.hooks?.['preToolUse']?.[0]?.command
  if (typeof preToolUseCommand !== 'string' || preToolUseCommand === '') {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook config at ${configPath} has no preToolUse entry; run: token-goat install --copilot`,
    }
  }

  // The command string's first quoted segment is the baked process.execPath (see
  // hookCommandFor in copilot_cli_install.ts).
  const bakedExecPath = /^"([^"]+)"/.exec(preToolUseCommand)?.[1]
  if (bakedExecPath !== undefined && !fs.existsSync(bakedExecPath)) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook points at a node binary that no longer exists (${bakedExecPath}) -- likely stale after an nvm/fnm/volta node upgrade. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI (renaming/reinstalling the hook has no effect on an already-running session -- Copilot caches hook configs at startup).`,
    }
  }

  const synthetic = JSON.stringify({
    sessionId: 'doctor-check',
    cwd: process.cwd(),
    toolName: 'view',
    toolArgs: { path: 'doctor-check.txt' },
  })
  // preToolUseCommand is config.hooks.preToolUse[0].command: the exact string Copilot CLI runs
  // itself on every tool call. Spawning it here reproduces that, to check it still launches.
  // Anyone able to write that file already has execution through Copilot, so shell: true adds no
  // reach; parsing the string instead would break a hook command a user customised by hand.
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const res = spawnSync(preToolUseCommand, {
    input: synthetic,
    encoding: 'utf-8',
    shell: true,
    windowsHide: true,
    timeout: 15000,
  })
  if (res.error) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook failed to launch: ${extractErrorMessage(res.error, 'unknown error')}. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI.`,
    }
  }
  if (res.status !== 0) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook exited with status ${res.status} -- Copilot's preToolUse fails closed on a non-zero exit and denies every tool call for the rest of the session. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI (a live session won't pick up the fix).`,
    }
  }
  try {
    JSON.parse(res.stdout ?? '')
  } catch {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: 'hook did not return valid JSON -- Copilot treats this as a hook error and denies every tool call. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI.',
    }
  }

  return { name: 'Copilot CLI', status: 'ok', message: 'preToolUse hook invokes cleanly and returns valid JSON' }
}

/**
 * Run all doctor checks and return results.
 */
/**
 * Warn when a token-goat marker block lives in a markdown file other than `~/.claude/CLAUDE.md`.
 *
 * install/uninstall resolve one hardcoded path, so a relocated block is never refreshed and
 * never removed -- and the next install appends a fresh copy to CLAUDE.md, duplicating the
 * guidance with only one copy live. Detection only; the user's file is never edited here.
 */
export function checkStrayClaudeMdBlocks(searchRoot?: string): DoctorResult {
  const strays = findStrayClaudeMdBlocks(searchRoot)
  if (strays.length === 0) {
    return { name: 'CLAUDE.md block', status: 'ok', message: 'no stray copies outside CLAUDE.md' }
  }
  return {
    name: 'CLAUDE.md block',
    status: 'warn',
    message:
      `${strays.length} stray cop${strays.length === 1 ? 'y' : 'ies'} outside CLAUDE.md ` +
      `(never refreshed by install, never removed by uninstall, will go stale): ${strays.join(', ')}`,
  }
}

/**
 * Reports the security posture in one place, because that is the question an evaluation asks and
 * there was no command that answered it: what is this allowed to reach, what is it scanning, and
 * who else on this machine can read what it stored.
 *
 * Reporting, not nagging. A line only warns when a protection that ships on has been turned off,
 * so a default install is quiet. Google Drive is reported either way rather than warned about: it
 * is opt-out by design, and a warning on the shipped default would train the reader to skip the
 * whole section.
 */
/**
 * The safe direction for each project-locked setting that is a boolean.
 *
 * Every key here must also appear in {@link CONFIG_KEY_ENV_OVERRIDES}; every project-locked key that
 * has an env override and is *not* here is treated as a value replacement instead (see below). The
 * guard test asserts that split covers the locked set exactly, because the first version of this
 * check listed six keys by hand and missed nine, and a hand-kept list of what to check is the same
 * drift this file already avoided for env var *names*.
 */
const LOCKED_BOOLEAN_SAFE_VALUE: Readonly<Record<string, boolean>> = {
  'gdrive.enabled': false,
  'injection.enabled': true,
  'redaction.strict': true,
  'mcp.confine_reads_to_project_root': true,
  'screenshot.block_private_targets': true,
  'network.offline': true,
  'indexing.cross_project_symbols': false,
  'webfetch.compress_bodies': true,
}

/**
 * Every project-locked config key that an environment variable can still override.
 *
 * `PROJECT_LOCKED_SECTIONS` and `PROJECT_LOCKED_KEYS` stop a checked-in `.token-goat.toml` from
 * loosening these. They do not stop an environment variable, and the environment is reachable from a
 * cloned repository in more ways than it looks: `.envrc` for direnv, `terminal.integrated.env.*` in a
 * committed `.vscode/settings.json`, `containerEnv` in a devcontainer. The lock and the override sit
 * at different layers, so the lock never sees it.
 *
 * Refusing the override was considered and rejected. An operator exporting a variable in their own
 * shell is doing something legitimate, and blocking it would break that case to defend against one
 * they can already see. What they cannot see is a variable arriving from a file they did not write,
 * so this reports rather than prevents.
 *
 * Derived rather than listed, so a new locked section, a new locked key, or a new env override is
 * covered the day it lands instead of the day someone remembers this function exists.
 */
export function lockedEnvOverridableKeys(): string[] {
  const out: string[] = []
  for (const key of Object.keys(CONFIG_KEY_ENV_OVERRIDES)) {
    const section = key.split('.')[0] ?? ''
    const locked = PROJECT_LOCKED_SECTIONS.includes(section) || PROJECT_LOCKED_KEYS.includes(key)
    if (locked && (CONFIG_KEY_ENV_OVERRIDES[key] ?? []).length > 0) out.push(key)
  }
  return out.sort()
}

/** One locked setting the environment is currently deciding, and how it is deciding it. */
export interface EnvOverriddenSetting {
  readonly setting: string
  readonly envVar: string
  /** `weakened` = a boolean flipped to its unsafe value. `replaced` = a non-boolean value supplied. */
  readonly kind: 'weakened' | 'replaced'
}

/**
 * Locked settings the environment is holding open or replacing.
 *
 * Booleans are read through `envBool` rather than compared as strings, so the answer here is the one
 * `_buildConfig` reached: `0`, `no` and `off` are all ways to switch a protection off, and a check
 * that only looked for the literal `false` would miss three of the four spellings. Passing the safe
 * value as the default means an unset, blank or unrecognised variable reports nothing, and a variable
 * that makes a setting *safer* reports nothing either.
 *
 * A non-boolean locked setting is reported whenever its variable is set at all. There is no safe
 * direction to compare against: `TOKEN_GOAT_WEBFETCH_ALLOW` and `TOKEN_GOAT_MCP_ALLOWED_ROOTS`
 * replace their list rather than adding to it, so the environment supplying one means the config
 * file is no longer deciding it, and only the operator can say whether the replacement is weaker.
 * Saying nothing here is what made the first version print a clean line while the fetch allow list
 * and the MCP root confinement were both being set from outside the config.
 */
export function envOverriddenSecuritySettings(): EnvOverriddenSetting[] {
  const out: EnvOverriddenSetting[] = []
  for (const setting of lockedEnvOverridableKeys()) {
    const safe = LOCKED_BOOLEAN_SAFE_VALUE[setting]
    for (const envVar of CONFIG_KEY_ENV_OVERRIDES[setting] ?? []) {
      if (safe === undefined) {
        const raw = process.env[envVar]
        if (raw !== undefined && raw.trim() !== '') out.push({ setting, envVar, kind: 'replaced' })
      } else if (envBool(envVar, safe) !== safe) {
        out.push({ setting, envVar, kind: 'weakened' })
      }
    }
  }
  return out
}

export function checkSecurityPosture(cfg: Config, dataDirPath: string): DoctorResult[] {
  const results: DoctorResult[] = []

  results.push({
    name: 'Security network',
    status: 'ok',
    message: cfg.network.offline
      ? 'offline mode is on: no fetch, model download, OCR data, screenshot, or Drive call'
      : 'offline mode is off (network.offline)',
  })

  results.push(
    cfg.injection.enabled
      ? { name: 'Security injection', status: 'ok', message: 'fetched and MCP content is scanned and fenced' }
      : { name: 'Security injection', status: 'warn', message: 'scanning is off (injection.enabled): fetched and MCP content reaches the model unfenced' },
  )

  results.push({
    name: 'Security gdrive',
    status: 'ok',
    message: cfg.gdrive.enabled ? 'enabled (gdrive.enabled = false turns it off)' : 'disabled',
  })

  const allow = cfg.webfetch.allow.length
  const deny = cfg.webfetch.deny.length
  results.push({
    name: 'Security fetch policy',
    status: 'ok',
    message: allow > 0
      ? `${allow} allowed host pattern${allow === 1 ? '' : 's'}, ${deny} denied: nothing outside the allow list is fetched`
      : `no allow list, ${deny} denied pattern${deny === 1 ? '' : 's'}: any host not denied can be fetched`,
  })

  const custom = compileCustomPatterns(cfg.redaction.custom_patterns)
  const strictNote = cfg.redaction.strict ? 'strict mode on' : 'strict mode off (redaction.strict)'
  const patternNote =
    custom.patterns.length === 0
      ? 'built-in patterns only'
      : `${custom.patterns.length} custom pattern${custom.patterns.length === 1 ? '' : 's'} plus the built-in ones`
  results.push(
    custom.problems.length > 0
      ? {
          name: 'Security redaction',
          // A pattern the operator believes is redacting, but which never compiled, is the one
          // failure here that is invisible from the output itself -- so it warns rather than
          // being reported as a healthy count that happens to be short.
          status: 'warn',
          message:
            `${custom.problems.length} custom redaction pattern${custom.problems.length === 1 ? '' : 's'} could not be used ` +
            `and ${custom.problems.length === 1 ? 'is' : 'are'} not redacting anything: ` +
            custom.problems.map((p) => `${p.pattern} (${p.reason})`).join('; '),
        }
      : { name: 'Security redaction', status: 'ok', message: `${patternNote}, ${strictNote}` },
  )

  const extraRoots = cfg.mcp.allowed_roots.length
  results.push(
    cfg.mcp.confine_reads_to_project_root
      ? {
          name: 'Security mcp roots',
          status: 'ok',
          message: extraRoots === 0
            ? 'reads are confined to the project root'
            : `reads are confined to the project root plus ${extraRoots} configured root${extraRoots === 1 ? '' : 's'}`,
        }
      : { name: 'Security mcp roots', status: 'warn', message: 'confinement is off (mcp.confine_reads_to_project_root): a read can leave the project' },
  )

  const overridden = envOverriddenSecuritySettings()
  const weakened = overridden.filter((o) => o.kind === 'weakened')
  const replaced = overridden.filter((o) => o.kind === 'replaced')
  const describe = (o: EnvOverriddenSetting): string => `${o.setting} (${o.envVar})`
  const parts: string[] = []
  if (weakened.length > 0) parts.push(`held open: ${weakened.map(describe).join(', ')}`)
  if (replaced.length > 0) parts.push(`set from the environment: ${replaced.map(describe).join(', ')}`)
  results.push(
    overridden.length === 0
      ? {
          name: 'Security config overrides',
          status: 'ok',
          // Naming the count keeps this from reading as a guarantee about settings it never looked
          // at, which is what the first version of this line did while nine locked keys went
          // unchecked behind it.
          message: `no environment variable is overriding any of the ${lockedEnvOverridableKeys().length} project-locked settings`,
        }
      : {
          name: 'Security config overrides',
          status: 'warn',
          message:
            `the environment, not the config file, is deciding ${overridden.length === 1 ? 'a' : 'these'} ` +
            `project-locked setting${overridden.length === 1 ? '' : 's'}. ${parts.join('; ')}. ` +
            'A project config cannot change these; an environment variable can, and one can be set by a file in a cloned repository.',
        },
  )

  results.push(dataDirPermissionResult(dataDirPath))
  return results
}

/** Owner-only is the shipped mode; anything looser means another local user can read the index. */
function dataDirPermissionResult(dataDirPath: string): DoctorResult {
  if (process.platform === 'win32') {
    return { name: 'Security data dir', status: 'ok', message: 'inherits the parent ACL (POSIX modes do not apply on Windows)' }
  }
  try {
    const mode = fs.statSync(dataDirPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      return {
        name: 'Security data dir',
        status: 'warn',
        message: `mode ${mode.toString(8).padStart(3, '0')}: other local users can read the indexed source text`,
      }
    }
    return { name: 'Security data dir', status: 'ok', message: `mode ${mode.toString(8).padStart(3, '0')}: owner only` }
  } catch {
    return { name: 'Security data dir', status: 'warn', message: 'could not be read, so its permissions are unknown' }
  }
}

/**
 * Runs every diagnostic check and returns the results.
 *
 * `processes` exists so a caller that does not care about MCP process health can skip gathering
 * it: on Windows that gather shells out to PowerShell for a full `Win32_Process` listing, which
 * measured 1.2 s of this function's 1.5 s. Leave it undefined and the listing happens as normal --
 * that is what the CLI does, and `tests/cli_doctor.test.ts` covers that default path explicitly so
 * the gather cannot rot behind an argument every test supplies.
 */
/** How many recent compactions must all show zero surviving manifest paths before the channel is called broken. One is noise -- a summary can legitimately paraphrase every path away when the session barely touched any files. */
const COMPACTION_CHANNEL_WINDOW = 5

/**
 * Is the manifest token-goat sends ahead of a compaction still reaching the summary?
 *
 * That manifest travels a route Claude Code does not document: a PreCompact hook's raw stdout is
 * handed to the summarizing model as its instructions. If that ever changes, nothing fails --
 * the hook still exits 0, the manifest is still built, and the only visible symptom is summaries
 * that quietly stop naming real paths. `postCompactHandler` records how many of the paths it sent
 * came back out of each summary verbatim; this reads that record and says so out loud.
 *
 * Deliberately quiet in every ambiguous case. A run with nothing to look for (`sampled === 0`,
 * i.e. the session had touched no files) proves nothing either way and is skipped rather than
 * counted as a failure, and fewer than {@link COMPACTION_CHANNEL_WINDOW} conclusive runs is not
 * enough evidence to accuse the harness of anything. The alarm only sounds when every one of the
 * last several compactions that had something to find found none of it.
 */
export function checkCompactionChannel(dbPath: string): DoctorResult {
  const name = 'Compaction channel'
  if (!fs.existsSync(dbPath)) {
    return { name, status: 'ok', message: 'no database yet' }
  }
  try {
    const db = getDb(dbPath)
    // The stats table is created lazily by the first recordStat call (src/stats.ts), so on a fresh
    // install global.db exists with an index schema and no stats at all. Querying it blind would
    // throw "no such table" and be reported as a warning, which would put a scary line in front of
    // every new user for the entirely normal condition of having compacted nothing yet.
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats'").get()
    if (present === undefined) {
      return { name, status: 'ok', message: 'no compaction has been measured yet' }
    }
    const rows = db
      .prepare("SELECT detail FROM stats WHERE kind = 'compact_summary' ORDER BY rowid DESC LIMIT ?")
      .all(COMPACTION_CHANNEL_WINDOW * 4) as Array<{ detail: string | null }>
    const conclusive: Array<{ survived: number; sampled: number }> = []
    for (const row of rows) {
      const m = /manifest_paths=(\d+)\/(\d+)/.exec(row.detail ?? '')
      if (m === null) continue
      const sampled = Number(m[2])
      if (sampled === 0) continue
      conclusive.push({ survived: Number(m[1]), sampled })
      if (conclusive.length >= COMPACTION_CHANNEL_WINDOW) break
    }
    if (conclusive.length === 0) {
      return { name, status: 'ok', message: 'no compaction has been measured yet' }
    }
    const dead = conclusive.filter((c) => c.survived === 0).length
    if (conclusive.length >= COMPACTION_CHANNEL_WINDOW && dead === conclusive.length) {
      return {
        name,
        status: 'warn',
        message: `none of the last ${conclusive.length} compaction summaries kept a single file path token-goat sent ahead of them -- Claude Code may have stopped feeding a PreCompact hook's output to the summarizer, which would make the session manifest a no-op`,
      }
    }
    const kept = conclusive.reduce((n, c) => n + c.survived, 0)
    const sent = conclusive.reduce((n, c) => n + c.sampled, 0)
    return { name, status: 'ok', message: `${kept}/${sent} sampled paths survived the last ${conclusive.length} compaction(s)` }
  } catch (e) {
    return { name, status: 'warn', message: `could not read compaction stats: ${extractErrorMessage(e)}` }
  }
}

/** How many unrecognized names to name in the informational line before summarizing the rest. */
const UNMAPPED_TOOL_SAMPLE = 5

/**
 * Report the tool names that reached token-goat's hooks and matched no handler.
 *
 * This is the only bridge check here that is not a restatement of a belief. `bridges-status` says
 * which events a bridge *should* wire; the harness fixture matrix says what a payload *should*
 * look like; the Copilot shape manifest says what the vendor *declares*. Each of those was
 * written from the same understanding that produced the bridge, so a bridge built on a
 * misunderstanding agrees with all three -- which is exactly how four separate features shipped
 * wired, tested, green and inert. This one reads back what a harness actually sent.
 *
 * A warning fires only for a *near miss*: a name that differs from one token-goat handles by case
 * or separators alone, e.g. `bash` arriving where `Bash` is handled. That is the fingerprint of a
 * bridge's tool-rename step not being applied, and it is the only inference available without
 * knowing what the harness meant. Everything else is reported as-is rather than judged: a name
 * with no handler is usually just a tool token-goat has nothing to say about.
 *
 * A row whose near miss equals its own tool name is not a near miss at all -- the dispatcher
 * returns before recording when a handler asked for that exact spelling, so such a row can only
 * come from a database written by an older or in-development build. Warning on it would print a
 * sentence that contradicts itself (sent "Bash" where "Bash" is handled) and would never clear,
 * so it falls through to the informational line instead.
 */
export function checkUnmappedTools(dbPath: string): DoctorResult {
  const name = 'Tool names'
  if (!fs.existsSync(dbPath)) {
    return { name, status: 'ok', message: 'no database yet' }
  }
  try {
    const rows = readUnmappedTools(dbPath)
    if (rows.length === 0) {
      return { name, status: 'ok', message: 'every tool name seen so far reached a handler that wanted it' }
    }
    const nearMisses = rows.filter(
      (r) => r.near_miss !== null && r.near_miss !== undefined && r.near_miss !== r.tool_name,
    )
    if (nearMisses.length > 0) {
      const shown = nearMisses
        .slice(0, UNMAPPED_TOOL_SAMPLE)
        .map((r) => `${r.harness} sent "${r.tool_name}" where "${r.near_miss}" is handled (${r.event_name}, ${r.hits}x)`)
      const more = nearMisses.length > UNMAPPED_TOOL_SAMPLE ? ` (+${nearMisses.length - UNMAPPED_TOOL_SAMPLE} more)` : ''
      return {
        name,
        status: 'warn',
        message: `${shown.join('; ')}${more} -- these differ only by case or separators, so that bridge's tool-rename step is very likely not being applied and every handler behind those names is inert`,
      }
    }
    const shown = rows.slice(0, UNMAPPED_TOOL_SAMPLE).map((r) => `${r.tool_name} (${r.hits}x)`)
    const more = rows.length > UNMAPPED_TOOL_SAMPLE ? `, +${rows.length - UNMAPPED_TOOL_SAMPLE} more` : ''
    return {
      name,
      status: 'ok',
      message: `${rows.length} tool name(s) seen with no handler, none resembling one token-goat handles: ${shown.join(', ')}${more}`,
    }
  } catch (e) {
    return { name, status: 'warn', message: `could not read the tool-name histogram: ${extractErrorMessage(e)}` }
  }
}

export function runDoctor(dataDir?: string, configPath?: string, rootDir?: string, processes?: ProcessInfo[]): DoctorResult[] {
  const results: DoctorResult[] = []
  const actualDataDir = dataDir || defaultDataDir()

  // Basic checks
  results.push(checkInstall())
  results.push(checkTsCompiler())
  results.push(checkStrayClaudeMdBlocks())
  results.push(checkWorkerRunning(actualDataDir) ? { name: 'Worker', status: 'ok', message: 'running' } : { name: 'Worker', status: 'warn', message: 'not running' })

  // File checks
  results.push(checkDbExists(actualDataDir))
  results.push(checkSymbolBodySize(path.join(actualDataDir, 'global.db')))
  results.push(checkSymbolCount(path.join(actualDataDir, 'global.db'), rootDir))
  results.push(checkDirtyQueueHealth(actualDataDir))
  results.push(checkCompactionChannel(path.join(actualDataDir, 'global.db')))
  results.push(checkUnmappedTools(path.join(actualDataDir, 'global.db')))

  const actualConfigPath = configPath || defaultConfigPath()
  results.push(checkConfigValid(actualConfigPath))
  results.push(checkEmbeddings(loadConfig(rootDir)))
  // Directly after the availability row: "available" and "3% of files covered" are both true at
  // once, and reading either alone gives the wrong picture of what `semantic` can actually see.
  results.push(checkEmbeddingCoverage(path.join(actualDataDir, 'global.db'), rootDir))

  for (const result of checkSecurityPosture(loadConfig(rootDir), actualDataDir)) results.push(result)

  results.push(checkDiskSpace(actualDataDir))

  const copilotResult = checkCopilotCli(copilotCliConfigPath(), copilotCliScriptPath())
  if (copilotResult) results.push(copilotResult)
  results.push(checkGlobalMcpConfig())
  if (process.platform === 'win32') results.push(checkMcpProcessHealth(processes ?? readWindowsProcesses()))

  return results
}

/**
 * Format and print doctor results to stdout.
 */
export function printDoctorResults(results: DoctorResult[]): void {
  console.log('\ntoken-goat doctor\n')

  const grouped = new Map<string, DoctorResult[]>()
  for (const result of results) {
    const key = result.name.split(' ')[0]!
    if (!grouped.has(key)) {
      grouped.set(key, [])
    }
    grouped.get(key)!.push(result)
  }

  for (const [, items] of grouped) {
    for (const item of items) {
      const prefix = item.status === 'ok' ? '  ' : `  [${item.status.toUpperCase()}] `
      console.log(`${prefix}${item.name}: ${item.message}`)
    }
  }

  const hasFailures = results.some((r) => r.status === 'fail')
  // A warning is not a pass. The verdict counted only failures, so a run that printed several
  // [WARN] lines -- an oversized database, an empty index for this project, orphaned processes --
  // still signed off with "All checks passed" directly underneath them. Nothing here changes
  // what counts as a failure or the exit code; the summary stops contradicting the list above it.
  const warnings = results.filter((r) => r.status === 'warn').length
  const clean =
    warnings === 0
      ? '\nAll checks passed'
      : `\nNo failures, but ${warnings} warning${warnings === 1 ? '' : 's'} above`
  console.log(hasFailures ? '\nFAILURES DETECTED' : clean)
  console.log()
}

/**
 * Run doctor and return exit code (0 for success, 1 for failures).
 */
export async function runDoctorAndExit(opts?: {
  dataDir?: string
  configPath?: string
  context?: boolean
  rootDir?: string
  /** See `runDoctor`: supply a list to skip the Windows process gather. */
  processes?: ProcessInfo[]
}): Promise<number> {
  const results = runDoctor(opts?.dataDir, opts?.configPath, opts?.rootDir, opts?.processes)
  printDoctorResults(results)

  if (opts?.context === true) {
    console.log('\n## Context footprint\n')
    // Call runContextStats to show the context breakdown.
    await runContextStats({})
    console.log()

    // Add pregen-gap check: if pregen.json exists, check for skills on disk missing from pregen names.
    try {
      const dir = skillOutputsDir()
      const pregenPath = path.join(dir, 'pregen.json')
      if (fs.existsSync(pregenPath)) {
        const content = JSON.parse(fs.readFileSync(pregenPath, 'utf-8')) as { names?: string[] }
        const pregenNames = new Set(content.names || [])
        // A skill can have multiple .meta files (one per distinct content hash cached across
        // sessions -- see skill_cache.ts's findCrossSessionEntry, which only dedups identical
        // content, not every version of an updated skill), so collect into a Set keyed by name
        // rather than pushing to an array -- otherwise a skill missing from pregen.json with two
        // or more cached versions would be listed twice (or more) in the same report line.
        const skillsSeen = new Set<string>()
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.meta')) continue
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8')) as { skillName: string }
              if (meta.skillName && !pregenNames.has(meta.skillName)) {
                skillsSeen.add(meta.skillName)
              }
            } catch {
              // skip
            }
          }
        } catch {
          // skip
        }
        const skills = [...skillsSeen]
        if (skills.length > 0) {
          console.log(`Missing from pregen.json: ${skills.join(', ')}`)
          console.log(`Remediation: token-goat skill-compact --all\n`)
        }
      }
    } catch {
      // skip pregen check
    }
  }

  return results.some((r) => r.status === 'fail') ? 1 : 0
}
