/**
 * Session store and database schema catalog, discovery, and runtime error diagnostics.
 *
 * Provides a zero-dependency, authoritative reference for Copilot CLI's cross-session
 * DuckDB/SQLite database (`session_store_sql`) and session SQLite database (`sql`),
 * preventing trial-and-error SELECT * fallbacks when querying session history or tasks.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HookEvent } from './hook_registry.js'
import { getToolName } from './hooks_common.js'
import { displaySafeJson } from './paths.js'

export interface SessionStoreColumn {
  readonly name: string
  readonly type: string
  readonly description: string
  readonly primaryKey?: boolean
  readonly notNull?: boolean
}

export type SessionStoreTableKind = 'view' | 'table' | 'local_view' | 'session_db'
export type SessionStoreTableSource = 'cloud' | 'local' | 'session' | 'both'

export interface SessionStoreTable {
  readonly name: string
  readonly kind: SessionStoreTableKind
  readonly source: SessionStoreTableSource
  readonly description: string
  readonly keyFields: readonly string[]
  readonly columns: readonly SessionStoreColumn[]
  readonly notes?: readonly string[]
  readonly commonMisnomers?: Readonly<Record<string, string>>
}

/**
 * Authoritative table and view definitions for Copilot CLI `session_store_sql`
 * and session SQLite `sql` tools.
 */
export const SESSION_STORE_TABLES: readonly SessionStoreTable[] = [
  {
    name: 'sessions',
    kind: 'view',
    source: 'both',
    description: 'Session metadata and discovery across projects and agents',
    keyFields: ['id', 'task_id', 'cwd', 'repository', 'branch', 'summary', 'agent_name', 'agent_description', 'created_at', 'updated_at'],
    columns: [
      { name: 'id', type: 'TEXT', description: 'Session UUID (matches .../sessions/<id>)', primaryKey: true, notNull: true },
      { name: 'task_id', type: 'TEXT', description: 'Task UUID from .../tasks/<id> URL (cloud only)' },
      { name: 'cwd', type: 'TEXT', description: 'Working directory path where session started' },
      { name: 'repository', type: 'TEXT', description: 'Repository name or owner/repo slug' },
      { name: 'branch', type: 'TEXT', description: 'Active git branch name' },
      { name: 'summary', type: 'TEXT', description: 'Concise summary of session conversation' },
      { name: 'agent_name', type: 'TEXT', description: "Exact agent name, e.g. 'Copilot CLI', 'Copilot Coding Agent' (cloud only)" },
      { name: 'agent_description', type: 'TEXT', description: 'Agent description or specialty (cloud only)' },
      { name: 'created_at', type: 'TIMESTAMP', description: 'Session start timestamp (UTC)' },
      { name: 'updated_at', type: 'TIMESTAMP', description: 'Session last active timestamp (UTC)' },
      { name: 'host_type', type: 'TEXT', description: 'Host environment type (local source only)' },
    ],
    notes: [
      'In local mode (source: "local"), sessions only contains: id, cwd, repository, host_type, branch, summary, created_at, updated_at (no task_id or agent_*).',
      'Filter exact agent_name values such as "Copilot Code Review", "Copilot Coding Agent", or "Copilot CLI", not summary text.',
      'Always use LIMIT and filter by repository or time (created_at >= now() - INTERVAL \'7 days\').',
    ],
    commonMisnomers: {
      title: 'summary (sessions has no "title" column; checkpoints has "title")',
      role: 'agent_name or agent_description (sessions has no "role" column)',
      name: 'agent_name (for agent identity) or repository (for project name)',
      user: 'user_message in turns table',
      prompt: 'user_message in turns table',
    },
  },
  {
    name: 'turns',
    kind: 'view',
    source: 'both',
    description: 'Conversation messages grouped into user and assistant turns',
    keyFields: ['session_id', 'turn_index', 'user_message', 'assistant_response', 'timestamp'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'turn_index', type: 'INTEGER', description: '0-based turn index in conversation', notNull: true },
      { name: 'user_message', type: 'TEXT', description: 'User input / prompt message' },
      { name: 'assistant_response', type: 'TEXT', description: 'Assistant generated response' },
      { name: 'timestamp', type: 'TIMESTAMP', description: 'Turn execution timestamp' },
    ],
    notes: [
      'Never ILIKE-scan turns without narrow time or session_id filters; turns table can exceed 50,000+ rows.',
    ],
    commonMisnomers: {
      prompt: 'user_message',
      response: 'assistant_response',
      content: 'user_message or assistant_response',
      text: 'user_message or assistant_response',
    },
  },
  {
    name: 'checkpoints',
    kind: 'view',
    source: 'both',
    description: 'Handoff and checkpoint summaries created during sessions',
    keyFields: ['session_id', 'checkpoint_number', 'title', 'overview', 'created_at'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'checkpoint_number', type: 'INTEGER', description: 'Sequential checkpoint number (1-based)' },
      { name: 'title', type: 'TEXT', description: 'Checkpoint short title' },
      { name: 'overview', type: 'TEXT', description: 'Checkpoint narrative markdown summary' },
      { name: 'created_at', type: 'TIMESTAMP', description: 'Checkpoint creation timestamp' },
    ],
    commonMisnomers: {
      summary: 'overview or title',
      description: 'overview',
      notes: 'overview',
    },
  },
  {
    name: 'session_files',
    kind: 'view',
    source: 'both',
    description: 'Files touched, created, or modified during sessions',
    keyFields: ['session_id', 'file_path', 'tool_name', 'turn_index', 'first_seen_at'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'file_path', type: 'TEXT', description: 'Workspace or absolute file path', notNull: true },
      { name: 'tool_name', type: 'TEXT', description: 'Tool used to touch file (edit, create, apply_patch)' },
      { name: 'turn_index', type: 'INTEGER', description: 'Turn index where file was modified' },
      { name: 'first_seen_at', type: 'TIMESTAMP', description: 'Timestamp file was first modified in session' },
    ],
    commonMisnomers: {
      path: 'file_path',
      filename: 'file_path',
      name: 'file_path',
    },
  },
  {
    name: 'session_refs',
    kind: 'view',
    source: 'both',
    description: 'Commit, pull request, and issue references linked to sessions',
    keyFields: ['session_id', 'ref_type', 'ref_value', 'turn_index', 'created_at'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'ref_type', type: 'TEXT', description: "Reference type ('commit', 'pr', or 'issue')" },
      { name: 'ref_value', type: 'TEXT', description: 'Reference value (e.g. git SHA, PR number, or issue number)' },
      { name: 'turn_index', type: 'INTEGER', description: 'Turn index where reference appeared' },
      { name: 'created_at', type: 'TIMESTAMP', description: 'Reference creation timestamp' },
    ],
    notes: [
      'Prefer session_refs exact matches for PR/issue lookups over text-scanning turns.',
    ],
    commonMisnomers: {
      type: 'ref_type',
      value: 'ref_value',
      ref: 'ref_value',
    },
  },
  {
    name: 'session_usage',
    kind: 'view',
    source: 'cloud',
    description: 'Model and token usage aggregated per session and model (cloud only)',
    keyFields: ['session_id', 'usage_model', 'api_call_count', 'input_tokens', 'output_tokens', 'cost', 'duration', 'first_used_at', 'last_used_at'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'usage_model', type: 'TEXT', description: 'LLM model identifier used' },
      { name: 'api_call_count', type: 'INTEGER', description: 'Total API calls issued to model' },
      { name: 'input_tokens', type: 'INTEGER', description: 'Total prompt/input tokens' },
      { name: 'output_tokens', type: 'INTEGER', description: 'Total generated/output tokens' },
      { name: 'cache_read_tokens', type: 'INTEGER', description: 'Prompt tokens read from cache' },
      { name: 'cache_write_tokens', type: 'INTEGER', description: 'Prompt tokens written to cache' },
      { name: 'cost', type: 'DOUBLE', description: 'Sum of model billing multipliers' },
      { name: 'duration', type: 'BIGINT', description: 'Total duration in milliseconds' },
      { name: 'first_used_at', type: 'TIMESTAMP', description: 'First usage timestamp' },
      { name: 'last_used_at', type: 'TIMESTAMP', description: 'Last usage timestamp' },
    ],
    notes: [
      'Filtering last_used_at selects session/model rows whose latest usage falls in the period; rows remain whole-session aggregates.',
    ],
    commonMisnomers: {
      model: 'usage_model',
      tokens: 'input_tokens or output_tokens',
    },
  },
  {
    name: 'tool_executions',
    kind: 'view',
    source: 'cloud',
    description: 'Completed tool calls and outcomes (cloud only)',
    keyFields: ['session_id', 'tool_call_id', 'tool_name', 'started_at', 'completed_at', 'duration_ms', 'success', 'error_code'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'tool_call_id', type: 'TEXT', description: 'Unique tool invocation identifier' },
      { name: 'tool_name', type: 'TEXT', description: 'Tool name executed' },
      { name: 'started_at', type: 'TIMESTAMP', description: 'Tool start timestamp' },
      { name: 'completed_at', type: 'TIMESTAMP', description: 'Tool completion timestamp' },
      { name: 'duration_ms', type: 'BIGINT', description: 'Execution duration in milliseconds' },
      { name: 'success', type: 'BOOLEAN', description: 'True if tool succeeded, false on error' },
      { name: 'error_code', type: 'TEXT', description: 'Error code or category on failure' },
    ],
    notes: [
      'To exclude invalid negative durations, filter completed_at >= started_at.',
    ],
    commonMisnomers: {
      name: 'tool_name',
      duration: 'duration_ms',
      status: 'success (boolean)',
    },
  },
  {
    name: 'tool_requests',
    kind: 'table',
    source: 'cloud',
    description: 'Raw tool request arguments in JSON format (cloud fallback table)',
    keyFields: ['session_id', 'tool_call_id', 'name', 'arguments_json'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'tool_call_id', type: 'TEXT', description: 'Tool call identifier' },
      { name: 'name', type: 'TEXT', description: 'Tool name requested' },
      { name: 'arguments_json', type: 'TEXT', description: 'Raw JSON arguments payload' },
    ],
  },
  {
    name: 'attachments',
    kind: 'table',
    source: 'cloud',
    description: 'Attachments submitted with user messages (cloud fallback table)',
    keyFields: ['session_id', 'display_name', 'path', 'type'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'display_name', type: 'TEXT', description: 'Display name or label' },
      { name: 'path', type: 'TEXT', description: 'Path to attachment' },
      { name: 'type', type: 'TEXT', description: 'MIME type or category' },
    ],
  },
  {
    name: 'events',
    kind: 'table',
    source: 'cloud',
    description: 'Underlying raw event stream (~90 columns, large table - filter by session_id and timestamp)',
    keyFields: ['session_id', 'timestamp', 'type', 'agent_name', 'agent_description', 'user_content', 'assistant_content'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Foreign key to sessions.id', notNull: true },
      { name: 'timestamp', type: 'TIMESTAMP', description: 'Event timestamp' },
      { name: 'type', type: 'TEXT', description: "Event type ('user.message', 'assistant.message', 'tool.execution_complete')" },
      { name: 'agent_name', type: 'TEXT', description: 'Agent identifier' },
      { name: 'agent_description', type: 'TEXT', description: 'Agent description' },
      { name: 'user_content', type: 'TEXT', description: 'User message text' },
      { name: 'assistant_content', type: 'TEXT', description: 'Assistant message text' },
      { name: 'tool_start_name', type: 'TEXT', description: 'Tool name at invocation' },
      { name: 'tool_complete_call_id', type: 'TEXT', description: 'Tool call ID on completion' },
      { name: 'tool_complete_success', type: 'BOOLEAN', description: 'Success status flag' },
      { name: 'tool_complete_result_content', type: 'TEXT', description: 'Tool execution result text' },
      { name: 'usage_model', type: 'TEXT', description: 'Model name' },
      { name: 'usage_input_tokens', type: 'INTEGER', description: 'Input token count' },
      { name: 'usage_output_tokens', type: 'INTEGER', description: 'Output token count' },
    ],
  },
  {
    name: 'todos',
    kind: 'session_db',
    source: 'session',
    description: 'Active session SQLite workflow todos (managed via sql tool in session database)',
    keyFields: ['id', 'title', 'description', 'status', 'created_at', 'updated_at'],
    columns: [
      { name: 'id', type: 'TEXT', description: 'Unique kebab-case todo identifier', primaryKey: true, notNull: true },
      { name: 'title', type: 'TEXT', description: 'Gerund action title (e.g. "Creating auth module")', notNull: true },
      { name: 'description', type: 'TEXT', description: 'Self-contained task description' },
      { name: 'status', type: 'TEXT', description: "'pending', 'in_progress', 'done', or 'blocked'", notNull: true },
      { name: 'created_at', type: 'TIMESTAMP', description: 'Creation timestamp' },
      { name: 'updated_at', type: 'TIMESTAMP', description: 'Last update timestamp' },
    ],
    commonMisnomers: {
      name: 'title or id',
      task: 'title or description',
      state: 'status',
    },
  },
  {
    name: 'todo_deps',
    kind: 'session_db',
    source: 'session',
    description: 'Active session SQLite todo dependencies (managed via sql tool in session database)',
    keyFields: ['todo_id', 'depends_on'],
    columns: [
      { name: 'todo_id', type: 'TEXT', description: 'Todo identifier that has a dependency', notNull: true },
      { name: 'depends_on', type: 'TEXT', description: 'Todo identifier that must be done first', notNull: true },
    ],
    commonMisnomers: {
      parent: 'depends_on',
      child: 'todo_id',
    },
  },
  {
    name: 'assistant_usage_events',
    kind: 'table',
    source: 'local',
    description: 'Local SQLite assistant usage events (source: "local" only)',
    keyFields: ['session_id', 'timestamp', 'model', 'input_tokens', 'output_tokens'],
    columns: [
      { name: 'session_id', type: 'TEXT', description: 'Session UUID' },
      { name: 'timestamp', type: 'TEXT', description: 'Timestamp string' },
      { name: 'model', type: 'TEXT', description: 'Model identifier' },
      { name: 'input_tokens', type: 'INTEGER', description: 'Input token count' },
      { name: 'output_tokens', type: 'INTEGER', description: 'Output token count' },
    ],
  },
  {
    name: 'search_index',
    kind: 'table',
    source: 'local',
    description: 'Local SQLite FTS5 search index table for MATCH queries (source: "local" only)',
    keyFields: ['search_index'],
    columns: [
      { name: 'search_index', type: 'FTS5', description: 'Full-text indexed search virtual table' },
    ],
  },
]

/**
 * Find table definition by name (case-insensitive).
 */
export function getSessionStoreTable(name: string): SessionStoreTable | undefined {
  const norm = name.trim().toLowerCase()
  return SESSION_STORE_TABLES.find((t) => t.name.toLowerCase() === norm)
}

/**
 * Format overview of all session store tables.
 */
export function formatSessionStoreCatalog(opts?: { json?: boolean | undefined }): string {
  if (opts?.json === true) {
    return displaySafeJson(SESSION_STORE_TABLES)
  }

  const lines: string[] = [
    '# Session Store & Workflow Database Schema Catalog',
    '',
    'Available tables and materialized views for `session_store_sql` (DuckDB/SQLite) and `sql` (session SQLite):',
    '',
  ]

  for (const table of SESSION_STORE_TABLES) {
    const kindTag = table.kind === 'session_db' ? '[session sql]' : `[${table.source}]`
    const cols = table.columns.map((c) => c.name).join(', ')
    lines.push(`• **${table.name}** ${kindTag} — ${table.description}`)
    lines.push(`  Columns: ${cols}`)
    lines.push('')
  }

  lines.push('Run `token-goat session-schema <table>` or `token-goat describe <table>` for detailed column specifications.')
  return lines.join('\n')
}

/**
 * Format detailed specification for one table.
 */
export function formatSessionStoreTable(table: SessionStoreTable, opts?: { json?: boolean | undefined }): string {
  if (opts?.json === true) {
    return displaySafeJson(table)
  }

  const lines: string[] = [
    `# Schema: ${table.name} (${table.kind}, source: ${table.source})`,
    '',
    table.description,
    '',
    '## Columns',
    '',
    '| Column | Type | Description |',
    '| :--- | :--- | :--- |',
  ]

  for (const col of table.columns) {
    const pk = col.primaryKey === true ? ' *(PK)*' : ''
    const req = col.notNull === true ? ' *(not null)*' : ''
    lines.push(`| \`${col.name}\`${pk}${req} | \`${col.type}\` | ${col.description} |`)
  }

  if (table.notes && table.notes.length > 0) {
    lines.push('', '## Important Notes', '')
    for (const note of table.notes) {
      lines.push(`- ${note}`)
    }
  }

  if (table.commonMisnomers && Object.keys(table.commonMisnomers).length > 0) {
    lines.push('', '## Common Column Misnomers & Pitfalls', '')
    for (const [bad, good] of Object.entries(table.commonMisnomers)) {
      lines.push(`- Don't use \`${bad}\` → use \`${good}\``)
    }
  }

  return lines.join('\n')
}

/**
 * Unified describe command:
 * 1. If `target` is a local SQLite database file (e.g. .db, .sqlite), inspects with SQLite schema.
 * 2. If `target` matches a known session store or SQLite table, describes that table.
 * 3. If no target is given or target is 'all'/'session_store_sql', outputs catalog overview.
 */
export async function describeTarget(
  target?: string | undefined,
  table?: string | undefined,
  opts?: { json?: boolean | undefined },
): Promise<{ exitCode: number; text: string }> {
  if (!target || target === 'all' || target === 'session_store_sql') {
    return { exitCode: 0, text: formatSessionStoreCatalog(opts) }
  }

  // 1. Check if target is a known session store table
  const sessionTable = getSessionStoreTable(target)
  if (sessionTable) {
    return { exitCode: 0, text: formatSessionStoreTable(sessionTable, opts) }
  }

  // 2. Check if target is a SQLite file
  const absPath = resolve(process.cwd(), target)
  if (existsSync(absPath)) {
    try {
      const { isSqliteFile, getSqliteSchema, formatSqliteSchema } = await import('./sqlite_query.js')
      if (isSqliteFile(absPath)) {
        const schema = getSqliteSchema(absPath)
        if (table) {
          const found = schema.tables.find((t) => t.name.toLowerCase() === table.toLowerCase())
          if (!found) {
            const avail = schema.tables.map((t) => t.name).join(', ')
            return { exitCode: 1, text: `Table '${table}' not found in SQLite database ${target}. Available tables: ${avail}` }
          }
          if (opts?.json === true) {
            return { exitCode: 0, text: displaySafeJson(found) }
          }
          const lines = [
            `# SQLite Table: ${found.name} (${found.kind}) in ${target}`,
            `Row Count: ${found.rowCount ?? 'unknown'}`,
            '',
            '| Column | Type | Nullable | Default | PK |',
            '| :--- | :--- | :--- | :--- | :--- |',
          ]
          for (const col of found.columns) {
            lines.push(`| \`${col.name}\` | \`${col.type}\` | ${col.notNull ? 'NO' : 'YES'} | ${col.defaultValue ?? 'NULL'} | ${col.primaryKey ? 'YES' : 'NO'} |`)
          }
          return { exitCode: 0, text: lines.join('\n') }
        }
        if (opts?.json === true) {
          return { exitCode: 0, text: displaySafeJson(schema) }
        }
        return { exitCode: 0, text: formatSqliteSchema(schema) }
      }
    } catch (err: unknown) {
      return { exitCode: 1, text: `Error reading SQLite database ${target}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // Target not recognized as file or table
  const avail = SESSION_STORE_TABLES.map((t) => t.name).join(', ')
  return {
    exitCode: 1,
    text: `Unknown table or SQLite file '${target}'. Available session store tables: ${avail}\nRun 'token-goat session-schema' to see all tables.`,
  }
}

/**
 * Diagnostic helper that inspects SQL tool failures and returns surgical column/table guidance.
 */
export function diagnoseSqlFailure(event: HookEvent, errorText: string): string | null {
  const toolName = (getToolName(event) || '').toLowerCase()
  const isSqlTool =
    toolName === 'session_store_sql' ||
    toolName === 'sql' ||
    toolName === 'sqlite_query' ||
    toolName === 'sqlite-query' ||
    /sql/i.test(toolName)

  // Look for column or table not found errors
  const isColumnError =
    /referenced column\s*["']?([^"'\s]+)["']?\s*not found/i.test(errorText) ||
    /no such column:\s*([^\s,;]+)/i.test(errorText) ||
    /column\s*["']?([^"'\s]+)["']?\s*(?:does not exist|not found)/i.test(errorText) ||
    /has no column named\s*([^\s,;]+)/i.test(errorText)

  const isTableError =
    /table\s*["']?([^"'\s]+)["']?\s*(?:does not exist|not found)/i.test(errorText) ||
    /no such table:\s*([^\s,;]+)/i.test(errorText)

  if (!isColumnError && !isTableError && !isSqlTool) {
    return null
  }

  // Extract query from tool input if available
  const query =
    typeof event.toolInput['query'] === 'string'
      ? event.toolInput['query']
      : typeof event.toolInput['sql'] === 'string'
        ? event.toolInput['sql']
        : ''

  // Attempt to extract referenced table from query (FROM/JOIN <table>)
  let matchedTable: SessionStoreTable | undefined
  if (query) {
    const fromMatch = query.match(/(?:from|join)\s+([a-zA-Z0-9_]+)/i)
    if (fromMatch && fromMatch[1]) {
      matchedTable = getSessionStoreTable(fromMatch[1])
    }
  }

  // Extract invalid column name
  let badCol: string | undefined
  const colMatch =
    errorText.match(/referenced column\s*["']?([^"'\s]+)["']?\s*not found/i) ??
    errorText.match(/no such column:\s*([^\s,;]+)/i) ??
    errorText.match(/column\s*["']?([^"'\s]+)["']?\s*(?:does not exist|not found)/i) ??
    errorText.match(/has no column named\s*([^\s,;]+)/i)
  const matchedColName = colMatch?.[1]
  if (matchedColName) {
    const raw = matchedColName.trim()
    if (!raw.startsWith('$') && !raw.includes('{')) {
      badCol = raw.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase()
    }
  }

  if (matchedTable) {
    const validCols = matchedTable.columns.map((c) => c.name).join(', ')
    let advice = `[token-goat] Table '${matchedTable.name}' has columns: ${validCols}.`

    if (badCol && matchedTable.commonMisnomers && matchedTable.commonMisnomers[badCol]) {
      advice += ` (For '${badCol}', use ${matchedTable.commonMisnomers[badCol]}).`
    } else if (badCol) {
      advice += ` (Column '${badCol}' does not exist on '${matchedTable.name}').`
    }

    advice += ` Run 'token-goat session-schema ${matchedTable.name}' to inspect full table structure.`
    return advice
  }

  // If table was unknown or not found in query
  if (isTableError) {
    const tableMatch =
      errorText.match(/table\s*["']?([^"'\s]+)["']?\s*(?:does not exist|not found)/i) ??
      errorText.match(/no such table:\s*([^\s,;]+)/i)
    const badTable = tableMatch ? tableMatch[1] : undefined
    if (badTable && (badTable.startsWith('$') || badTable.includes('{'))) {
      return null
    }
    const knownTables = SESSION_STORE_TABLES.map((t) => t.name).join(', ')
    return `[token-goat] ${badTable ? `Table '${badTable}' does not exist.` : 'Table not found.'} Available session store tables: ${knownTables}. Run 'token-goat session-schema' for schema details.`
  }

  return null
}

export function runSessionSchema(opts: { table?: string | undefined; json?: boolean | undefined }): number {
  if (!opts.table) {
    process.stdout.write(formatSessionStoreCatalog({ json: opts.json }) + '\n')
    return 0
  }
  const found = getSessionStoreTable(opts.table)
  if (!found) {
    const avail = SESSION_STORE_TABLES.map((t) => t.name).join(', ')
    process.stderr.write(`Unknown session store table '${opts.table}'. Available tables: ${avail}\nRun 'token-goat session-schema' to see all tables.\n`)
    return 1
  }
  process.stdout.write(formatSessionStoreTable(found, { json: opts.json }) + '\n')
  return 0
}

export async function runDescribe(opts: { target?: string | undefined; table?: string | undefined; json?: boolean | undefined }): Promise<number> {
  const result = await describeTarget(opts.target, opts.table, { json: opts.json })
  if (result.exitCode !== 0) {
    process.stderr.write(result.text + '\n')
  } else {
    process.stdout.write(result.text + '\n')
  }
  return result.exitCode
}

export function cmdSessionSchema(table?: string, opts?: { json?: boolean }): void {
  process.exitCode = runSessionSchema({ table, json: opts?.json })
}

export async function cmdDescribe(target?: string, table?: string, opts?: { json?: boolean }): Promise<void> {
  process.exitCode = await runDescribe({ target, table, json: opts?.json })
}

