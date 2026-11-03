/** Repair utilities and routines for token-goat doctor --fix / --repair. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { extractErrorMessage } from './util.js'
import { displaySafeText } from './paths.js'
import { dataDir as defaultDataDir } from './constants.js'
import {
  loadConfig,
  loadPersistedConfig,
  saveConfig,
  invalidateConfigCache,
  resolveConfigKeyLayer,
  getProjectConfigInfo,
  type Config,
} from './config.js'
import { ensureModelFiles, modelFilesPresent } from './embed_model.js'
import { downloadAdvice, runtimeDownloadAdvice } from './embed_preflight.js'
import { withExplicitDownload } from './model_download_gate.js'
import { activeRuntime, ensureWasmBinary, wasmBinaryPresent } from './embed_runtime.js'
import { cleanupDeprecatedVscodeProjectMcp } from './bridges/vscode_install.js'
import { hasSqliteHeader, isZeroLengthDb, quarantineMalformedDb, quickCheckDb, recreateDb } from './db_integrity.js'
import { checkParserFreshness } from './cli_doctor_index.js'
import { comparableSizes, indexSizeBytes, mb, reclaimIndex, reclaimNotes, type ReclaimResult } from './index_reclaim.js'
import { repairInstructionGates } from './cli_doctor_guidance.js'

export interface DoctorRepairResult {
  readonly repairs: string[]
  readonly errors: string[]
  readonly notices: string[]
}

/** The repair row for an automatic embeddings reclaim. The figure is the one `reclaim-index` prints (comparableSizes), so a reader-blocked checkpoint that left the DB+WAL total larger reads as no space released instead of a saving. "compacted" is said only when VACUUM ran and the checkpoint was not blocked, and the VACUUM-skipped and checkpoint-busy notes are the ones `reclaim-index` prints. */
export function autoReclaimRow(res: ReclaimResult): string {
  const { freed } = comparableSizes(res)
  const compacted = !res.vacuumDeferred && !res.checkpointBusy
  const outcome = freed > 0 ? `reclaimed ${mb(freed)}${compacted ? ', compacted' : ''}` : 'no space was released'
  return [`Auto-reclaimed embeddings from global.db (${outcome})`, ...reclaimNotes(res, 'global.db').map((n) => `note: ${n}`)].join('; ')
}

/** Why a key cannot be repaired by writing the global config, or null when the global config is the layer that holds its effective value. */
export function repairBlocker(key: string, effectiveCfg: Config, projectInfo: ReturnType<typeof getProjectConfigInfo>, goal: string): string | null {
  const parts = key.split('.')
  const effective = (effectiveCfg as unknown as Record<string, Record<string, unknown> | undefined>)[parts[0] ?? '']?.[parts[1] ?? '']
  const state = resolveConfigKeyLayer(key, effective, effectiveCfg as unknown as Record<string, unknown>, projectInfo)
  if (state.layer === 'env' || state.layer === 'env-invalid') return `${state.envVar} is set in your environment; unset it to ${goal}`
  if (state.layer === 'project') return `${displaySafeText(state.path)} sets ${key}; edit that file to ${goal}`
  return null
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
  const notices: string[] = []
  // Decisions use the effective config, but only the persisted file's own values are mutated and saved: an environment override or a repository's .token-goat.toml must never be written into the global config.
  const projectInfo = getProjectConfigInfo(opts?.rootDir)
  const persisted = loadPersistedConfig()
  // A config repair is applied only once the save below succeeds, so it waits here rather than in `repairs`.
  const configRepairs: string[] = []
  const offlineInConfig = cfg.network?.offline === true
  const embeddingsInConfig = (cfg.indexing?.embeddings_enabled ?? true) !== false
  let offlineNow = offlineInConfig
  let embeddingsNow = embeddingsInConfig

  // 1. Repair restrictive settings to permissive defaults
  if (cfg.mcp?.confine_reads_to_project_root) {
    const blocker = repairBlocker('mcp.confine_reads_to_project_root', cfg, projectInfo, 'allow reads outside the project root')
    if (blocker === null) {
      persisted.mcp = { ...persisted.mcp, confine_reads_to_project_root: false }
      configRepairs.push('Restored permissive read access (mcp.confine_reads_to_project_root = false)')
    } else notices.push(blocker)
  }
  if (cfg.indexing?.cross_project_symbols === false) {
    const blocker = repairBlocker('indexing.cross_project_symbols', cfg, projectInfo, 'allow cross-project symbol search')
    if (blocker === null) {
      persisted.indexing = { ...persisted.indexing, cross_project_symbols: true }
      configRepairs.push('Restored cross-project symbol search (indexing.cross_project_symbols = true)')
    } else notices.push(blocker)
  }

  // 2. Repair missing semantic model (e.g. from mistaken rollout with network disabled)
  const needModel = !modelFilesPresent()
  if (needModel) {
    if (cfg.network?.offline) {
      const blocker = repairBlocker('network.offline', cfg, projectInfo, 'allow the model download')
      if (blocker === null) {
        persisted.network = { ...persisted.network, offline: false }
        offlineNow = false
        configRepairs.push('Restored network access (network.offline = false)')
      } else notices.push(blocker)
    }
    if (!embeddingsNow) {
      const blocker = repairBlocker('indexing.embeddings_enabled', cfg, projectInfo, 'turn semantic embeddings on')
      if (blocker === null) {
        persisted.indexing = { ...persisted.indexing, embeddings_enabled: true }
        embeddingsNow = true
        configRepairs.push('Enabled semantic embeddings (indexing.embeddings_enabled = true)')
      } else notices.push(blocker)
    }
  }

  if (configRepairs.length > 0) {
    try {
      saveConfig(persisted)
      invalidateConfigCache()
      repairs.push(...configRepairs)
    } catch (e) {
      errors.push(`Failed to update configuration: ${extractErrorMessage(e)}. Not applied: ${configRepairs.join('; ')}`)
      // The switches stay as they were, so the download below is not attempted against them.
      offlineNow = offlineInConfig
      embeddingsNow = embeddingsInConfig
    }
  }

  // 3. Download and verify missing semantic model files. A still-active offline switch or disabled embeddings was named above; attempting the download would only fail against it.
  if (needModel && !offlineNow && embeddingsNow) {
    try {
      console.log('Downloading and verifying semantic model files...')
      // `--repair` is the user asking for the download now, so it goes through a hold an earlier failure left behind.
      await withExplicitDownload(() => ensureModelFiles())
      repairs.push('Downloaded and verified semantic embedding model files')
    } catch (e) {
      errors.push(`Failed to download embedding model: ${extractErrorMessage(e)}. ${downloadAdvice()}`)
    }
  }

  // 3b. The WebAssembly runtime's binary, the other download semantic search waits on when the native runtime is not installed. Offline mode is left alone here unless step 2 lifted it, since nothing else is missing that would justify overriding the user's setting.
  if (embeddingsNow && !offlineNow && activeRuntime() === 'onnxruntime-web' && !wasmBinaryPresent()) {
    try {
      console.log('Downloading and verifying the WebAssembly runtime binary...')
      await withExplicitDownload(() => ensureWasmBinary())
      repairs.push('Downloaded and verified the WebAssembly runtime binary')
    } catch (e) {
      errors.push(`Failed to download the WebAssembly runtime binary: ${extractErrorMessage(e)}. ${runtimeDownloadAdvice()}`)
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
        repairs.push(autoReclaimRow(res))
      }
    } catch (e) {
      errors.push(`Failed to auto-reclaim embeddings from global.db: ${extractErrorMessage(e)}`)
    }
  }

  // 5b. A database whose pages are malformed, or a file with no SQLite header at all (truncated, or written over), fails the Database check; move it aside (never deleted) and start a fresh one for the index to refill.
  let rebuiltDb = false
  if (fs.existsSync(dbPath) && !isZeroLengthDb(dbPath) && (!hasSqliteHeader(dbPath) || !quickCheckDb(dbPath).ok)) {
    const quarantined = quarantineMalformedDb(dbPath, actualDataDir)
    if (quarantined.status === 'quarantined') {
      try {
        recreateDb(dbPath)
        rebuiltDb = true
        repairs.push(`Moved the malformed global.db aside to ${displaySafeText(quarantined.quarantinePath)} and created a fresh one`)
      } catch (e) {
        errors.push(`Moved the malformed global.db aside to ${displaySafeText(quarantined.quarantinePath)} but could not create a fresh one (${extractErrorMessage(e)}); run: token-goat index`)
      }
    } else {
      errors.push(`global.db is malformed and could not be moved aside (${quarantined.error}); stop token-goat (token-goat worker stop), rename ${displaySafeText(dbPath)} by hand, then run: token-goat index`)
    }
  }

  // 6. Repair missing instruction gates
  const gateRepair = repairInstructionGates(opts?.rootDir)
  repairs.push(...gateRepair.repairs)
  errors.push(...gateRepair.errors)

  // 6b. Repair stale or outdated harness hooks and shims
  const { repairHarnessHooks } = await import('./cli_doctor_hooks.js')
  const hookRepair = repairHarnessHooks(opts?.rootDir)
  repairs.push(...hookRepair.repairs)
  errors.push(...hookRepair.errors)

  // 6c. Repair parser freshness mismatch by enqueuing project for background reindexing
  try {
    const actualRoot = path.resolve(opts?.rootDir ?? process.cwd())
    if (rebuiltDb || checkParserFreshness(dbPath, actualRoot).status === 'warn') {
      const { formatInstallIndexResult, queueInstallIndex } = await import('./install_index.js')
      const queued = queueInstallIndex(actualRoot)
      if (queued.status === 'queued') repairs.push(rebuiltDb ? 'Queued project for reindexing into the fresh database' : 'Queued project for parser freshness reindexing')
      else if (queued.status === 'failed') errors.push(`Could not queue this project for reindexing (${queued.error}); run: token-goat index`)
      else if (rebuiltDb) notices.push(formatInstallIndexResult(queued) ?? 'The project was not queued for reindexing; run: token-goat index')
    }
  } catch {
    // Non-fatal if queue or db unavailable
  }

  // 7. Check for pending updates and upgrade if available. A development checkout is reported, never replaced: installing from the registry would overwrite the developer's own build. Offline or an unreachable registry installs nothing and is not an error, since the rest of the repair still ran.
  try {
    const upgrade = await import('./cli_upgrade.js')
    const update = await upgrade.checkUpdateStatus(2500)
    const decision = upgrade.currentUpgradeDecision(update)
    if (decision === 'dev-checkout') {
      repairs.push(`Update available (v${update.current} -> v${update.latest}). This token-goat runs from a development checkout, so it was not replaced; run: ${upgrade.DEV_CHECKOUT_ADVICE}`)
    } else if (decision === 'install') {
      const outcome = await upgrade.performUpgrade()
      if (outcome.ok) repairs.push(`Upgraded token-goat v${update.current} -> v${update.latest}`)
      else errors.push(`Upgrade to v${update.latest} failed: ${outcome.message}`)
    }
  } catch (e) {
    errors.push(`Upgrade check failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { repairs, errors, notices }
}
