import * as fs from 'node:fs'

import { parse, stringify } from 'smol-toml'

import { KNOWN_HARNESS_NAMES } from './bridges/registry.js'
import { configPath, projectConfigPath } from './constants.js'
import { envBool, envInt, envStr } from './env.js'
import { shortFingerprint } from './fingerprint.js'
import { findProject } from './project.js'
import { atomicWriteText, extractErrorMessage } from './util.js'

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

export interface ImageShrinkConfig {
  enabled: boolean
  jpeg_quality: number
  max_image_pixels: number
  screenshot_redirect: boolean
  ocr_enabled: boolean
  ocr_min_confidence: number
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
  quiet_hours: string
  json_sidecar: boolean
  min_file_lines_for_hint: number
  bash_dedup_min_bytes: number
  web_dedup_min_bytes: number
  grep_dedup_min_matches: number
  glob_dedup_min_matches: number
  write_rewrite_min_lines: number
  write_rewrite_unchanged_pct: number
  serve_diff_on_reread: boolean
  // Ascending suppressed-occasion counts at which hint_stats.ts's applyHintTracking lets a
  // suppressed hint category through as a genuine "probe" emission, so fresh acted-on signal
  // can lift it back above hint_stats.suppress_threshold_pct -- see that module's "Probe
  // recovery" doc-comment section. `[]` means no probes: suppression is permanent until a
  // manual `token-goat hint-stats --reset`.
  backoff_thresholds: number[]
  git_hint_max_ms: number
  min_session_hint_savings_bytes: number
  pre_skill_advisory: boolean
  context_threshold_advisory: boolean
  diff_hint_min_tokens_saved: number
  large_read_redirect_bytes: number
  reread_deny: boolean
  reread_deny_min_bytes: number
  stable_doc_compacts: boolean
  truncated_read_min_lines: number
  protect_recent_reads: number
  warn_unbalanced_shell_quoting: boolean
  prompt_triggers: PromptTrigger[]
  log_large_file_hint_outcomes: boolean
  cross_session_read_dedup: boolean
  cross_session_read_dedup_ttl_secs: number
  mcp_dedup_ttl_secs: number
  // Whether the SessionStart hook (hooks_session_start.ts) injects a short command-routing
  // reminder as additionalContext at session start/resume/compact-restart. The one-time static
  // CLAUDE.md block install.ts writes only reaches the model once per install, with zero
  // reinforcement across a long session -- this re-injects a short reminder every time a
  // SessionStart fires. Defaults true; set false to silence it entirely.
  session_start_reminder: boolean
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
  blocked_roots: string[]
  max_pool_workers: number
}

export interface IndexingConfig {
  large_file_symbol_only_kb: number
  large_file_skip_kb: number
  skip_dirs: string[]
  // Basenames (not paths) excluded from the syntactic parse regardless of directory depth --
  // e.g. generated coverage reports. Defaults to the previously-hardcoded coverage.json /
  // coverage-final.json so existing behavior is unchanged; users can add their own generated
  // artifacts (lcov.json, stats.json, ...) or override this list to re-include a legitimately
  // named file. See isParseSkipEligible in parser.ts.
  skip_files: string[]
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

/**
 * Config for `token-goat hint-stats` (hint_stats.ts): the suppression gate that stops emitting
 * a hint category for the rest of a session once its measured efficacy (acted-on / emitted)
 * falls below `suppress_threshold_pct`, but only once at least `min_sample_size` emissions have
 * been observed -- guards against suppressing a category on a single unlucky (or un-actable,
 * e.g. no correlator extracted) data point.
 */
export interface HintStatsConfig {
  suppress_threshold_pct: number
  min_sample_size: number
}

export interface Config {
  compact_assist: CompactAssistConfig
  bash_compress: BashCompressConfig
  bash_diff: BashDiffConfig
  bash_severity_log: SeverityLogConfig
  post_read_code_compress: CodeCompressConfig
  session_brief: SessionBriefConfig
  skill_preservation: SkillPreservationConfig
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
  hint_stats: HintStatsConfig
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
  image_shrink: {
    enabled: true,
    jpeg_quality: 75,
    max_image_pixels: 16_000_000,
    screenshot_redirect: true,
    ocr_enabled: true,
    // Confidence is Tesseract's own 0-100 mean-word-confidence score. 65 is a deliberately
    // conservative floor: a real screenshot of terminal/code/prose text routinely scores
    // 85+, while a photo with an incidental sign or logo in frame scores much lower and
    // noisier -- padding the threshold below the terminal/code norm still comfortably
    // excludes photographic false positives without needing a second heuristic.
    ocr_min_confidence: 65,
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
    quiet_hours: '',
    json_sidecar: false,
    min_file_lines_for_hint: 0,
    bash_dedup_min_bytes: 200,
    web_dedup_min_bytes: 200,
    grep_dedup_min_matches: 5,
    glob_dedup_min_matches: 5,
    // Existing on-disk file must have at least this many lines before a Write rewrite is even
    // considered -- rewriting a small file whole is fine, so hooks_write.ts's detector skips
    // comparison entirely below this floor rather than firing on trivial files.
    write_rewrite_min_lines: 40,
    // Minimum percentage of the existing file's lines that must survive unchanged (by LCS) in
    // the incoming Write content for hooks_write.ts to advise Edit instead. High by design: this
    // is only meant to catch the "mostly untouched, a few lines changed" case, not a genuine
    // rewrite that happens to share some boilerplate.
    write_rewrite_unchanged_pct: 75,
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
    // Matches hooks_read.ts's previously-hardcoded REREAD_DENY_BYTES (50 * 1024) so wiring this
    // key up as the real gate for that logic does not silently change default behavior for
    // existing users -- see the reread_deny/reread_deny_min_bytes fix's commit message.
    reread_deny_min_bytes: 51_200,
    stable_doc_compacts: true,
    truncated_read_min_lines: 200,
    protect_recent_reads: 4,
    warn_unbalanced_shell_quoting: true,
    prompt_triggers: [],
    log_large_file_hint_outcomes: false,
    cross_session_read_dedup: false,
    cross_session_read_dedup_ttl_secs: 2700,
    mcp_dedup_ttl_secs: 45,
    session_start_reminder: true,
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
    blocked_roots: [],
    max_pool_workers: 4,
  },
  indexing: {
    large_file_symbol_only_kb: 500,
    large_file_skip_kb: 2048,
    skip_dirs: [],
    skip_files: ['coverage.json', 'coverage-final.json'],
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
  hint_stats: {
    suppress_threshold_pct: 15,
    min_sample_size: 5,
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
    hint_stats: getDefaultConfig('hint_stats') as HintStatsConfig,
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

/**
 * Like {@link validatedInt}, but a persisted value exactly equal to `sentinel` is treated as
 * the stale pre-rewire default (see the three "Legacy-sentinel guard" call sites below) and
 * falls through to `def` instead of being trusted, since a `config set` on any unrelated key
 * used to resave every field including then-inert defaults that a later change wired up as a
 * real gate. Any other persisted value, including one that happens to equal a *current*
 * default, is validated and respected as-is.
 */
function validatedIntWithLegacySentinel(raw: unknown, def: number, sentinel: number, min: number, max: number): number {
  return raw === sentinel ? def : validatedInt(raw, def, min, max)
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = raw[key]
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {}
}

// Numeric field bounds for targeted validation (config set on numbers). Extracted from _buildConfig.
const NUMERIC_FIELD_BOUNDS: Record<string, {min: number, max: number, clampTo?: string}> = {
  'compact_assist.min_events': {min: 0, max: 1000},
  'compact_assist.max_manifest_tokens': {min: 50, max: 10000},
  'compact_assist.auto_trigger_multiplier': {min: 1.0, max: 10.0},
  'compact_assist.compact_skip_ttl_secs': {min: 1.0, max: 3600.0},
  'compact_assist.noise_floor_tokens': {min: 0, max: 10000},
  'compact_assist.edited_dir_group_threshold': {min: 0, max: 100},
  'compact_assist.max_section_lines': {min: 0, max: 10000},
  'compact_assist.wide_session_threshold': {min: 1, max: 10000},
  'compact_assist.orchestrator_commit_threshold': {min: 1, max: 10000},
  'compact_assist.max_manifest_chars': {min: 0, max: 16000},
  'bash_compress.max_lines': {min: 50, max: 100_000},
  'bash_compress.max_bytes': {min: 1024, max: 16 * 1024 * 1024},
  'bash_compress.timeout_seconds': {min: 5, max: 7200},
  'bash_compress.cache_min_bytes': {min: 0, max: 100 * 1024 * 1024},
  'bash_compress.cache_max_file_count': {min: 1, max: 1_000_000},
  'bash_compress.cache_max_bytes': {min: 1024, max: 4 * 1024 * 1024 * 1024},
  'bash_compress.cache_max_bytes_per_output': {min: 1024, max: 4 * 1024 * 1024 * 1024, clampTo: 'bash_compress.cache_max_bytes'},
  'bash_diff.max_hunks_per_file': {min: 1, max: 10000},
  'bash_severity_log.context_lines': {min: 0, max: 100},
  'bash_severity_log.score_threshold': {min: 0.0, max: 1.0},
  'post_read_code_compress.min_lines': {min: 0, max: 1_000_000},
  'skill_preservation.max_cache_bytes': {min: 64 * 1024, max: 512 * 1024 * 1024},
  'skill_preservation.orphan_age_secs': {min: 1, max: 2_592_000},
  'skill_preservation.truncation_budget_tokens': {min: 0, max: 8000},
  'skill_preservation.compress_min_bytes': {min: 1024, max: 10 * 1024 * 1024},
  'image_shrink.jpeg_quality': {min: 1, max: 100},
  'image_shrink.max_image_pixels': {min: 0, max: 1_000_000_000},
  'image_shrink.ocr_min_confidence': {min: 0, max: 100},
  'repomap.compact_file_threshold': {min: 0, max: 100_000},
  'overflow_guard.max_tokens': {min: 1000, max: 1_000_000},
  'hints.min_file_lines_for_hint': {min: 0, max: 1_000_000},
  'hints.bash_dedup_min_bytes': {min: 0, max: 100_000},
  'hints.web_dedup_min_bytes': {min: 0, max: 100_000},
  'hints.grep_dedup_min_matches': {min: 0, max: 100_000},
  'hints.glob_dedup_min_matches': {min: 0, max: 100_000},
  'hints.write_rewrite_min_lines': {min: 0, max: 1_000_000},
  'hints.write_rewrite_unchanged_pct': {min: 0, max: 100},
  'hints.git_hint_max_ms': {min: 0, max: 10000},
  'hints.min_session_hint_savings_bytes': {min: 0, max: 1_000_000},
  'hints.diff_hint_min_tokens_saved': {min: 0, max: 100_000},
  'hints.large_read_redirect_bytes': {min: 0, max: 100_000_000},
  'hints.reread_deny_min_bytes': {min: 0, max: 100_000_000},
  'hints.truncated_read_min_lines': {min: 0, max: 1_000_000},
  'hints.protect_recent_reads': {min: 0, max: 100},
  'hints.cross_session_read_dedup_ttl_secs': {min: 1, max: 86400},
  'hints.mcp_dedup_ttl_secs': {min: 1, max: 3600},
  'hooks.watchdog_ms': {min: 100, max: 30000},
  'webfetch.max_file_count': {min: 0, max: 10_000_000},
  'webfetch.max_bytes': {min: 0, max: 100 * 1024 * 1024 * 1024},
  'webfetch.compress_min_bytes': {min: 1024, max: 10 * 1024 * 1024},
  'worker.max_pool_workers': {min: 1, max: 8},
  'indexing.large_file_symbol_only_kb': {min: 1, max: 1048576, clampTo: 'indexing.large_file_skip_kb'},
  'indexing.large_file_skip_kb': {min: 1, max: 1048576},
  'context.model_window_tokens': {min: 10_000, max: 10_000_000},
  'hint_stats.suppress_threshold_pct': {min: 0, max: 100},
  'hint_stats.min_sample_size': {min: 1, max: 10000},
}

/** Look up a field's [min, max] from NUMERIC_FIELD_BOUNDS for spreading into validatedInt/
 *  validatedFloat/envInt -- _buildConfig's single source of truth for bounds, instead of
 *  restating each field's min/max a second time at its build-time validation call site. */
function boundsOf(key: string): [number, number] {
  const b = NUMERIC_FIELD_BOUNDS[key]
  if (!b) throw new Error(`token-goat: no NUMERIC_FIELD_BOUNDS entry for '${key}'`)
  return [b.min, b.max]
}

/**
 * Validate a single numeric config field against its documented bounds and cross-field constraints.
 * Used by config set to reject out-of-range values without rebuilding the entire config tree.
 * Returns the clamped value if validation passes, or undefined if the field is not numeric/known.
 */
function walkGetNumeric(obj: Record<string, unknown>, parts: string[]): number | undefined {
  let cur: unknown = obj
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
    if (cur === undefined) return undefined
  }
  return typeof cur === 'number' ? cur : undefined
}

export function validateNumericField(fieldKey: string, value: number, cfg: Record<string, unknown>): number | undefined {
  const bounds = NUMERIC_FIELD_BOUNDS[fieldKey]
  if (!bounds) return undefined

  // Apply simple min/max clamping (matching validatedInt/validatedFloat logic)
  let clamped = Math.max(bounds.min, Math.min(bounds.max, value))

  // Apply cross-field constraints if present
  if (bounds.clampTo) {
    const clampToValue = walkGetNumeric(cfg, bounds.clampTo.split('.'))
    if (typeof clampToValue === 'number') {
      clamped = Math.min(clamped, clampToValue)
    }
  }

  return clamped
}

// String-valued config fields whose value must come from a fixed set. Extracted from
// _buildConfig / dispatch.ts's PROFILE_CAPS and bridges/registry.ts's harness names, so a typo
// (e.g. `agressive` instead of `aggressive`) is rejected by `config set` instead of silently
// falling back to a default at runtime with no signal to the user.
const ENUM_FIELD_VALUES: Record<string, string[]> = {
  'compression.profile': ['auto', 'aggressive', 'balanced', 'minimal'],
  'compact_assist.harness': ['auto', ...KNOWN_HARNESS_NAMES],
}

/**
 * Validate a single enum-valued string config field against its fixed set of allowed values.
 * Used by config set to reject unrecognized values without rebuilding the entire config tree.
 * Returns undefined if the field isn't enum-constrained (any string is fine) or the value is
 * valid; returns the allowed-value list if the value is invalid.
 */
export function validateEnumField(fieldKey: string, value: string): string[] | undefined {
  const allowed = ENUM_FIELD_VALUES[fieldKey]
  if (!allowed) return undefined
  return allowed.includes(value) ? undefined : allowed
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
  'TOKEN_GOAT_WRITE_REWRITE_MIN_LINES',
  'TOKEN_GOAT_WRITE_REWRITE_UNCHANGED_PCT',
]

// Every env var actually consulted by _buildConfig's envInt/envBool/envStr calls is registered
// in CONFIG_KEY_ENV_OVERRIDES (below) as the per-field canonical source of truth. Fold those in
// here rather than relying solely on the hand-maintained ENV_KEYS list above: a var added only
// to CONFIG_KEY_ENV_OVERRIDES (as happened for TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES and
// TOKEN_GOAT_OCR_ENABLED, both consumed in _buildConfig but omitted from ENV_KEYS) would
// otherwise silently drop out of the fingerprint, letting loadConfig()'s cache serve a stale
// config across a change to that var with no cache-invalidation signal at all.
function allEnvKeys(): string[] {
  return [...new Set([...ENV_KEYS, ...Object.values(CONFIG_KEY_ENV_OVERRIDES).flat()])]
}

export function configEnvFingerprint(): string {
  const snap: Record<string, string | undefined> = {}
  for (const k of allEnvKeys()) {
    snap[k] = process.env[k]
  }
  return JSON.stringify(snap)
}

interface CacheEntry {
  config: Config
  contentFp: string
  envFp: string
  projectRoot: string
  projectContentFp: string
}

let _cached: CacheEntry | null = null

// Recursively freezes a config tree before it enters the cache. loadConfig() intentionally
// returns the SAME cached object reference on every hit within one mtime/env fingerprint
// window (see the "second call with unchanged file returns same object reference" test) --
// without this, a caller that does `loadConfig().hints.foo = x` instead of reading it would
// silently corrupt that shared singleton for every other caller until the next cache
// invalidation. Object.freeze() throws on such a write in strict mode (ESM is always strict)
// instead of corrupting shared state, while leaving the returned reference itself unchanged.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v)
    }
  }
  return value
}

// Set by loadConfig()/loadPersistedConfig() whenever the on-disk config.toml exists but fails
// to parse (as opposed to being simply absent, which is not an error). Both loaders otherwise
// treat a parse failure identically to a missing file — silently falling back to defaults with
// no signal — so callers that need to warn the user (the CLI entry point, `config set`) check
// this after loading instead of duplicating TOML-read/error-classification logic themselves.
let _lastConfigParseError: string | null = null

/**
 * The error message from the most recent config.toml parse failure, or `null` if the most
 * recent load either succeeded or found no file at all. See {@link _lastConfigParseError}.
 */
export function getLastConfigParseError(): string | null {
  return _lastConfigParseError
}

// Mirrors _lastConfigParseError, but for the per-project .token-goat.toml override read by
// loadConfig(). Set on every loadConfig() call; null when the file is absent or parsed cleanly.
let _lastProjectConfigParseError: string | null = null

/**
 * The error message from the most recent `.token-goat.toml` parse/read failure, or `null` if
 * the most recent {@link loadConfig} call found no per-project override file, or found one that
 * parsed cleanly. Unlike {@link getLastConfigParseError}, a non-null result here never blocks
 * config loading — the per-project layer fails open and loadConfig() always returns a valid
 * global-only config in that case. Intended for a CLI entry point to optionally surface a
 * warning, the same way {@link getLastConfigParseError} is surfaced for the global config.toml.
 */
export function getLastProjectConfigParseError(): string | null {
  return _lastProjectConfigParseError
}

/** Dotted `section.key` names set at the top two levels of a raw TOML tree (section-only entries report just the section name). */
function flattenRawKeys(raw: Record<string, unknown>): string[] {
  const keys: string[] = []
  for (const [sectionName, val] of Object.entries(raw)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const sub of Object.keys(val as Record<string, unknown>)) {
        keys.push(`${sectionName}.${sub}`)
      }
    } else {
      keys.push(sectionName)
    }
  }
  return keys
}

export interface ProjectConfigInfo {
  path: string
  keys: string[]
  parseError: string | null
}

/**
 * Report what (if anything) a project's `.token-goat.toml` override file contributes, for
 * `token-goat config list`'s "what's actually in effect and why" display (see cmdConfig in
 * config_commands.ts). Returns `null` if no such file exists at the resolved project root.
 * A malformed or unreadable file returns an empty `keys` list with `parseError` set — matching
 * loadConfig()'s fail-open handling of the same file — so the caller can still show the
 * effective (global-only) config alongside a note that the override itself is broken.
 */
export function getProjectConfigInfo(projectRoot?: string): ProjectConfigInfo | null {
  const root = projectRoot ?? resolveConfigProjectRoot()
  const p = projectConfigPath(root)
  if (!fs.existsSync(p)) return null
  const { raw, parseError } = readConfigToml(p)
  return { path: p, keys: parseError === null ? flattenRawKeys(raw) : [], parseError }
}

/**
 * Read and parse `p` as TOML, distinguishing "file does not exist" (not an error — returns
 * `{}` with no message) from a genuine parse/read failure (returns `{}` with the error
 * message). Shared by {@link loadConfig} and {@link loadPersistedConfig} so both loaders
 * classify failures the same way.
 */
function readConfigToml(p: string): { raw: Record<string, unknown>; parseError: string | null } {
  try {
    const text = fs.readFileSync(p, 'utf8')
    return { raw: parse(text) as Record<string, unknown>, parseError: null }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { raw: {}, parseError: null }
    return { raw: {}, parseError: extractErrorMessage(e) }
  }
}

/**
 * Read `p` as UTF-8 text for cache-fingerprinting purposes, distinguishing "file does not
 * exist" (returns `null` text, no error) from a genuine read failure (returns `null` text with
 * an error message) exactly like {@link readConfigToml} does for parsing — but deferring the
 * TOML parse itself so {@link loadConfig} can compute a content fingerprint and check the cache
 * before paying for a re-parse. Shared by the global config.toml and per-project
 * `.token-goat.toml` reads inside {@link loadConfig}.
 */
function readConfigText(p: string): { text: string | null; readError: string | null } {
  try {
    return { text: fs.readFileSync(p, 'utf8'), readError: null }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { text: null, readError: null }
    return { text: null, readError: extractErrorMessage(e) }
  }
}

/**
 * Layer a per-project `.token-goat.toml` override on top of the global config.toml's raw TOML
 * data, one field at a time within each section — not a whole-section replace, so a project
 * file that sets only `hints.large_read_redirect_bytes` still inherits every other `hints.*`
 * key from the global file instead of losing them to a blank section. Only 2 levels deep
 * (section -> field), matching the {@link Config} schema's own shape. Unknown sections/keys in
 * `override` pass through here untouched and are silently dropped later by `_buildConfig`'s
 * {@link section} helper, exactly like an unknown key in the global config.toml already is.
 */
function mergeRawConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, overrideVal] of Object.entries(override)) {
    if (overrideVal !== null && typeof overrideVal === 'object' && !Array.isArray(overrideVal)) {
      const baseVal = base[key]
      const baseSection = baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)
        ? (baseVal as Record<string, unknown>)
        : {}
      merged[key] = { ...baseSection, ...(overrideVal as Record<string, unknown>) }
    } else {
      // A non-object value at a section-level key (e.g. a project file that sets `hints = 5`)
      // is not a valid section shape — section() already treats any non-object raw value as {}
      // at build time, so pass it through as-is and let that existing guard handle it exactly
      // like a malformed value in the global config.toml.
      merged[key] = overrideVal
    }
  }
  return merged
}

let _projectRootCache: { cwd: string; root: string } | null = null

/**
 * Resolve the project root to check for a per-project `.token-goat.toml` override, for callers
 * of {@link loadConfig} that don't pass one explicitly — almost every hook and CLI command.
 * Deliberately uses the cheap, subprocess-free `findProject()` marker walk rather than
 * `resolveProjectRoot()`'s `git rev-parse` step: loadConfig() is called from the hot hook path
 * (every Read/Grep/Bash/... hook invocation), where hooks already avoid spawning git for this
 * exact reason (see hooks_read.ts's own findProject() usage). Memoized per `process.cwd()`,
 * matching constants.ts's DATA_DIR memoization rationale — cwd does not change within a hook or
 * CLI process's lifetime.
 */
export function resolveConfigProjectRoot(): string {
  const cwd = process.cwd()
  if (_projectRootCache !== null && _projectRootCache.cwd === cwd) return _projectRootCache.root
  const project = findProject(cwd)
  const root = project !== null ? project.root : cwd
  _projectRootCache = { cwd, root }
  return root
}

/**
 * Whether the user has explicitly set `compact_assist.auto_trigger_multiplier` in their raw
 * config.toml (or per-project .token-goat.toml), as opposed to it merely holding the
 * (indistinguishable) default value. loadConfig()'s merged Config object can't tell these two
 * cases apart, so this reads and parses the raw file text directly to check for the key's real
 * presence. Checks both the global config.toml and any per-project override (mirroring
 * loadConfig()'s own two-file layering), since a project that sets the field solely via
 * .token-goat.toml would otherwise be misread as still holding the default.
 */
export function isAutoTriggerMultiplierExplicit(): boolean {
  const setsMultiplier = (text: string): boolean => {
    const raw = parse(text) as Record<string, unknown>
    const ca_raw = raw['compact_assist']
    if (ca_raw === null || typeof ca_raw !== 'object' || Array.isArray(ca_raw)) {
      return false
    }
    return (ca_raw as Record<string, unknown>)['auto_trigger_multiplier'] !== undefined
  }
  try {
    if (setsMultiplier(fs.readFileSync(configPath(), 'utf8'))) return true
  } catch {
    // no readable global config.toml -- fall through to the per-project check
  }
  try {
    return setsMultiplier(fs.readFileSync(projectConfigPath(resolveConfigProjectRoot()), 'utf8'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

export function loadConfig(projectRoot?: string): Config {
  const p = configPath()
  const root = projectRoot ?? resolveConfigProjectRoot()
  const projPath = projectConfigPath(root)

  // Content hash, not mtime: a `config set` immediately followed by another `config set`
  // (or a concurrent writer) can land two different writes within the same mtime tick on
  // some filesystems, which made the old mtime-only cache key silently keep serving the
  // first write's config after the second landed. Reading the whole file is cheap (config.toml
  // is always tiny) and this also skips the actual cost we care about avoiding on a hit --
  // re-parsing the TOML.
  const { text, readError } = readConfigText(p)
  const contentFp = text !== null ? shortFingerprint(text) : ''

  // Same content-hash-not-mtime reasoning applies to the per-project override file, plus the
  // resolved project root itself is part of the cache key -- an explicit projectRoot argument
  // (or a cwd change between calls) can change which .token-goat.toml is in play even when
  // neither the global file nor env vars changed.
  const { text: projText, readError: projReadError } = readConfigText(projPath)
  const projectContentFp = projText !== null ? shortFingerprint(projText) : ''

  const envFp = configEnvFingerprint()
  if (
    _cached !== null &&
    _cached.contentFp === contentFp &&
    _cached.envFp === envFp &&
    _cached.projectRoot === root &&
    _cached.projectContentFp === projectContentFp
  ) {
    return _cached.config
  }

  let raw: Record<string, unknown> = {}
  if (text !== null) {
    try {
      raw = parse(text) as Record<string, unknown>
      _lastConfigParseError = null
    } catch (e) {
      _lastConfigParseError = extractErrorMessage(e)
    }
  } else {
    _lastConfigParseError = readError
  }

  // A malformed or unreadable .token-goat.toml fails open, exactly like a malformed global
  // config.toml does above: the parse/read error is recorded for a CLI entry point to
  // optionally surface (see getLastProjectConfigParseError()'s doc comment), but loadConfig()
  // itself never throws and always falls through to the global-only config on failure.
  let projectRaw: Record<string, unknown> = {}
  if (projText !== null) {
    try {
      projectRaw = parse(projText) as Record<string, unknown>
      _lastProjectConfigParseError = null
    } catch (e) {
      _lastProjectConfigParseError = extractErrorMessage(e)
    }
  } else {
    _lastProjectConfigParseError = projReadError
  }

  const cfg = deepFreeze(_buildConfig(raw, projectRaw))

  _cached = { config: cfg, contentFp, envFp, projectRoot: root, projectContentFp }
  return cfg
}

export function invalidateConfigCache(): void {
  _cached = null
}

/**
 * Run `fn` with every config-affecting env var (the {@link allEnvKeys} registry, not just the
 * hand-maintained {@link ENV_KEYS} list) temporarily cleared, then restore the original values.
 * Safe because `_buildConfig` is fully synchronous — no other code can observe the env vars
 * while they are unset. Using only ENV_KEYS here previously let a var missing from that list
 * (e.g. TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES, TOKEN_GOAT_OCR_ENABLED) survive the clear and leak
 * into buildPersistedConfig()'s output, defeating this function's whole purpose for that var:
 * a transient env override would get permanently written to config.toml by `config set` on any
 * unrelated key instead of staying scoped to the current invocation.
 */
function withoutConfigEnv<T>(fn: () => T): T {
  const keys = allEnvKeys()
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    return fn()
  } finally {
    for (const k of keys) {
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
  const { raw, parseError } = readConfigToml(p)
  _lastConfigParseError = parseError
  return buildPersistedConfig(raw)
}

function _buildConfig(raw: Record<string, unknown>, projectRaw: Record<string, unknown> = {}): Config {
  // Layer the per-project override (if any) on top of the global raw data before any field is
  // read below, so every validatedInt/validatedBool/bounds-checked field, the legacy-sentinel
  // guards, and the cross-field clamps all see one already-merged raw tree — the exact same
  // validation path the global-only config always went through, with no divergent logic for
  // the project layer.
  if (Object.keys(projectRaw).length > 0) {
    raw = mergeRawConfig(raw, projectRaw)
  }

  const ca_raw = section(raw, 'compact_assist')
  const ca = getDefaultConfig('compact_assist') as CompactAssistConfig
  ca.enabled = validatedBool(ca_raw['enabled'], ca.enabled)
  ca.triggers = validatedStrList(ca_raw['triggers'], ca.triggers)
  ca.min_events = validatedInt(ca_raw['min_events'], ca.min_events, ...boundsOf('compact_assist.min_events'))
  ca.max_manifest_tokens = validatedInt(ca_raw['max_manifest_tokens'], ca.max_manifest_tokens, ...boundsOf('compact_assist.max_manifest_tokens'))
  ca.auto_trigger_multiplier = validatedFloat(ca_raw['auto_trigger_multiplier'], ca.auto_trigger_multiplier, ...boundsOf('compact_assist.auto_trigger_multiplier'))
  ca.compact_skip_ttl_secs = validatedFloat(ca_raw['compact_skip_ttl_secs'], ca.compact_skip_ttl_secs, ...boundsOf('compact_assist.compact_skip_ttl_secs'))
  ca.noise_floor_tokens = validatedInt(ca_raw['noise_floor_tokens'], ca.noise_floor_tokens, ...boundsOf('compact_assist.noise_floor_tokens'))
  ca.edited_dir_group_threshold = validatedInt(ca_raw['edited_dir_group_threshold'], ca.edited_dir_group_threshold, ...boundsOf('compact_assist.edited_dir_group_threshold'))
  ca.max_section_lines = validatedInt(ca_raw['max_section_lines'], ca.max_section_lines, ...boundsOf('compact_assist.max_section_lines'))
  ca.wide_session_threshold = validatedInt(ca_raw['wide_session_threshold'], ca.wide_session_threshold, ...boundsOf('compact_assist.wide_session_threshold'))
  ca.orchestrator_commit_threshold = validatedInt(ca_raw['orchestrator_commit_threshold'], ca.orchestrator_commit_threshold, ...boundsOf('compact_assist.orchestrator_commit_threshold'))
  ca.max_manifest_chars = validatedInt(ca_raw['max_manifest_chars'], ca.max_manifest_chars, ...boundsOf('compact_assist.max_manifest_chars'))
  ca.harness = validatedStr(ca_raw['harness'], ca.harness)
  // env overrides
  ca.enabled = envBool('TOKEN_GOAT_COMPACT_ASSIST', envBool('TOKENWISE_COMPACT_ASSIST', ca.enabled))

  const bc_raw = section(raw, 'bash_compress')
  const bc = getDefaultConfig('bash_compress') as BashCompressConfig
  bc.enabled = validatedBool(bc_raw['enabled'], bc.enabled)
  bc.disabled_filters = validatedStrList(bc_raw['disabled_filters'], bc.disabled_filters)
  bc.max_lines = validatedInt(bc_raw['max_lines'], bc.max_lines, ...boundsOf('bash_compress.max_lines'))
  bc.max_bytes = validatedInt(bc_raw['max_bytes'], bc.max_bytes, ...boundsOf('bash_compress.max_bytes'))
  bc.timeout_seconds = validatedInt(bc_raw['timeout_seconds'], bc.timeout_seconds, ...boundsOf('bash_compress.timeout_seconds'))
  // Legacy-sentinel guard: config set on ANY key does a full load->mutate-one-field->save-all
  // round trip (see saveConfig), so any pre-687758ae user who ran `config set` for an unrelated
  // key got the then-in-memory default cache_min_bytes (0) permanently persisted, even though
  // the field had zero consumers at the time and nobody could have deliberately chosen it.
  // 687758ae wired this key up as the real cache minimum-size gate and bumped the in-code
  // default to 512 -- but those stale 0s now load back in and silently disable caching.
  // Treat an exactly-persisted 0 as that stale default and fall through to the current default
  // instead of trusting it; any other persisted value (including a deliberate 0 set after
  // upgrading) is respected as-is. Note: 0 is a more plausible value someone might
  // deliberately choose post-upgrade (cache everything with no minimum size) than the other
  // sentinel values were, so callers who really want 0 can work around this by setting 1 instead.
  bc.cache_min_bytes = validatedIntWithLegacySentinel(bc_raw['cache_min_bytes'], bc.cache_min_bytes, 0, ...boundsOf('bash_compress.cache_min_bytes'))
  bc.cache_max_file_count = validatedInt(bc_raw['cache_max_file_count'], bc.cache_max_file_count, ...boundsOf('bash_compress.cache_max_file_count'))
  bc.cache_max_bytes = validatedInt(bc_raw['cache_max_bytes'], bc.cache_max_bytes, ...boundsOf('bash_compress.cache_max_bytes'))
  bc.cache_max_bytes_per_output = validatedInt(bc_raw['cache_max_bytes_per_output'], bc.cache_max_bytes_per_output, ...boundsOf('bash_compress.cache_max_bytes_per_output'))
  bc.enabled = envBool('TOKEN_GOAT_BASH_COMPRESS', bc.enabled)
  bc.cache_min_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MIN_BYTES', bc.cache_min_bytes, ...boundsOf('bash_compress.cache_min_bytes'))
  bc.cache_max_file_count = envInt('TOKEN_GOAT_BASH_CACHE_MAX_FILES', bc.cache_max_file_count, ...boundsOf('bash_compress.cache_max_file_count'))
  bc.cache_max_bytes = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES', bc.cache_max_bytes, ...boundsOf('bash_compress.cache_max_bytes'))
  bc.cache_max_bytes_per_output = envInt('TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT', bc.cache_max_bytes_per_output, ...boundsOf('bash_compress.cache_max_bytes_per_output'))
  // A per-item cap larger than the total-directory budget is nonsensical: pruneBlobs()
  // would otherwise evict a freshly-written item (and everything else) in the same
  // storeBlob() call that just wrote it. Clamp it so the per-item cap can never
  // exceed the total budget.
  bc.cache_max_bytes_per_output = Math.min(bc.cache_max_bytes_per_output, bc.cache_max_bytes)

  const bd_raw = section(raw, 'bash_diff')
  const bd = getDefaultConfig('bash_diff') as BashDiffConfig
  bd.max_hunks_per_file = validatedInt(bd_raw['max_hunks_per_file'], bd.max_hunks_per_file, ...boundsOf('bash_diff.max_hunks_per_file'))

  const sl_raw = section(raw, 'bash_severity_log')
  const sl = getDefaultConfig('bash_severity_log') as SeverityLogConfig
  sl.context_lines = validatedInt(sl_raw['context_lines'], sl.context_lines, ...boundsOf('bash_severity_log.context_lines'))
  sl.score_threshold = validatedFloat(sl_raw['score_threshold'], sl.score_threshold, ...boundsOf('bash_severity_log.score_threshold'))

  const cc_raw = section(raw, 'post_read_code_compress')
  const cc = getDefaultConfig('post_read_code_compress') as CodeCompressConfig
  cc.min_lines = validatedInt(cc_raw['min_lines'], cc.min_lines, ...boundsOf('post_read_code_compress.min_lines'))

  const sb_raw = section(raw, 'session_brief')
  const sb = getDefaultConfig('session_brief') as SessionBriefConfig
  sb.enabled = validatedBool(sb_raw['enabled'], sb.enabled)
  sb.enabled = envBool('TOKEN_GOAT_SESSION_BRIEF', sb.enabled)

  const sp_raw = section(raw, 'skill_preservation')
  const sp = getDefaultConfig('skill_preservation') as SkillPreservationConfig
  sp.enabled = validatedBool(sp_raw['enabled'], sp.enabled)
  sp.max_cache_bytes = validatedInt(sp_raw['max_cache_bytes'], sp.max_cache_bytes, ...boundsOf('skill_preservation.max_cache_bytes'))
  sp.orphan_sweep_enabled = validatedBool(sp_raw['orphan_sweep_enabled'], sp.orphan_sweep_enabled)
  sp.orphan_age_secs = validatedInt(sp_raw['orphan_age_secs'], sp.orphan_age_secs, ...boundsOf('skill_preservation.orphan_age_secs'))
  sp.truncation_budget_tokens = validatedInt(sp_raw['truncation_budget_tokens'], sp.truncation_budget_tokens, ...boundsOf('skill_preservation.truncation_budget_tokens'))
  sp.compress_bodies = validatedBool(sp_raw['compress_bodies'], sp.compress_bodies)
  sp.compress_min_bytes = validatedInt(sp_raw['compress_min_bytes'], sp.compress_min_bytes, ...boundsOf('skill_preservation.compress_min_bytes'))
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
  is_cfg.jpeg_quality = validatedInt(is_raw['jpeg_quality'], is_cfg.jpeg_quality, ...boundsOf('image_shrink.jpeg_quality'))
  is_cfg.max_image_pixels = validatedInt(is_raw['max_image_pixels'], is_cfg.max_image_pixels, ...boundsOf('image_shrink.max_image_pixels'))
  is_cfg.screenshot_redirect = validatedBool(is_raw['screenshot_redirect'], is_cfg.screenshot_redirect)
  is_cfg.ocr_enabled = validatedBool(is_raw['ocr_enabled'], is_cfg.ocr_enabled)
  is_cfg.ocr_min_confidence = validatedInt(is_raw['ocr_min_confidence'], is_cfg.ocr_min_confidence, ...boundsOf('image_shrink.ocr_min_confidence'))
  is_cfg.max_image_pixels = envInt('TOKEN_GOAT_MAX_IMAGE_PIXELS', is_cfg.max_image_pixels, ...boundsOf('image_shrink.max_image_pixels'))
  is_cfg.ocr_enabled = envBool('TOKEN_GOAT_OCR_ENABLED', is_cfg.ocr_enabled)

  const sc_raw = section(raw, 'screenshot')
  const sc_cfg = getDefaultConfig('screenshot') as ScreenshotConfig
  sc_cfg.chrome_path = validatedStr(sc_raw['chrome_path'], sc_cfg.chrome_path)

  const rm_raw = section(raw, 'repomap')
  const rm = getDefaultConfig('repomap') as RepomapConfig
  rm.compact_file_threshold = validatedInt(rm_raw['compact_file_threshold'], rm.compact_file_threshold, ...boundsOf('repomap.compact_file_threshold'))
  rm.exclude_tests = validatedBool(rm_raw['exclude_tests'], rm.exclude_tests)
  rm.compact_file_threshold = envInt('TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD', rm.compact_file_threshold, ...boundsOf('repomap.compact_file_threshold'))
  rm.exclude_tests = envBool('TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS', rm.exclude_tests)

  const og_raw = section(raw, 'overflow_guard')
  const og = getDefaultConfig('overflow_guard') as OverflowGuardConfig
  og.enabled = validatedBool(og_raw['enabled'], og.enabled)
  og.max_tokens = validatedInt(og_raw['max_tokens'], og.max_tokens, ...boundsOf('overflow_guard.max_tokens'))
  og.enabled = envBool('TOKEN_GOAT_OVERFLOW_GUARD', og.enabled)
  og.max_tokens = envInt('TOKEN_GOAT_OVERFLOW_MAX_TOKENS', og.max_tokens, ...boundsOf('overflow_guard.max_tokens'))

  const st_raw = section(raw, 'stats')
  const st = getDefaultConfig('stats') as StatsConfig
  st.record_zero_savings = validatedBool(st_raw['record_zero_savings'], st.record_zero_savings)

  const hi_raw = section(raw, 'hints')
  const hi = getDefaultConfig('hints') as HintsConfig
  hi.quiet_hours = validatedStr(hi_raw['quiet_hours'], hi.quiet_hours)
  hi.json_sidecar = validatedBool(hi_raw['json_sidecar'], hi.json_sidecar)
  hi.min_file_lines_for_hint = validatedInt(hi_raw['min_file_lines_for_hint'], hi.min_file_lines_for_hint, ...boundsOf('hints.min_file_lines_for_hint'))
  hi.bash_dedup_min_bytes = validatedInt(hi_raw['bash_dedup_min_bytes'], hi.bash_dedup_min_bytes, ...boundsOf('hints.bash_dedup_min_bytes'))
  hi.bash_dedup_min_bytes = envInt('TOKEN_GOAT_BASH_DEDUP_MIN_BYTES', hi.bash_dedup_min_bytes, ...boundsOf('hints.bash_dedup_min_bytes'))
  hi.web_dedup_min_bytes = validatedInt(hi_raw['web_dedup_min_bytes'], hi.web_dedup_min_bytes, ...boundsOf('hints.web_dedup_min_bytes'))
  hi.web_dedup_min_bytes = envInt('TOKEN_GOAT_WEB_DEDUP_MIN_BYTES', hi.web_dedup_min_bytes, ...boundsOf('hints.web_dedup_min_bytes'))
  hi.grep_dedup_min_matches = validatedInt(hi_raw['grep_dedup_min_matches'], hi.grep_dedup_min_matches, ...boundsOf('hints.grep_dedup_min_matches'))
  hi.grep_dedup_min_matches = envInt('TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES', hi.grep_dedup_min_matches, ...boundsOf('hints.grep_dedup_min_matches'))
  hi.glob_dedup_min_matches = validatedInt(hi_raw['glob_dedup_min_matches'], hi.glob_dedup_min_matches, ...boundsOf('hints.glob_dedup_min_matches'))
  hi.glob_dedup_min_matches = envInt('TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES', hi.glob_dedup_min_matches, ...boundsOf('hints.glob_dedup_min_matches'))
  hi.write_rewrite_min_lines = validatedInt(hi_raw['write_rewrite_min_lines'], hi.write_rewrite_min_lines, ...boundsOf('hints.write_rewrite_min_lines'))
  hi.write_rewrite_min_lines = envInt('TOKEN_GOAT_WRITE_REWRITE_MIN_LINES', hi.write_rewrite_min_lines, ...boundsOf('hints.write_rewrite_min_lines'))
  hi.write_rewrite_unchanged_pct = validatedInt(hi_raw['write_rewrite_unchanged_pct'], hi.write_rewrite_unchanged_pct, ...boundsOf('hints.write_rewrite_unchanged_pct'))
  hi.write_rewrite_unchanged_pct = envInt('TOKEN_GOAT_WRITE_REWRITE_UNCHANGED_PCT', hi.write_rewrite_unchanged_pct, ...boundsOf('hints.write_rewrite_unchanged_pct'))
  hi.serve_diff_on_reread = validatedBool(hi_raw['serve_diff_on_reread'], hi.serve_diff_on_reread)
  hi.backoff_thresholds = validatedIntList(hi_raw['backoff_thresholds'], hi.backoff_thresholds)
  hi.git_hint_max_ms = validatedInt(hi_raw['git_hint_max_ms'], hi.git_hint_max_ms, ...boundsOf('hints.git_hint_max_ms'))
  hi.min_session_hint_savings_bytes = validatedInt(hi_raw['min_session_hint_savings_bytes'], hi.min_session_hint_savings_bytes, ...boundsOf('hints.min_session_hint_savings_bytes'))
  hi.pre_skill_advisory = validatedBool(hi_raw['pre_skill_advisory'], hi.pre_skill_advisory)
  hi.context_threshold_advisory = validatedBool(hi_raw['context_threshold_advisory'], hi.context_threshold_advisory)
  hi.diff_hint_min_tokens_saved = validatedInt(hi_raw['diff_hint_min_tokens_saved'], hi.diff_hint_min_tokens_saved, ...boundsOf('hints.diff_hint_min_tokens_saved'))
  // Legacy-sentinel guard: config set on ANY key does a full load->mutate-one-field->save-all
  // round trip (see saveConfig), so any pre-4b6f30dc user who ran `config set` for an unrelated
  // key got the then-in-memory default large_read_redirect_bytes (45_000) permanently persisted,
  // even though the field had zero consumers at the time and nobody could have deliberately chosen it.
  // 4b6f30dc wired this key up as the real pressure-scaled first-read deny gate and bumped the
  // in-code default to 512_000 -- but those stale 45_000s now load back in and silently make the
  // gate ~11.4x more aggressive than intended. Treat an exactly-persisted 45_000 as that stale
  // default and fall through to the current default instead of trusting it; any other persisted
  // value (including a deliberate 45_000 set after upgrading) is respected as-is.
  hi.large_read_redirect_bytes = validatedIntWithLegacySentinel(hi_raw['large_read_redirect_bytes'], hi.large_read_redirect_bytes, 45_000, ...boundsOf('hints.large_read_redirect_bytes'))
  hi.reread_deny = validatedBool(hi_raw['reread_deny'], hi.reread_deny)
  // Legacy-sentinel guard: config set on ANY key does a full load->mutate-one-field->save-all
  // round trip (see saveConfig), so any pre-a1fad4c6 user who ran `config set` for an unrelated
  // key got the then-in-memory default reread_deny_min_bytes (2048) permanently persisted, even
  // though the field had zero consumers at the time and nobody could have deliberately chosen it.
  // a1fad4c6 wired this key up as the real re-read-deny gate and bumped the in-code default to
  // 51_200 -- but those stale 2048s now load back in and silently make the gate 25x more
  // aggressive than intended. Treat an exactly-persisted 2048 as that stale default and fall
  // through to the current default instead of trusting it; any other persisted value (including a
  // deliberate 2048 set after upgrading) is respected as-is.
  hi.reread_deny_min_bytes = validatedIntWithLegacySentinel(hi_raw['reread_deny_min_bytes'], hi.reread_deny_min_bytes, 2048, ...boundsOf('hints.reread_deny_min_bytes'))
  hi.stable_doc_compacts = validatedBool(hi_raw['stable_doc_compacts'], hi.stable_doc_compacts)
  hi.truncated_read_min_lines = validatedInt(hi_raw['truncated_read_min_lines'], hi.truncated_read_min_lines, ...boundsOf('hints.truncated_read_min_lines'))
  hi.protect_recent_reads = validatedInt(hi_raw['protect_recent_reads'], hi.protect_recent_reads, ...boundsOf('hints.protect_recent_reads'))
  hi.warn_unbalanced_shell_quoting = validatedBool(hi_raw['warn_unbalanced_shell_quoting'], hi.warn_unbalanced_shell_quoting)
  hi.log_large_file_hint_outcomes = validatedBool(hi_raw['log_large_file_hint_outcomes'], hi.log_large_file_hint_outcomes)
  hi.warn_unbalanced_shell_quoting = envBool('TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING', hi.warn_unbalanced_shell_quoting)
  hi.serve_diff_on_reread = envBool('TOKEN_GOAT_SERVE_DIFF_ON_REREAD', hi.serve_diff_on_reread)
  hi.log_large_file_hint_outcomes = envBool('TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES', hi.log_large_file_hint_outcomes)
  hi.json_sidecar = envBool('TOKEN_GOAT_HINT_JSON_SIDECAR', hi.json_sidecar)
  hi.large_read_redirect_bytes = envInt('TOKEN_GOAT_LARGE_READ_BYTES', hi.large_read_redirect_bytes, ...boundsOf('hints.large_read_redirect_bytes'))
  hi.cross_session_read_dedup = validatedBool(hi_raw['cross_session_read_dedup'], hi.cross_session_read_dedup)
  hi.cross_session_read_dedup_ttl_secs = validatedInt(hi_raw['cross_session_read_dedup_ttl_secs'], hi.cross_session_read_dedup_ttl_secs, ...boundsOf('hints.cross_session_read_dedup_ttl_secs'))
  hi.cross_session_read_dedup = envBool('TOKEN_GOAT_CROSS_SESSION_READ_DEDUP', hi.cross_session_read_dedup)
  hi.cross_session_read_dedup_ttl_secs = envInt('TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS', hi.cross_session_read_dedup_ttl_secs, ...boundsOf('hints.cross_session_read_dedup_ttl_secs'))
  hi.mcp_dedup_ttl_secs = validatedInt(hi_raw['mcp_dedup_ttl_secs'], hi.mcp_dedup_ttl_secs, ...boundsOf('hints.mcp_dedup_ttl_secs'))
  hi.mcp_dedup_ttl_secs = envInt('TOKEN_GOAT_MCP_DEDUP_TTL_SECS', hi.mcp_dedup_ttl_secs, ...boundsOf('hints.mcp_dedup_ttl_secs'))
  hi.session_start_reminder = validatedBool(hi_raw['session_start_reminder'], hi.session_start_reminder)
  hi.session_start_reminder = envBool('TOKEN_GOAT_SESSION_START_REMINDER', hi.session_start_reminder)
  hi.min_session_hint_savings_bytes = envInt('TOKEN_GOAT_SESSION_HINT_MIN_BYTES', hi.min_session_hint_savings_bytes, ...boundsOf('hints.min_session_hint_savings_bytes'))
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
  hk.watchdog_ms = validatedInt(hk_raw['watchdog_ms'], hk.watchdog_ms, ...boundsOf('hooks.watchdog_ms'))
  hk.watchdog_ms = envInt('TOKEN_GOAT_HOOK_WATCHDOG_MS', hk.watchdog_ms, ...boundsOf('hooks.watchdog_ms'))

  const wf_raw = section(raw, 'webfetch')
  const wf = getDefaultConfig('webfetch') as WebFetchConfig
  wf.allow = validatedStrList(wf_raw['allow'], wf.allow)
  wf.deny = validatedStrList(wf_raw['deny'], wf.deny)
  wf.max_file_count = validatedInt(wf_raw['max_file_count'], wf.max_file_count, ...boundsOf('webfetch.max_file_count'))
  wf.max_file_count = envInt('TOKEN_GOAT_WEB_CACHE_MAX_FILES', wf.max_file_count, ...boundsOf('webfetch.max_file_count'))
  wf.max_bytes = validatedInt(wf_raw['max_bytes'], wf.max_bytes, ...boundsOf('webfetch.max_bytes'))
  wf.max_bytes = envInt('TOKEN_GOAT_WEB_CACHE_MAX_BYTES', wf.max_bytes, ...boundsOf('webfetch.max_bytes'))
  wf.compress_bodies = validatedBool(wf_raw['compress_bodies'], wf.compress_bodies)
  wf.compress_min_bytes = validatedInt(wf_raw['compress_min_bytes'], wf.compress_min_bytes, ...boundsOf('webfetch.compress_min_bytes'))
  wf.compress_bodies = envBool('TOKEN_GOAT_WEB_COMPRESS', wf.compress_bodies)

  const wk_raw = section(raw, 'worker')
  const wk = getDefaultConfig('worker') as WorkerConfig
  wk.blocked_roots = validatedStrList(wk_raw['blocked_roots'], wk.blocked_roots)
  wk.max_pool_workers = validatedInt(wk_raw['max_pool_workers'], wk.max_pool_workers, ...boundsOf('worker.max_pool_workers'))
  wk.max_pool_workers = envInt('TOKEN_GOAT_WORKER_MAX_POOL', wk.max_pool_workers, ...boundsOf('worker.max_pool_workers'))

  const ix_raw = section(raw, 'indexing')
  const ix = getDefaultConfig('indexing') as IndexingConfig
  ix.large_file_symbol_only_kb = validatedInt(ix_raw['large_file_symbol_only_kb'], ix.large_file_symbol_only_kb, ...boundsOf('indexing.large_file_symbol_only_kb'))
  ix.large_file_skip_kb = validatedInt(ix_raw['large_file_skip_kb'], ix.large_file_skip_kb, ...boundsOf('indexing.large_file_skip_kb'))
  // A symbol-only threshold larger than the skip threshold is nonsensical: files would be
  // skipped entirely before the symbol-only tier's condition could ever apply. Clamp
  // symbol_only_kb so it never exceeds skip_kb.
  ix.large_file_symbol_only_kb = Math.min(ix.large_file_symbol_only_kb, ix.large_file_skip_kb)
  ix.skip_dirs = validatedStrList(ix_raw['skip_dirs'], ix.skip_dirs)
  ix.skip_files = validatedStrList(ix_raw['skip_files'], ix.skip_files)
  ix.embeddings_enabled = validatedBool(ix_raw['embeddings_enabled'], ix.embeddings_enabled)
  ix.embeddings_enabled = envBool('TOKEN_GOAT_EMBEDDINGS_ENABLED', ix.embeddings_enabled)

  const cpr_raw = section(raw, 'compression')
  const cpr = getDefaultConfig('compression') as CompressionConfig
  cpr.profile = validatedStr(cpr_raw['profile'], cpr.profile)
  cpr.profile = envStr('TOKEN_GOAT_COMPRESS_PROFILE', cpr.profile)

  const ctx_raw = section(raw, 'context')
  const ctx = getDefaultConfig('context') as ContextConfig
  ctx.model_window_tokens = validatedInt(ctx_raw['model_window_tokens'], ctx.model_window_tokens, ...boundsOf('context.model_window_tokens'))
  ctx.model_window_tokens = envInt('TOKEN_GOAT_MODEL_WINDOW_TOKENS', ctx.model_window_tokens, ...boundsOf('context.model_window_tokens'))

  const inj_raw = section(raw, 'injection')
  const inj = getDefaultConfig('injection') as InjectionConfig
  inj.enabled = validatedBool(inj_raw['enabled'], inj.enabled)
  inj.enabled = envBool('TOKEN_GOAT_INJECTION_ENABLED', inj.enabled)

  const hs_raw = section(raw, 'hint_stats')
  const hs = getDefaultConfig('hint_stats') as HintStatsConfig
  hs.suppress_threshold_pct = validatedInt(hs_raw['suppress_threshold_pct'], hs.suppress_threshold_pct, ...boundsOf('hint_stats.suppress_threshold_pct'))
  hs.min_sample_size = validatedInt(hs_raw['min_sample_size'], hs.min_sample_size, ...boundsOf('hint_stats.min_sample_size'))

  return {
    compact_assist: ca,
    bash_compress: bc,
    bash_diff: bd,
    bash_severity_log: sl,
    post_read_code_compress: cc,
    session_brief: sb,
    skill_preservation: sp,
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
    hint_stats: hs,
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
  'image_shrink.ocr_enabled': ['TOKEN_GOAT_OCR_ENABLED'],
  'repomap.compact_file_threshold': ['TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD'],
  'repomap.exclude_tests': ['TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS'],
  'overflow_guard.enabled': ['TOKEN_GOAT_OVERFLOW_GUARD'],
  'overflow_guard.max_tokens': ['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'],
  'hints.json_sidecar': ['TOKEN_GOAT_HINT_JSON_SIDECAR'],
  'hints.bash_dedup_min_bytes': ['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'],
  'hints.web_dedup_min_bytes': ['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'],
  'hints.grep_dedup_min_matches': ['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'],
  'hints.glob_dedup_min_matches': ['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'],
  'hints.write_rewrite_min_lines': ['TOKEN_GOAT_WRITE_REWRITE_MIN_LINES'],
  'hints.write_rewrite_unchanged_pct': ['TOKEN_GOAT_WRITE_REWRITE_UNCHANGED_PCT'],
  'hints.large_read_redirect_bytes': ['TOKEN_GOAT_LARGE_READ_BYTES'],
  'hints.warn_unbalanced_shell_quoting': ['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING'],
  'hints.serve_diff_on_reread': ['TOKEN_GOAT_SERVE_DIFF_ON_REREAD'],
  'hints.log_large_file_hint_outcomes': ['TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES'],
  'hints.cross_session_read_dedup': ['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP'],
  'hints.cross_session_read_dedup_ttl_secs': ['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS'],
  'hints.mcp_dedup_ttl_secs': ['TOKEN_GOAT_MCP_DEDUP_TTL_SECS'],
  'hints.session_start_reminder': ['TOKEN_GOAT_SESSION_START_REMINDER'],
  'hints.min_session_hint_savings_bytes': ['TOKEN_GOAT_SESSION_HINT_MIN_BYTES'],
  'hooks.watchdog_ms': ['TOKEN_GOAT_HOOK_WATCHDOG_MS'],
  'webfetch.max_file_count': ['TOKEN_GOAT_WEB_CACHE_MAX_FILES'],
  'webfetch.max_bytes': ['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'],
  'webfetch.compress_bodies': ['TOKEN_GOAT_WEB_COMPRESS'],
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

  // auto_trigger_multiplier is the one field isAutoTriggerMultiplierExplicit() needs to tell
  // "user explicitly set this" apart from "still holding the compiled default" by checking
  // whether the raw TOML literally has the key. Writing it unconditionally below (like every
  // other field) would bake it into config.toml on every save -- including a save that never
  // touched this field -- permanently defeating that check. Check explicitness BEFORE this
  // write lands, and omit the key entirely when it's still an untouched default.
  const wasExplicit = isAutoTriggerMultiplierExplicit()
  const defaultMultiplier = (getDefaultConfig('compact_assist') as CompactAssistConfig).auto_trigger_multiplier
  const keepsMultiplierDefault = !wasExplicit && ca.auto_trigger_multiplier === defaultMultiplier

  const data = {
    compact_assist: {
      enabled: ca.enabled,
      triggers: ca.triggers,
      min_events: ca.min_events,
      max_manifest_tokens: ca.max_manifest_tokens,
      ...(keepsMultiplierDefault ? {} : { auto_trigger_multiplier: ca.auto_trigger_multiplier }),
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
    image_shrink: {
      enabled: is_cfg.enabled,
      jpeg_quality: is_cfg.jpeg_quality,
      max_image_pixels: is_cfg.max_image_pixels,
      screenshot_redirect: is_cfg.screenshot_redirect,
      ocr_enabled: is_cfg.ocr_enabled,
      ocr_min_confidence: is_cfg.ocr_min_confidence,
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
      quiet_hours: config.hints.quiet_hours,
      json_sidecar: config.hints.json_sidecar,
      min_file_lines_for_hint: config.hints.min_file_lines_for_hint,
      bash_dedup_min_bytes: config.hints.bash_dedup_min_bytes,
      web_dedup_min_bytes: config.hints.web_dedup_min_bytes,
      grep_dedup_min_matches: config.hints.grep_dedup_min_matches,
      glob_dedup_min_matches: config.hints.glob_dedup_min_matches,
      write_rewrite_min_lines: config.hints.write_rewrite_min_lines,
      write_rewrite_unchanged_pct: config.hints.write_rewrite_unchanged_pct,
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
      stable_doc_compacts: config.hints.stable_doc_compacts,
      truncated_read_min_lines: config.hints.truncated_read_min_lines,
      protect_recent_reads: config.hints.protect_recent_reads,
      prompt_triggers: config.hints.prompt_triggers,
      warn_unbalanced_shell_quoting: config.hints.warn_unbalanced_shell_quoting,
      log_large_file_hint_outcomes: config.hints.log_large_file_hint_outcomes,
      cross_session_read_dedup: config.hints.cross_session_read_dedup,
      cross_session_read_dedup_ttl_secs: config.hints.cross_session_read_dedup_ttl_secs,
      mcp_dedup_ttl_secs: config.hints.mcp_dedup_ttl_secs,
      session_start_reminder: config.hints.session_start_reminder,
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
      blocked_roots: config.worker.blocked_roots,
      max_pool_workers: config.worker.max_pool_workers,
    },
    indexing: {
      large_file_symbol_only_kb: config.indexing.large_file_symbol_only_kb,
      large_file_skip_kb: config.indexing.large_file_skip_kb,
      skip_dirs: config.indexing.skip_dirs,
      skip_files: config.indexing.skip_files,
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
    hint_stats: {
      suppress_threshold_pct: config.hint_stats.suppress_threshold_pct,
      min_sample_size: config.hint_stats.min_sample_size,
    },
  }

  const toml = stringify(data)
  atomicWriteText(configPath(), toml)
  _cached = null
}
