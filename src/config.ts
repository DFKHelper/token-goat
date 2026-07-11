import * as fs from 'node:fs'

import { parse, stringify } from 'smol-toml'

import { configPath } from './constants.js'
import { envBool, envInt, envStr } from './env.js'
import { atomicWriteText } from './util.js'

// ---------------------------------------------------------------------------
// Section interfaces
// ---------------------------------------------------------------------------

export interface CompactAssistConfig {
  enabled: boolean
  triggers: string[]
  min_events: number
  max_manifest_tokens: number
  auto_trigger_multiplier: number
  compact_skip_ttl_secs: number
  noise_floor_tokens: number
  edited_dir_group_threshold: number
  max_section_lines: number
  wide_session_threshold: number
  orchestrator_commit_threshold: number
  max_manifest_chars: number
  harness: string
}

export interface BashCompressConfig {
  enabled: boolean
  disabled_filters: string[]
  max_lines: number
  max_bytes: number
  timeout_seconds: number
  cache_min_bytes: number
  cache_max_file_count: number
  cache_max_bytes: number
  cache_max_bytes_per_output: number
}

export interface BashDiffConfig {
  max_hunks_per_file: number
  hunk_density_cap: boolean
}

export interface SeverityLogConfig {
  context_lines: number
  score_threshold: number
}

/**
 * Gates the post-read structural-navigation hint in `postReadHandler` (hooks_read.ts):
 * once a just-read source file has at least `min_lines` lines, the hook nudges toward
 * `token-goat skeleton`/`outline` for bodies-elided navigation instead of a future full
 * re-read. Historically gated an actual regex-based code compressor (removed as dead code
 * -- see code_compress.ts in git history); the config key is kept unchanged to avoid a
 * config-schema break for existing users.
 */
export interface CodeCompressConfig {
  min_lines: number
}

export interface SessionBriefConfig {
  enabled: boolean
}

export interface SkillPreservationConfig {
  enabled: boolean
  max_cache_bytes: number
  orphan_sweep_enabled: boolean
  orphan_age_secs: number
  truncation_budget_tokens: number
  compress_bodies: boolean
  compress_min_bytes: number
  inline_snippets: boolean
  pre_skill_enabled: boolean
  first_load_compact: boolean
  post_compact_full_loads: boolean
}

export interface CuratorConfig {
  enabled: boolean
  min_samples: number
  threshold_pct: number
}

export interface HintBudgetConfig {
  enabled: boolean
  max_per_session: number
  max_structured_per_session: number
  max_index_only_per_session: number
}

export interface ImageShrinkConfig {
  enabled: boolean
  jpeg_quality: number
  max_image_pixels: number
  screenshot_redirect: boolean
}

export interface ScreenshotConfig {
  chrome_path: string
}

export interface RepomapConfig {
  compact_file_threshold: number
  exclude_tests: boolean
}

export interface OverflowGuardConfig {
  enabled: boolean
  max_tokens: number
}

export interface StatsConfig {
  record_zero_savings: boolean
}

export interface PromptTrigger {
  keywords: string[]
  hint: string
}

export interface HintsConfig {
  suppress_after_ignored: number
  quiet_hours: string
  json_sidecar: boolean
  verbose_until_seen_count: number
  min_file_lines_for_hint: number
  bash_dedup_min_bytes: number
  web_dedup_min_bytes: number
  grep_dedup_min_matches: number
  serve_diff_on_reread: boolean
  backoff_thresholds: number[]
  git_hint_max_ms: number
  min_session_hint_savings_bytes: number
  pre_skill_advisory: boolean
  context_threshold_advisory: boolean
  diff_hint_min_tokens_saved: number
  large_read_redirect_bytes: number
  reread_deny: boolean
  reread_deny_min_bytes: number
  baseline_budget_tokens: number
  stable_doc_compacts: boolean
  truncated_read_min_lines: number
  protect_recent_reads: number
  warn_unbalanced_shell_quoting: boolean
  prompt_triggers: PromptTrigger[]
  log_large_file_hint_outcomes: boolean
  cross_session_read_dedup: boolean
  cross_session_read_dedup_ttl_secs: number
  mcp_dedup_ttl_secs: number
}

export interface HooksConfig {
  watchdog_ms: number
}

export interface WebFetchConfig {
  allow: string[]
  deny: string[]
  max_file_count: number
  max_bytes: number
  compress_bodies: boolean
  compress_min_bytes: number
}

export interface WorkerConfig {
  watchdog_enabled: boolean
  max_pool_workers: number
  blocked_roots: string[]
}

export interface IndexingConfig {
  large_file_symbol_only_kb: number
  large_file_skip_kb: number
  skip_dirs: string[]
  // Whether indexing (token-goat index and the worker's incremental drain) also chunks and
  // embeds file content for `token-goat semantic`, in addition to the always-on syntactic
  // symbols/refs parse. Defaults to true to match the feature's advertised behavior; set
  // false to skip the (meaningfully slower, model-inference-backed) embeddings step and keep
  // indexing purely syntactic. Independently gated at the point of use on whether
  // @xenova/transformers and sqlite-vec are actually installed - this flag only controls
  // whether embeddings are attempted at all.
  embeddings_enabled: boolean
}

export interface CompressionConfig {
  profile: string
}

export interface ContextConfig {
  model_window_tokens: number
}

export interface InjectionConfig {
  enabled: boolean
}

export interface Config {
  compact_assist: CompactAssistConfig
  bash_compress: BashCompressConfig
  bash_diff: BashDiffConfig
  bash_severity_log: SeverityLogConfig
  post_read_code_compress: CodeCompressConfig
  session_brief: SessionBriefConfig
  skill_preservation: SkillPreservationConfig
  curator: CuratorConfig
  hint_budget: HintBudgetConfig
  image_shrink: ImageShrinkConfig
  screenshot: ScreenshotConfig
  repomap: RepomapConfig
  overflow_guard: OverflowGuardConfig
  stats: StatsConfig
  hints: HintsConfig
  hooks: HooksConfig
  webfetch: WebFetchConfig
  worker: WorkerConfig
  indexing: IndexingConfig
  compression: CompressionConfig
  context: ContextConfig
  injection: InjectionConfig
}

// ---------------------------------------------------------------------------
// Default factories
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS: Record<string, object> = {
  compact_assist: {
    enabled: true,
    triggers: ['manual', 'auto'],
    min_events: 3,
    max_manifest_tokens: 400,
    auto_trigger_multiplier: 2.0,
    compact_skip_ttl_secs: 300.0,
    noise_floor_tokens: 0,
    edited_dir_group_threshold: 3,
    max_section_lines: 0,
    wide_session_threshold: 15,
    orchestrator_commit_threshold: 5,
    max_manifest_chars: 1600,
    harness: 'auto',
  },
  bash_compress: {
    enabled: true,
    disabled_filters: [],
    max_lines: 1000,
    max_bytes: 64 * 1024,
    timeout_seconds: 600,
    // Matches the hardcoded MIN_CACHE_BYTES floor hooks_bash.ts used before this
    // knob was wired to a real consumer, so untouched-config installs see no
    // behavior change now that hooks_bash.ts reads this value instead.
    cache_min_bytes: 512,
    cache_max_file_count: 4096,
    cache_max_bytes: 16 * 1024 * 1024,
    cache_max_bytes_per_output: 50 * 1024 * 1024,
  },
  bash_diff: {
    max_hunks_per_file: 10,
    hunk_density_cap: true,
  },
  bash_severity_log: {
    context_lines: 3,
    score_threshold: 0.5,
  },
  post_read_code_compress: {
    min_lines: 200,
  },
  session_brief: {
    enabled: true,
  },
  skill_preservation: {
    enabled: true,
    max_cache_bytes: 5 * 1024 * 1024,
    orphan_sweep_enabled: true,
    orphan_age_secs: 604800,
    truncation_budget_tokens: 800,
    compress_bodies: true,
    compress_min_bytes: 16 * 1024,
    inline_snippets: true,
    pre_skill_enabled: true,
    first_load_compact: false,
    post_compact_full_loads: false,
  },
  curator: {
    enabled: true,
    min_samples: 10,
    threshold_pct: 20,
  },
  hint_budget: {
    enabled: true,
    max_per_session: 100,
    max_structured_per_session: 30,
    max_index_only_per_session: 30,
  },
  image_shrink: {
    enabled: true,
    jpeg_quality: 75,
    max_image_pixels: 16_000_000,
    screenshot_redirect: true,
  },
  screenshot: {
    chrome_path: '',
  },
  repomap: {
    compact_file_threshold: 50,
    exclude_tests: true,
  },
  overflow_guard: {
    enabled: true,
    max_tokens: 25000,
  },
  stats: {
    record_zero_savings: false,
  },
  hints: {
    suppress_after_ignored: 5,
    quiet_hours: '',
    json_sidecar: false,
    verbose_until_seen_count: 2,
    min_file_lines_for_hint: 0,
    bash_dedup_min_bytes: 200,
    web_dedup_min_bytes: 200,
    grep_dedup_min_matches: 5,
    serve_diff_on_reread: false,
    backoff_thresholds: [1, 3, 10, 30],
    git_hint_max_ms: 50,
    min_session_hint_savings_bytes: 512,
    pre_skill_advisory: true,
    context_threshold_advisory: true,
    diff_hint_min_tokens_saved: 1000,
    // Base for the pressure-scaled first-read deny gate in hooks_read.ts (large file, never read
    // before). Matches that gate's long-tuned 500KB threshold at 'cool' context pressure; warm/hot/
    // critical scale it down from there so the same read gets redirected to a surgical read sooner
    // once the context window is nearly full.
    large_read_redirect_bytes: 512_000,
    reread_deny: true,
    reread_deny_min_bytes: 2048,
    baseline_budget_tokens: 0,
    stable_doc_compacts: true,
    truncated_read_min_lines: 200,
    protect_recent_reads: 4,
    warn_unbalanced_shell_quoting: true,
    prompt_triggers: [],
    log_large_file_hint_outcomes: false,
    cross_session_read_dedup: false,
    cross_session_read_dedup_ttl_secs: 2700,
    mcp_dedup_ttl_secs: 45,
  },
  hooks: {
    watchdog_ms: 700,
  },
  webfetch: {
    allow: [],
    deny: [],
    max_file_count: 4096,
    max_bytes: 32 * 1024 * 1024,
    compress_bodies: true,
    compress_min_bytes: 16 * 1024,
  },
  worker: {
    watchdog_enabled: true,
    max_pool_workers: 4,
    blocked_roots: [],
  },
  indexing: {
    large_file_symbol_only_kb: 500,
    large_file_skip_kb: 2048,
    skip_dirs: [],
    embeddings_enabled: true,
  },
  compression: {
    profile: 'auto',
  },
  context: {
    model_window_tokens: 200_000,
  },
  injection: {
    enabled: true,
  },
}

export function getDefaultConfig(section: string): object {
  return structuredClone(CONFIG_DEFAULTS[section] ?? {})
}

export function defaultConfig(): Config {
  return {
    compact_assist: getDefaultConfig('compact_assist') as CompactAssistConfig,
    bash_compress: getDefaultConfig('bash_compress') as BashCompressConfig,
    bash_diff: getDefaultConfig('bash_diff') as BashDiffConfig,
    bash_severity_log: getDefaultConfig('bash_severity_log') as SeverityLogConfig,
    post_read_code_compress: getDefaultConfig('post_read_code_compress') as CodeCompressConfig,
    session_brief: getDefaultConfig('session_brief') as SessionBriefConfig,
    skill_preservation: getDefaultConfig('skill_preservation') as SkillPreservationConfig,
    curator: getDefaultConfig('curator') as CuratorConfig,
    hint_budget: getDefaultConfig('hint_budget') as HintBudgetConfig,
    image_shrink: getDefaultConfig('image_shrink') as ImageShrinkConfig,
    screenshot: getDefaultConfig('screenshot') as ScreenshotConfig,
    repomap: getDefaultConfig('repomap') as RepomapConfig,
    overflow_guard: getDefaultConfig('overflow_guard') as OverflowGuardConfig,
    stats: getDefaultConfig('stats') as StatsConfig,
    hints: getDefaultConfig('hints') as HintsConfig,
    hooks: getDefaultConfig('hooks') as HooksConfig,
    webfetch: getDefaultConfig('webfetch') as WebFetchConfig,
    worker: getDefaultConfig('worker') as WorkerConfig,
    indexing: getDefaultConfig('indexing') as IndexingConfig,
    compression: getDefaultConfig('compression') as CompressionConfig,
    context: getDefaultConfig('context') as ContextConfig,
    injection: getDefaultConfig('injection') as InjectionConfig,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatedBool(raw: unknown, def: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  return def
}

function validatedInt(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : def
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

function validatedFloat(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : def
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

function validatedStr(raw: unknown, def: string): string {
  return typeof raw === 'string' ? raw : def
}

function validatedStrList(raw: unknown, def: string[]): string[] {
  if (!Array.isArray(raw)) return def
  return raw.filter((x): x is string => typeof x === 'string')
}

function validatedIntList(raw: unknown, def: number[]): number[] {
  if (!Array.isArray(raw)) return def
  return raw.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map(Math.trunc)
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = raw[key]
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {}
}

// ---------------------------------------------------------------------------
// Env fingerprint + mtime cache
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'TOKEN_GOAT_COMPACT_ASSIST',
  'TOKENWISE_COMPACT_ASSIST',
  'TOKEN_GOAT_BASH_COMPRESS',
  'TOKEN_GOAT_SESSION_BRIEF',
  'TOKEN_GOAT_SKILL_PRESERVATION',
  'TOKEN_GOAT_MAX_IMAGE_PIXELS',
  'TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD',
  'TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS',
  'TOKEN_GOAT_OVERFLOW_GUARD',
  'TOKEN_GOAT_OVERFLOW_MAX_TOKENS',
  'TOKEN_GOAT_HINT_JSON_SIDECAR',
  'TOKEN_GOAT_LARGE_READ_BYTES',
  'TOKEN_GOAT_BASELINE_BUDGET_TOKENS',
  'TOKEN_GOAT_CURATOR',
  'TOKEN_GOAT_HINT_BUDGET',
  'TOKEN_GOAT_HOOK_WATCHDOG_MS',
  'TOKEN_GOAT_WEB_COMPRESS',
  'TOKEN_GOAT_WORKER_WATCHDOG',
  'TOKEN_GOAT_WORKER_MAX_POOL',
  'TOKEN_GOAT_COMPRESS_PROFILE',
  'TOKEN_GOAT_MODEL_WINDOW_TOKENS',
  'TOKEN_GOAT_INJECTION_ENABLED',
  'TOKEN_GOAT_SERVE_DIFF_ON_REREAD',
  'TOKEN_GOAT_BASH_CACHE_MIN_BYTES',
  'TOKEN_GOAT_BASH_CACHE_MAX_FILES',
  'TOKEN_GOAT_BASH_CACHE_MAX_BYTES',
  'TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT',
  'TOKEN_GOAT_SESSION_HINT_MIN_BYTES',
  'TOKEN_GOAT_SKILL_COMPRESS',
  'TOKEN_GOAT_PRE_SKILL',
  'TOKEN_GOAT_ORPHAN_SWEEP',
  'TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING',
  'TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES',
  'TOKEN_GOAT_CROSS_SESSION_READ_DEDUP',
  'TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS',
  'TOKEN_GOAT_MCP_DEDUP_TTL_SECS',
  'TOKEN_GOAT_EMBEDDINGS_ENABLED',
  'TOKEN_GOAT_BASH_DEDUP_MIN_BYTES',
  'TOKEN_GOAT_WEB_DEDUP_MIN_BYTES',
  'TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES',
  'TOKEN_GOAT_WEB_CACHE_MAX_FILES',
  'TOKEN_GOAT_WEB_CACHE_MAX_BYTES',
]

export function configEnvFingerprint(): string {
  const snap: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k]
  }
  return JSON.stringify(snap)
}

interface CacheEntry {
  config: Config
  mtime: number
  envFp: string
}

let _cached: CacheEntry | null = null

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

export function loadConfig(): Config {
  const p = configPath()

  let currentMtime = 0
  try {
    currentMtime = fs.statSync(p).mtimeMs
  } catch {
    // file absent — mtime stays 0
  }

  const envFp = configEnvFingerprint()
  if (_cached !== null && _cached.mtime === currentMtime && _cached.envFp === envFp) {
    return _cached.config
  }

  let raw: Record<string, unknown> = {}
  if (currentMtime !== 0) {
    try {
      const text = fs.readFileSync(p, 'utf8')
      raw = parse(text) as Record<string, unknown>
    } catch {
      // unreadable — fall back to defaults
    }
  }

  const cfg = _buildConfig(raw)

  _cached = { config: cfg, mtime: currentMtime, envFp }
  return cfg
}

export function invalidateConfigCache(): void {
  _cached = null
}

/**
 * Run `fn` with every config-affecting env var (the {@link ENV_KEYS} registry) temporarily
 * cleared, then restore the original values. Safe because `_buildConfig` is fully
 * synchronous — no other code can observe the env vars while they are unset.
 */
function withoutConfigEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * Build a {@link Config} from `raw` TOML-shaped data with no env-var overlay — exactly what
 * is (or would be) persisted to disk. Used by {@link loadPersistedConfig} and by `config set`'s
 * write-time range check, so a transient TOKEN_GOAT_* env override active for one invocation
 * never gets baked permanently into config.toml by a mutate-then-save command.
 */
export function buildPersistedConfig(raw: Record<string, unknown>): Config {
  return withoutConfigEnv(() => _buildConfig(raw))
}

/**
 * Like {@link loadConfig} but without env-var overlay — the config exactly as it exists on
 * disk. `config set` / `project exclude` / `project prune` must load through this (not
 * loadConfig()) before mutating and saving, or a TOKEN_GOAT_* env override active only for
 * the current invocation would get written to config.toml permanently.
 */
export function loadPersistedConfig(): Config {
  const p = configPath()
  let raw: Record<string, unknown> = {}
  try {
    const text = fs.readFileSync(p, 'utf8')
    raw = parse(text) as Record<string, unknown>
  } catch {
    // missing/unreadable — fall back to defaults
  }
  return buildPersistedConfig(raw)
}

function _buildConfig(raw: Record<string, unknown>): Config {
  const ca_raw = section(raw, 'compact_assist')
  const ca = getDefaultConfig('compact_assist') as CompactAssistConfig
  ca.enabled = validatedBool(ca_raw['enabled'], ca.enabled)
  ca.triggers = validatedStrList(ca_raw['triggers'], ca.triggers)
  ca.min_events = validatedInt(ca_raw['min_events'], ca.min_events, 0, 1000)
  ca.max_manifest_tokens = validatedInt(ca_raw['max_manifest_tokens'], ca.max_manifest_tokens, 50, 10000)
  ca.auto_trigger_multiplier = validatedFloat(ca_raw['auto_trigger_multiplier'], ca.auto_trigger_multiplier, 1.0, 10.0)
  ca.compact_skip_ttl_secs = validatedFloat(ca_raw['compact_skip_ttl_secs'], ca.compact_skip_ttl_secs, 1.0, 3600.0)
  ca.noise_floor_tokens = validatedInt(ca_raw['noise_floor_tokens'], ca.noise_floor_tokens, 0, 10000)
  ca.edited_dir_group_threshold = validatedInt(ca_raw['edited_dir_group_threshold'], ca.edited_dir_group_threshold, 0, 100)
  ca.max_section_lines = validatedInt(ca_raw['max_section_lines'], ca.max_section_lines, 0, 10000)
  ca.wide_session_threshold = validatedInt(ca_raw['wide_session_threshold'], ca.wide_session_threshold, 1, 10000)
  ca.orchestrator_commit_threshold = validatedInt(ca_raw['orchestrator_commit_threshold'], ca.orchestrator_commit_threshold, 1, 10000)
  ca.max_manifest_chars = validatedInt(ca_raw['max_manifest_chars'], ca.max_manifest_chars, 0, 16000)
  ca.harness = validatedStr(ca_raw['harness'], ca.harness)
  // env overrides
  ca.enabled = envBool('TOKEN_GOAT_COMPACT_ASSIST', envBool('TOKENWISE_COMPACT_ASSIST', ca.enabled))

  const bc_raw = section(raw, 'bash_compress')
  const bc = getDefaultConfig('bash_compress') as BashCompressConfig
  bc.enabled = validatedBool(bc_raw['enabled'], bc.enabled)
  bc.disabled_filters = validatedStrList(bc_raw['disabled_filters'], bc.disabled_filters)
  bc.max_lines = validatedInt(bc_raw['max_lines'], bc.max_lines, 50, 100_000)
  bc.max_bytes = validatedInt(bc_raw['max_bytes'], bc.max_bytes, 1024, 16 * 1024 * 1024)
  bc.timeout_seconds = validatedInt(bc_raw['timeout_seconds'], bc.timeout_seconds, 5, 7200)
  bc.cache_min_bytes = validatedInt(bc_raw['cache_min_bytes'], bc.cache_min_bytes, 0, 100 * 1024 * 1024)
  bc.cache_max_file_count = validatedInt(bc_raw['cache_max_file_count'], bc.cache_max_file_count, 1, 1_000_000)
  bc.cache_max_bytes = validatedInt(bc_raw['cache_max_bytes'], bc.cache_max_bytes, 1024, 4 * 1024 * 1024 * 1024)
  bc.cache_max_bytes_per_output = validatedInt(bc_raw['cache_max_bytes_per_output'], bc.cache_max_bytes_per_output, 1024, 4 * 1024 * 1024 * 1024)
  bc.enabled = envBool('TOKEN_GOAT_BASH_COMPRESS', bc.enabled)
  bc.cache_min_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MIN_BYTES', bc.cache_min_bytes, 0, 100 * 1024 * 1024)
  bc.cache_max_file_count = envInt('TOKEN_GOAT_BASH_CACHE_MAX_FILES', bc.cache_max_file_count, 1, 1_000_000)
  bc.cache_max_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES', bc.cache_max_bytes, 1024, 4 * 1024 * 1024 * 1024)
  bc.cache_max_bytes_per_output = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT', bc.cache_max_bytes_per_output, 1024, 4 * 1024 * 1024 * 1024)
  // A per-item cap larger than the total-directory budget is nonsensical: pruneBlobs()
  // would otherwise evict a freshly-written item (and everything else) in the same
  // storeBlob() call that just wrote it. Clamp it so the per-item cap can never
  // exceed the total budget.
  bc.cache_max_bytes_per_output = Math.min(bc.cache_max_bytes_per_output, bc.cache_max_bytes)

  const bd_raw = section(raw, 'bash_diff')
  const bd = getDefaultConfig('bash_diff') as BashDiffConfig
  bd.max_hunks_per_file = validatedInt(bd_raw['max_hunks_per_file'], bd.max_hunks_per_file, 1, 10000)
  bd.hunk_density_cap = validatedBool(bd_raw['hunk_density_cap'], bd.hunk_density_cap)

  const sl_raw = section(raw, 'bash_severity_log')
  const sl = getDefaultConfig('bash_severity_log') as SeverityLogConfig
  sl.context_lines = validatedInt(sl_raw['context_lines'], sl.context_lines, 0, 100)
  sl.score_threshold = validatedFloat(sl_raw['score_threshold'], sl.score_threshold, 0.0, 1.0)

  const cc_raw = section(raw, 'post_read_code_compress')
  const cc = getDefaultConfig('post_read_code_compress') as CodeCompressConfig
  cc.min_lines = validatedInt(cc_raw['min_lines'], cc.min_lines, 0, 1_000_000)

  const sb_raw = section(raw, 'session_brief')
  const sb = getDefaultConfig('session_brief') as SessionBriefConfig
  sb.enabled = validatedBool(sb_raw['enabled'], sb.enabled)
  sb.enabled = envBool('TOKEN_GOAT_SESSION_BRIEF', sb.enabled)

  const sp_raw = section(raw, 'skill_preservation')
  const sp = getDefaultConfig('skill_preservation') as SkillPreservationConfig
  sp.enabled = validatedBool(sp_raw['enabled'], sp.enabled)
  sp.max_cache_bytes = validatedInt(sp_raw['max_cache_bytes'], sp.max_cache_bytes, 64 * 1024, 512 * 1024 * 1024)
  sp.orphan_sweep_enabled = validatedBool(sp_raw['orphan_sweep_enabled'], sp.orphan_sweep_enabled)
  sp.orphan_age_secs = validatedInt(sp_raw['orphan_age_secs'], sp.orphan_age_secs, 1, 2_592_000)
  sp.truncation_budget_tokens = validatedInt(sp_raw['truncation_budget_tokens'], sp.truncation_budget_tokens, 0, 8000)
  sp.compress_bodies = validatedBool(sp_raw['compress_bodies'], sp.compress_bodies)
  sp.compress_min_bytes = validatedInt(sp_raw['compress_min_bytes'], sp.compress_min_bytes, 1024, 10 * 1024 * 1024)
  sp.inline_snippets = validatedBool(sp_raw['inline_snippets'], sp.inline_snippets)
  sp.pre_skill_enabled = validatedBool(sp_raw['pre_skill_enabled'], sp.pre_skill_enabled)
  sp.first_load_compact = validatedBool(sp_raw['first_load_compact'], sp.first_load_compact)
  sp.post_compact_full_loads = validatedBool(sp_raw['post_compact_full_loads'], sp.post_compact_full_loads)
  sp.enabled = envBool('TOKEN_GOAT_SKILL_PRESERVATION', sp.enabled)
  sp.compress_bodies = envBool('TOKEN_GOAT_SKILL_COMPRESS', sp.compress_bodies)
  sp.pre_skill_enabled = envBool('TOKEN_GOAT_PRE_SKILL', sp.pre_skill_enabled)
  sp.orphan_sweep_enabled = envBool('TOKEN_GOAT_ORPHAN_SWEEP', sp.orphan_sweep_enabled)

  const is_raw = section(raw, 'image_shrink')
  const is_cfg = getDefaultConfig('image_shrink') as ImageShrinkConfig
  is_cfg.enabled = validatedBool(is_raw['enabled'], is_cfg.enabled)
  is_cfg.jpeg_quality = validatedInt(is_raw['jpeg_quality'], is_cfg.jpeg_quality, 1, 100)
  is_cfg.max_image_pixels = validatedInt(is_raw['max_image_pixels'], is_cfg.max_image_pixels, 0, 1_000_000_000)
  is_cfg.screenshot_redirect = validatedBool(is_raw['screenshot_redirect'], is_cfg.screenshot_redirect)
  is_cfg.max_image_pixels = envInt('TOKEN_GOAT_MAX_IMAGE_PIXELS', is_cfg.max_image_pixels, 0, 1_000_000_000)

  const sc_raw = section(raw, 'screenshot')
  const sc_cfg = getDefaultConfig('screenshot') as ScreenshotConfig
  sc_cfg.chrome_path = validatedStr(sc_raw['chrome_path'], sc_cfg.chrome_path)

  const cur_raw = section(raw, 'curator')
  const cur = getDefaultConfig('curator') as CuratorConfig
  cur.enabled = validatedBool(cur_raw['enabled'], cur.enabled)
  cur.min_samples = validatedInt(cur_raw['min_samples'], cur.min_samples, 0, 10000)
  cur.threshold_pct = validatedInt(cur_raw['threshold_pct'], cur.threshold_pct, 0, 100)
  cur.enabled = envBool('TOKEN_GOAT_CURATOR', cur.enabled)

  const hb_raw = section(raw, 'hint_budget')
  const hb = getDefaultConfig('hint_budget') as HintBudgetConfig
  hb.enabled = validatedBool(hb_raw['enabled'], hb.enabled)
  hb.max_per_session = validatedInt(hb_raw['max_per_session'], hb.max_per_session, 0, 1_000_000)
  hb.max_structured_per_session = validatedInt(hb_raw['max_structured_per_session'], hb.max_structured_per_session, 0, 1_000_000)
  hb.max_index_only_per_session = validatedInt(hb_raw['max_index_only_per_session'], hb.max_index_only_per_session, 0, 1_000_000)
  hb.enabled = envBool('TOKEN_GOAT_HINT_BUDGET', hb.enabled)

  const rm_raw = section(raw, 'repomap')
  const rm = getDefaultConfig('repomap') as RepomapConfig
  rm.compact_file_threshold = validatedInt(rm_raw['compact_file_threshold'], rm.compact_file_threshold, 0, 100_000)
  rm.exclude_tests = validatedBool(rm_raw['exclude_tests'], rm.exclude_tests)
  rm.compact_file_threshold = envInt('TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD', rm.compact_file_threshold, 0, 100_000)
  rm.exclude_tests = envBool('TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS', rm.exclude_tests)

  const og_raw = section(raw, 'overflow_guard')
  const og = getDefaultConfig('overflow_guard') as OverflowGuardConfig
  og.enabled = validatedBool(og_raw['enabled'], og.enabled)
  og.max_tokens = validatedInt(og_raw['max_tokens'], og.max_tokens, 1000, 1_000_000)
  og.enabled = envBool('TOKEN_GOAT_OVERFLOW_GUARD', og.enabled)
  og.max_tokens = envInt('TOKEN_GOAT_OVERFLOW_MAX_TOKENS', og.max_tokens, 1000, 1_000_000)

  const st_raw = section(raw, 'stats')
  const st = getDefaultConfig('stats') as StatsConfig
  st.record_zero_savings = validatedBool(st_raw['record_zero_savings'], st.record_zero_savings)

  const hi_raw = section(raw, 'hints')
  const hi = getDefaultConfig('hints') as HintsConfig
  hi.suppress_after_ignored = validatedInt(hi_raw['suppress_after_ignored'], hi.suppress_after_ignored, 0, 1000)
  hi.quiet_hours = validatedStr(hi_raw['quiet_hours'], hi.quiet_hours)
  hi.json_sidecar = validatedBool(hi_raw['json_sidecar'], hi.json_sidecar)
  hi.verbose_until_seen_count = validatedInt(hi_raw['verbose_until_seen_count'], hi.verbose_until_seen_count, 0, 10000)
  hi.min_file_lines_for_hint = validatedInt(hi_raw['min_file_lines_for_hint'], hi.min_file_lines_for_hint, 0, 1_000_000)
  hi.bash_dedup_min_bytes = validatedInt(hi_raw['bash_dedup_min_bytes'], hi.bash_dedup_min_bytes, 0, 100_000)
  hi.bash_dedup_min_bytes = envInt('TOKEN_GOAT_BASH_DEDUP_MIN_BYTES', hi.bash_dedup_min_bytes, 0, 100_000)
  hi.web_dedup_min_bytes = validatedInt(hi_raw['web_dedup_min_bytes'], hi.web_dedup_min_bytes, 0, 100_000)
  hi.web_dedup_min_bytes = envInt('TOKEN_GOAT_WEB_DEDUP_MIN_BYTES', hi.web_dedup_min_bytes, 0, 100_000)
  hi.grep_dedup_min_matches = validatedInt(hi_raw['grep_dedup_min_matches'], hi.grep_dedup_min_matches, 0, 100_000)
  hi.grep_dedup_min_matches = envInt('TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES', hi.grep_dedup_min_matches, 0, 100_000)
  hi.serve_diff_on_reread = validatedBool(hi_raw['serve_diff_on_reread'], hi.serve_diff_on_reread)
  hi.backoff_thresholds = validatedIntList(hi_raw['backoff_thresholds'], hi.backoff_thresholds)
  hi.git_hint_max_ms = validatedInt(hi_raw['git_hint_max_ms'], hi.git_hint_max_ms, 0, 10000)
  hi.min_session_hint_savings_bytes = validatedInt(hi_raw['min_session_hint_savings_bytes'], hi.min_session_hint_savings_bytes, 0, 1_000_000)
  hi.pre_skill_advisory = validatedBool(hi_raw['pre_skill_advisory'], hi.pre_skill_advisory)
  hi.context_threshold_advisory = validatedBool(hi_raw['context_threshold_advisory'], hi.context_threshold_advisory)
  hi.diff_hint_min_tokens_saved = validatedInt(hi_raw['diff_hint_min_tokens_saved'], hi.diff_hint_min_tokens_saved, 0, 100_000)
  hi.large_read_redirect_bytes = validatedInt(hi_raw['large_read_redirect_bytes'], hi.large_read_redirect_bytes, 0, 100_000_000)
  hi.reread_deny = validatedBool(hi_raw['reread_deny'], hi.reread_deny)
  hi.reread_deny_min_bytes = validatedInt(hi_raw['reread_deny_min_bytes'], hi.reread_deny_min_bytes, 0, 100_000_000)
  hi.baseline_budget_tokens = validatedInt(hi_raw['baseline_budget_tokens'], hi.baseline_budget_tokens, 0, 10_000_000)
  hi.stable_doc_compacts = validatedBool(hi_raw['stable_doc_compacts'], hi.stable_doc_compacts)
  hi.truncated_read_min_lines = validatedInt(hi_raw['truncated_read_min_lines'], hi.truncated_read_min_lines, 0, 1_000_000)
  hi.protect_recent_reads = validatedInt(hi_raw['protect_recent_reads'], hi.protect_recent_reads, 0, 100)
  hi.warn_unbalanced_shell_quoting = validatedBool(hi_raw['warn_unbalanced_shell_quoting'], hi.warn_unbalanced_shell_quoting)
  hi.log_large_file_hint_outcomes = validatedBool(hi_raw['log_large_file_hint_outcomes'], hi.log_large_file_hint_outcomes)
  hi.warn_unbalanced_shell_quoting = envBool('TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING', hi.warn_unbalanced_shell_quoting)
  hi.serve_diff_on_reread = envBool('TOKEN_GOAT_SERVE_DIFF_ON_REREAD', hi.serve_diff_on_reread)
  hi.log_large_file_hint_outcomes = envBool('TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES', hi.log_large_file_hint_outcomes)
  hi.json_sidecar = envBool('TOKEN_GOAT_HINT_JSON_SIDECAR', hi.json_sidecar)
  hi.large_read_redirect_bytes = envInt('TOKEN_GOAT_LARGE_READ_BYTES', hi.large_read_redirect_bytes, 0, 100_000_000)
  hi.baseline_budget_tokens = envInt('TOKEN_GOAT_BASELINE_BUDGET_TOKENS', hi.baseline_budget_tokens, 0, 10_000_000)
  hi.cross_session_read_dedup = validatedBool(hi_raw['cross_session_read_dedup'], hi.cross_session_read_dedup)
  hi.cross_session_read_dedup_ttl_secs = validatedInt(hi_raw['cross_session_read_dedup_ttl_secs'], hi.cross_session_read_dedup_ttl_secs, 1, 86400)
  hi.cross_session_read_dedup = envBool('TOKEN_GOAT_CROSS_SESSION_READ_DEDUP', hi.cross_session_read_dedup)
  hi.cross_session_read_dedup_ttl_secs = envInt('TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS', hi.cross_session_read_dedup_ttl_secs, 1, 86400)
  hi.mcp_dedup_ttl_secs = validatedInt(hi_raw['mcp_dedup_ttl_secs'], hi.mcp_dedup_ttl_secs, 1, 3600)
  hi.mcp_dedup_ttl_secs = envInt('TOKEN_GOAT_MCP_DEDUP_TTL_SECS', hi.mcp_dedup_ttl_secs, 1, 3600)
  hi.min_session_hint_savings_bytes = envInt('TOKEN_GOAT_SESSION_HINT_MIN_BYTES', hi.min_session_hint_savings_bytes, 0, 1_000_000)
  // parse prompt_triggers
  const triggers_raw = hi_raw['prompt_triggers']
  if (Array.isArray(triggers_raw)) {
    hi.prompt_triggers = triggers_raw
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object' && !Array.isArray(t))
      .map((t) => ({
        keywords: validatedStrList(t['keywords'], []),
        hint: validatedStr(t['hint'], ''),
      }))
      .filter((t) => t.keywords.length > 0 && t.hint.length > 0)
  }

  const hk_raw = section(raw, 'hooks')
  const hk = getDefaultConfig('hooks') as HooksConfig
  hk.watchdog_ms = validatedInt(hk_raw['watchdog_ms'], hk.watchdog_ms, 100, 30000)
  hk.watchdog_ms = envInt('TOKEN_GOAT_HOOK_WATCHDOG_MS', hk.watchdog_ms, 100, 30000)

  const wf_raw = section(raw, 'webfetch')
  const wf = getDefaultConfig('webfetch') as WebFetchConfig
  wf.allow = validatedStrList(wf_raw['allow'], wf.allow)
  wf.deny = validatedStrList(wf_raw['deny'], wf.deny)
  wf.max_file_count = validatedInt(wf_raw['max_file_count'], wf.max_file_count, 0, 10_000_000)
  wf.max_file_count = envInt('TOKEN_GOAT_WEB_CACHE_MAX_FILES', wf.max_file_count, 0, 10_000_000)
  wf.max_bytes = validatedInt(wf_raw['max_bytes'], wf.max_bytes, 0, 100 * 1024 * 1024 * 1024)
  wf.max_bytes = envInt('TOKEN_GOAT_WEB_CACHE_MAX_BYTES', wf.max_bytes, 0, 100 * 1024 * 1024 * 1024)
  wf.compress_bodies = validatedBool(wf_raw['compress_bodies'], wf.compress_bodies)
  wf.compress_min_bytes = validatedInt(wf_raw['compress_min_bytes'], wf.compress_min_bytes, 1024, 10 * 1024 * 1024)
  wf.compress_bodies = envBool('TOKEN_GOAT_WEB_COMPRESS', wf.compress_bodies)

  const wk_raw = section(raw, 'worker')
  const wk = getDefaultConfig('worker') as WorkerConfig
  wk.watchdog_enabled = validatedBool(wk_raw['watchdog_enabled'], wk.watchdog_enabled)
  wk.max_pool_workers = validatedInt(wk_raw['max_pool_workers'], wk.max_pool_workers, 1, 8)
  wk.blocked_roots = validatedStrList(wk_raw['blocked_roots'], wk.blocked_roots)
  wk.watchdog_enabled = envBool('TOKEN_GOAT_WORKER_WATCHDOG', wk.watchdog_enabled)
  wk.max_pool_workers = envInt('TOKEN_GOAT_WORKER_MAX_POOL', wk.max_pool_workers, 1, 8)

  const ix_raw = section(raw, 'indexing')
  const ix = getDefaultConfig('indexing') as IndexingConfig
  ix.large_file_symbol_only_kb = validatedInt(ix_raw['large_file_symbol_only_kb'], ix.large_file_symbol_only_kb, 1, 1048576)
  ix.large_file_skip_kb = validatedInt(ix_raw['large_file_skip_kb'], ix.large_file_skip_kb, 1, 1048576)
  // A symbol-only threshold larger than the skip threshold is nonsensical: files would be
  // skipped entirely before the symbol-only tier's condition could ever apply. Clamp
  // symbol_only_kb so it never exceeds skip_kb.
  ix.large_file_symbol_only_kb = Math.min(ix.large_file_symbol_only_kb, ix.large_file_skip_kb)
  ix.skip_dirs = validatedStrList(ix_raw['skip_dirs'], ix.skip_dirs)
  ix.embeddings_enabled = validatedBool(ix_raw['embeddings_enabled'], ix.embeddings_enabled)
  ix.embeddings_enabled = envBool('TOKEN_GOAT_EMBEDDINGS_ENABLED', ix.embeddings_enabled)

  const cpr_raw = section(raw, 'compression')
  const cpr = getDefaultConfig('compression') as CompressionConfig
  cpr.profile = validatedStr(cpr_raw['profile'], cpr.profile)
  cpr.profile = envStr('TOKEN_GOAT_COMPRESS_PROFILE', cpr.profile)

  const ctx_raw = section(raw, 'context')
  const ctx = getDefaultConfig('context') as ContextConfig
  ctx.model_window_tokens = validatedInt(ctx_raw['model_window_tokens'], ctx.model_window_tokens, 10_000, 10_000_000)
  ctx.model_window_tokens = envInt('TOKEN_GOAT_MODEL_WINDOW_TOKENS', ctx.model_window_tokens, 10_000, 10_000_000)

  const inj_raw = section(raw, 'injection')
  const inj = getDefaultConfig('injection') as InjectionConfig
  inj.enabled = validatedBool(inj_raw['enabled'], inj.enabled)
  inj.enabled = envBool('TOKEN_GOAT_INJECTION_ENABLED', inj.enabled)

  return {
    compact_assist: ca,
    bash_compress: bc,
    bash_diff: bd,
    bash_severity_log: sl,
    post_read_code_compress: cc,
    session_brief: sb,
    skill_preservation: sp,
    curator: cur,
    hint_budget: hb,
    image_shrink: is_cfg,
    screenshot: sc_cfg,
    repomap: rm,
    overflow_guard: og,
    stats: st,
    hints: hi,
    hooks: hk,
    webfetch: wf,
    worker: wk,
    indexing: ix,
    compression: cpr,
    context: ctx,
    injection: inj,
  }
}

/**
 * Maps each dotted config key that has an env-var override in {@link _buildConfig} to the
 * TOKEN_GOAT_* env var name(s) that can override it, highest-precedence first. Used by
 * `config set` (see cmdConfig in config_commands.ts) to warn when a value just written to
 * config.toml is shadowed by an active env var. Keep in sync with the env-override
 * assignments in _buildConfig.
 */
export const CONFIG_KEY_ENV_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  'compact_assist.enabled': ['TOKEN_GOAT_COMPACT_ASSIST', 'TOKENWISE_COMPACT_ASSIST'],
  'bash_compress.enabled': ['TOKEN_GOAT_BASH_COMPRESS'],
  'bash_compress.cache_min_bytes': ['TOKEN_GOAT_BASH_CACHE_MIN_BYTES'],
  'bash_compress.cache_max_file_count': ['TOKEN_GOAT_BASH_CACHE_MAX_FILES'],
  'bash_compress.cache_max_bytes': ['TOKEN_GOAT_BASH_CACHE_MAX_BYTES'],
  'bash_compress.cache_max_bytes_per_output': ['TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT'],
  'session_brief.enabled': ['TOKEN_GOAT_SESSION_BRIEF'],
  'skill_preservation.enabled': ['TOKEN_GOAT_SKILL_PRESERVATION'],
  'skill_preservation.compress_bodies': ['TOKEN_GOAT_SKILL_COMPRESS'],
  'skill_preservation.pre_skill_enabled': ['TOKEN_GOAT_PRE_SKILL'],
  'skill_preservation.orphan_sweep_enabled': ['TOKEN_GOAT_ORPHAN_SWEEP'],
  'image_shrink.max_image_pixels': ['TOKEN_GOAT_MAX_IMAGE_PIXELS'],
  'curator.enabled': ['TOKEN_GOAT_CURATOR'],
  'hint_budget.enabled': ['TOKEN_GOAT_HINT_BUDGET'],
  'repomap.compact_file_threshold': ['TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD'],
  'repomap.exclude_tests': ['TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS'],
  'overflow_guard.enabled': ['TOKEN_GOAT_OVERFLOW_GUARD'],
  'overflow_guard.max_tokens': ['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'],
  'hints.json_sidecar': ['TOKEN_GOAT_HINT_JSON_SIDECAR'],
  'hints.bash_dedup_min_bytes': ['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'],
  'hints.web_dedup_min_bytes': ['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'],
  'hints.grep_dedup_min_matches': ['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'],
  'hints.large_read_redirect_bytes': ['TOKEN_GOAT_LARGE_READ_BYTES'],
  'hints.baseline_budget_tokens': ['TOKEN_GOAT_BASELINE_BUDGET_TOKENS'],
  'hints.warn_unbalanced_shell_quoting': ['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING'],
  'hints.serve_diff_on_reread': ['TOKEN_GOAT_SERVE_DIFF_ON_REREAD'],
  'hints.log_large_file_hint_outcomes': ['TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES'],
  'hints.cross_session_read_dedup': ['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP'],
  'hints.cross_session_read_dedup_ttl_secs': ['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS'],
  'hints.mcp_dedup_ttl_secs': ['TOKEN_GOAT_MCP_DEDUP_TTL_SECS'],
  'hints.min_session_hint_savings_bytes': ['TOKEN_GOAT_SESSION_HINT_MIN_BYTES'],
  'hooks.watchdog_ms': ['TOKEN_GOAT_HOOK_WATCHDOG_MS'],
  'webfetch.max_file_count': ['TOKEN_GOAT_WEB_CACHE_MAX_FILES'],
  'webfetch.max_bytes': ['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'],
  'webfetch.compress_bodies': ['TOKEN_GOAT_WEB_COMPRESS'],
  'worker.watchdog_enabled': ['TOKEN_GOAT_WORKER_WATCHDOG'],
  'worker.max_pool_workers': ['TOKEN_GOAT_WORKER_MAX_POOL'],
  'compression.profile': ['TOKEN_GOAT_COMPRESS_PROFILE'],
  'context.model_window_tokens': ['TOKEN_GOAT_MODEL_WINDOW_TOKENS'],
  'injection.enabled': ['TOKEN_GOAT_INJECTION_ENABLED'],
  'indexing.embeddings_enabled': ['TOKEN_GOAT_EMBEDDINGS_ENABLED'],
}

export function saveConfig(config: Config): void {
  const ca = config.compact_assist
  const bc = config.bash_compress
  const sp = config.skill_preservation
  const is_cfg = config.image_shrink

  const data = {
    compact_assist: {
      enabled: ca.enabled,
      triggers: ca.triggers,
      min_events: ca.min_events,
      max_manifest_tokens: ca.max_manifest_tokens,
      auto_trigger_multiplier: ca.auto_trigger_multiplier,
      compact_skip_ttl_secs: ca.compact_skip_ttl_secs,
      noise_floor_tokens: ca.noise_floor_tokens,
      edited_dir_group_threshold: ca.edited_dir_group_threshold,
      max_section_lines: ca.max_section_lines,
      wide_session_threshold: ca.wide_session_threshold,
      orchestrator_commit_threshold: ca.orchestrator_commit_threshold,
      max_manifest_chars: ca.max_manifest_chars,
      harness: ca.harness,
    },
    bash_compress: {
      enabled: bc.enabled,
      disabled_filters: bc.disabled_filters,
      max_lines: bc.max_lines,
      max_bytes: bc.max_bytes,
      timeout_seconds: bc.timeout_seconds,
      cache_min_bytes: bc.cache_min_bytes,
      cache_max_file_count: bc.cache_max_file_count,
      cache_max_bytes: bc.cache_max_bytes,
      cache_max_bytes_per_output: bc.cache_max_bytes_per_output,
    },
    bash_diff: {
      max_hunks_per_file: config.bash_diff.max_hunks_per_file,
      hunk_density_cap: config.bash_diff.hunk_density_cap,
    },
    bash_severity_log: {
      context_lines: config.bash_severity_log.context_lines,
      score_threshold: config.bash_severity_log.score_threshold,
    },
    post_read_code_compress: {
      min_lines: config.post_read_code_compress.min_lines,
    },
    session_brief: {
      enabled: config.session_brief.enabled,
    },
    skill_preservation: {
      enabled: sp.enabled,
      max_cache_bytes: sp.max_cache_bytes,
      orphan_sweep_enabled: sp.orphan_sweep_enabled,
      orphan_age_secs: sp.orphan_age_secs,
      truncation_budget_tokens: sp.truncation_budget_tokens,
      compress_bodies: sp.compress_bodies,
      compress_min_bytes: sp.compress_min_bytes,
      inline_snippets: sp.inline_snippets,
      pre_skill_enabled: sp.pre_skill_enabled,
      first_load_compact: sp.first_load_compact,
      post_compact_full_loads: sp.post_compact_full_loads,
    },
    curator: {
      enabled: config.curator.enabled,
      min_samples: config.curator.min_samples,
      threshold_pct: config.curator.threshold_pct,
    },
    hint_budget: {
      enabled: config.hint_budget.enabled,
      max_per_session: config.hint_budget.max_per_session,
      max_structured_per_session: config.hint_budget.max_structured_per_session,
      max_index_only_per_session: config.hint_budget.max_index_only_per_session,
    },
    image_shrink: {
      enabled: is_cfg.enabled,
      jpeg_quality: is_cfg.jpeg_quality,
      max_image_pixels: is_cfg.max_image_pixels,
      screenshot_redirect: is_cfg.screenshot_redirect,
    },
    screenshot: {
      chrome_path: config.screenshot.chrome_path,
    },
    repomap: {
      compact_file_threshold: config.repomap.compact_file_threshold,
      exclude_tests: config.repomap.exclude_tests,
    },
    overflow_guard: {
      enabled: config.overflow_guard.enabled,
      max_tokens: config.overflow_guard.max_tokens,
    },
    stats: {
      record_zero_savings: config.stats.record_zero_savings,
    },
    hints: {
      suppress_after_ignored: config.hints.suppress_after_ignored,
      quiet_hours: config.hints.quiet_hours,
      json_sidecar: config.hints.json_sidecar,
      verbose_until_seen_count: config.hints.verbose_until_seen_count,
      min_file_lines_for_hint: config.hints.min_file_lines_for_hint,
      bash_dedup_min_bytes: config.hints.bash_dedup_min_bytes,
      web_dedup_min_bytes: config.hints.web_dedup_min_bytes,
      grep_dedup_min_matches: config.hints.grep_dedup_min_matches,
      serve_diff_on_reread: config.hints.serve_diff_on_reread,
      backoff_thresholds: config.hints.backoff_thresholds,
      git_hint_max_ms: config.hints.git_hint_max_ms,
      min_session_hint_savings_bytes: config.hints.min_session_hint_savings_bytes,
      pre_skill_advisory: config.hints.pre_skill_advisory,
      context_threshold_advisory: config.hints.context_threshold_advisory,
      diff_hint_min_tokens_saved: config.hints.diff_hint_min_tokens_saved,
      large_read_redirect_bytes: config.hints.large_read_redirect_bytes,
      reread_deny: config.hints.reread_deny,
      reread_deny_min_bytes: config.hints.reread_deny_min_bytes,
      baseline_budget_tokens: config.hints.baseline_budget_tokens,
      stable_doc_compacts: config.hints.stable_doc_compacts,
      truncated_read_min_lines: config.hints.truncated_read_min_lines,
      protect_recent_reads: config.hints.protect_recent_reads,
      prompt_triggers: config.hints.prompt_triggers,
      warn_unbalanced_shell_quoting: config.hints.warn_unbalanced_shell_quoting,
      log_large_file_hint_outcomes: config.hints.log_large_file_hint_outcomes,
      cross_session_read_dedup: config.hints.cross_session_read_dedup,
      cross_session_read_dedup_ttl_secs: config.hints.cross_session_read_dedup_ttl_secs,
      mcp_dedup_ttl_secs: config.hints.mcp_dedup_ttl_secs,
    },
    hooks: {
      watchdog_ms: config.hooks.watchdog_ms,
    },
    webfetch: {
      allow: config.webfetch.allow,
      deny: config.webfetch.deny,
      max_file_count: config.webfetch.max_file_count,
      max_bytes: config.webfetch.max_bytes,
      compress_bodies: config.webfetch.compress_bodies,
      compress_min_bytes: config.webfetch.compress_min_bytes,
    },
    worker: {
      watchdog_enabled: config.worker.watchdog_enabled,
      max_pool_workers: config.worker.max_pool_workers,
      blocked_roots: config.worker.blocked_roots,
    },
    indexing: {
      large_file_symbol_only_kb: config.indexing.large_file_symbol_only_kb,
      large_file_skip_kb: config.indexing.large_file_skip_kb,
      skip_dirs: config.indexing.skip_dirs,
      embeddings_enabled: config.indexing.embeddings_enabled,
    },
    compression: {
      profile: config.compression.profile,
    },
    context: {
      model_window_tokens: config.context.model_window_tokens,
    },
    injection: {
      enabled: config.injection.enabled,
    },
  }

  const toml = stringify(data)
  atomicWriteText(configPath(), toml)
  _cached = null
}
