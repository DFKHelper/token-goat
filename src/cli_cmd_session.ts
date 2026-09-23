/**
 * CLI command registration for session, caching, audit, skill, and note commands.
 */

import type { Command } from 'commander'
import { VERSION } from './version.js'
import { displaySafeJson } from './paths.js'
import { collectCapabilities, renderCapabilities } from './capabilities.js'
import {
  DEFAULT_RECONCILE_BUDGET_MS,
  runReconcile,
} from './reconcile.js'
import {
  cmdContextStats,
  cmdBootstrapAudit,
  cmdMemory,
  cmdWaste,
  cmdAudit,
  cmdSessionOutline,
  cmdSessionSlice,
  cmdSessionAudit,
  cmdMcpAudit,
  cmdRecall,
  cmdHintStats,
  cmdStatusline,
} from './cli_session.js'
import {
  cmdSkillBody,
  cmdSkillCompact,
  cmdSkillList,
  cmdSkillSize,
  cmdSkillHistory,
  cmdSkillDiff,
  cmdSkillSection,
} from './cli_skills.js'
import {
  cmdNoteAdd,
} from './cli_file_ops.js'
import {
  cmdNote,
  cmdHot,
  cmdRecent,
  cmdIgnores,
} from './text_commands.js'
import {
  cmdReclaimIndex,
} from './index_reclaim.js'
import {
  cmdConfig,
  cmdProject,
  cmdCompactDoc,
} from './config_commands.js'
import {
  cmdBashHistory,
  cmdWebHistory,
  cmdMcpHistory,
  cmdCleanCache,
  cmdPruneCache,
  cmdCacheAudit,
  cmdResume,
  cmdCompactHint,
  cmdSessionSummary,
  cmdCost,
  cmdBaseline,
} from './cache_session_commands.js'
import {
  runNoteGet,
  runNoteList,
} from './read_commands.js'
import {
  cmdSessionSchema,
  cmdDescribe,
} from './session_store_schema.js'
import {
  runExit,
  runExitText,
  requireNonNegativeInt,
} from './cli_dispatch.js'

export type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>

export function registerSessionCommands(program: Command, guard: GuardFn): void {
  program
    .command('reconcile')
    .description('sweep this project for files that changed while token-goat was not watching, and queue them for reindexing')
    .option('--dry-run', 'report the drift without queueing anything')
    .option('--budget-ms <ms>', `wall-clock budget for the sweep (default ${DEFAULT_RECONCILE_BUDGET_MS})`)
    .option('-j, --json', 'output as JSON')
    .action((opts: { dryRun?: boolean; budgetMs?: string; json?: boolean }) =>
      runExit(() =>
        runReconcile({
          ...(opts.dryRun === true ? { dryRun: true } : {}),
          ...(opts.budgetMs !== undefined ? { budgetMs: requireNonNegativeInt('--budget-ms', opts.budgetMs) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('capabilities')
    .description('report every capability that can send data off this machine, and its current state')
    .option('-j, --json', 'emit as JSON, for asserting on in a pipeline')
    .action(
      guard((opts: { json?: boolean }) => {
        const caps = collectCapabilities()
        console.log(opts.json ? displaySafeJson({ version: VERSION, capabilities: caps }) : renderCapabilities(caps))
      }),
    )

  program
    .command('context-stats')
    .description('show context statistics')
    .option('--project <path>', 'project root to analyze')
    .option('-j, --json', 'output as JSON')
    .option('--fix', 'apply automatic fixes (confirm-gated; shows a diff before writing)')
    .option('-y, --yes', 'with --fix, apply without prompting (non-interactive / scripted use)')
    .action(guard(cmdContextStats))

  program
    .command('bootstrap-audit')
    .description('audit Claude Code startup-context contributors without reading prompt bodies')
    .option('--project <path>', 'project root to analyze')
    .option('--home <path>', 'home directory override (for CI/testing)')
    .option('--follow-links', 'follow external symlink/junction roots and direct children')
    .option('-j, --json', 'output as JSON')
    .option('--top <n>', 'largest metadata entries to show (default 10)', '10')
    .option('--warn-tokens <n>', 'warn when total estimated startup tokens exceed n')
    .option('--fail-tokens <n>', 'fail when total estimated startup tokens exceed n')
    .option('--warn-bytes <n>', 'warn when agent/skill metadata bytes exceed n')
    .option('--fail-bytes <n>', 'fail when agent/skill metadata bytes exceed n')
    .action(guard(cmdBootstrapAudit))

  program
    .command('memory')
    .description('analyze CLAUDE.md files for duplicate/overlapping content (--fix to apply safe mechanical fixes)')
    .option('--project <path>', 'project root to analyze')
    .option('--analyze', 'report-only analysis (default)')
    .option('--fix', 'remove exact-duplicate lines (confirm-gated; shows a diff before writing)')
    .option('--yes', 'apply --fix changes without prompting (non-interactive)')
    .action(guard(cmdMemory))

  program
    .command('waste')
    .description('session spend-ledger: token cost per tool/file from the current Claude Code session transcript, plus waste signals')
    .option('--project <path>', 'project root to analyze')
    .option('--transcript <path>', 'explicit transcript JSONL path (default: most-recently-modified transcript for this project)')
    .option('--top <n>', 'number of top expensive tool calls to show (default: 10)')
    .option('--copilot', 'analyze a Copilot CLI session event log instead, reporting Copilot\'s own token split')
    .option('--json', 'output JSON')
    .action(guard(cmdWaste))

  program
    .command('audit')
    .description('session retrospective: analyze the current session transcript (Copilot CLI or Claude Code) and emit a Maintainer Feedback Card')
    .option('--project <path>', 'project root to analyze')
    .option('--transcript <path>', 'explicit transcript path (default: active or newest session for this project)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdAudit))

  program
    .command('session-outline [session-id-or-path]')
    .description('turn-by-turn structure (role, preview, tool calls, approx size) of a Claude Code session JSONL transcript, instead of a raw Read; defaults to the current project\'s most recent session')
    .option('--project <path>', 'project root to resolve the session transcript against')
    .option('--json', 'output JSON')
    .action(guard(cmdSessionOutline))

  program
    .command('session-slice [session-id-or-path]')
    .description('full content of one turn range from a Claude Code session JSONL transcript (see session-outline for turn numbers), instead of a raw Read')
    .requiredOption('--range <spec>', 'turn range, e.g. 5-9 or 12 (see session-outline for turn numbers)')
    .option('--project <path>', 'project root to resolve the session transcript against')
    .option('--json', 'output JSON')
    .action(guard(cmdSessionSlice))

  program
    .command('session-audit')
    .alias('audit-session')
    .description('corpus-wide token attribution across every local Claude Code session transcript: measured billed usage, estimated content size by source and by tool, and billed cost by session position (aggregate counts only, never transcript content)')
    .option('--dir <path>', 'transcript corpus root to scan (default: ~/.claude/projects)')
    .option('--json', 'output JSON')
    .action(guard(cmdSessionAudit))

  program
    .command('mcp-audit')
    .description('MCP server schema cost-vs-usage report: estimate per-server token cost from cached tool calls')
    .option('--project <path>', 'project root to analyze')
    .option('--json', 'output JSON')
    .action(guard(cmdMcpAudit))

  program
    .command('recall [query]')
    .description('search across every cached bash-output, web-output, and mcp-output entry (full-text); with no query, list them newest-first')
    .option('--type <type>', 'filter to one cache type: bash, web, or mcp')
    .option('--limit <n>', 'max results to return (default: 10)')
    .option('--json', 'output JSON')
    .action(guard(cmdRecall))

  program
    .command('hint-stats')
    .description('per-category efficacy report for token-goat\'s discretionary hint hooks (emitted/acted-on/suppression)')
    .option('--json', 'output JSON')
    .option('--reset', 'clear all tracked emissions and manual marks')
    .option('--mark-effective <category>', 'record a manual "effective" vote for a hint category')
    .option('--mark-ineffective <category>', 'record a manual "ineffective" vote for a hint category')
    .action(guard(cmdHintStats))

  program
    .command('statusline')
    .description('render one line of terminal status text from a harness statusline payload on stdin (Claude Code statusLine.command)')
    .option('--json', 'emit the underlying data as JSON instead of a rendered line (debug)')
    .action(guard(cmdStatusline))

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
    .command('note <action> [key] [value]')
    .description('per-project key-value notes (actions: set, get, unset, list, clear)')
    .option('-j, --json', 'output as JSON (list action only)')
    .action((action: string, key: string | undefined, value: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdNote(action, key, value, opts))(),
    )

  program
    .command('note-add <file>')
    .description(
      'attach a free-text architecture note to a file, or to one specific indexed symbol within it (--symbol NAME), fingerprinting what the note describes so `note-list --stale-only` can flag it once the code changes',
    )
    .option('--symbol <name>', 'attach the note to one indexed symbol in the file instead of the whole file')
    .option('--content-from <source>', 'read the note content (Markdown) from this source file')
    .option('--content-b64 <payload>', 'base64 payload for the note content')
    .action(guard(cmdNoteAdd))

  program
    .command('note-get <file>')
    .description('read back the note attached to a file, or to one indexed symbol within it (--symbol NAME); flags whether it has gone stale since it was written')
    .option('--symbol <name>', 'read the note attached to this indexed symbol instead of the whole-file note')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { symbol?: string; json?: boolean }) =>
      runExitText(() =>
        runNoteGet({
          file,
          ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('note-list')
    .description('list every recorded architecture note; --stale-only shows just the notes whose attached file/symbol changed since they were written')
    .option('--stale-only', 'only list notes whose fingerprint no longer matches the current index')
    .option('-j, --json', 'output as JSON')
    .action((opts: { staleOnly?: boolean; json?: boolean }) =>
      runExitText(() =>
        runNoteList({
          ...(opts.staleOnly === true ? { staleOnly: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
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
    .command('mcp-history')
    .description('list cached MCP tool result entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdMcpHistory(opts))())

  program
    .command('reclaim-index')
    .description('shrink an oversized symbol index: VACUUM, or --rebuild to drop derived rows so the next index run re-derives them')
    .option('--rebuild', 'also drop all derived rows (files/symbols/refs/chunks) so the next `token-goat index` reparses from scratch under current parser rules')
    .option('--db-path <path>', 'index database to reclaim (default: the global index)')
    .option('--force', 'proceed even if the worker daemon appears to be running')
    .option('-j, --json', 'output as JSON')
    .action((opts: { rebuild?: boolean; dbPath?: string; json?: boolean; force?: boolean }) =>
      guard(() => cmdReclaimIndex(opts))(),
    )

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
    .option('--suggest-mem', 'also scan CLAUDE.md/AGENTS.md for preference-shaped bullets and suggest `mem import --from-md` (advisory only; never invokes mem)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { subagent?: boolean; json?: boolean; suggestMem?: boolean }) => guard(() => cmdBaseline(opts))())

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
    .option('--dry-run', 'with prune, preview removals without touching the config file')
    .action((action: string, pathArg: string | undefined, opts: { json?: boolean; dryRun?: boolean }) =>
      guard(() =>
        cmdProject({
          action,
          ...(pathArg !== undefined ? { pathArg } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        }),
      )())

  program
    .command('compact-doc <path>')
    .description('build/refresh an extractive compact sidecar for a document; pre_read serves it in place of the full file when fresh. --heading is a legacy mode that extracts one section via a `<!-- COMPACT_END -->` marker instead.')
    .option('--heading <heading>', 'legacy mode: compact only the named section (COMPACT_END marker)')
    .option('--force', 'rebuild the sidecar even if a fresh one already exists')
    .option('--sentences <n>', 'sentences to keep per section (default: 2)')
    .option('--show', 'print the sidecar content to stdout')
    .option('-j, --json', 'output as JSON')
    .action((filePath: string, opts: { heading?: string; json?: boolean; force?: boolean; sentences?: string; show?: boolean }) =>
      guard(() => cmdCompactDoc({
        filePath,
        ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
        ...(opts.json === true ? { json: true } : {}),
        ...(opts.force === true ? { force: true } : {}),
        ...(opts.sentences !== undefined ? { sentences: opts.sentences } : {}),
        ...(opts.show === true ? { show: true } : {}),
      }))())

  program
    .command('session-schema [table]')
    .description('authoritative schema discovery for Copilot session_store_sql (DuckDB/SQLite) and session SQLite tables instead of trial-and-error SELECT *')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdSessionSchema))

  program
    .command('describe [target] [table]')
    .description('describe columns and structure of a session store table or SQLite database file instead of querying SELECT *')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdDescribe))
}

