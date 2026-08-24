import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { registerHook, runHook } from '../src/hook_registry.js'
import { readUnmappedTools, GLOBAL_SCHEMA_SQL } from '../src/stats.js'
import { checkUnmappedTools } from '../src/cli_doctor.js'

/**
 * The unrecognized-tool histogram, driven through the real `runHook` rather than around it.
 *
 * The gap this whole mechanism exists to close is the injected-seam trap: a test hands a handler
 * the payload the shipping path drops upstream, so the drop is invisible. Testing the recorder in
 * isolation would repeat that mistake one level out -- the question is not "does the INSERT work",
 * it is "does dispatch notice a name no handler wanted". So these register real handlers and call
 * the real dispatcher.
 *
 * Tool names are prefixed `TgTest`/`tgtest_` because `recordUnmappedTool` writes to the process's
 * one real global database, which the whole suite shares. Unique names make each assertion depend
 * only on the rows this file created.
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
    // Exactly the shape a bridge produces when its tool-rename step is missing: the harness's own
    // spelling arrives verbatim, and every handler behind the renamed spelling is unreachable.
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
    // A semantic rename (Copilot's `view` -> `Read`) is unrecoverable from the name alone. The
    // row is still worth having -- for the nine bridges nobody can dogfood it is the only record
    // of what they actually send -- but claiming a near miss here would be a guess.
    registerHook('pre_tool_use', async () => ({ hookType: 'pass' }), { toolName: 'TgTestBash' })
    await dispatch('tgtest_wholly_unrelated')

    const row = rowFor('tgtest_wholly_unrelated')
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

  function insert(toolName: string, nearMiss: string | null, hits: number): void {
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO unmapped_tools (harness, tool_name, event_name, near_miss, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('copilot_cli', toolName, 'pre_tool_use', nearMiss, 1, 2, hits)
    db.close()
  }

  it('warns and names both spellings when a bridge stopped renaming a tool', () => {
    insert('bash', 'Bash', 42)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('warn')
    // Naming both halves is the whole value: the fix is a one-line mapping entry, and the message
    // has to say which entry.
    expect(result.message).toContain('"bash"')
    expect(result.message).toContain('"Bash"')
    expect(result.message).toContain('copilot_cli')
  })

  it('does not warn about names that merely have no handler', () => {
    insert('todo_write', null, 900)
    const result = checkUnmappedTools(dbPath)

    expect(result.status).toBe('ok')
    expect(result.message).toContain('todo_write')
  })

  it('reports an untouched database as clean rather than as an unread table', () => {
    // The empty-vs-broken distinction: "nothing recorded" and "could not read" must not print the
    // same way, or a genuinely dead detector reads as a passing check.
    expect(checkUnmappedTools(dbPath).status).toBe('ok')
    expect(checkUnmappedTools(dbPath).message).toContain('reached a handler')
  })
})
