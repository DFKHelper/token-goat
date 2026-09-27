/** Doctor CLI helpers — diagnose token-goat health. Provides check utilities and the runDoctor() entrypoint for the doctor command. */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { parse } from 'smol-toml'
import { extractErrorMessage, resolveOnPath } from './util.js'
import { displaySafeText } from './paths.js'
import { PACKAGE_NAME } from './version.js'
import { compareSemver } from './cli_upgrade.js'
import { serverStatuses } from './hook_client.js'
import { readMarker, type ServerStatus } from './hook_ipc.js'
import { dataDirWriteRefusal } from './worker.js'
import { dataDir as defaultDataDir, configPath as defaultConfigPath } from './constants.js'
import { hookServerEnabled, loadConfig, readConfigSource, saveConfig, invalidateConfigCache } from './config.js'
import type { Config } from './config.js'
import { ensureModelFiles, modelFilesPresent } from './embed_model.js'
import { runContextStats } from './cli_context_stats.js'
import { skillOutputsDir } from './skill_cache.js'
import { copilotCliConfigPath, copilotCliScriptPath, LEGACY_HOOKS_SCRIPT_FILE, readCopilotHooksOwners } from './bridges/copilot_cli_install.js'
import { hasCreatedConfig } from './bridges/created_configs.js'
import { COPILOT_CLI_HOOK_SCRIPT } from './bridges/copilot_cli.js'
import { claudeHookScriptPath, hookEventGaps, isInstalled } from './install.js'
import { parseNativeInvocation, splitHookCommand } from './native_hook.js'
import { CLAUDECODE_HOOK_SCRIPT } from './bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from './bridges/codex.js'
import { codexHookScriptPath } from './bridges/codex_install.js'
import { LEGACY_SHIM_FILE } from './bridges/shim_common.js'
import { cleanupDeprecatedVscodeProjectMcp, vscodeHooksInstalled, vscodeUsesClaudeHooks } from './bridges/vscode_install.js'
import { visualStudioProjectMcpPath, visualStudioSolutionVscodeMcpPath, visualStudioUserMcpPath } from './bridges/visualstudio_install.js'
import { cursorMcpPath } from './bridges/cursor_install.js'
import { zedSettingsPath } from './bridges/zed_install.js'
import { isAvailable as tsRefsAvailable, loadError as tsRefsLoadError } from './ts_refs.js'
import { isAvailable as embeddingModelAvailable, embeddingBackendLoadError } from './embeddings.js'
import { treeSitterCoreAvailable, treeSitterCoreLoadError, isTreeSitterAvailable, missingTreeSitterGrammarPackages } from './parser.js'
import { nonTreeSitterLanguageCount, TREE_SITTER_LANGUAGES } from './parser_types.js'
import { checkSymbolBodySize } from './symbol_body_probe.js'
import { getDb } from './db.js'
import { HOOK_PROBE_ENV, readUnmappedTools, pruneStalePatternCoveredUnmappedTools } from './stats.js'
import { hookLatencyBreakdown } from './hook_latency.js'
import { checkNativeHooks } from './cli_doctor_native.js'
import { checkDbExists, checkSymbolCount, checkDirtyQueueHealth, checkEmbeddingCoverage, checkParserFreshness } from './cli_doctor_index.js'
import { MCP_TOOL_PATTERN } from './mcp_tool_pattern.js'
import { reclaimIndex, indexSizeBytes } from './index_reclaim.js'
import type { DoctorResult } from './doctor_result.js'
import { type ProcessInfo, checkMcpProcessHealth, readWindowsProcesses, checkWorkerRunning } from './cli_doctor_process.js'
import { checkGlobalMcpConfig, checkVscodeUserScopeHooks, checkVscodeClaudeHooks, checkClaudeHookEvents, checkVisualStudio, checkZed, checkCursor, checkStrayClaudeMdBlocks, checkVscodeProjectMcp } from './cli_doctor_platforms.js'
import { checkSecurityPosture } from './cli_doctor_security.js'

/** Check if token-goat binary is installed and accessible. */
export function checkInstall(): DoctorResult {
  // Resolved against PATH and then executed by absolute path. This used to be `execSync('token-goat --version')`: a bare name in a shell string, which on Windows `cmd.exe` resolves from the current directory before PATH, so running `token-goat doctor` inside a repository containing a `token-goat.bat` ran that file and printed its output as the installed version. Demonstrated end to end against the shipped bundle. `resolveOnPath` skips the current directory, and spawnSync with an argv array never reaches a shell, so neither half of the original shape remains.
  const resolved = resolveOnPath('token-goat')
  if (resolved !== null) {
    // A global npm install on Windows puts a `.CMD` shim on PATH, and since the argument-injection fix in Node 20.12/21.7 a batch file cannot be spawned directly at all -- spawnSync returns EINVAL. Running it through an explicit absolute cmd.exe with an argv array keeps the property that matters (the name is never re-resolved by an interpreter, so the current directory cannot supply the binary) while still executing the shim. Reported as a FAIL by the shipped build until this was run for real: the resolver was correct and the spawn was the part that broke.
    const isBatch = /\.(?:cmd|bat)$/i.test(resolved)
    const comspec = path.join(process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const result = isBatch
      ? spawnSync(fs.existsSync(comspec) ? comspec : 'cmd.exe', ['/d', '/s', '/c', resolved, '--version'], { encoding: 'utf-8', timeout: 15000, windowsHide: true })
      : spawnSync(resolved, ['--version'], { encoding: 'utf-8', timeout: 15000, windowsHide: true })
    if (result.status === 0) return { name: 'Installation', status: 'ok', message: (result.stdout ?? '').trim() }
  }
  // The package name is read from the manifest rather than written here: it was hardcoded as `token-goat-ts`, which is not the published name and is an unregistered, claimable npm package. This message prints exactly when a user's install is broken and they are most likely to run the command in it, and it installs globally.
  return { name: 'Installation', status: 'fail', message: `token-goat command not found; run: npm install -g ${PACKAGE_NAME}` }
}

/** Check whether the optional `typescript` compiler API loaded (`ts_refs.ts`'s type-resolved exact-refs tier needs it). Missing/failed load only degrades `refs` to its name-based tier, so this is a warn, not a fail. */
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

/** Why the core `tree-sitter` binding failed to load, as far as the error says. */
export type TreeSitterFailure = 'absent' | 'no-prebuild' | 'dlopen' | 'other'

/** Classify a `tree-sitter` load error. `absent`: Node's resolver found no `tree-sitter` package (a nested dependency missing inside it names that dependency instead, so it is `other`). `no-prebuild`: the package is there but node-gyp-build found neither a shipped prebuild for this platform/ABI nor a local compile (node-gyp-build.js throws "No native build was found for ..."). `dlopen`: a binary was found but the OS loader refused it (Node's ERR_DLOPEN_FAILED). */
export function classifyTreeSitterLoadError(err: Error | null): TreeSitterFailure {
  if (err === null) return 'other'
  const code = (err as NodeJS.ErrnoException).code
  if ((code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') && /Cannot find (?:module|package) 'tree-sitter'/.test(err.message)) return 'absent'
  if (err.message.startsWith('No native build was found')) return 'no-prebuild'
  if (code === 'ERR_DLOPEN_FAILED') return 'dlopen'
  return 'other'
}

/** Check whether tree-sitter (the core native binding plus its language grammars) is available. When it is not, the source skeleton fold, the code body fold's disk-parse fallback, and tree-sitter indexing are all silently disabled -- this is the single largest structural lever in the product, so a plain warn (not a fail, since the product is designed to still run degraded on the regex-based fallback) is the right severity, matching `checkTsCompiler` and `checkEmbeddings` above for the same "optional native dependency missing" shape. */
export function checkTreeSitter(): DoctorResult {
  const name = 'Tree-sitter'
  if (!treeSitterCoreAvailable()) {
    const err = treeSitterCoreLoadError()
    const firstLine = err !== null ? extractErrorMessage(err).split('\n')[0]!.trim() : 'not attempted'
    const impact =
      `${TREE_SITTER_LANGUAGES.join(', ')} fall back to a coarse regex scan with no references, and the skeleton fold is off; ` +
      `the other ${nonTreeSitterLanguageCount()} languages index normally`
    const missing = missingTreeSitterGrammarPackages()
    // Says plainly what was checked. `missingTreeSitterGrammarPackages` only resolves each package, so an empty list means "all present", never "all working": whether a grammar loads cannot be established at all while the core is down, and printing nothing here read as a clean bill of health for the half that was never tested.
    const grammars =
      missing.length > 0
        ? `; grammar packages not installed: ${missing.join(', ')}`
        : '; all grammar packages are present, though only presence was checked: whether each one loads cannot be tested while the core is unavailable'
    let message: string
    switch (classifyTreeSitterLoadError(err)) {
      case 'absent':
        message =
          `not installed (${firstLine}): ${impact}. Fix: npm install -g ${PACKAGE_NAME} --include=optional ` +
          '(on npm 12+, if doctor then reports no native build, add --allow-scripts=tree-sitter)'
        break
      case 'no-prebuild':
        message =
          `installed, but has no native build for ${process.platform}-${process.arch} on Node ${process.versions.node}: ${impact}. ` +
          'The package ships prebuilt binaries and its install script (node-gyp-build) compiles one only when none matches; ' +
          `npm 12+ skips dependency install scripts, so reinstall with them allowed (needs a C++ toolchain): npm install -g ${PACKAGE_NAME} --allow-scripts=tree-sitter`
        break
      case 'dlopen':
        message =
          `installed, but its native binary will not load (${firstLine}): ${impact}. ` +
          `It was built for another Node version or CPU architecture; reinstall under the Node that runs token-goat: npm install -g ${PACKAGE_NAME}`
        break
      default:
        message = `failed to load (${firstLine}): ${impact}. Fix: npm install -g ${PACKAGE_NAME} --include=optional`
    }
    return { name, status: 'warn', message: message + grammars }
  }
  const available = TREE_SITTER_LANGUAGES.filter((lang) => isTreeSitterAvailable(lang))
  if (available.length === TREE_SITTER_LANGUAGES.length) {
    return { name, status: 'ok', message: `available (${available.length}/${TREE_SITTER_LANGUAGES.length} grammars)` }
  }
  const missing = TREE_SITTER_LANGUAGES.filter((lang) => !available.includes(lang))
  return {
    name,
    status: 'warn',
    message: `partially available (${available.length}/${TREE_SITTER_LANGUAGES.length} grammars); missing: ${missing.join(', ')}`,
  }
}

/** The embedding model is the one optional package a default install no longer carries. It used to arrive with everyone, and it brought the whole `onnxruntime-web` -> `onnx-proto` -> `protobufjs` chain plus its own nested, older `sharp` with it -- five high advisories and one critical, none of them fixable from here, on a feature that most installs never invoke. So it is opt-in now, and the cost of that trade is discoverability: `semantic` keeps working either way, because it always consults keyword search as well, so nothing errors and nothing is empty. The failure is silent by construction, which is exactly the kind doctor exists to make loud. Three states, three different answers. Off by config is not a problem and is reported as fine. Absent is one command away, and the command is the whole point of the line. Present but throwing is a different fault with a different fix, which is why this reads the error rather than the boolean -- see `embeddingBackendLoadError`. */
export function checkEmbeddings(config: Config): DoctorResult {
  const name = 'Embeddings'
  // `?? true` rather than `=== true`: the rest of the codebase reads an absent flag as enabled (src/cli.ts and src/worker.ts both spell it this way), and a doctor line that reported "disabled by config" for a config that never mentioned the setting would be a false all-clear.
  if ((config.indexing?.embeddings_enabled ?? true) === false) {
    return { name, status: 'ok', message: 'disabled by config (indexing.embeddings_enabled)' }
  }
  if (embeddingModelAvailable()) return { name, status: 'ok', message: 'available' }
  const err = embeddingBackendLoadError()
  // createRequire goes through Node's CJS loader, so an absent package is MODULE_NOT_FOUND; ERR_MODULE_NOT_FOUND is accepted too rather than assumed away, since the same package reached through an ESM path would report that instead and both mean the same thing to the reader.
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

/** Check whether the pinned embedding model files are present on disk. */
export function checkEmbeddingModel(config: Config): DoctorResult {
  const name = 'Embedding model'
  if ((config.indexing?.embeddings_enabled ?? true) === false) {
    return { name, status: 'ok', message: 'embeddings disabled by config' }
  }
  if (!modelFilesPresent()) {
    if (config.network?.offline) {
      return {
        name,
        status: 'warn',
        message:
          'model files are missing and network is disabled (network.offline = true) — run "token-goat doctor --repair" to restore network and download model',
      }
    }
    return {
      name,
      status: 'warn',
      message:
        'model files are missing — run "token-goat doctor --repair" to download',
    }
  }
  return { name, status: 'ok', message: 'model files verified and ready' }
}

/** Check if config file is valid and readable. */
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

/** Format a byte count as a human-readable disk-space string (e.g. "650.0 GB"). */
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

/** Below this many free bytes in the data directory (1 GiB), flag `warn` instead of `ok`. The indexer, embeddings DB, and worker queue all live here, and a near-full disk fails writes to any of them silently from this check's point of view otherwise -- without a threshold, `checkDiskSpace` always reported `ok` as long as it could read *some* available figure, even at a few MB free, making it a "check" that could never actually flag the problem it exists to catch. 1 GiB is comfortably above global.db's typical size for a mid-sized project while still well below "nothing to worry about" territory. */
const LOW_DISK_WARN_BYTES = 1024 * 1024 * 1024

/** Check available disk space in data directory. Prefers Node's built-in `fs.statfsSync` (Node 18.15+): no subprocess, and it works on stock Windows where there is no `df` binary. Falls back to shelling out to `df` on platforms/Node versions where `statfsSync` isn't available. If neither path works -- notably plain Windows without Git Bash/WSL on PATH and an old Node -- reports that explicitly instead of silently claiming "could not determine" every single time. */
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
      // Use spawnSync with an array argv so dataDir cannot inject shell metacharacters. `-k` (not `-h`) so the available-space column is a plain integer KB count this check can compare against LOW_DISK_WARN_BYTES, instead of a human-formatted string like "1.2G" that would need re-parsing (and whose unit suffix varies by platform's df) to threshold at all. `-P` forces POSIX single-line output -- without it, a long filesystem/device name can wrap onto its own line, shifting lines[1] and desyncing the column parse below.
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

/** Checks the installed Copilot CLI hook end-to-end: config is valid JSON with a preToolUse entry, the node binary baked into that entry's command still exists on disk (it goes stale after an nvm/fnm/volta node upgrade removes the old version -- a silent deny-all trigger, since Copilot's command hooks fail closed on a process that never launches), and running the exact command Copilot itself would run -- through a shell, the same win32 cmd.exe path Copilot uses -- against a synthetic preToolUse payload returns exit 0 and parseable JSON. Returns null (not a result) when Copilot CLI integration isn't installed: this is an opt-in feature, not a core component, so silence rather than a permanent 'warn' entry is correct for users who have never touched `--copilot`. The project scope is `<cwd>/.github/hooks`, which a cloned repository controls, so its command runs only when the created-configs ledger, kept outside the clone, records that an install on this machine wrote that config. */

export function checkCopilotCli(configPath: string, scriptPath: string, scope: 'user' | 'project' = 'user'): DoctorResult | null {
  if (!fs.existsSync(configPath)) {
    return null
  }
  const name = scope === 'project' ? 'Copilot CLI (project)' : 'Copilot CLI'
  const { install, harness } = copilotHooksRecovery(path.dirname(configPath), scope)
  if (scope === 'project' && !hasCreatedConfig(configPath)) {
    return {
      name,
      status: 'warn',
      message: `hook config at ${configPath} was not written by token-goat on this machine, so doctor does not run the command it names. If these hooks are yours, run "${install}" to rewrite them here.`,
    }
  }
  if (!fs.existsSync(scriptPath)) {
    // An install from before the shim was renamed has only the .js one, and its config still runs it.
    if (!fs.existsSync(path.join(path.dirname(scriptPath), LEGACY_HOOKS_SCRIPT_FILE))) return null
    return {
      name,
      status: 'warn',
      message: `hooks at ${path.dirname(scriptPath)} still run ${LEGACY_HOOKS_SCRIPT_FILE} from an older token-goat build, which Node loads as an ES module under any package.json that says "type": "module" and then fails every tool call. Recovery: run "${install}", then fully restart ${harness}.`,
    }
  }

  let config: { hooks?: Partial<Record<string, Array<{ command?: string }>>> }
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `hook config at ${configPath} is not valid JSON: ${extractErrorMessage(err, 'unknown error')}`,
    }
  }

  const preToolUseCommand = config.hooks?.['preToolUse']?.[0]?.command
  if (typeof preToolUseCommand !== 'string' || preToolUseCommand === '') {
    return {
      name,
      status: 'fail',
      message: `hook config at ${configPath} has no preToolUse entry; run: ${install}`,
    }
  }

  // The command's first word is the baked process.execPath (see hookCommandFor in copilot_cli_install.ts), or with the native client wired, that binary, and the baked node path is the first word of the command it wraps.
  const words = splitHookCommand(preToolUseCommand, process.platform === 'win32' ? 'cmd' : 'sh')
  const native = parseNativeInvocation(words)
  if (native !== undefined && !fs.existsSync(native.bin)) {
    return {
      name,
      status: 'fail',
      message: `hook points at a native hook client binary that no longer exists (${native.bin}), so ${harness} cannot start it. Recovery: run "${install}", then fully restart ${harness}.`,
    }
  }
  const bakedExecPath = (native?.wrapped ?? words)[0]
  if (bakedExecPath !== undefined && path.isAbsolute(bakedExecPath) && !fs.existsSync(bakedExecPath)) {
    return {
      name,
      status: 'fail',
      message: `hook points at a node binary that no longer exists (${bakedExecPath}) -- likely stale after an nvm/fnm/volta node upgrade. Recovery: run "${install}", then fully restart ${harness} (renaming/reinstalling the hook has no effect on an already-running session -- hook configs are cached at startup).`,
    }
  }

  const synthetic = JSON.stringify({
    sessionId: 'doctor-check',
    cwd: process.cwd(),
    toolName: 'view',
    toolArgs: { path: 'doctor-check.txt' },
  })
  // HOOK_PROBE_ENV keeps this call out of the hook stats: it is doctor's own, and the native hook client counts this same run reports would otherwise count it as one of Copilot's. preToolUseCommand is config.hooks.preToolUse[0].command: the exact string Copilot CLI runs itself on every tool call. Spawning it here reproduces that, to check it still launches. Anyone able to write that file already has execution through Copilot (for the project scope, only once the ledger check above has passed), so shell: true adds no reach; parsing the string instead would break a hook command a user customised by hand. nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const res = spawnSync(preToolUseCommand, {
    input: synthetic,
    encoding: 'utf-8',
    env: { ...process.env, [HOOK_PROBE_ENV]: '1' },
    shell: true,
    windowsHide: true,
    timeout: 15000,
  })
  if (res.error) {
    return {
      name,
      status: 'fail',
      message: `hook failed to launch: ${extractErrorMessage(res.error, 'unknown error')}. Recovery: run "${install}", then fully restart ${harness}.`,
    }
  }
  if (res.status !== 0) {
    return {
      name,
      status: 'fail',
      message: `hook exited with status ${res.status} -- Copilot's preToolUse fails closed on a non-zero exit and denies every tool call for the rest of the session. Recovery: run "${install}", then fully restart ${harness} (a live session won't pick up the fix).`,
    }
  }
  try {
    JSON.parse(res.stdout ?? '')
  } catch {
    return {
      name,
      status: 'fail',
      message: `hook did not return valid JSON -- Copilot treats this as a hook error and denies every tool call. Recovery: run "${install}", then fully restart ${harness}.`,
    }
  }

  if (!shimIsCurrent(scriptPath, COPILOT_CLI_HOOK_SCRIPT)) {
    return { name, status: 'warn', message: staleShimMessage(scriptPath, 'Copilot', install) + `, then fully restart ${harness}.` }
  }

  return { name, status: 'ok', message: 'preToolUse hook invokes cleanly and returns valid JSON' }
}

/** Does the shim installed at `scriptPath` match the one this build writes? A shim that launches and answers is not necessarily current: install writes it and only the next install rewrites it, so a token-goat upgrade without a reinstall leaves the old one running, and every fix to the shim itself stays off that machine. On the machine this was found on, the Copilot shim was 153 lines behind and dropped every pre-tool note, the Claude Code one 92 lines, and doctor reported both as fine. Line endings are normalized so an editor's CRLF conversion is not reported as drift. */
/** The install command that rewrites a Copilot hooks directory, and the harness to restart after it. `install --vscode` writes the same files, so a directory only it owns is repaired by it and not by `--copilot`, which would also register a Copilot CLI integration nobody asked for. */
function copilotHooksRecovery(hooksDir: string, scope: 'user' | 'project'): { install: string; harness: string } {
  const owners = readCopilotHooksOwners(hooksDir)
  if (!owners.has('copilot') && owners.has('vscode')) {
    return { install: scope === 'project' ? 'token-goat install --vscode' : 'token-goat install --vscode --user', harness: 'VS Code' }
  }
  return { install: scope === 'project' ? 'token-goat install --copilot --local' : 'token-goat install --copilot', harness: 'Copilot CLI' }
}

function shimIsCurrent(scriptPath: string, expected: string): boolean {
  return fs.readFileSync(scriptPath, 'utf-8').replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')
}

function staleShimMessage(scriptPath: string, harness: string, reinstall: string): string {
  return `hook shim at ${scriptPath} was written by an older token-goat build, so fixes to it since then are not reaching ${harness}. Recovery: run "${reinstall}"`
}

/** Checks one installed hook shim against the script this build would write in its place. Null when the shim is not installed, so a harness nobody uses adds no row. */
export function checkHookShim(name: string, scriptPath: string, expected: string, reinstall: string): DoctorResult | null {
  if (!fs.existsSync(scriptPath)) {
    // An install from before the shim was renamed has only the .js one, and its hook commands still run it.
    if (!fs.existsSync(path.join(path.dirname(scriptPath), LEGACY_SHIM_FILE))) return null
    return {
      name,
      status: 'warn',
      message: `hooks at ${path.dirname(scriptPath)} still run ${LEGACY_SHIM_FILE} from an older token-goat build, which Node loads as an ES module under any package.json that says "type": "module" and then fails every tool call. Recovery: run "${reinstall}", then restart any running session.`,
    }
  }
  if (shimIsCurrent(scriptPath, expected)) return { name, status: 'ok', message: `hook shim at ${scriptPath} matches this build` }
  return { name, status: 'warn', message: staleShimMessage(scriptPath, name, reinstall) + ', then restart any running session.' }
}

/** Run all doctor checks and return results. */

/** Runs every diagnostic check and returns the results. `processes` exists so a caller that does not care about MCP process health can skip gathering it: on Windows that gather shells out to PowerShell for a full `Win32_Process` listing, which measured 1.2 s of this function's 1.5 s. Leave it undefined and the listing happens as normal -- that is what the CLI does, and `tests/cli_doctor.test.ts` covers that default path explicitly so the gather cannot rot behind an argument every test supplies. */
/** How many recent compactions must all show zero surviving manifest paths before the channel is called broken. One is noise -- a summary can legitimately paraphrase every path away when the session barely touched any files. */
const COMPACTION_CHANNEL_WINDOW = 5

/** Rows fetched per page while hunting for COMPACTION_CHANNEL_WINDOW conclusive (sampled > 0) rows below. Small enough that a fresh install with only a handful of compactions never over-fetches, large enough that most real histories resolve in one page. */
const COMPACTION_STATS_BATCH_SIZE = 50

/** Hard ceiling on total compact_summary rows read across all pages in one doctor run. stats accumulates for the life of the install across every project with no size cap of its own, so an unbounded scan back to row 1 on a years-old global.db is the wrong trade for one diagnostic line; 2000 rows covers many hundreds of real compactions even if the great majority are sample.length === 0 (sessions that touched no files), and if the scan hits this ceiling without finding COMPACTION_CHANNEL_WINDOW conclusive rows the result is reported as inconclusive rather than as a false warn or false ok. */
const COMPACTION_STATS_SCAN_CEILING = 2000

/** The release that fixed d30a8055's survival matcher: before it, a summary that named a manifest path relative to the project root (the only form a real summarizer produces) never matched the absolute-path-only check, so every compaction recorded manifest_paths=0/N regardless of whether the channel actually worked. A row written by an older build carries no signal either way and must not be counted toward "dead" or "working" -- see {@link checkCompactionChannel}. */
const COMPACTION_MANIFEST_FIX_VERSION = '2.9.18'

/** Is the manifest token-goat sends ahead of a compaction still reaching the summary? That manifest travels a route Claude Code does not document: a PreCompact hook's raw stdout is handed to the summarizing model as its instructions. If that ever changes, nothing fails -- the hook still exits 0, the manifest is still built, and the only visible symptom is summaries that quietly stop naming real paths. `postCompactHandler` records how many of the paths it sent came back out of each summary verbatim; this reads that record and says so out loud. Deliberately quiet in every ambiguous case. A run with nothing to look for (`sampled === 0`, i.e. the session had touched no files) proves nothing either way and is skipped rather than counted as a failure, and fewer than {@link COMPACTION_CHANNEL_WINDOW} conclusive runs is not enough evidence to accuse the harness of anything. The alarm only sounds when every one of the last several compactions that had something to find found none of it. */
export function checkCompactionChannel(dbPath: string): DoctorResult {
  const name = 'Compaction channel'
  if (!fs.existsSync(dbPath)) {
    return { name, status: 'ok', message: 'no database yet' }
  }
  try {
    const db = getDb(dbPath)
    // The stats table is created lazily by the first recordStat call (src/stats.ts), so on a fresh install global.db exists with an index schema and no stats at all. Querying it blind would throw "no such table" and be reported as a warning, which would put a scary line in front of every new user for the entirely normal condition of having compacted nothing yet.
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats'").get()
    if (present === undefined) {
      return { name, status: 'ok', message: 'no compaction has been measured yet' }
    }
    // A fixed multiple of COMPACTION_CHANNEL_WINDOW as the fetch size was a cap applied before the sampled===0 predicate below, so a run of sessions that touched no files (sample.length is 0 for those, which is common for short, purely conversational sessions) could starve the window below COMPACTION_CHANNEL_WINDOW conclusive rows and silently disable the warn branch. Page through rowid-ordered batches instead, applying the predicate per batch, so the fetch size never determines how many conclusive rows survive it. COMPACTION_STATS_SCAN_CEILING bounds the total rows read per doctor run, since stats accumulates across every project for the life of the install and this table has no per-project scope in global.db.
    const conclusive: Array<{ survived: number; sampled: number }> = []
    let offset = 0
    let scanned = 0
    let preFixConclusive = 0
    for (;;) {
      const batch = db
        .prepare("SELECT detail, tg_version FROM stats WHERE kind = 'compact_summary' ORDER BY rowid DESC LIMIT ? OFFSET ?")
        .all(COMPACTION_STATS_BATCH_SIZE, offset) as Array<{ detail: string | null; tg_version: string | null }>
      if (batch.length === 0) break
      offset += batch.length
      scanned += batch.length
      for (const row of batch) {
        const m = /manifest_paths=(\d+)\/(\d+)/.exec(row.detail ?? '')
        if (m === null) continue
        const sampled = Number(m[2])
        if (sampled === 0) continue
        // A row written before COMPACTION_MANIFEST_FIX_VERSION carries no signal either way (see that constant's doc comment) -- count it separately so an install with only pre-fix history is told "no evidence yet" rather than "the channel is dead".
        if (row.tg_version === null || compareSemver(row.tg_version, COMPACTION_MANIFEST_FIX_VERSION) < 0) {
          preFixConclusive++
          continue
        }
        conclusive.push({ survived: Number(m[1]), sampled })
        if (conclusive.length >= COMPACTION_CHANNEL_WINDOW) break
      }
      if (conclusive.length >= COMPACTION_CHANNEL_WINDOW) break
      if (scanned >= COMPACTION_STATS_SCAN_CEILING) break
    }
    if (conclusive.length === 0) {
      if (preFixConclusive > 0) {
        return { name, status: 'ok', message: `no post-fix compaction evidence yet -- ${preFixConclusive} compaction(s) found predate ${COMPACTION_MANIFEST_FIX_VERSION}'s manifest-survival fix and are not counted` }
      }
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

/** Is any single (event, harness) pair's hook latency running hot? Reads the same `stats.duration_ms` rows `token-goat stats --hooks` renders, via {@link hookLatencyBreakdown}, so this and that view can never disagree about what "hot" means. The p95 ceiling is `hooks.latency_budget_ms`, whose 1500ms default was measured as follows. `duration_ms` reads `performance.now()` inside `relayInProcess`'s finally block for a synchronous call -- total time since process start, Node bootstrap and bundle import included, not just dispatch -- which measured ~86-92ms total on this machine against a ~28ms dispatch-only figure the old threshold was calibrated for. Re-examined after the fix that made a Claude Code async-detached call (post_tool_use on Edit/Write/MultiEdit/NotebookEdit outside markdown, and every subagent_stop) record what the harness actually waited on instead: that population now measures ~20-30ms, since the harness stops waiting at the shim's early `{"async":true}` marker rather than at process exit. Left at 1500ms rather than lowered for that smaller floor: this is a ceiling meant to catch a genuine regression, not a tight bound on either population's normal range, and 1500ms is already 16-60x either one -- lowering it would only invite false positives from ordinary variance in the still-larger synchronous population, which this column measures unchanged. */
export function checkHookLatency(dbPath: string): DoctorResult {
  const name = 'Hook latency'
  if (!fs.existsSync(dbPath)) {
    return { name, status: 'ok', message: 'no database yet' }
  }
  try {
    const db = getDb(dbPath)
    // Same lazy-table guard as checkCompactionChannel above: a fresh install has an index schema and no `stats` table at all until the first recordStat() call creates it.
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats'").get()
    if (present === undefined) {
      return { name, status: 'ok', message: 'no hooks measured yet' }
    }
    const rows = hookLatencyBreakdown(db)
    if (rows.length === 0) {
      return { name, status: 'ok', message: 'no hook latency recorded yet (or this database predates the duration_ms column)' }
    }
    const worst = rows[0]! // hookLatencyBreakdown sorts worst p95 first.
    const totalCount = rows.reduce((n, r) => n + r.count, 0)
    const worstLabel = `${worst.event} (${worst.harness || 'unrecorded harness'})`
    const budgetMs = loadConfig().hooks.latency_budget_ms
    if (worst.p95_ms > budgetMs) {
      return {
        name,
        status: 'warn',
        message: `${worstLabel} is running a p95 of ${worst.p95_ms}ms across ${totalCount} recent hook(s); see 'token-goat stats --hooks' for the full breakdown`,
      }
    }
    return { name, status: 'ok', message: `worst p95 ${worst.p95_ms}ms (${worstLabel}) across ${totalCount} recent hook(s)` }
  } catch (e) {
    return { name, status: 'warn', message: `could not read hook latency stats: ${extractErrorMessage(e)}` }
  }
}

/** How many unrecognized names to name in the informational line before summarizing the rest. */
const UNMAPPED_TOOL_SAMPLE = 5
/** A near-miss not observed within this window is treated as resolved residue (e.g. the mapping was added in a later release), not a live bridge failure. */
const UNMAPPED_TOOL_MAX_AGE_DAYS = 7

/** Report the tool names that reached token-goat's hooks and matched no handler. This is the only bridge check here that is not a restatement of a belief. `bridges-status` says which events a bridge *should* wire; the harness fixture matrix says what a payload *should* look like; the Copilot shape manifest says what the vendor *declares*. Each of those was written from the same understanding that produced the bridge, so a bridge built on a misunderstanding agrees with all three -- which is exactly how four separate features shipped wired, tested, green and inert. This one reads back what a harness actually sent. A warning fires only for a *near miss*: a name that differs from one token-goat handles by case or separators alone, e.g. `bash` arriving where `Bash` is handled. That is the fingerprint of a bridge's tool-rename step not being applied, and it is the only inference available without knowing what the harness meant. Everything else is reported as-is rather than judged: a name with no handler is usually just a tool token-goat has nothing to say about. A row whose near miss equals its own tool name is not a near miss at all -- the dispatcher returns before recording when a handler asked for that exact spelling, so such a row can only come from a database written by an older or in-development build. Warning on it would print a sentence that contradicts itself (sent "Bash" where "Bash" is handled) and would never clear, so it falls through to the informational line instead. */
export function checkUnmappedTools(dbPath: string, options?: { maxAgeDays?: number; nowSecs?: number }): DoctorResult {
  const name = 'Tool names'
  if (!fs.existsSync(dbPath)) {
    return { name, status: 'ok', message: 'no database yet' }
  }
  try {
    // Clean up rows recorded before noteUnrecognizedTool (hook_registry.ts) learned to check a handler's toolPattern, not just its exact toolName -- a pattern-covered tool name (every MCP tool preMcpHandler/postMcpHandler's '^mcp__' pattern already covers) was never actually unmapped. Only reached from an explicit `token-goat doctor` run, not on every process, so this needs no throttle of its own.
    pruneStalePatternCoveredUnmappedTools(getDb(dbPath), [MCP_TOOL_PATTERN])
    const rows = readUnmappedTools(dbPath)
    if (rows.length === 0) {
      return { name, status: 'ok', message: 'every tool name seen so far reached a handler that wanted it' }
    }
    const maxAgeDays = options?.maxAgeDays ?? UNMAPPED_TOOL_MAX_AGE_DAYS
    const nowSecs = options?.nowSecs ?? Math.floor(Date.now() / 1000)
    const maxAgeSecs = maxAgeDays * 86400

    const nearMisses = rows.filter((r) => {
      if (r.near_miss === null || r.near_miss === undefined || r.near_miss === r.tool_name) return false
      // A near-miss not observed within the retention window is historically resolved residue (e.g. the mapping was added in a later release), not a live bridge failure. The guard only applies to rows carrying a real epoch timestamp: a zero or placeholder `last_seen` is "unknown when", and filtering those would silence a live failure forever.
      if (r.last_seen > 0 && nowSecs - r.last_seen > maxAgeSecs) return false
      return true
    })
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
    // A name is recorded once per event it fires on, so one tool arrives as both a pre_tool_use and a post_tool_use row; list it once, at its busier event's count.
    const byName = new Map<string, number>()
    for (const r of rows) byName.set(r.tool_name, Math.max(byName.get(r.tool_name) ?? 0, r.hits))
    const names = [...byName].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const shown = names.slice(0, UNMAPPED_TOOL_SAMPLE).map(([tool, hits]) => `${tool} (${hits}x)`)
    const more = names.length > UNMAPPED_TOOL_SAMPLE ? `, +${names.length - UNMAPPED_TOOL_SAMPLE} more` : ''
    return {
      name,
      status: 'ok',
      message: `${names.length} tool name(s) seen with no handler, none resembling one token-goat handles: ${shown.join(', ')}${more}`,
    }
  } catch (e) {
    return { name, status: 'warn', message: `could not read the tool-name histogram: ${extractErrorMessage(e)}` }
  }
}

/** The Worker line. A worker stopped because its data directory refuses writes does not come back on its own, since every hook's auto-restart is refused the same way, so that case says why instead of the bare "not running" a stopped worker gets. A directory that does not exist yet is not probed: `worker start` creates it. */
export function checkWorker(dir: string): DoctorResult {
  if (checkWorkerRunning(dir)) return { name: 'Worker', status: 'ok', message: 'running' }
  const refusal = fs.existsSync(dir) ? dataDirWriteRefusal(dir) : undefined
  if (refusal !== undefined) {
    return { name: 'Worker', status: 'fail', message: `not running, and cannot start: ${displaySafeText(dir)} cannot be written (${displaySafeText(extractErrorMessage(refusal))}); make it writable, then run 'token-goat worker start'` }
  }
  return { name: 'Worker', status: 'warn', message: 'not running' }
}

/** The Hook server line. A server that is not running is normal (the next hook call starts one); one whose last background start failed is worth a warning, because nothing else ever shows that error. */
export function checkHookServer(state: { enabled: boolean; statuses: readonly ServerStatus[]; failure?: string | undefined }): DoctorResult {
  const name = 'Hook server'
  if (!state.enabled) return { name, status: 'ok', message: 'off (hooks.server or TOKEN_GOAT_HOOK_SERVER); every hook call starts its own process' }
  if (state.statuses.length > 0) return { name, status: 'ok', message: `${state.statuses.length} running (${state.statuses.map((s) => `slot ${s.slot}, pid ${s.pid}, ${s.served} served`).join('; ')})` }
  if (state.failure !== undefined) return { name, status: 'warn', message: `not running, and the last start failed: ${state.failure}. Run 'token-goat hook-server run' to see it in the foreground` }
  return { name, status: 'ok', message: 'not running; the next hook call starts one' }
}

/** {@link runDoctor} plus the checks that have to ask a running process, which the synchronous checks cannot. */
export async function runDoctorChecks(dataDir?: string, configPath?: string, rootDir?: string, processes?: ProcessInfo[]): Promise<DoctorResult[]> {
  const results = runDoctor(dataDir, configPath, rootDir, processes)
  const enabled = hookServerEnabled()
  const dir = dataDir || defaultDataDir()
  results.push(checkHookServer({ enabled, statuses: enabled ? await serverStatuses(dir) : [], failure: readMarker('failed', dir) }))
  return results
}

export function runDoctor(dataDir?: string, configPath?: string, rootDir?: string, processes?: ProcessInfo[]): DoctorResult[] {
  const results: DoctorResult[] = []
  const actualDataDir = dataDir || defaultDataDir()

  // Basic checks
  results.push(checkInstall())
  results.push(checkTsCompiler())
  results.push(checkTreeSitter())
  results.push(checkStrayClaudeMdBlocks())
  results.push(checkWorker(actualDataDir))

  // File checks
  const cfg = loadConfig(rootDir)
  results.push(checkDbExists(actualDataDir, cfg.indexing.max_db_size_mb))
  results.push(checkSymbolBodySize(path.join(actualDataDir, 'global.db')))
  results.push(checkSymbolCount(path.join(actualDataDir, 'global.db'), rootDir))
  results.push(checkDirtyQueueHealth(actualDataDir))
  results.push(checkCompactionChannel(path.join(actualDataDir, 'global.db')))
  results.push(checkHookLatency(path.join(actualDataDir, 'global.db')))
  results.push(checkUnmappedTools(path.join(actualDataDir, 'global.db')))

  const actualConfigPath = configPath || defaultConfigPath()
  results.push(checkConfigValid(actualConfigPath))
  results.push(checkEmbeddings(loadConfig(rootDir)))
  results.push(checkEmbeddingModel(loadConfig(rootDir)))
  // Directly after the availability row: "available" and "3% of files covered" are both true at once, and reading either alone gives the wrong picture of what `semantic` can actually see.
  results.push(checkEmbeddingCoverage(path.join(actualDataDir, 'global.db'), rootDir))
  results.push(checkParserFreshness(path.join(actualDataDir, 'global.db'), rootDir))

  for (const result of checkSecurityPosture(loadConfig(rootDir), actualDataDir)) results.push(result)

  results.push(checkDiskSpace(actualDataDir))

  const copilotResult = checkCopilotCli(copilotCliConfigPath(), copilotCliScriptPath())
  if (copilotResult) results.push(copilotResult)
  const copilotProjectResult = checkCopilotCli(copilotCliConfigPath({ local: true }), copilotCliScriptPath({ local: true }), 'project')
  if (copilotProjectResult) results.push(copilotProjectResult)
  const claudeShimResult = checkHookShim('Claude Code', claudeHookScriptPath(), CLAUDECODE_HOOK_SCRIPT, isInstalled('user') || !isInstalled('project') ? 'token-goat install' : 'token-goat install --project')
  if (claudeShimResult) results.push(claudeShimResult)
  const claudeEventsResult = checkClaudeHookEvents({ user: hookEventGaps('user'), project: hookEventGaps('project') })
  if (claudeEventsResult) results.push(claudeEventsResult)
  for (const result of checkNativeHooks(path.join(actualDataDir, 'global.db'))) results.push(result)
  const codexShimResult = checkHookShim('Codex', codexHookScriptPath(), CODEX_HOOK_SCRIPT, 'token-goat install --codex')
  if (codexShimResult) results.push(codexShimResult)
  const vscodeHooksResult = checkVscodeClaudeHooks(
    vscodeUsesClaudeHooks(),
    isInstalled('user') || isInstalled('project'),
    vscodeHooksInstalled() || vscodeHooksInstalled({ project: true }),
  )
  if (vscodeHooksResult) results.push(vscodeHooksResult)
  const vscodeScopeResult = checkVscodeUserScopeHooks(vscodeHooksInstalled(), vscodeHooksInstalled({ project: true }))
  if (vscodeScopeResult) results.push(vscodeScopeResult)
  const vscodeProjectMcpResult = checkVscodeProjectMcp(rootDir)
  if (vscodeProjectMcpResult) results.push(vscodeProjectMcpResult)
  const visualStudioResult = checkVisualStudio([visualStudioUserMcpPath(), visualStudioProjectMcpPath()], [visualStudioSolutionVscodeMcpPath()])
  if (visualStudioResult) results.push(visualStudioResult)
  const zedResult = checkZed(zedSettingsPath())
  if (zedResult) results.push(zedResult)
  const cursorResult = checkCursor(cursorMcpPath(), isInstalled('user') || isInstalled('project'))
  if (cursorResult) results.push(cursorResult)
  results.push(checkGlobalMcpConfig())
  if (process.platform === 'win32') results.push(checkMcpProcessHealth(processes ?? readWindowsProcesses()))

  return results
}

export interface DoctorRepairResult {
  repairs: string[]
  errors: string[]
}

/** Automatically repairs known issues such as restrictive security posture and missing semantic models due to offline rollout. */
export async function runDoctorRepair(opts?: {
  dataDir?: string | undefined
  configPath?: string | undefined
  rootDir?: string | undefined
}): Promise<DoctorRepairResult> {
  const repairs: string[] = []
  const errors: string[] = []
  const cfg = loadConfig(opts?.rootDir)

  let configDirty = false
  const updatedCfg = { ...cfg }

  // 1. Repair restrictive settings to permissive defaults
  if (updatedCfg.mcp?.confine_reads_to_project_root) {
    updatedCfg.mcp = { ...updatedCfg.mcp, confine_reads_to_project_root: false }
    configDirty = true
    repairs.push('Restored permissive read access (mcp.confine_reads_to_project_root = false)')
  }
  if (updatedCfg.indexing?.cross_project_symbols === false) {
    updatedCfg.indexing = { ...updatedCfg.indexing, cross_project_symbols: true }
    configDirty = true
    repairs.push('Restored cross-project symbol search (indexing.cross_project_symbols = true)')
  }

  // 2. Repair missing semantic model (e.g. from mistaken rollout with network disabled)
  const needModel = !modelFilesPresent()
  if (needModel) {
    if (updatedCfg.network?.offline) {
      updatedCfg.network = { ...updatedCfg.network, offline: false }
      configDirty = true
      repairs.push('Restored network access (network.offline = false)')
    }
    if ((updatedCfg.indexing?.embeddings_enabled ?? true) === false) {
      updatedCfg.indexing = { ...updatedCfg.indexing, embeddings_enabled: true }
      configDirty = true
      repairs.push('Enabled semantic embeddings (indexing.embeddings_enabled = true)')
    }
  }

  if (configDirty) {
    try {
      saveConfig(updatedCfg)
      invalidateConfigCache()
    } catch (e) {
      errors.push(`Failed to update configuration: ${extractErrorMessage(e)}`)
    }
  }

  // 3. Download and verify missing semantic model files
  if (needModel) {
    try {
      console.log('Downloading and verifying semantic model files...')
      await ensureModelFiles()
      repairs.push('Downloaded and verified semantic embedding model files')
    } catch (e) {
      errors.push(`Failed to download embedding model: ${extractErrorMessage(e)}`)
    }
  }

  // 4. Remove empty deprecated .vscode/mcp.json residue if present. Same ownership rule as `uninstall --vscode`: only a file token-goat created (created-config ledger) is deleted, and the write is scope-confined so a symlinked .vscode cannot point the unlink outside the project.
  const rootDir = path.resolve(opts?.rootDir ?? process.cwd())
  const projectMcp = path.join(rootDir, '.vscode', 'mcp.json')
  try {
    if (cleanupDeprecatedVscodeProjectMcp(rootDir)) {
      repairs.push(`Removed empty deprecated VS Code MCP residue file at ${displaySafeText(projectMcp)}`)
    }
  } catch (e) {
    errors.push(`Failed to clean up ${displaySafeText(projectMcp)}: ${extractErrorMessage(e)}`)
  }

  // 5. Auto-reclaim embeddings if database exceeds max_db_size_mb and auto_reclaim_embeddings is enabled
  const actualDataDir = opts?.dataDir ?? defaultDataDir()
  const dbPath = path.join(actualDataDir, 'global.db')
  if (cfg.indexing.auto_reclaim_embeddings && fs.existsSync(dbPath)) {
    try {
      const sizeBytes = indexSizeBytes(dbPath)
      const thresholdMb = cfg.indexing.max_db_size_mb ?? 1500
      const maxBytes = thresholdMb * 1024 * 1024
      if (sizeBytes > maxBytes) {
        const res = reclaimIndex(dbPath, { embeddingsOnly: true })
        const savedMb = Math.round((res.beforeBytes - res.afterBytes) / (1024 * 1024))
        repairs.push(`Auto-reclaimed embeddings and compacted global.db (${savedMb > 0 ? `reclaimed ${savedMb} MB` : 'compacted'})`)
      }
    } catch (e) {
      errors.push(`Failed to auto-reclaim embeddings from global.db: ${extractErrorMessage(e)}`)
    }
  }

  return { repairs, errors }
}

/** Format and print doctor results to stdout. */
export function printDoctorResults(results: DoctorResult[]): void {
  console.log('\ntoken-goat doctor\n')

  const categoryMap: Record<string, string> = {
    Installation: 'System & Runtime',
    TypeScript: 'System & Runtime',
    'Tree-sitter': 'System & Runtime',
    Worker: 'System & Runtime',
    Config: 'System & Runtime',
    Disk: 'System & Runtime',

    Database: 'Index & Storage',
    Symbol: 'Index & Storage',
    Symbols: 'Index & Storage',
    Dirty: 'Index & Storage',
    Parser: 'Index & Storage',
    Compaction: 'Index & Storage',

    Embeddings: 'Semantic Search',
    Embedding: 'Semantic Search',

    Security: 'Security & Access',

    Copilot: 'Bridges & Integrations',
    VS: 'Bridges & Integrations',
    Visual: 'Bridges & Integrations',
    Cursor: 'Bridges & Integrations',
    Zed: 'Bridges & Integrations',
    Global: 'Bridges & Integrations',
    MCP: 'Bridges & Integrations',

    'CLAUDE.md': 'Diagnostics & Tools',
    Tool: 'Diagnostics & Tools',
  }

  const categoryOrder = [
    'System & Runtime',
    'Index & Storage',
    'Semantic Search',
    'Security & Access',
    'Bridges & Integrations',
    'Diagnostics & Tools',
  ]

  const grouped = new Map<string, DoctorResult[]>()
  for (const cat of categoryOrder) {
    grouped.set(cat, [])
  }

  for (const result of results) {
    const key = result.name.split(' ')[0]!
    const category = categoryMap[key] || 'Diagnostics & Tools'
    if (!grouped.has(category)) {
      grouped.set(category, [])
    }
    grouped.get(category)!.push(result)
  }

  for (const cat of categoryOrder) {
    const items = grouped.get(cat)
    if (!items || items.length === 0) continue

    console.log(`[${cat}]`)
    for (const item of items) {
      const badge = item.status === 'ok' ? '  ✓ ' : `  [${item.status.toUpperCase()}] `
      console.log(`${badge}${item.name}: ${displaySafeText(item.message)}`)
    }
    console.log()
  }

  const hasFailures = results.some((r) => r.status === 'fail')
  const warnings = results.filter((r) => r.status === 'warn').length
  const clean =
    warnings === 0
      ? 'All checks passed'
      : `No failures, but ${warnings} warning${warnings === 1 ? '' : 's'} above`
  console.log(hasFailures ? 'FAILURES DETECTED' : clean)

  const restrictiveTips: string[] = []
  let hasRepairable = false
  for (const result of results) {
    if (result.message.includes('restrictive mode') || result.message.includes('Restrictive mode')) {
      hasRepairable = true
      const idx = result.message.indexOf('with: ')
      if (idx !== -1) {
        const after = result.message.slice(idx + 6)
        const closeParen = after.indexOf(')')
        if (closeParen !== -1) {
          restrictiveTips.push(after.slice(0, closeParen).trim())
        }
      }
    }
    if (result.message.includes('doctor --repair')) {
      hasRepairable = true
    }
  }

  if (restrictiveTips.length > 0) {
    console.log('\nPermissive defaults suggestion:')
    console.log('  Some settings are in restrictive mode. The recommended setup is fully permissive so external skills, transcripts, and cross-project symbols are never blocked.')
    console.log('  To restore recommended permissive defaults, run:')
    for (const cmd of restrictiveTips) {
      console.log(`    ${cmd}`)
    }
    console.log("  Or run: token-goat doctor --repair")
  }

  if (hasRepairable) {
    console.log('\nAuto-repair available:')
    console.log("  Run 'token-goat doctor --repair' to automatically resolve fixable warnings.")
  }

  console.log()
}

/** Run doctor and return exit code (0 for success, 1 for failures). */
export async function runDoctorAndExit(opts?: string | {
  dataDir?: string
  configPath?: string
  context?: boolean
  rootDir?: string
  /** See `runDoctor`: supply a list to skip the Windows process gather. */
  processes?: ProcessInfo[]
  repair?: boolean
  fix?: boolean
}): Promise<number> {
  const options = typeof opts === 'string' ? { rootDir: opts } : (opts ?? {})

  if (options.repair === true || options.fix === true) {
    console.log('Running automatic repairs...\n')
    const { repairs, errors } = await runDoctorRepair({
      dataDir: options.dataDir,
      configPath: options.configPath,
      rootDir: options.rootDir,
    })

    if (repairs.length > 0) {
      console.log('Repairs applied:')
      for (const r of repairs) {
        console.log(`  ✓ ${r}`)
      }
      console.log()
    } else {
      console.log('No automatic repairs needed.\n')
    }

    if (errors.length > 0) {
      console.log('Repair errors encountered:')
      for (const e of errors) {
        console.log(`  ✕ ${e}`)
      }
      console.log()
    }
  }

  const results = await runDoctorChecks(options.dataDir, options.configPath, options.rootDir, options.processes)
  printDoctorResults(results)

  if (options.context === true) {
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
        // A skill can have multiple .meta files (one per distinct content hash cached across sessions -- see skill_cache.ts's findCrossSessionEntry, which only dedups identical content, not every version of an updated skill), so collect into a Set keyed by name rather than pushing to an array -- otherwise a skill missing from pregen.json with two or more cached versions would be listed twice (or more) in the same report line.
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

  try {
    const { checkUpdateStatus } = await import('./cli_upgrade.js')
    const update = await checkUpdateStatus(1500)
    if (update.updateAvailable && update.latest) {
      console.log(`\n[!] Update available: token-goat v${displaySafeText(update.current)} -> v${displaySafeText(update.latest)}`)
      console.log(`    Run 'token-goat upgrade' to update.\n`)
    }
  } catch {
    // Silent fail if network unreachable or offline
  }

  return results.some((r) => r.status === 'fail') ? 1 : 0
}
