import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyHintTracking,
  classifyBashHint,
  classifyEditHint,
  classifyReadHint,
  extractPathCorrelator,
  getHintStatsSummary,
  getHintStatsTotals,
  isHintCategory,
  isProbeOccasion,
  logHintEmission,
  markCategoryEffective,
  markCategoryIneffective,
  meetsSavingsFloor,
  resetHintStats,
  resolvePendingHintsForEvent,
  shouldSuppress,
  HINT_CATEGORIES,
} from '../src/hint_stats.js'
import { getDb } from '../src/db.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { defaultConfig, saveConfig, invalidateConfigCache } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'

function nonce(): string {
  return `hs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    agentId: undefined,
    raw: {},
  }
}

function readEvent(sessionId: string, filePath: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: filePath },
    sessionId,
    agentId: undefined,
    raw: {},
  }
}

// saveConfig does not create configPath()'s parent directory itself; make sure it
// exists before writing (same pattern as bash_runner.test.ts / tool_filters_*.test.ts).
fs.mkdirSync(path.dirname(configPath()), { recursive: true })

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
  // Regression (#50): several tests in this file call saveConfig() against the real,
  // unmocked configPath() -- which resolves to the DATA_DIR shared by every test file
  // running in this vitest worker (isolate-home.ts pins DATA_DIR per worker PID, not per
  // file). saveConfig() always serializes the FULL config object, so even a test that
  // only means to set hint_stats.min_sample_size also persists an explicit
  // compact_assist.auto_trigger_multiplier at its default value. Left uncleaned, that
  // flips isAutoTriggerMultiplierExplicit() to true for the rest of this worker's test
  // run, corrupting getContextPressure()'s tier/fillFraction for any sibling test file
  // that relies on the harness-default multiplier (observed in
  // cache_session_commands.test.ts's tier assertion). Restore the shared config.toml to
  // its absent/default state after every test, the same way tool_filters_git.test.ts,
  // tool_filters_misc.test.ts, and tool_filters_shell_file.test.ts already do.
  invalidateConfigCache()
  try {
    fs.unlinkSync(configPath())
  } catch {
    // ok — may not exist
  }
})

describe('isHintCategory', () => {
  it('accepts exactly the five tracked categories', () => {
    for (const c of HINT_CATEGORIES) {
      expect(isHintCategory(c)).toBe(true)
    }
    expect(isHintCategory('not_a_category')).toBe(false)
    expect(isHintCategory('')).toBe(false)
  })
})

describe('extractPathCorrelator', () => {
  it('extracts an absolute Windows path', () => {
    expect(extractPathCorrelator('Use `token-goat read "C:/repo/src/mod.ts::Foo"` instead.')).toBe('C:/repo/src/mod.ts::Foo')
  })

  it('extracts an absolute POSIX path', () => {
    expect(extractPathCorrelator('was already read this session; see /home/user/repo/file.md')).toBe('/home/user/repo/file.md')
  })

  it('returns null when no path-shaped substring is present', () => {
    expect(extractPathCorrelator('Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass).')).toBe(null)
  })

  it('trims trailing sentence punctuation', () => {
    expect(extractPathCorrelator('See C:/repo/file.ts for details.')).toBe('C:/repo/file.ts')
  })

  // Regression: hint text templates in hooks_edit.ts/hooks_read.ts splice a literal
  // `::<placeholder>` (e.g. `::HeadingName`, `::SectionName`, `::<field>`, `::Symbol`,
  // `::SymbolName`, `::name`, or a bracketed `::<...>` name) onto the real path so a human
  // reads it as "put a heading/symbol name here" -- not a real value. An agent that actually
  // follows the hint substitutes its own concrete heading/symbol, so isActedOn's
  // `command.includes(correlator)` check could never match if the correlator kept the literal
  // placeholder text, permanently pinning the category's efficacy at 0% and triggering
  // auto-suppression despite perfect real-world follow-through. The correlator must therefore
  // be just the bare path when the `::` suffix is one of these known placeholders.
  it('strips a known literal placeholder suffix, keeping only the bare path', () => {
    expect(extractPathCorrelator('Use `token-goat section "C:/repo/README.md::HeadingName"` to re-read a specific section.')).toBe('C:/repo/README.md')
    expect(extractPathCorrelator('Use `token-goat section "' + '/a/b.md' + '::SectionName"` to read one section.')).toBe('/a/b.md')
    expect(extractPathCorrelator('Use `token-goat section "' + '/a/b.json' + '::<field>"` to extract just the value.')).toBe('/a/b.json')
    expect(extractPathCorrelator('Use `token-goat read "' + '/a/b.ts' + '::SymbolName"` for one function.')).toBe('/a/b.ts')
  })

  // Regression: hooks_bash.ts's markdown-heading-grep and extractNodeFileRead hints splice
  // `::Heading`, `::sectionName`, and `::table_name` onto the real path, but none of the three
  // were in KNOWN_CORRELATOR_PLACEHOLDERS -- the exact same permanently-pinned-at-0%-efficacy
  // bug the placeholder set exists to prevent, just for a hint family not covered by the
  // original regression test above.
  it('strips the hooks_bash.ts placeholder suffixes (Heading, sectionName, table_name)', () => {
    expect(extractPathCorrelator('Use `token-goat outline "/a/b.md"` to get all headings — then `token-goat section "/a/b.md::Heading"` to read one section.')).toBe('/a/b.md')
    expect(extractPathCorrelator('Use `token-goat config-get "/a/b.yaml" KEY_NAME` or `token-goat section "/a/b.yaml::sectionName"` to read a specific value.')).toBe('/a/b.yaml')
    expect(extractPathCorrelator('Use `token-goat section "/a/b.sql::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')).toBe('/a/b.sql')
  })

  it('keeps a concrete, non-placeholder :: suffix (e.g. a real tsconfig field name)', () => {
    expect(extractPathCorrelator('Use `token-goat section "/a/tsconfig.json::compilerOptions"` to extract compiler options.')).toBe(
      '/a/tsconfig.json::compilerOptions',
    )
  })
})

describe('classifyBashHint', () => {
  it('classifies a bash-output recall hint by its embedded id', () => {
    const result = classifyBashHint('Prior output from `npm test` is cached. Use `token-goat bash-output ab12cd34` to recall the full file.')
    expect(result.category).toBe('bash_recall')
    expect(result.correlator).toBe('ab12cd34')
  })

  it(
    'classifies a `bash-output --file "<path>"` hint by the quoted path, not the literal --file flag ' +
      '(regression: [A-Za-z0-9_.-]+ includes "-", so the bare-id regex matched "--file" itself as the ' +
      'correlator, making isActedOn credit ANY later bash-output --file call regardless of which file it targeted)',
    () => {
      const result = classifyBashHint(
        '`.output` files are JSONL agent transcripts. Use `token-goat bash-output --file "C:/Projects/tasks/abc.output" --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail N`, instead of hand-parsing the JSONL.',
      )
      expect(result.category).toBe('bash_recall')
      expect(result.correlator).toBe('C:/Projects/tasks/abc.output')
      expect(result.correlator).not.toBe('--file')
    },
  )

  it('classifies a surgical-redirect hint by its embedded path when no bash-output id is present', () => {
    const result = classifyBashHint('`cat` loads the entire file into context. Use `token-goat read "C:/repo/file.ts::SymbolName"` to read one function or class.')
    expect(result.category).toBe('bash_redirect')
    // Regression: "SymbolName" is the literal placeholder this hint text template splices onto
    // the path -- an agent following the hint substitutes a real symbol name, so the correlator
    // must be the bare path (see extractPathCorrelator's regression test for the full explanation).
    expect(result.correlator).toBe('C:/repo/file.ts')
  })

  it('falls back to a null correlator when the redirect hint has no extractable path', () => {
    const result = classifyBashHint('Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass). For symbol discovery: `token-goat refs <symbol>` or `token-goat semantic`.')
    expect(result.category).toBe('bash_redirect')
    expect(result.correlator).toBe(null)
  })
})

describe('classifyReadHint', () => {
  it('classifies a re-read dedup hint', () => {
    const result = classifyReadHint('Note: C:/repo/file.ts was already read this session (2 reads). Use `token-goat read "C:/repo/file.ts::Foo"`.')
    expect(result.category).toBe('read_reread_dedup')
    expect(result.correlator).toBe('C:/repo/file.ts')
  })

  it('classifies a structural-navigation hint', () => {
    const result = classifyReadHint('C:/repo/file.ts is 400 lines. Use `token-goat skeleton "C:/repo/file.ts"` for structural navigation.')
    expect(result.category).toBe('read_structural_nav')
    expect(result.correlator).toBe('C:/repo/file.ts')
  })
})

describe('classifyEditHint', () => {
  it('always classifies as edit_reread_suggest', () => {
    const result = classifyEditHint('README.md was edited. Use `token-goat section "C:/repo/README.md::HeadingName"` to re-read a specific section.')
    expect(result.category).toBe('edit_reread_suggest')
    // Regression: "HeadingName" is the literal placeholder this hint text template splices onto
    // the path -- an agent following the hint substitutes a real heading, so the correlator must
    // be the bare path, not the placeholder text (see extractPathCorrelator's regression test
    // above for the full explanation).
    expect(result.correlator).toBe('C:/repo/README.md')
  })
})

describe('logHintEmission', () => {
  it('inserts an unresolved pending row when a correlator is present', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as
      | { resolved: number; acted_on: number; calls_remaining: number }
      | undefined
    expect(row).toBeDefined()
    expect(row?.resolved).toBe(0)
    expect(row?.acted_on).toBe(0)
    // Pins the actual default (hint_stats.ts's private ACTED_ON_WINDOW = 5) rather than just
    // "some positive number" -- a `toBeGreaterThan(0)` here would pass unchanged even if a
    // regression made every emission carry the compensateSelfResolve +1 bump regardless of the
    // call site (this call passes no fourth argument, so compensateSelfResolve defaults false
    // and calls_remaining must be exactly ACTED_ON_WINDOW, not ACTED_ON_WINDOW + 1).
    expect(row?.calls_remaining).toBe(5)
  })

  it('inserts an already-resolved, not-acted-on row when no correlator is available', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number } | undefined
    expect(row?.resolved).toBe(1)
    expect(row?.acted_on).toBe(0)
  })

  it('still counts toward emitted even with a null correlator', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_redirect')
    expect(row?.emitted).toBe(1)
    expect(row?.actedOn).toBe(0)
  })

  it('persists the bytesEmitted spend figure passed by the caller', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null, false, 123)
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT bytes_emitted FROM hint_emissions WHERE session_id = ?').get(n) as { bytes_emitted: number | null }
    expect(row.bytes_emitted).toBe(123)
  })

  it('defaults bytesEmitted to NULL (not 0) when the caller does not pass one', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT bytes_emitted FROM hint_emissions WHERE session_id = ?').get(n) as { bytes_emitted: number | null }
    expect(row.bytes_emitted).toBe(null)
  })
})

describe('getHintStatsSummary — spend (bytesEmitted/legacyEmissions)', () => {
  it('reports bytesEmitted null and legacyEmissions 0 for a category with zero emissions', () => {
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'read_reread_dedup')
    expect(row?.emitted).toBe(0)
    expect(row?.bytesEmitted).toBe(null)
    expect(row?.legacyEmissions).toBe(0)
  })

  it('sums bytesEmitted across emissions that all carry a tracked spend figure', () => {
    logHintEmission('read_reread_dedup', nonce(), null, false, 100)
    logHintEmission('read_reread_dedup', nonce(), null, false, 50)
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'read_reread_dedup')
    expect(row?.emitted).toBe(2)
    expect(row?.bytesEmitted).toBe(150)
    expect(row?.legacyEmissions).toBe(0)
  })

  it('reports bytesEmitted null (not a fake 0) when every emission predates spend tracking', () => {
    // Simulates a pre-migration row: bytes_emitted left unset, same shape the v9->v10 ALTER
    // TABLE migration leaves a pre-existing row in (see db.test.ts's v9->v10 migration test).
    logHintEmission('edit_reread_suggest', nonce(), null)
    logHintEmission('edit_reread_suggest', nonce(), null)
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'edit_reread_suggest')
    expect(row?.emitted).toBe(2)
    expect(row?.bytesEmitted).toBe(null)
    expect(row?.legacyEmissions).toBe(2)
  })

  it('sums only the tracked rows and reports the legacy count separately for a mixed category', () => {
    logHintEmission('bash_recall', nonce(), null) // legacy: no spend figure
    logHintEmission('bash_recall', nonce(), null, false, 80) // tracked
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_recall')
    expect(row?.emitted).toBe(2)
    expect(row?.bytesEmitted).toBe(80)
    expect(row?.legacyEmissions).toBe(1)
  })
})

describe('resolvePendingHintsForEvent', () => {
  it('marks acted_on when a subsequent Bash command mentions the exact correlator (bash_redirect)', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/file.ts::Foo"'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.resolved).toBe(1)
    expect(row.acted_on).toBe(1)
  })

  it('requires the bash-output id itself for bash_recall, not just any token-goat call', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'ab12cd34')
    // A token-goat call that does NOT reference this id must not count as acted-on.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output zz99yy88'))

    let db = getDb(globalDbPath())
    let row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0) // still pending — window not exhausted yet

    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output ab12cd34'))
    db = getDb(globalDbPath())
    row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(1)
    expect(row.resolved).toBe(1)
  })

  // Regression (mutation-testing gap): isActedOn requires a bash_recall's later command to
  // contain the literal substring 'bash-output', not merely mention the exact correlator id
  // somewhere in a token-goat invocation -- an id could coincidentally reappear as an argument
  // to a completely different subcommand. Dropping that requirement still passed the full
  // suite, since no existing fixture exercises a token-goat command that mentions the correlator
  // without also being a bash-output call.
  it('does not credit acted_on for bash_recall when the correlator id appears in an unrelated token-goat subcommand, not a bash-output call', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'ab12cd34')
    // The id reappears verbatim as, say, a grep pattern argument to an unrelated subcommand --
    // never actually recalling the cached output the hint pointed at.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat grep ab12cd34'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
  })

  it('does not credit acted_on when a later command touches a different file that merely shares the correlator as a prefix (e.g. foo.ts vs foo.tsx)', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/foo.ts')
    // foo.tsx is a distinct, unrelated file whose path happens to start with the exact
    // correlator text 'C:/repo/foo.ts' -- a naive `command.includes(correlator)` check would
    // wrongly credit this as following the hint about foo.ts.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/foo.tsx::Foo"'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
  })

  it('does not credit acted_on for bash_recall when a later id merely shares the correlator as a prefix (e.g. ab12 vs ab1234)', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'ab12')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output ab1234'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
  })

  // Regression: commandMentionsCorrelator only checked the character AFTER a substring match
  // (guarding the prefix-collision direction above, e.g. ab12 vs ab1234), never the character
  // BEFORE it -- so a later id that merely shares the correlator as a SUFFIX of a longer,
  // distinct token (e.g. correlator '1234abcd' inside 'x1234abcd') was wrongly credited as
  // acted-on. Mirrors read_commands.ts's endsWithPathBoundary / coverage_query.ts's
  // endsWithPathBoundaryLocal convention, which both guard the boundary on the side missing here.
  it('does not credit acted_on for bash_recall when a later id merely shares the correlator as a suffix (e.g. 1234abcd vs x1234abcd)', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, '1234abcd')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output x1234abcd'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
  })

  it('resolves as not-acted-on once the window is exhausted by unrelated tool calls', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    for (let i = 0; i < 10; i++) {
      resolvePendingHintsForEvent(readEvent(n, `C:/repo/unrelated-${i}.ts`))
    }
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as {
      resolved: number
      acted_on: number
      calls_remaining: number
    }
    expect(row.resolved).toBe(1)
    expect(row.acted_on).toBe(0)
  })

  it('resolves exactly on the ACTED_ON_WINDOW-th unrelated call, not one call earlier or later', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    // ACTED_ON_WINDOW is 5 (see the module doc comment) -- 4 unrelated calls must leave the row
    // pending (calls_remaining decrements to 1, not 0), and the 5th must be the one that flips it
    // to resolved. A `calls_remaining < 0` off-by-one would instead require a 6th call.
    for (let i = 0; i < 4; i++) {
      resolvePendingHintsForEvent(readEvent(n, `C:/repo/unrelated-${i}.ts`))
    }
    const db = getDb(globalDbPath())
    let row = db.prepare('SELECT resolved, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; calls_remaining: number }
    expect(row.resolved).toBe(0)
    expect(row.calls_remaining).toBe(1)

    resolvePendingHintsForEvent(readEvent(n, 'C:/repo/unrelated-4.ts'))
    row = db.prepare('SELECT resolved, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; calls_remaining: number }
    expect(row.resolved).toBe(1)
  })

  it('does not resolve pending hints from a different session', () => {
    const n = nonce()
    const other = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    resolvePendingHintsForEvent(bashEvent(other, 'token-goat read "C:/repo/file.ts::Foo"'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0)
  })

  it('does not credit acted_on when "token-goat" only appears as a path segment, not an actual CLI invocation', () => {
    // This project's own working directory is literally named "token-goat", so a command that
    // re-runs the exact wasteful pattern the hint warned about -- but whose target path merely
    // lies inside this repo -- must not falsely satisfy the "did the agent invoke token-goat" check.
    const n = nonce()
    const correlator = 'C:/Projects/token-goat/src/hint_stats.ts'
    logHintEmission('bash_redirect', n, correlator)
    resolvePendingHintsForEvent(bashEvent(n, `cat ${correlator}`))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as {
      resolved: number
      acted_on: number
      calls_remaining: number
    }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0) // still pending, window merely decremented -- not falsely resolved as acted-on
  })
})

describe('efficacy calculation', () => {
  it('computes acted-on / emitted as a percentage', () => {
    const n1 = nonce()
    const n2 = nonce()
    const n3 = nonce()
    // A redirect category is the right vehicle for this arithmetic: it is the polarity where a
    // hint that times out unfollowed genuinely means "not acted on", so the 1-of-3 split the
    // percentage is checked against is real. A suppression category would give 3 of 3 here,
    // because leaving b.ts and c.ts unread is precisely what those hints asked for -- see
    // 'acted-on polarity for suppression-shaped hints' below.
    logHintEmission('bash_redirect', n1, 'C:/repo/a.ts')
    logHintEmission('bash_redirect', n2, 'C:/repo/b.ts')
    logHintEmission('bash_redirect', n3, 'C:/repo/c.ts')
    resolvePendingHintsForEvent(bashEvent(n1, 'token-goat read "C:/repo/a.ts::Foo"'))
    // n2 and n3 time out unresolved (not acted on).
    for (let i = 0; i < 6; i++) {
      resolvePendingHintsForEvent(readEvent(n2, 'C:/other.ts'))
      resolvePendingHintsForEvent(readEvent(n3, 'C:/other.ts'))
    }

    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_redirect')
    expect(row?.emitted).toBe(3)
    expect(row?.actedOn).toBe(1)
    expect(row?.efficacyPct).toBeCloseTo(33.3, 1)
  })

  it('reports null efficacy for a category with zero emissions', () => {
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'edit_reread_suggest')
    expect(row?.emitted).toBe(0)
    expect(row?.efficacyPct).toBe(null)
  })
})

describe('shouldSuppress — threshold + minimum sample size', () => {
  it('never suppresses below the configured minimum sample size, even at 0% efficacy', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 4; i++) {
      const n = nonce()
      logHintEmission('bash_redirect', n, null) // resolved immediately, never acted on
    }
    expect(shouldSuppress('bash_redirect', nonce())).toBe(false)
  })

  it('suppresses once both the sample-size floor and the efficacy threshold are crossed', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 5; i++) {
      const n = nonce()
      logHintEmission('bash_redirect', n, null) // 0% acted-on
    }
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)
  })

  it('does not suppress a category whose efficacy is at/above threshold regardless of sample size', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 4
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 4; i++) {
      const n = nonce()
      logHintEmission('bash_recall', n, `id-${i}`)
      resolvePendingHintsForEvent(bashEvent(n, `token-goat bash-output id-${i}`))
    }
    expect(shouldSuppress('bash_recall', nonce())).toBe(false)
  })

  it('respects a reconfigured threshold/sample size', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 2
    cfg.hint_stats.suppress_threshold_pct = 50
    saveConfig(cfg)

    const nActed = nonce()
    logHintEmission('read_structural_nav', nActed, 'C:/repo/a.ts')
    resolvePendingHintsForEvent(bashEvent(nActed, 'token-goat skeleton "C:/repo/a.ts"'))
    const nNotActed = nonce()
    logHintEmission('read_structural_nav', nNotActed, null)
    // 1/2 = 50%, not below a 50% threshold.
    expect(shouldSuppress('read_structural_nav', nonce())).toBe(false)

    cfg.hint_stats.suppress_threshold_pct = 60
    saveConfig(cfg)
    // Same 50% data, now below a 60% threshold.
    expect(shouldSuppress('read_structural_nav', nonce())).toBe(true)
  })

  // Regression (mutation-testing gap): getHintStatsSummary's per-category `suppressed` field is
  // never asserted anywhere else in this file (every other test only checks emitted/actedOn/
  // efficacyPct, or calls the standalone shouldSuppress() directly). Hardcoding
  // `suppressed: false` in getHintStatsSummary still passed the full suite.
  it('reflects a suppressed category in getHintStatsSummary\'s per-category suppressed field', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100 // guarantee suppression on the first sample
    saveConfig(cfg)

    logHintEmission('bash_redirect', nonce(), null) // 0% acted-on, resolved
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    const summary = getHintStatsSummary()
    const suppressedRow = summary.find((r) => r.category === 'bash_redirect')
    const notSuppressedRow = summary.find((r) => r.category === 'bash_recall')
    expect(suppressedRow?.suppressed).toBe(true)
    // bash_recall has zero emissions -- below min_sample_size, never suppressed.
    expect(notSuppressedRow?.suppressed).toBe(false)
  })
})

describe('meetsSavingsFloor', () => {
  it('is false when a hint emission carries fewer bytes than hints.min_session_hint_savings_bytes', () => {
    const cfg = defaultConfig()
    cfg.hints.min_session_hint_savings_bytes = 512
    saveConfig(cfg)

    expect(meetsSavingsFloor(100)).toBe(false)
  })

  it('is true once a hint emission meets or exceeds hints.min_session_hint_savings_bytes', () => {
    const cfg = defaultConfig()
    cfg.hints.min_session_hint_savings_bytes = 512
    saveConfig(cfg)

    expect(meetsSavingsFloor(512)).toBe(true)
    expect(meetsSavingsFloor(1024)).toBe(true)
  })

  it('respects a reconfigured floor', () => {
    const cfg = defaultConfig()
    cfg.hints.min_session_hint_savings_bytes = 0
    saveConfig(cfg)
    expect(meetsSavingsFloor(1)).toBe(true)

    cfg.hints.min_session_hint_savings_bytes = 2000
    saveConfig(cfg)
    expect(meetsSavingsFloor(1)).toBe(false)
  })
})

describe('applyHintTracking', () => {
  const classify = (text: string): { category: 'bash_redirect'; correlator: string | null } => ({ category: 'bash_redirect', correlator: extractPathCorrelator(text) })

  it('passes through non-context outputs untouched (deny/pass/rewrite are not hints)', () => {
    const event = bashEvent(nonce(), 'cat file.ts')
    const passOut = { hookType: 'pass' as const }
    expect(applyHintTracking(event, passOut, classify)).toEqual(passOut)
    const denyOut = { hookType: 'deny' as const, message: 'blocked' }
    expect(applyHintTracking(event, denyOut, classify)).toEqual(denyOut)
  })

  it('logs an emission and returns the context output unchanged when not suppressed', () => {
    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/file.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/file.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual(contextOut)

    const summary = getHintStatsSummary()
    // Exactly one applyHintTracking call above, isolated by beforeEach's resetHintStats().
    expect(summary.find((r) => r.category === 'bash_redirect')?.emitted).toBe(1)
  })

  it('records the emitted hint text length as the spend (bytesEmitted) for this emission', () => {
    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/file.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/file.ts::Foo"` instead.' }
    applyHintTracking(event, contextOut, classify)

    const summary = getHintStatsSummary()
    expect(summary.find((r) => r.category === 'bash_redirect')?.bytesEmitted).toBe(contextOut.context.length)
  })

  it('substitutes passOutput() and does not log when the category is suppressed and backoff_thresholds is empty (no probing)', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100 // guarantee suppression on the very first sample
    cfg.hints.backoff_thresholds = [] // no probes: suppression is permanent for this test
    saveConfig(cfg)

    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null) // 0% acted-on, resolved

    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/other.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/other.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual({ hookType: 'pass' })

    // The suppressed emission must not itself have been logged.
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT COUNT(*) AS n FROM hint_emissions WHERE session_id = ?').get(n) as { n: number }
    expect(row.n).toBe(0)
  })

  it('preserves the full ACTED_ON_WINDOW of genuinely subsequent chances for a pre_tool_use-emitted hint, despite the guaranteed self-resolving post_tool_use pass for the same tool call', () => {
    const n = nonce()
    // preBashHandler fires on pre_tool_use — the real production caller of applyHintTracking for
    // bash_redirect hints. Its own post_tool_use event for this SAME command is guaranteed to run
    // resolvePendingHintsForEvent next, before any genuinely later tool call can occur.
    const triggerCommand = 'cat C:/repo/file.ts'
    const preEvent: HookEvent = { eventName: 'pre_tool_use', toolName: 'Bash', toolInput: { command: triggerCommand }, sessionId: n, agentId: undefined, raw: {} }
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/file.ts::Foo"` instead.' }
    applyHintTracking(preEvent, contextOut, classify)

    // The self-resolving post_tool_use pass for the same triggering command.
    resolvePendingHintsForEvent(bashEvent(n, triggerCommand))

    // Four more genuinely subsequent, unrelated tool calls must still not exhaust the window.
    for (let i = 0; i < 4; i++) {
      resolvePendingHintsForEvent(readEvent(n, `C:/repo/unrelated-${i}.ts`))
    }
    let db = getDb(globalDbPath())
    let row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.resolved).toBe(0) // still pending after the self-resolve + 4 unrelated calls

    // The 5th genuinely subsequent call is the correct follow-through — must still count.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/file.ts::Foo"'))
    db = getDb(globalDbPath())
    row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(1)
    expect(row.resolved).toBe(1)
  })
})

describe('isProbeOccasion', () => {
  it('matches occasions in an ascending threshold list', () => {
    expect(isProbeOccasion(1, [1, 3, 10, 30])).toBe(true)
    expect(isProbeOccasion(2, [1, 3, 10, 30])).toBe(false)
    expect(isProbeOccasion(3, [1, 3, 10, 30])).toBe(true)
    expect(isProbeOccasion(10, [1, 3, 10, 30])).toBe(true)
    expect(isProbeOccasion(30, [1, 3, 10, 30])).toBe(true)
  })

  it('probes every multiple of the largest threshold beyond it', () => {
    expect(isProbeOccasion(31, [1, 3, 10, 30])).toBe(false)
    expect(isProbeOccasion(59, [1, 3, 10, 30])).toBe(false)
    expect(isProbeOccasion(60, [1, 3, 10, 30])).toBe(true)
    expect(isProbeOccasion(90, [1, 3, 10, 30])).toBe(true)
  })

  it('never probes when the list is empty', () => {
    expect(isProbeOccasion(1, [])).toBe(false)
    expect(isProbeOccasion(1000, [])).toBe(false)
  })

  it('tolerates an unsorted list with duplicates and non-positive entries', () => {
    expect(isProbeOccasion(3, [10, 0, 3, -5, 3, 1])).toBe(true)
    expect(isProbeOccasion(1, [10, 0, 3, -5, 3, 1])).toBe(true)
    expect(isProbeOccasion(2, [10, 0, 3, -5, 3, 1])).toBe(false)
  })
})

// Regression: applyHintTracking only ever reached logHintEmission on the NOT-suppressed branch,
// so once a category crossed shouldSuppress's threshold it could never accumulate fresh
// acted-on signal and stayed suppressed permanently, with no recovery path short of a manual
// `--mark-effective` override or a full `--reset`. hints.backoff_thresholds now fixes this by
// letting a scheduled occasion through as a real, logged "probe" -- these tests would fail on
// the pre-fix code (which had no isProbeOccasion, no hint_suppression_probes counter, and always
// returned passOutput() for a suppressed occasion with nothing ever logged).
describe('probe recovery (hints.backoff_thresholds)', () => {
  const classify = (text: string): { category: 'bash_redirect'; correlator: string | null } => ({ category: 'bash_redirect', correlator: extractPathCorrelator(text) })

  it('lets a scheduled probe through, logs it as a real emission, and a genuine acted-on signal lifts suppression on the next check', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 50
    cfg.hints.backoff_thresholds = [1]
    saveConfig(cfg)

    // Seed one below-threshold, never-acted-on emission so the category crosses min_sample_size at 0% efficacy.
    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null)
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    // Occasion 1 while suppressed matches backoff_thresholds' single threshold (1) -- must probe:
    // shown to the caller AND logged as a real emission, unlike an ordinary suppressed occasion.
    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/probe.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/probe.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual(contextOut) // shown, not swapped for passOutput()

    const db = getDb(globalDbPath())
    const probeRow = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number } | undefined
    expect(probeRow).toBeDefined() // the probe WAS logged, unlike a plain suppressed occasion

    // Acting on the probe's own pointer supplies the fresh acted-on signal.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/probe.ts::Foo"'))
    const resolvedRow = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(resolvedRow.acted_on).toBe(1)

    // emitted=2 (seed + probe), actedOn=1 -> 50%, not below a 50% threshold -> suppression lifts.
    expect(shouldSuppress('bash_redirect', nonce())).toBe(false)
  })

  it('stays silently suppressed on occasions that do not match the configured schedule', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100
    cfg.hints.backoff_thresholds = [3] // only the 3rd suppressed occasion should probe
    saveConfig(cfg)

    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null)
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    // Occasions 1 and 2 don't match the schedule -- must stay silently suppressed, not logged.
    for (let i = 0; i < 2; i++) {
      const n = nonce()
      const event = bashEvent(n, `cat C:/repo/skip-${i}.ts`)
      const contextOut = { hookType: 'context' as const, context: `Use \`token-goat read "C:/repo/skip-${i}.ts::Foo"\` instead.` }
      const result = applyHintTracking(event, contextOut, classify)
      expect(result).toEqual({ hookType: 'pass' })
      const db = getDb(globalDbPath())
      const row = db.prepare('SELECT COUNT(*) AS n FROM hint_emissions WHERE session_id = ?').get(n) as { n: number }
      expect(row.n).toBe(0)
    }

    // Occasion 3 matches the schedule -- probes through and is logged.
    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/probe3.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/probe3.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual(contextOut)
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT COUNT(*) AS n FROM hint_emissions WHERE session_id = ?').get(n) as { n: number }
    expect(row.n).toBe(1)
  })

  it('with backoff_thresholds left empty, a suppressed category never recovers on its own (permanent-suppression baseline preserved)', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100
    cfg.hints.backoff_thresholds = []
    saveConfig(cfg)

    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null)
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    for (let i = 0; i < 40; i++) {
      const n = nonce()
      const event = bashEvent(n, `cat C:/repo/never-${i}.ts`)
      const contextOut = { hookType: 'context' as const, context: `Use \`token-goat read "C:/repo/never-${i}.ts::Foo"\` instead.` }
      const result = applyHintTracking(event, contextOut, classify)
      expect(result).toEqual({ hookType: 'pass' })
    }
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)
  })

  // Regression (mutation-testing gap): applyHintTracking's not-suppressed branch calls
  // resetSuppressionStreak so a fresh suppression episode's backoff schedule restarts from
  // occasion 1, rather than continuing the streak accumulated by a PRIOR suppression episode
  // that has since lifted. Dropping that reset call still passed the full suite, since every
  // other probe-recovery test only ever exercises one continuous suppression episode -- none
  // lift suppression, let it re-trigger, and then check whether the backoff schedule restarted.
  it('restarts the backoff streak from occasion 1 when a fresh suppression episode begins after a prior one lifted', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 50
    // [1, 5], not just [1]: with a sole threshold of 1, isProbeOccasion's "every multiple of the
    // largest threshold" fallback makes every occasion >= 1 probe regardless of the streak's
    // actual value, which would make this test pass even without the streak reset. A leftover
    // (unreset) streak of 1 bumped to 2 for episode 2's first call must NOT match [1, 5] (2 is
    // in neither the list nor a multiple of 5), so only a genuinely-reset streak of 1 probes.
    cfg.hints.backoff_thresholds = [1, 5]
    saveConfig(cfg)

    // Episode 1: seed a 0%-acted-on emission -> suppressed. Occasion 1 matches threshold [1] and
    // probes through.
    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null)
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    const probeSession = nonce()
    const probeEvent = bashEvent(probeSession, 'cat C:/repo/probe.ts')
    const probeContext = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/probe.ts::Foo"` instead.' }
    expect(applyHintTracking(probeEvent, probeContext, classify)).toEqual(probeContext) // probed through

    // Act on the probe's own pointer: emitted=2, actedOn=1 -> 50%, not below a 50% threshold ->
    // suppression genuinely lifts (a fresh episode, not just a probe).
    resolvePendingHintsForEvent(bashEvent(probeSession, 'token-goat read "C:/repo/probe.ts::Foo"'))
    expect(shouldSuppress('bash_redirect', nonce())).toBe(false)

    // This not-suppressed call must reset the streak, AND its own never-acted-on emission tips
    // the cumulative percentage back below threshold (emitted=3, actedOn=1 -> 33.3%), so the
    // category is suppressed again for the NEXT call -- episode 2 begins here.
    const liftedSession = nonce()
    const liftedEvent = bashEvent(liftedSession, 'cat C:/repo/lifted.ts')
    const liftedContext = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/lifted.ts::Foo"` instead.' }
    expect(applyHintTracking(liftedEvent, liftedContext, classify)).toEqual(liftedContext) // shown: not suppressed yet
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true) // suppressed again starting now

    // Episode 2, occasion 1: if the streak was properly reset to 0, this is occasion 1 again,
    // which matches threshold [1] and must probe through -- not stay silently suppressed as it
    // would if the streak had kept counting up from episode 1's leftover value.
    const episode2Session = nonce()
    const episode2Event = bashEvent(episode2Session, 'cat C:/repo/episode2.ts')
    const episode2Context = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/episode2.ts::Foo"` instead.' }
    expect(applyHintTracking(episode2Event, episode2Context, classify)).toEqual(episode2Context)
  })
})

describe('manual marks', () => {
  it('tracks effective/ineffective votes separately from the automatic signal, per category', () => {
    markCategoryEffective('bash_redirect')
    markCategoryEffective('bash_redirect')
    markCategoryIneffective('bash_redirect')

    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_redirect')
    expect(row?.manualEffective).toBe(2)
    expect(row?.manualIneffective).toBe(1)
    // Manual marks never feed into the automatic emitted/actedOn counters.
    expect(row?.emitted).toBe(0)
  })
})

describe('resetHintStats', () => {
  it('clears every tracked emission and manual mark', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    markCategoryEffective('bash_redirect')

    resetHintStats()

    const summary = getHintStatsSummary()
    expect(summary.every((r) => r.emitted === 0 && r.manualEffective === 0 && r.manualIneffective === 0)).toBe(true)
  })
})

// The saved half of the net figure comes from the `stats` ledger, which has no `harness` column and therefore spans every harness. Scoping only the spend half to the current harness subtracted one harness's cost from every harness's savings and overstated the net.
describe('getHintStatsTotals harness scope', () => {
  it('sums spend across every harness, matching the unscoped saved half', () => {
    const db = getDb(globalDbPath())
    db.prepare('DELETE FROM hint_emissions').run()
    const insert = db.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining, bytes_emitted)
       VALUES (?, ?, ?, NULL, ?, 1, 0, 0, ?)`,
    )
    insert.run('bash_redirect', nonce(), 'claude-code', Date.now(), 100)
    insert.run('bash_redirect', nonce(), 'some-other-harness', Date.now(), 25)

    expect(getHintStatsTotals().spentBytes).toBe(125)
  })

  it('counts legacy (null-spend) emissions from every harness too', () => {
    const db = getDb(globalDbPath())
    db.prepare('DELETE FROM hint_emissions').run()
    const insert = db.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining, bytes_emitted)
       VALUES (?, ?, ?, NULL, ?, 1, 0, 0, NULL)`,
    )
    insert.run('bash_redirect', nonce(), 'claude-code', Date.now())
    insert.run('bash_redirect', nonce(), 'some-other-harness', Date.now())

    const totals = getHintStatsTotals()
    expect(totals.legacyEmissions).toBe(2)
    expect(totals.spentBytes).toBeNull()
    expect(totals.netBytes).toBeNull()
  })
})

// Regression (#50): a saveConfig() call in this file used to leave the real, shared
// per-worker config.toml behind, silently persisting an explicit
// compact_assist.auto_trigger_multiplier (at its default value) that corrupted
// getContextPressure() for any sibling test file sharing this worker.
describe('config isolation (regression #50)', () => {
  it('restores the shared config.toml to absent after a test that calls saveConfig', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    saveConfig(cfg)
    expect(fs.existsSync(configPath())).toBe(true)
  })

  it('confirms the prior test\'s afterEach already deleted the shared config.toml', () => {
    expect(fs.existsSync(configPath())).toBe(false)
  })
})

/**
 * Polarity regression: a hint that asks for an absence must be scored on that absence.
 *
 * `read_reread_dedup` and `edit_reread_suggest` say "you already have this file, don't read it
 * again." Doing what they ask means issuing no command at all, but `isActedOn` credits follow-through
 * only when a later Bash command invokes token-goat AND names the correlator. So every one of those
 * rows resolved `acted_on = 0` however well the hint worked, the two categories sat at exactly 0%
 * efficacy, and `shouldSuppress` muted each for good once `min_sample_size` (default 5) rows had
 * accrued -- the hints that save a whole file read were the first to switch themselves off, on
 * evidence that could not exist. Observed live: those two categories at 0.0% on 5 emissions each and
 * both suppressed, while all three redirect categories scored above zero.
 *
 * Why didn't a test catch this: every existing case in this file drives the acted-on path with a
 * follow-up `token-goat ...` command, which is the redirect categories' compliance shape. No case
 * ever let a suppression hint's window simply expire and then asked what that meant, because the
 * expiry branch looked like uninteresting bookkeeping shared by all five categories. The gap was in
 * which category was fed to the shared branch, not in the branch's logic, so exercising the existing
 * cases harder could never reach it.
 *
 * Both polarities are asserted here, so a fix that flipped the default globally -- making every
 * unfollowed redirect hint look effective -- fails just as loudly as the original bug.
 */
describe('acted-on polarity for suppression-shaped hints', () => {
  /** Run the window down with unrelated tool calls, one call per turn. */
  function idleOut(sessionId: string, turns = 6): void {
    for (let i = 0; i < turns; i++) resolvePendingHintsForEvent(bashEvent(sessionId, `echo idle-${i}`))
  }

  function rowFor(sessionId: string): { resolved: number; acted_on: number } | undefined {
    return getDb(globalDbPath())
      .prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?')
      .get(sessionId) as { resolved: number; acted_on: number } | undefined
  }

  it('credits a re-read dedup hint when the window expires with no re-read', () => {
    const n = nonce()
    logHintEmission('read_reread_dedup', n, 'C:/repo/src/big.ts')
    idleOut(n)
    const row = rowFor(n)
    expect(row?.resolved, 'the hint never resolved').toBe(1)
    expect(row?.acted_on, 'not re-reading the file is the compliance this hint asked for').toBe(1)
  })

  it('credits an edit re-read suggestion the same way', () => {
    const n = nonce()
    logHintEmission('edit_reread_suggest', n, 'C:/repo/docs/guide.md')
    idleOut(n)
    expect(rowFor(n)?.acted_on).toBe(1)
  })

  it('counts a plain Read of the named file against the dedup hint', () => {
    const n = nonce()
    logHintEmission('read_reread_dedup', n, 'C:/repo/src/big.ts')
    resolvePendingHintsForEvent(readEvent(n, 'C:/repo/src/big.ts'))
    const row = rowFor(n)
    expect(row?.resolved, 'defiance must resolve the row immediately').toBe(1)
    expect(row?.acted_on, 're-reading the file is exactly what the hint warned against').toBe(0)
  })

  it('counts a shell re-read of the named file against the dedup hint', () => {
    const n = nonce()
    logHintEmission('read_reread_dedup', n, 'C:/repo/src/big.ts')
    resolvePendingHintsForEvent(bashEvent(n, 'cat C:/repo/src/big.ts'))
    const row = rowFor(n)
    // Resolution is the discriminating half: before the fix a `cat` of the named file merely
    // decremented the window like any unrelated call, so acted_on alone read 0 either way.
    expect(row?.resolved, 'the re-read must settle the row there and then').toBe(1)
    expect(row?.acted_on).toBe(0)
  })

  it('does not count a surgical token-goat read of that file as defiance', () => {
    const n = nonce()
    logHintEmission('read_reread_dedup', n, 'C:/repo/src/big.ts')
    // Green on both sides of the fix by design: this guards the new isDefiance path from
    // over-classifying the surgical route as a re-read, which would invert the fix's own benefit.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/src/big.ts::parse"'))
    const row = rowFor(n)
    expect(row?.resolved).toBe(1)
    expect(row?.acted_on, 'taking the cheap route is following the hint, not defying it').toBe(1)
  })

  it('leaves a read of some other file alone until the window runs out', () => {
    const n = nonce()
    logHintEmission('read_reread_dedup', n, 'C:/repo/src/big.ts')
    resolvePendingHintsForEvent(readEvent(n, 'C:/repo/src/unrelated.ts'))
    expect(rowFor(n)?.resolved, 'an unrelated read must not resolve the row').toBe(0)
    idleOut(n)
    expect(rowFor(n)?.acted_on).toBe(1)
  })

  it('still books an unfollowed redirect hint as not acted on', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/src/big.ts')
    idleOut(n)
    const row = rowFor(n)
    expect(row?.resolved).toBe(1)
    expect(row?.acted_on, 'a redirect hint names a command to run; silence is not compliance').toBe(0)
  })

  it('books a correlator-less hint by its own polarity', () => {
    const sup = nonce()
    logHintEmission('read_reread_dedup', sup, null)
    expect(rowFor(sup)?.acted_on, 'an unobservable suppression hint was never contradicted').toBe(1)

    const red = nonce()
    logHintEmission('bash_redirect', red, null)
    expect(rowFor(red)?.acted_on, 'an unobservable redirect hint was never followed either').toBe(0)
  })

  it('lets a category already muted by pre-fix rows recover on its next obeyed probe', () => {
    // The shape this machine was actually found in: read_reread_dedup at 0 acted-on across 5
    // emissions and suppressed, every one of those zeros produced by the rule this fix replaced.
    // Recovery does not need those rows rewritten -- the backoff probe schedule already exists to
    // let a muted category earn its way back, and it could not work while compliance was
    // unobservable. One probe the agent obeys is now enough to clear the threshold.
    saveConfig({ ...defaultConfig(), hint_stats: { suppress_threshold_pct: 15, min_sample_size: 5 } })
    invalidateConfigCache()
    for (let i = 0; i < 5; i++) {
      const stale = nonce()
      logHintEmission('read_reread_dedup', stale, `C:/repo/src/old${i}.ts`)
      resolvePendingHintsForEvent(readEvent(stale, `C:/repo/src/old${i}.ts`))
    }
    expect(shouldSuppress('read_reread_dedup', nonce()), 'setup: the category must start muted').toBe(true)

    const probe = nonce()
    logHintEmission('read_reread_dedup', probe, 'C:/repo/src/new.ts')
    idleOut(probe)
    expect(shouldSuppress('read_reread_dedup', nonce()), 'one obeyed probe must lift the mute').toBe(false)
  })

  it('keeps a consistently obeyed dedup category out of auto-suppression', () => {
    saveConfig({ ...defaultConfig(), hint_stats: { suppress_threshold_pct: 15, min_sample_size: 5 } })
    invalidateConfigCache()
    for (let i = 0; i < 6; i++) {
      const n = nonce()
      logHintEmission('read_reread_dedup', n, `C:/repo/src/file${i}.ts`)
      idleOut(n)
    }
    const summary = getHintStatsSummary().find((r) => r.category === 'read_reread_dedup')
    expect(summary?.emitted, 'the sample must be past min_sample_size for this to mean anything').toBeGreaterThanOrEqual(5)
    expect(shouldSuppress('read_reread_dedup', nonce()), 'an obeyed category muted itself').toBe(false)
  })

  // Regression: `suppressed: true` used to mean two operationally opposite things -- throttled
  // and self-healing (probes configured), or off until a manual reset (backoff_thresholds = [],
  // a documented, supported value). They rendered identically, which is how a reader of this
  // table once concluded the suppression path was broken when it was working as specified.
  it.each([
    [[1, 3, 10, 30], false, 'probes configured: suppression is a self-healing throttle'],
    [[], true, 'no probes: suppression is permanent until a manual reset'],
    [[0], true, 'only non-positive thresholds: no usable probe occasion, same as empty'],
  ])('backoff_thresholds %s gives suppressionPermanent=%s (%s)', (thresholds, expected) => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100
    cfg.hints.backoff_thresholds = thresholds as number[]
    saveConfig(cfg)

    logHintEmission('bash_redirect', nonce(), null)
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)

    const row = getHintStatsSummary().find((r) => r.category === 'bash_redirect')
    expect(row?.suppressed).toBe(true)
    expect(row?.suppressionPermanent).toBe(expected)
  })

  it('never reports suppressionPermanent for a category that is not suppressed at all', () => {
    const cfg = defaultConfig()
    cfg.hints.backoff_thresholds = []
    saveConfig(cfg)

    // bash_recall has no emissions, so it is below min_sample_size and cannot be suppressed.
    // Empty backoff_thresholds must not make an unsuppressed category look permanently off.
    const row = getHintStatsSummary().find((r) => r.category === 'bash_recall')
    expect(row?.suppressed).toBe(false)
    expect(row?.suppressionPermanent).toBe(false)
  })
})
