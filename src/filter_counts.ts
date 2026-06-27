/**
 * Aggregated filter/rule counts for all hook types.
 *
 * Dynamic counts are computed from the live source arrays and update
 * automatically when entries are added to those arrays.
 *
 * Static counts are maintained explicitly here — the comment on each line
 * names the source file so the right constant is easy to find and update.
 */

import { FILTERS } from './filters.js'
import {
  BUILD_COMMAND_PATTERNS,
  MONITORING_COMMAND_PATTERNS,
  LOCK_FILE_COUNT,
  MANIFEST_FILE_COUNT,
  BUILD_DIR_COUNT,
  GENERATED_EXT_COUNT,
} from './hints/lang_patterns.js'

// --- Dynamic (auto-updates when source arrays grow) ---

/** Universal line-pattern bash output compression rules (src/filters.ts). */
export const BASH_OUTPUT_FILTER_COUNT = FILTERS.length

/** Build-command recall patterns (src/hints/lang_patterns.ts). */
export const BUILD_RECALL_PATTERN_COUNT = BUILD_COMMAND_PATTERNS.length

/** Long-running monitoring command recall patterns (src/hints/lang_patterns.ts). */
export const MONITORING_PATTERN_COUNT = MONITORING_COMMAND_PATTERNS.length

/** File/directory path pattern entries: lock files, manifests, build dirs, generated exts. */
export const PATH_PATTERN_COUNT =
  LOCK_FILE_COUNT + MANIFEST_FILE_COUNT + BUILD_DIR_COUNT + GENERATED_EXT_COUNT

// --- Static (update the constant when adding to the corresponding module) ---

/** File type intercept handlers — PDF, HTML, txt/log, office binary, CSV/TSV, generic large (src/hints/file_type_handler.ts). */
export const FILE_TYPE_HANDLER_COUNT = 6

/** Pre-bash read interceptors — cat/cat+flags, cat+WSL, cat|jq, python open()/heredoc, head, node readFileSync/require, tail/tail-c, tasks output, sed line range, directory listing, find, markdown heading grep, rg structural, grep|grep chain, curl GET cache, curl -o dedup, rg symbol search (src/hooks_bash.ts). */
export const BASH_INTERCEPTOR_COUNT = 17

/** Distinct deny/context decision paths in the pre-read hook (src/hooks_read.ts). */
export const READ_HOOK_CONDITION_COUNT = 20

/** Test-runner failure block extractors — pytest, jest, go, cargo (src/failures.ts). */
export const FAILURE_RUNNER_COUNT = 4

// --- Total ---

/**
 * Sum of all filter/rule/pattern counts across every hook type.
 *
 * Update BASH_OUTPUT_FILTER_COUNT, PATH_PATTERN_COUNT, BUILD_RECALL_PATTERN_COUNT,
 * and MONITORING_PATTERN_COUNT update automatically. The static counts above need
 * a manual bump when their corresponding modules gain new handlers.
 */
export const TOTAL_FILTER_COUNT =
  BASH_OUTPUT_FILTER_COUNT +
  BUILD_RECALL_PATTERN_COUNT +
  MONITORING_PATTERN_COUNT +
  PATH_PATTERN_COUNT +
  FILE_TYPE_HANDLER_COUNT +
  BASH_INTERCEPTOR_COUNT +
  READ_HOOK_CONDITION_COUNT +
  FAILURE_RUNNER_COUNT
