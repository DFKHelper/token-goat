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
  lazy_skill_injection: boolean
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
  prefer_avif: boolean
  avif_quality: number
  jpeg_quality: number
  max_image_pixels: number
  orphan_sweep_enabled: boolean
  orphan_age_secs: number
  screenshot_redirect: boolean
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
  prompt_triggers: PromptTrigger[]
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
    lazy_skill_injection: true,
    max_manifest_chars: 1600,
    harness: 'auto',
  },
  bash_compress: {
    enabled: true,
    disabled_filters: [],
    max_lines: 1000,
    max_bytes: 64 * 1024,
    timeout_seconds: 600,
    cache_min_bytes: 0,
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
    prefer_avif: true,
    avif_quality: 60,
    jpeg_quality: 75,
    max_image_pixels: 16_000_000,
    orphan_sweep_enabled: true,
    orphan_age_secs: 604800,
    screenshot_redirect: true,
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
    large_read_redirect_bytes: 45_000,
    reread_deny: true,
    reread_deny_min_bytes: 2048,
    baseline_budget_tokens: 0,
    stable_doc_compacts: true,
    truncated_read_min_lines: 200,
    protect_recent_reads: 4,
    prompt_triggers: [],
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
  'TOKEN_GOAT_LAZY_SKILL_INJECTION',
  'TOKEN_GOAT_PREFER_AVIF',
  'TOKEN_GOAT_MAX_IMAGE_PIXELS',
  'TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD',
  'TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS',
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
  ca.lazy_skill_injection = validatedBool(ca_raw['lazy_skill_injection'], ca.lazy_skill_injection)
  ca.max_manifest_chars = validatedInt(ca_raw['max_manifest_chars'], ca.max_manifest_chars, 0, 16000)
  ca.harness = validatedStr(ca_raw['harness'], ca.harness)
  // env overrides
  ca.enabled = envBool('TOKEN_GOAT_COMPACT_ASSIST', envBool('TOKENWISE_COMPACT_ASSIST', ca.enabled))
  ca.lazy_skill_injection = envBool('TOKEN_GOAT_LAZY_SKILL_INJECTION', ca.lazy_skill_injection)

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
  bc.cache_min_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MIN_BYTES', bc.cache_min_bytes)
  bc.cache_max_file_count = envInt('TOKEN_GOAT_BASH_CACHE_MAX_FILES', bc.cache_max_file_count)
  bc.cache_max_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES', bc.cache_max_bytes)
  bc.cache_max_bytes_per_output = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT', bc.cache_max_bytes_per_output)

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
  is_cfg.prefer_avif = validatedBool(is_raw['prefer_avif'], is_cfg.prefer_avif)
  is_cfg.avif_quality = validatedInt(is_raw['avif_quality'], is_cfg.avif_quality, 1, 100)
  is_cfg.jpeg_quality = validatedInt(is_raw['jpeg_quality'], is_cfg.jpeg_quality, 1, 100)
  is_cfg.max_image_pixels = validatedInt(is_raw['max_image_pixels'], is_cfg.max_image_pixels, 0, 1_000_000_000)
  is_cfg.orphan_sweep_enabled = validatedBool(is_raw['orphan_sweep_enabled'], is_cfg.orphan_sweep_enabled)
  is_cfg.orphan_age_secs = validatedInt(is_raw['orphan_age_secs'], is_cfg.orphan_age_secs, 1, 2_592_000)
  is_cfg.screenshot_redirect = validatedBool(is_raw['screenshot_redirect'], is_cfg.screenshot_redirect)
  is_cfg.prefer_avif = envBool('TOKEN_GOAT_PREFER_AVIF', is_cfg.prefer_avif)
  is_cfg.max_image_pixels = envInt('TOKEN_GOAT_MAX_IMAGE_PIXELS', is_cfg.max_image_pixels)

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
  rm.compact_file_threshold = envInt('TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD', rm.compact_file_threshold)
  rm.exclude_tests = envBool('TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS', rm.exclude_tests)

  const og_raw = section(raw, 'overflow_guard')
  const og = getDefaultConfig('overflow_guard') as OverflowGuardConfig
  og.enabled = validatedBool(og_raw['enabled'], og.enabled)
  og.max_tokens = validatedInt(og_raw['max_tokens'], og.max_tokens, 1000, 1_000_000)

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
  hi.web_dedup_min_bytes = validatedInt(hi_raw['web_dedup_min_bytes'], hi.web_dedup_min_bytes, 0, 100_000)
  hi.grep_dedup_min_matches = validatedInt(hi_raw['grep_dedup_min_matches'], hi.grep_dedup_min_matches, 0, 100_000)
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
  hi.serve_diff_on_reread = envBool('TOKEN_GOAT_SERVE_DIFF_ON_REREAD', hi.serve_diff_on_reread)
  hi.min_session_hint_savings_bytes = envInt('TOKEN_GOAT_SESSION_HINT_MIN_BYTES', hi.min_session_hint_savings_bytes)
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
  hk.watchdog_ms = envInt('TOKEN_GOAT_HOOK_WATCHDOG_MS', hk.watchdog_ms)

  const wf_raw = section(raw, 'webfetch')
  const wf = getDefaultConfig('webfetch') as WebFetchConfig
  wf.allow = validatedStrList(wf_raw['allow'], wf.allow)
  wf.deny = validatedStrList(wf_raw['deny'], wf.deny)
  wf.max_file_count = validatedInt(wf_raw['max_file_count'], wf.max_file_count, 0, 10_000_000)
  wf.max_bytes = validatedInt(wf_raw['max_bytes'], wf.max_bytes, 0, 100 * 1024 * 1024 * 1024)
  wf.compress_bodies = validatedBool(wf_raw['compress_bodies'], wf.compress_bodies)
  wf.compress_min_bytes = validatedInt(wf_raw['compress_min_bytes'], wf.compress_min_bytes, 1024, 10 * 1024 * 1024)
  wf.compress_bodies = envBool('TOKEN_GOAT_WEB_COMPRESS', wf.compress_bodies)

  const wk_raw = section(raw, 'worker')
  const wk = getDefaultConfig('worker') as WorkerConfig
  wk.watchdog_enabled = validatedBool(wk_raw['watchdog_enabled'], wk.watchdog_enabled)
  wk.max_pool_workers = validatedInt(wk_raw['max_pool_workers'], wk.max_pool_workers, 1, 8)
  wk.blocked_roots = validatedStrList(wk_raw['blocked_roots'], wk.blocked_roots)
  wk.watchdog_enabled = envBool('TOKEN_GOAT_WORKER_WATCHDOG', wk.watchdog_enabled)
  wk.max_pool_workers = envInt('TOKEN_GOAT_WORKER_MAX_POOL', wk.max_pool_workers)

  const ix_raw = section(raw, 'indexing')
  const ix = getDefaultConfig('indexing') as IndexingConfig
  ix.large_file_symbol_only_kb = validatedInt(ix_raw['large_file_symbol_only_kb'], ix.large_file_symbol_only_kb, 1, 1048576)
  ix.large_file_skip_kb = validatedInt(ix_raw['large_file_skip_kb'], ix.large_file_skip_kb, 1, 1048576)
  ix.skip_dirs = validatedStrList(ix_raw['skip_dirs'], ix.skip_dirs)

  const cpr_raw = section(raw, 'compression')
  const cpr = getDefaultConfig('compression') as CompressionConfig
  cpr.profile = validatedStr(cpr_raw['profile'], cpr.profile)
  cpr.profile = envStr('TOKEN_GOAT_COMPRESS_PROFILE', cpr.profile)

  const ctx_raw = section(raw, 'context')
  const ctx = getDefaultConfig('context') as ContextConfig
  ctx.model_window_tokens = validatedInt(ctx_raw['model_window_tokens'], ctx.model_window_tokens, 10_000, 10_000_000)
  ctx.model_window_tokens = envInt('TOKEN_GOAT_MODEL_WINDOW_TOKENS', ctx.model_window_tokens)

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
      lazy_skill_injection: ca.lazy_skill_injection,
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
      prefer_avif: is_cfg.prefer_avif,
      avif_quality: is_cfg.avif_quality,
      jpeg_quality: is_cfg.jpeg_quality,
      max_image_pixels: is_cfg.max_image_pixels,
      orphan_sweep_enabled: is_cfg.orphan_sweep_enabled,
      orphan_age_secs: is_cfg.orphan_age_secs,
      screenshot_redirect: is_cfg.screenshot_redirect,
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
