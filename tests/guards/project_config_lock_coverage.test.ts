/**
 * The other direction of the `.token-goat.toml` lock.
 *
 * `tests/project_config_locked_sections.test.ts` proves that everything named in
 * `PROJECT_LOCKED_SECTIONS` / `PROJECT_LOCKED_KEYS` is actually stripped, and that removing an
 * entry fails rather than vanishing quietly. What it cannot see is a setting that was never
 * added to either list: every assertion there starts from the lists themselves, so a
 * security-relevant key introduced somewhere in the config schema is invisible to it by
 * construction. That is how `screenshot.chrome_path` (the executable `puppeteer.launch` is
 * handed), `screenshot.block_private_targets` (the private-address refusal and the DNS-rebinding
 * pin) and `image_shrink.max_image_pixels` (sharp's decompression-bomb cap, where `0` means "no
 * cap") all stayed settable from a checked-in file long after the lock existed. Confirmed live
 * against the built binary before the fix: `config get screenshot.chrome_path` reported the
 * repository's value while `config get injection.enabled` correctly reported the locked one.
 *
 * So this file starts from the schema instead. Every `section.key` in `defaultConfig()` must be
 * either locked or named in `REVIEWED_OVERRIDABLE` below, and a key in neither fails. Adding a
 * config setting therefore forces one explicit decision about whether a repository may set it,
 * at the moment it is added, instead of relying on someone remembering this invariant later.
 */
import { describe, expect, it } from 'vitest'

import { PROJECT_LOCKED_KEYS, PROJECT_LOCKED_SECTIONS, defaultConfig } from '../../src/config.js'

/**
 * Every `section.key` deliberately left settable by a per-project `.token-goat.toml`.
 *
 * The bar is the one stated in CLAUDE.arch.md's Security Boundaries: a setting belongs in a lock
 * list when it turns a protection off, narrows an allowlist, or widens a confinement. Everything
 * here fails that bar -- it is formatting, a token-cost threshold, a cache size, or a tuning
 * knob whose worst case is a worse-compressed or slower answer, never a capability a repository
 * would not otherwise have on the machine.
 */
const REVIEWED_OVERRIDABLE: readonly string[] = [
  'agent_report.fence_collapse_keep_lines',
  'agent_report.fence_collapse_min_lines',
  'agent_report.min_bytes',
  'bash_compress.cache_max_bytes',
  'bash_compress.cache_max_bytes_per_output',
  'bash_compress.cache_max_file_count',
  'bash_compress.cache_min_bytes',
  'bash_compress.disabled_filters',
  'bash_compress.enabled',
  'bash_compress.max_bytes',
  'bash_compress.max_lines',
  'bash_compress.min_net_savings_bytes',
  'bash_compress.timeout_seconds',
  'bash_diff.max_hunks_per_file',
  'bash_severity_log.context_lines',
  'bash_severity_log.score_threshold',
  'compact_assist.auto_trigger_multiplier',
  'compact_assist.compact_skip_ttl_secs',
  'compact_assist.edited_dir_group_threshold',
  'compact_assist.enabled',
  'compact_assist.harness',
  'compact_assist.max_manifest_chars',
  'compact_assist.max_manifest_tokens',
  'compact_assist.max_section_lines',
  'compact_assist.min_events',
  'compact_assist.noise_floor_tokens',
  'compact_assist.orchestrator_commit_threshold',
  'compact_assist.triggers',
  'compact_assist.wide_session_threshold',
  'compression.profile',
  'context.model_window_tokens',
  'hint_stats.min_sample_size',
  'hint_stats.suppress_threshold_pct',
  'hints.backoff_thresholds',
  'hints.bash_dedup_min_bytes',
  'hints.context_threshold_advisory',
  'hints.cross_session_read_dedup',
  'hints.cross_session_read_dedup_ttl_secs',
  'hints.diff_hint_min_tokens_saved',
  'hints.git_hint_max_ms',
  'hints.glob_dedup_min_matches',
  'hints.grep_dedup_min_matches',
  'hints.json_sidecar',
  'hints.large_read_redirect_bytes',
  'hints.log_large_file_hint_outcomes',
  'hints.mcp_dedup_ttl_secs',
  'hints.min_file_lines_for_hint',
  'hints.min_session_hint_savings_bytes',
  'hints.pre_skill_advisory',
  'hints.prompt_triggers',
  'hints.protect_recent_reads',
  'hints.quiet_hours',
  'hints.reread_deny',
  'hints.reread_deny_min_bytes',
  'hints.serve_diff_on_reread',
  'hints.session_start_reminder',
  'hints.stable_doc_compacts',
  'hints.truncated_read_min_lines',
  'hints.warn_unbalanced_shell_quoting',
  'hints.web_dedup_min_bytes',
  'hints.write_rewrite_min_lines',
  'hints.write_rewrite_unchanged_pct',
  'hooks.watchdog_ms',
  'image_shrink.enabled',
  'image_shrink.jpeg_quality',
  'image_shrink.ocr_enabled',
  'image_shrink.ocr_min_confidence',
  'image_shrink.screenshot_redirect',
  // Overridable rather than locked: it changes no image and no protection, only which tier's
  // price token-goat reports an already-taken shrink at. A repository choosing it can flatter
  // that project's savings figure, which is a reason to keep the default at the honest floor
  // (it is) rather than a reason to stop a repository from stating which models it is read on.
  'image_shrink.vision_tier',
  'indexing.embeddings_enabled',
  'indexing.large_file_skip_kb',
  'indexing.large_file_symbol_only_kb',
  'indexing.skip_dirs',
  'indexing.skip_files',
  'overflow_guard.enabled',
  'overflow_guard.max_tokens',
  'post_read_code_compress.min_lines',
  'repomap.compact_file_threshold',
  'repomap.exclude_tests',
  'semantic.archive_weight',
  'semantic.docs_weight',
  'session_brief.enabled',
  'skill_preservation.compress_bodies',
  'skill_preservation.compress_min_bytes',
  'skill_preservation.enabled',
  'skill_preservation.first_load_compact',
  'skill_preservation.inline_snippets',
  'skill_preservation.max_cache_bytes',
  'skill_preservation.orphan_age_secs',
  'skill_preservation.orphan_sweep_enabled',
  'skill_preservation.post_compact_full_loads',
  'skill_preservation.pre_skill_enabled',
  'skill_preservation.truncation_budget_tokens',
  'stats.record_zero_savings',
  // Both fail the lock bar the same way `max_pool_workers` does: their worst case is a slower or
  // a less considerate index, never a capability the repository would not otherwise have. The
  // priority enum deliberately offers nothing above `normal`, so a checked-in file cannot use it
  // to raise a background process over the user's own work.
  'worker.embed_threads',
  'worker.max_pool_workers',
  'worker.priority',
]

function isLocked(section: string, key: string): boolean {
  return PROJECT_LOCKED_SECTIONS.includes(section) || PROJECT_LOCKED_KEYS.includes(`${section}.${key}`)
}

function everyConfigKey(): string[] {
  const out: string[] = []
  for (const [section, value] of Object.entries(defaultConfig() as unknown as Record<string, object>)) {
    for (const key of Object.keys(value)) out.push(`${section}.${key}`)
  }
  return out.sort()
}

describe('every config setting is classified as locked or deliberately project-overridable', () => {
  it('classifies each key, so a new setting cannot be added without deciding', () => {
    const unclassified = everyConfigKey().filter((dotted) => {
      const [section, key] = dotted.split('.') as [string, string]
      return !isLocked(section, key) && !REVIEWED_OVERRIDABLE.includes(dotted)
    })

    expect(
      unclassified,
      'each of these is settable by a checked-in .token-goat.toml and has never been reviewed: ' +
        'add it to PROJECT_LOCKED_SECTIONS/PROJECT_LOCKED_KEYS if a repository setting it could ' +
        'turn a protection off, narrow an allowlist, or widen a confinement, and to ' +
        'REVIEWED_OVERRIDABLE in this file otherwise',
    ).toEqual([])
  })

  // The reverse staleness check. Without it, a key that is later locked (or renamed away) leaves
  // a dead entry behind in the allowlist, and the next reader has no way to tell a reviewed
  // decision from a leftover.
  it('has no allowlist entry that is locked or no longer exists', () => {
    const known = new Set(everyConfigKey())
    const stale = REVIEWED_OVERRIDABLE.filter((dotted) => {
      const [section, key] = dotted.split('.') as [string, string]
      return !known.has(dotted) || isLocked(section, key)
    })

    expect(stale, 'these allowlist entries no longer name a live, unlocked setting').toEqual([])
  })

  // Guards the guard: if `defaultConfig()` ever returned an empty tree (a refactor, a mocked
  // module), both assertions above would pass by finding nothing to check.
  it('reads a populated schema, so the checks above cannot pass vacuously', () => {
    expect(everyConfigKey().length).toBeGreaterThan(100)
  })
})

// The three settings the coverage check above was written for, asserted by name and by the
// capability each one hands a repository. A rename that quietly drops one from the schema is
// caught by the staleness check above; this is what proves the lock is the right verdict for it.
describe('the settings that decide browser launch and image decode are not repository-settable', () => {
  it.each([
    ['screenshot.chrome_path', 'names the executable puppeteer.launch is handed'],
    ['screenshot.block_private_targets', 'gates the private-address refusal and the rebinding pin'],
    ['image_shrink.max_image_pixels', "is sharp's decompression-bomb cap, where 0 means no cap"],
  ])('locks %s, which %s', (dotted) => {
    const [section, key] = dotted.split('.') as [string, string]
    expect(isLocked(section, key)).toBe(true)
    expect(Object.keys(defaultConfig()[section as keyof ReturnType<typeof defaultConfig>])).toContain(key)
  })
})
