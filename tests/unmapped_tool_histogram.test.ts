import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { registerHook, runHook } from '../src/hook_registry.js'
import { readUnmappedTools, pruneStalePatternCoveredUnmappedTools, GLOBAL_SCHEMA_SQL } from '../src/stats.js'
import { checkUnmappedTools } from '../src/cli_doctor.js'
import { MCP_TOOL_PATTERN } from '../src/mcp_tool_pattern.js'

/**
 * The unrecognized-tool histogram, driven through the real `runHook` rather than around it.
 *
 * The gap this whole mechanism exists to close is the injected-seam trap: a test hands a handler the payload the shipping path drops upstream, so the drop is invisible. Testing the recorder in isolation would repeat that mistake one level out -- the question is not "does the INSERT work", it is "does dispatch notice a name no handler wanted". So these register real handlers and call the real dispatcher.
 *
 * Tool names are prefixed `TgTest`/`tgtest_` because `recordUnmappedTool` writes to the process's one real global database, which the whole suite shares. Unique names make each assertion depend only on the rows this file created.
 */
describe('unrecognized tool-name histogram', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    clearModuleCaches()
    closeAllDbs()
  })

  async function dispatch(toolName: string): Promise<void> {
    await runHook({
      eventName: 'pre_tool_use',
      toolName,
      toolInput: {},
      sessionId: 's1',
      agentId: undefined,
      raw: {},
    })
  }

  function rowFor(toolName: string) {
    return readUnmappedTools().find((r) => r.tool_name === toolName)
  }

  it('flags a name that differs from a handled one only by case and separators', async () => {
    // Exactly the shape a bridge produces when its tool-rename step is missing: the harness's own spelling arrives verbatim, and every handler behind the renamed spelling is unreachable.
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestBash' })
    await dispatch('tgtest_bash')

    const row = rowFor('tgtest_bash')
    expect(row?.near_miss).toBe('TgTestBash')
    expect(row?.event_name).toBe('pre_tool_use')
  })

  it('records nothing when the name is one a handler asked for', async () => {
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestExact' })
    await dispatch('TgTestExact')

    expect(rowFor('TgTestExact')).toBeUndefined()
  })

  it('records an unrelated name without inventing a near miss for it', async () => {
    // A semantic rename (Copilot's `view` -> `Read`) is unrecoverable from the name alone. The row is still worth having -- for the nine bridges nobody can dogfood it is the only record of what they actually send -- but claiming a near miss here would be a guess.
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestBash' })
    await dispatch('tgtest_wholly_unrelated')

    const row = rowFor('tgtest_wholly_unrelated')
    expect(row).toBeDefined()
    expect(row?.near_miss).toBeNull()
  })

  // Regression: a real GitHub MCP tool call reached preMcpHandler exactly as designed (it
  // registers with toolPattern '^mcp__', not an exact toolName), but noteUnrecognizedTool only
  // checked the exact-toolName list, so the call was logged as unmapped anyway. CAPTURE: a live
  // global.db's unmapped_tools table held mcp__plugin_github_github__get_file_contents with 244
  // pre_tool_use hits despite the GitHub compression pack and preMcpHandler both covering it.
  it('does not flag a tool name covered by a registered toolPattern', async () => {
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolPattern: MCP_TOOL_PATTERN })
    await dispatch('mcp__plugin_github_github__get_file_contents')

    expect(rowFor('mcp__plugin_github_github__get_file_contents')).toBeUndefined()
  })

  it('still flags a plain unknown tool name alongside a registered toolPattern handler', async () => {
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolPattern: MCP_TOOL_PATTERN })
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestKnown' })
    await dispatch('tgtest_genuinely_unmapped')

    const row = rowFor('tgtest_genuinely_unmapped')
    expect(row).toBeDefined()
    expect(row?.near_miss).toBeNull()
  })

  it('stays quiet on an event whose handlers all take every tool', async () => {
    // Nothing to be unrecognized against: an unfiltered handler wanted this call and got it.
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }))
    await dispatch('tgtest_no_named_handlers')

    expect(rowFor('tgtest_no_named_handlers')).toBeUndefined()
  })

  it('counts repeats instead of appending a row per call', async () => {
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestBash' })
    const before = rowFor('tgtest_repeated')?.hits ?? 0
    await dispatch('tgtest_repeated')
    await dispatch('tgtest_repeated')

    expect(rowFor('tgtest_repeated')?.hits).toBe(before + 2)
    expect(readUnmappedTools().filter((r) => r.tool_name === 'tgtest_repeated')).toHaveLength(1)
  })
})

describe('doctor reads the histogram', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-unmapped-doctor-'))
    dbPath = path.join(dir, 'global.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    db.close()
  })

  afterEach(() => {
    closeAllDbs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // A real, recent epoch, not a placeholder: the doctor's retention filter only applies to rows carrying a real timestamp, so a fixture that wants to be seen as live must look like one -- and "live" means inside the 7-day window measured against the wall clock, not a fixed date that ages out.
  const FIXTURE_EPOCH = Math.floor(Date.now() / 1000) - 3600

  function insert(toolName: string, nearMiss: string | null, hits: number, eventName = 'pre_tool_use'): void {
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO unmapped_tools (harness, tool_name, event_name, near_miss, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('copilot_cli', toolName, eventName, nearMiss, FIXTURE_EPOCH - 100, FIXTURE_EPOCH, hits)
    db.close()
  }

  it('warns and names both spellings when a bridge stopped renaming a tool', () => {
    insert('bash', 'Bash', 42)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('warn')
    // Naming both halves is the whole value: the fix is a one-line mapping entry, and the message has to say which entry.
    expect(result.message).toContain('"bash"')
    expect(result.message).toContain('"Bash"')
    expect(result.message).toContain('copilot_cli')
  })

  it('does not warn when a stale row names itself as its own near miss', () => {
    // A real global.db carried exactly this row: tool_name "Bash", near_miss "Bash", written by an in-development build 26 minutes before the exact-match guard was committed. Dispatch cannot produce it -- it returns before recording when a handler asked for that spelling -- so the only question is how the reader renders a row that should not exist. Warning printed a sentence that contradicted itself and could never clear, because nothing about a real harness had gone wrong for it to clear.
    insert('Bash', 'Bash', 2)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('ok')
    expect(result.message).not.toContain('is very likely not being applied')
    expect(result.message).toContain('Bash')
  })

  it('still warns about a genuine near miss sitting alongside a self-referential row', () => {
    // The guard must drop the impossible row without disarming the check: a real bridge failure in the same database still has to surface.
    insert('Bash', 'Bash', 2)
    insert('web_fetch', 'WebFetch', 7)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('warn')
    expect(result.message).toContain('"web_fetch"')
    expect(result.message).not.toContain('sent "Bash" where "Bash"')
  })

  it('does not warn about names that merely have no handler', () => {
    insert('todo_write', null, 900)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('ok')
    expect(result.message).toContain('todo_write')
  })

  it('lists a tool seen on both hook events once, not once per event', () => {
    // Uses a non-MCP name deliberately: the real captured example this once used
    // (mcp__plugin_github_github__get_file_contents) is now pruned as pattern-covered before
    // this dedup logic even runs -- see 'drops a pre-existing pattern-covered row' below, which
    // keeps that real fixture and its provenance note.
    insert('tgtest_dual_event_tool', null, 244, 'pre_tool_use')
    insert('tgtest_dual_event_tool', null, 241, 'post_tool_use')
    const { message } = checkUnmappedTools(dbPath)

    expect(message.split('tgtest_dual_event_tool').length - 1).toBe(1)
    expect(message).toContain('1 tool name(s)')
    expect(message).toContain('(244x)')
  })

  // Regression: a stale row written before noteUnrecognizedTool checked toolPattern (see the
  // real-dispatch tests above) survives forever in unmapped_tools unless cleaned, so doctor kept
  // reporting an MCP tool as unmapped even after the recorder itself was fixed.
  it('drops a pre-existing pattern-covered row instead of reporting it forever', () => {
    insert('mcp__plugin_github_github__get_file_contents', null, 244, 'pre_tool_use')
    insert('mcp__plugin_github_github__get_file_contents', null, 241, 'post_tool_use')
    insert('tgtest_genuinely_unmapped', null, 5)

    const result = checkUnmappedTools(dbPath)

    expect(result.message).not.toContain('get_file_contents')
    expect(result.message).toContain('tgtest_genuinely_unmapped')
  })

  it('pruneStalePatternCoveredUnmappedTools leaves a non-matching row untouched', () => {
    insert('mcp__plugin_github_github__get_file_contents', null, 244)
    insert('tgtest_genuinely_unmapped', null, 5)
    const db = new Database(dbPath)

    pruneStalePatternCoveredUnmappedTools(db, [MCP_TOOL_PATTERN])
    db.close()

    expect(readUnmappedTools(dbPath).map((r) => r.tool_name)).toEqual(['tgtest_genuinely_unmapped'])
  })

  it('reports an untouched database as clean rather than as an unread table', () => {
    // The empty-vs-broken distinction: "nothing recorded" and "could not read" must not print the same way, or a genuinely dead detector reads as a passing check.
    expect(checkUnmappedTools(dbPath).status).toBe('ok')
    expect(checkUnmappedTools(dbPath).message).toContain('reached a handler')
  })

  it('filters out stale near-misses that have not been observed within the retention window', () => {
    const now = 1790000000
    const tenDaysAgo = now - 10 * 86400
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO unmapped_tools (harness, tool_name, event_name, near_miss, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('copilot_cli', 'resolved_tool', 'pre_tool_use', 'ResolvedTool', tenDaysAgo - 100, tenDaysAgo, 20)
    db.close()

    // When evaluated at `now` with default 7-day window, the 10-day-old near-miss is ignored as resolved residue
    const result = checkUnmappedTools(dbPath, { nowSecs: now, maxAgeDays: 7 })
    expect(result.status).toBe('ok')
    expect(result.message).not.toContain('is very likely not being applied')
  })

  it('still warns for recent near-misses within the retention window', () => {
    const now = 1790000000
    const oneDayAgo = now - 1 * 86400
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO unmapped_tools (harness, tool_name, event_name, near_miss, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('copilot_cli', 'active_broken_tool', 'pre_tool_use', 'ActiveBrokenTool', oneDayAgo - 100, oneDayAgo, 5)
    db.close()

    const result = checkUnmappedTools(dbPath, { nowSecs: now, maxAgeDays: 7 })
    expect(result.status).toBe('warn')
    expect(result.message).toContain('"active_broken_tool"')
    expect(result.message).toContain('"ActiveBrokenTool"')
  })
})
