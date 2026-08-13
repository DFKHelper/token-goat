/**
 * Guard against the "command exists but the gate never learned about it" class.
 *
 * `buildGuidanceBody` in `../../src/bridges/guidance_block.ts` is the single source of the
 * routing gate written unprompted into CLAUDE.md, AGENTS.md, `.github/copilot-instructions.md`
 * and the installed SKILL.md — the only description of token-goat a model gets without asking
 * for one. Three real bugs shipped from the same root cause: a CLI command existed and worked,
 * but nobody updated this prose to mention it, so an agent never learned it existed and fell
 * back to a full-file read every time (fixed in c6df9746, c8369b51/a2a76dc7, 04d0abe9). Nothing
 * previously stopped a fourth instance of the same class.
 *
 * Coverage choice: this guard checks the `Commands:` reference line only, not the failure-shape
 * rows. The two are deliberately NOT the same bar. The `Commands:` line is a flat, mechanical
 * inventory — every command judged gate-worthy belongs there, and "is `name` a substring of this
 * one line" is a fact a test can check. A failure-shape row is a *prose judgment call*: which
 * misuse pattern a command replaces, phrased so an agent recognizes its own behavior ("a shell
 * text search with context flags", "paging one function with view/view_range"). That phrasing
 * can't be derived mechanically from a command's name or Commander description, and forcing one
 * to exist per command would either produce meaningless one-line paraphrases of the description
 * (defeating the point of curated failure shapes) or block this guard on a judgment call it can't
 * make. Instead: every command that reaches the gate is machine-verified present in `Commands:`;
 * whether it *also* deserves a failure-shape row remains a human decision made at the same time
 * the command is added to the gate (as happened for json-query, mcp-output, and brief below).
 *
 * Commands that legitimately never belong in the gate — operator/lifecycle commands, session/cache
 * introspection, derived-analysis tools, single-format extractors already covered by a generic
 * failure shape, write/mutation commands, and read-adjacent navigation utilities outside the gate's
 * four core failure shapes — are named in OMISSIONS below, each with a one-line reason. A command
 * that is neither in the guidance body's `Commands:` line nor in OMISSIONS fails this test: that is
 * exactly the "nobody decided" state that let the three historical bugs ship.
 */

import { describe, expect, it } from 'vitest'

import { buildGuidanceBody } from '../../src/bridges/guidance_block.js'
import { allCommandNames } from '../registry.js'

interface Omission {
  readonly command: string
  readonly reason: string
}

const LIFECYCLE_REASON = "operator/lifecycle command (installs, configures, starts, or manages token-goat itself) — not a read-routing decision an agent makes mid-task"
const SESSION_REASON = "inspects token-goat's own session, cache, or spend state, not a file the gate is meant to intercept a read of"
const ANALYSIS_REASON = "derived analysis/graph command (dependency, call, coverage, or noise-fold output) — not a drop-in replacement for a plain file read"
const FORMAT_EXTRACT_REASON = "narrow single-format extractor; the generic failure-shape rows (json/yaml-query, image-meta/image-text) already name the pattern without enumerating every supported format"
const WRITE_REASON = "writes or mutates a file rather than reading one — outside the read-routing gate's scope"
const NAV_REASON = "read-adjacent search/listing utility that falls outside the gate's four core failure shapes (symbol body, doc section, callers, concept search); omitted to keep the gate small enough to actually apply on every read"

const OMISSIONS: readonly Omission[] = [
  // Lifecycle / operator
  { command: 'install', reason: LIFECYCLE_REASON },
  { command: 'uninstall', reason: LIFECYCLE_REASON },
  { command: 'worker', reason: LIFECYCLE_REASON },
  { command: 'worker start', reason: LIFECYCLE_REASON },
  { command: 'worker stop', reason: LIFECYCLE_REASON },
  { command: 'worker status', reason: LIFECYCLE_REASON },
  { command: 'hook', reason: LIFECYCLE_REASON },
  { command: 'index', reason: LIFECYCLE_REASON },
  { command: 'doctor', reason: LIFECYCLE_REASON },
  { command: 'mcp-serve', reason: LIFECYCLE_REASON },
  { command: 'stats', reason: LIFECYCLE_REASON },
  { command: 'bridges-status', reason: LIFECYCLE_REASON },
  { command: 'commands', reason: LIFECYCLE_REASON },
  { command: 'context-stats', reason: LIFECYCLE_REASON },
  { command: 'bootstrap-audit', reason: LIFECYCLE_REASON },
  { command: 'reclaim-index', reason: LIFECYCLE_REASON },
  { command: 'clean-cache', reason: LIFECYCLE_REASON },
  { command: 'prune-cache', reason: LIFECYCLE_REASON },
  { command: 'cache-audit', reason: LIFECYCLE_REASON },
  { command: 'config', reason: LIFECYCLE_REASON },
  { command: 'project', reason: LIFECYCLE_REASON },
  { command: 'version', reason: LIFECYCLE_REASON },

  // Session / cache introspection
  { command: 'memory', reason: SESSION_REASON },
  { command: 'waste', reason: SESSION_REASON },
  { command: 'hint-stats', reason: SESSION_REASON },
  { command: 'statusline', reason: SESSION_REASON },
  { command: 'session-outline', reason: SESSION_REASON },
  { command: 'session-slice', reason: SESSION_REASON },
  { command: 'mcp-audit', reason: SESSION_REASON },
  { command: 'recall', reason: SESSION_REASON },
  { command: 'bash-history', reason: SESSION_REASON },
  { command: 'web-history', reason: SESSION_REASON },
  { command: 'mcp-history', reason: SESSION_REASON },
  { command: 'resume', reason: SESSION_REASON },
  { command: 'compact-hint', reason: SESSION_REASON },
  { command: 'session-summary', reason: SESSION_REASON },
  { command: 'cost', reason: SESSION_REASON },
  { command: 'baseline', reason: SESSION_REASON },
  { command: 'retrieve', reason: SESSION_REASON },
  { command: 'handoff-create', reason: SESSION_REASON },
  { command: 'handoff-resolve', reason: SESSION_REASON },
  { command: 'compress-text', reason: SESSION_REASON },
  { command: 'compress', reason: SESSION_REASON },

  // Derived analysis
  { command: 'callers', reason: ANALYSIS_REASON },
  { command: 'call-chain', reason: ANALYSIS_REASON },
  { command: 'impact', reason: ANALYSIS_REASON },
  { command: 'dead', reason: ANALYSIS_REASON },
  { command: 'deps', reason: ANALYSIS_REASON },
  { command: 'types', reason: ANALYSIS_REASON },
  { command: 'scope', reason: ANALYSIS_REASON },
  { command: 'similar', reason: ANALYSIS_REASON },
  { command: 'context-for', reason: ANALYSIS_REASON },
  { command: 'test-for', reason: ANALYSIS_REASON },
  { command: 'coverage-gaps', reason: ANALYSIS_REASON },
  { command: 'coverage-report-gaps', reason: ANALYSIS_REASON },
  { command: 'arch', reason: ANALYSIS_REASON },
  { command: 'blame', reason: ANALYSIS_REASON },
  { command: 'ask', reason: ANALYSIS_REASON },
  { command: 'pack', reason: ANALYSIS_REASON },
  { command: 'tokens', reason: ANALYSIS_REASON },
  { command: 'budget', reason: ANALYSIS_REASON },
  { command: 'failures', reason: ANALYSIS_REASON },
  { command: 'todo', reason: ANALYSIS_REASON },
  { command: 'trace', reason: ANALYSIS_REASON },
  { command: 'logfold', reason: ANALYSIS_REASON },
  { command: 'lockdeps', reason: ANALYSIS_REASON },
  { command: 'dep-docs', reason: ANALYSIS_REASON },
  { command: 'hot', reason: ANALYSIS_REASON },
  { command: 'recent', reason: ANALYSIS_REASON },
  { command: 'ignores', reason: ANALYSIS_REASON },
  { command: 'conflicts', reason: ANALYSIS_REASON },

  // Single-format extractors
  { command: 'pdf-extract', reason: FORMAT_EXTRACT_REASON },
  { command: 'pdf-outline', reason: FORMAT_EXTRACT_REASON },
  { command: 'pdf-meta', reason: FORMAT_EXTRACT_REASON },
  { command: 'sharepoint-resolve', reason: FORMAT_EXTRACT_REASON },
  { command: 'video-chapters', reason: FORMAT_EXTRACT_REASON },
  { command: 'xlsx-sheets', reason: FORMAT_EXTRACT_REASON },
  { command: 'xlsx-head', reason: FORMAT_EXTRACT_REASON },
  { command: 'xlsx-range', reason: FORMAT_EXTRACT_REASON },
  { command: 'xlsx-query', reason: FORMAT_EXTRACT_REASON },
  { command: 'pptx-outline', reason: FORMAT_EXTRACT_REASON },
  { command: 'pptx-slide', reason: FORMAT_EXTRACT_REASON },
  { command: 'pptx-notes', reason: FORMAT_EXTRACT_REASON },
  { command: 'pptx-text', reason: FORMAT_EXTRACT_REASON },
  { command: 'docx-outline', reason: FORMAT_EXTRACT_REASON },
  { command: 'docx-text', reason: FORMAT_EXTRACT_REASON },
  { command: 'transcript-outline', reason: FORMAT_EXTRACT_REASON },
  { command: 'transcript', reason: FORMAT_EXTRACT_REASON },
  { command: 'csv-query', reason: FORMAT_EXTRACT_REASON },
  { command: 'csv-profile', reason: FORMAT_EXTRACT_REASON },
  { command: 'openapi-outline', reason: FORMAT_EXTRACT_REASON },
  { command: 'openapi-op', reason: FORMAT_EXTRACT_REASON },
  { command: 'zip-list', reason: FORMAT_EXTRACT_REASON },
  { command: 'zip-read', reason: FORMAT_EXTRACT_REASON },
  { command: 'pr-slice', reason: FORMAT_EXTRACT_REASON },
  { command: 'sqlite-schema', reason: FORMAT_EXTRACT_REASON },
  { command: 'sqlite-query', reason: FORMAT_EXTRACT_REASON },
  { command: 'fetch-image', reason: FORMAT_EXTRACT_REASON },
  { command: 'screenshot', reason: FORMAT_EXTRACT_REASON },

  // Write / mutation
  { command: 'write-file', reason: WRITE_REASON },
  { command: 'replace', reason: WRITE_REASON },
  { command: 'insert-section', reason: WRITE_REASON },
  { command: 'note-add', reason: WRITE_REASON },
  { command: 'note-get', reason: WRITE_REASON },
  { command: 'note-list', reason: WRITE_REASON },
  { command: 'note', reason: WRITE_REASON },

  // Navigation / listing utilities outside the four core failure shapes
  { command: 'exports', reason: NAV_REASON },
  { command: 'imports', reason: NAV_REASON },
  { command: 'find', reason: NAV_REASON },
  { command: 'grep', reason: NAV_REASON },
  { command: 'skill-body', reason: NAV_REASON },
  { command: 'skill-compact', reason: NAV_REASON },
  { command: 'skill-list', reason: NAV_REASON },
  { command: 'skill-size', reason: NAV_REASON },
  { command: 'skill-history', reason: NAV_REASON },
  { command: 'skill-diff', reason: NAV_REASON },
  { command: 'skill-section', reason: NAV_REASON },
  { command: 'diff', reason: NAV_REASON },
  { command: 'log', reason: NAV_REASON },
  { command: 'history', reason: NAV_REASON },
  { command: 'compact-doc', reason: NAV_REASON },
]

describe('guidance body command coverage', () => {
  it('every OMISSIONS entry names a real, currently-registered command', () => {
    const registered = new Set(allCommandNames())
    const stale = OMISSIONS.filter((o) => !registered.has(o.command)).map((o) => o.command)
    expect(stale, `OMISSIONS in tests/guards/guidance_body_command_coverage.test.ts names command(s) that no longer exist: ${stale.join(', ')}. Remove the stale entry.`).toEqual([])
  })

  it('every registered CLI command is either named in the guidance gate or has a reasoned omission', () => {
    const body = buildGuidanceBody("Claude Code's own Read, Grep, and Glob preference rules")
    const commandsLine = body.split('\n').find((line) => line.startsWith('Commands:')) ?? ''
    const omitted = new Set(OMISSIONS.map((o) => o.command))

    const undecided = allCommandNames().filter((name) => {
      const base = name.split(' ')[0] ?? name // top-level word for subcommands like "worker start"
      const namedInGate = new RegExp(`\\b${base}\\b`).test(commandsLine)
      return !namedInGate && !omitted.has(name)
    })

    expect(
      undecided,
      undecided.length === 0
        ? ''
        : `New CLI command(s) exist that are neither named in buildGuidanceBody's "Commands:" line ` +
          `nor listed in OMISSIONS: ${undecided.join(', ')}. This is the exact gap that shipped three ` +
          `real bugs (a command worked but the routing gate never told an agent it existed). Decide, ` +
          `then either (a) add it to the "Commands:" line in src/bridges/guidance_block.ts (and a ` +
          `failure-shape row if it replaces a recognizable misuse pattern), or (b) add ` +
          `{ command: '${undecided[0] ?? ''}', reason: '...' } to OMISSIONS in ` +
          `tests/guards/guidance_body_command_coverage.test.ts with a one-line reason it doesn't belong in the gate.`,
    ).toEqual([])
  })
})
