import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  SESSION_STORE_TABLES,
  getSessionStoreTable,
  formatSessionStoreCatalog,
  formatSessionStoreTable,
  describeTarget,
  diagnoseSqlFailure,
} from '../src/session_store_schema.js'
import { postToolUseFailureHandler } from '../src/hooks_tool_failure.js'
import type { HookEvent } from '../src/hook_registry.js'

describe('Session Store Schema & Discovery', () => {
  it('contains all canonical session store views, tables, and session SQLite tables', () => {
    const tableNames = SESSION_STORE_TABLES.map((t) => t.name)
    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('turns')
    expect(tableNames).toContain('checkpoints')
    expect(tableNames).toContain('session_files')
    expect(tableNames).toContain('session_refs')
    expect(tableNames).toContain('session_usage')
    expect(tableNames).toContain('tool_executions')
    expect(tableNames).toContain('tool_requests')
    expect(tableNames).toContain('attachments')
    expect(tableNames).toContain('events')
    expect(tableNames).toContain('todos')
    expect(tableNames).toContain('todo_deps')
    expect(tableNames).toContain('assistant_usage_events')
    expect(tableNames).toContain('search_index')
  })

  it('looks up tables case-insensitively', () => {
    expect(getSessionStoreTable('SESSIONS')?.name).toBe('sessions')
    expect(getSessionStoreTable('Turns')?.name).toBe('turns')
    expect(getSessionStoreTable('CheckPoints')?.name).toBe('checkpoints')
    expect(getSessionStoreTable('nonexistent')).toBeUndefined()
  })

  it('verifies sessions table columns and notes', () => {
    const sessions = getSessionStoreTable('sessions')
    expect(sessions).toBeDefined()
    const cols = sessions!.columns.map((c) => c.name)
    expect(cols).toContain('id')
    expect(cols).toContain('task_id')
    expect(cols).toContain('cwd')
    expect(cols).toContain('repository')
    expect(cols).toContain('branch')
    expect(cols).toContain('summary')
    expect(cols).toContain('agent_name')
    expect(cols).toContain('agent_description')
    expect(cols).toContain('created_at')
    expect(cols).toContain('updated_at')
    expect(cols).not.toContain('title')
    expect(cols).not.toContain('role')

    // Common misnomers mapped
    expect(sessions!.commonMisnomers?.title).toContain('summary')
    expect(sessions!.commonMisnomers?.role).toContain('agent_name')
  })

  it('formats catalog in text and JSON', () => {
    const text = formatSessionStoreCatalog()
    expect(text).toContain('# Session Store & Workflow Database Schema Catalog')
    expect(text).toContain('• **sessions**')
    expect(text).toContain('• **turns**')
    expect(text).toContain('• **todos**')

    const jsonStr = formatSessionStoreCatalog({ json: true })
    const parsed = JSON.parse(jsonStr)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.some((t: { name: string }) => t.name === 'sessions')).toBe(true)
  })

  it('formats specific table specification in text and JSON', () => {
    const sessions = getSessionStoreTable('sessions')!
    const text = formatSessionStoreTable(sessions)
    expect(text).toContain('# Schema: sessions')
    expect(text).toContain('| `summary`')
    expect(text).toContain('| `agent_name`')
    expect(text).toContain('## Common Column Misnomers & Pitfalls')
    expect(text).toContain('Don\'t use `title`')

    const jsonStr = formatSessionStoreTable(sessions, { json: true })
    const parsed = JSON.parse(jsonStr)
    expect(parsed.name).toBe('sessions')
    expect(parsed.columns.length).toBeGreaterThan(5)
  })

  describe('describeTarget', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-desc-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('describes a session store table name directly', async () => {
      const res = await describeTarget('sessions')
      expect(res.exitCode).toBe(0)
      expect(res.text).toContain('# Schema: sessions')
      expect(res.text).toContain('agent_name')
    })

    it('returns catalog when target is omitted or all', async () => {
      const res = await describeTarget()
      expect(res.exitCode).toBe(0)
      expect(res.text).toContain('Session Store & Workflow Database Schema Catalog')
    })

    it('returns error when table is unknown', async () => {
      const res = await describeTarget('bogus_table_xyz')
      expect(res.exitCode).toBe(1)
      expect(res.text).toContain("Unknown table or SQLite file 'bogus_table_xyz'")
      expect(res.text).toContain('Available session store tables: sessions')
    })

    it('describes a real SQLite database file on disk', async () => {
      const dbPath = path.join(tmpDir, 'test.db')
      execFileSync(process.execPath, [
        '--no-warnings',
        '-e',
        "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, department TEXT)'); db.close();",
        dbPath,
      ])

      const resAll = await describeTarget(dbPath)
      expect(resAll.exitCode).toBe(0)
      expect(resAll.text).toContain('employees  (table, 0 rows)')

      const resTable = await describeTarget(dbPath, 'employees')
      expect(resTable.exitCode).toBe(0)
      expect(resTable.text).toContain('# SQLite Table: employees')
      expect(resTable.text).toContain('department')
    })
  })

  describe('diagnoseSqlFailure', () => {
    it('diagnoses DuckDB Binder column error on sessions query', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'test-session-123',
        agentId: undefined,
        toolName: 'session_store_sql',
        toolInput: {
          query: 'SELECT title, role FROM sessions WHERE created_at > now() - INTERVAL 1 day',
        },
        raw: {},
      }
      const errorText = 'Binder Error: Referenced column "title" not found in FROM clause! Candidate bindings: "sessions.id", "sessions.summary"'
      const diagnostic = diagnoseSqlFailure(event, errorText)
      expect(diagnostic).not.toBeNull()
      expect(diagnostic).toContain("Table 'sessions' has columns: id, task_id")
      expect(diagnostic).toContain("For 'title', use summary")
      expect(diagnostic).toContain("Run 'token-goat session-schema sessions'")
    })

    it('diagnoses SQLite no such column error on sessions query', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'test-session-123',
        agentId: undefined,
        toolName: 'sql',
        toolInput: {
          query: 'SELECT role FROM sessions',
        },
        raw: {},
      }
      const errorText = 'no such column: role'
      const diagnostic = diagnoseSqlFailure(event, errorText)
      expect(diagnostic).not.toBeNull()
      expect(diagnostic).toContain("For 'role', use agent_name or agent_description")
    })

    it('diagnoses invalid table error', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'test-session-123',
        agentId: undefined,
        toolName: 'session_store_sql',
        toolInput: {
          query: 'SELECT * FROM past_sessions',
        },
        raw: {},
      }
      const errorText = 'Table "past_sessions" does not exist'
      const diagnostic = diagnoseSqlFailure(event, errorText)
      expect(diagnostic).not.toBeNull()
      expect(diagnostic).toContain("Table 'past_sessions' does not exist")
      expect(diagnostic).toContain('Available session store tables: sessions, turns')
    })

    it('returns null for non-SQL errors', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'test-session-123',
        agentId: undefined,
        toolName: 'view',
        toolInput: { path: 'foo.ts' },
        raw: {},
      }
      expect(diagnoseSqlFailure(event, 'file not found')).toBeNull()
    })
  })

  describe('hook handler integration', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hook-sql-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('advises immediately on SQL column error in postToolUseFailureHandler', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'sql-test-session',
        agentId: undefined,
        toolName: 'session_store_sql',
        toolInput: {
          query: 'SELECT title FROM sessions LIMIT 10',
        },
        raw: {
          error: 'Binder Error: Referenced column "title" not found in FROM clause!',
        },
      }

      const out = postToolUseFailureHandler(event)
      expect(out.hookType).toBe('context')
      if (out.hookType === 'context') {
        expect(out.context).toContain("Table 'sessions' has columns")
        expect(out.context).toContain("For 'title', use summary")
      }
    })

    it('advises on postToolUseFailureHandler when raw has error response', () => {
      const event: HookEvent = {
        eventName: 'post_tool_use_failure',
        sessionId: 'sql-test-session',
        agentId: undefined,
        toolName: 'session_store_sql',
        toolInput: {
          query: 'SELECT role FROM sessions',
        },
        raw: {
          tool_response: 'Binder Error: Referenced column "role" not found in FROM clause!',
        },
      }

      const out = postToolUseFailureHandler(event)
      expect(out.hookType).toBe('context')
      if (out.hookType === 'context') {
        expect(out.context).toContain("Table 'sessions' has columns")
        expect(out.context).toContain("For 'role', use agent_name or agent_description")
      }
    })
  })
})
