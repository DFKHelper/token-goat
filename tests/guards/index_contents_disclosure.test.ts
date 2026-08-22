/**
 * The README tells an evaluator, in plain terms, that the index stores their source code and names
 * the columns that hold it. That disclosure is only worth anything while it matches the schema.
 * The failure that matters is not a rename: it is a new content-bearing table or column landing
 * quietly, leaving the document describing a smaller database than the one on disk. So the table
 * list is frozen here, and adding to it forces a decision about what the README now has to say.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const schema = fs.readFileSync(path.join(repoRoot, 'src', 'db.ts'), 'utf8')
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')

/** Every table the schema creates, virtual ones included, since an FTS table holds the text too. */
function schemaTables(): string[] {
  return [...schema.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1] as string).sort()
}

/** The column names inside one CREATE TABLE block, read by slicing rather than by regex. */
function columnsOf(table: string): string[] {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
  if (start === -1) return []
  const end = schema.indexOf('\n);', start)
  return schema
    .slice(start, end)
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

// Frozen deliberately. A new entry here is a prompt, not an obstacle: decide whether it stores file
// content, update the "What the index actually holds" paragraph if it does, then add the name.
const DISCLOSED_TABLES = [
  'cache_recall',
  'cache_recall_fts',
  'chunk_vectors',
  'chunks',
  // Holds one string naming the model, revision and backend that produced the stored vectors --
  // no file content, nothing derived from the user's code -- so the README's "What the index
  // actually holds" paragraph is still accurate without it. Recorded here because that judgement
  // is the whole point of this list; the next table to arrive has to make the same one.
  'embedding_provenance',
  'files',
  'hint_emissions',
  'hint_manual_marks',
  'hint_suppression_probes',
  'known_roots',
  'notes',
  'refs',
  'skill_version_snapshots',
  'symbols',
  'symbols_fts',
]

describe('index contents disclosure', () => {
  it('finds the schema at all, so an empty sweep cannot pass as a clean one', () => {
    expect(schemaTables().length).toBeGreaterThan(10)
  })

  it('has no table the disclosure has never been checked against', () => {
    expect(schemaTables()).toEqual(DISCLOSED_TABLES)
  })

  it.each([
    ['symbols.body'],
    ['symbols.docstring'],
    ['refs.context'],
    ['chunks.text'],
  ])('still names %s in the README, and the column still exists', (qualified) => {
    const [table, column] = qualified.split('.') as [string, string]
    expect(readme, 'the README names this column').toContain(qualified)
    expect(columnsOf(table), `${table} still has a ${column} column`).toContain(column)
  })

  it('still tells the reader how to delete it', () => {
    expect(readme).toContain('uninstall --purge')
  })
})
