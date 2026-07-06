/**
 * Narrow CSV projection/filter for `token-goat csv-query`, so a multi-thousand
 * row CSV never needs a full `Read` just to answer "what's in column X where
 * Y = Z". Deliberately no query language beyond column projection + one
 * equality filter -- matches the project's "no premature abstraction" bar.
 */

import { parse } from 'csv-parse/sync'

export interface CsvQueryOptions {
  columns?: string[]
  whereColumn?: string
  whereValue?: string | undefined
  head?: number
}

export interface CsvQueryResult {
  header: string[]
  rows: string[][]
  totalRows: number
}

export function queryCsv(content: string, opts: CsvQueryOptions): CsvQueryResult {
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>

  const allColumns = records.length > 0 ? Object.keys(records[0] as Record<string, string>) : []
  const columns = opts.columns && opts.columns.length > 0 ? opts.columns : allColumns

  for (const c of columns) {
    if (!allColumns.includes(c)) {
      throw new Error(`unknown column: ${c} (available: ${allColumns.join(', ')})`)
    }
  }
  if (opts.whereColumn !== undefined && !allColumns.includes(opts.whereColumn)) {
    throw new Error(`unknown column: ${opts.whereColumn} (available: ${allColumns.join(', ')})`)
  }

  let filtered = records
  if (opts.whereColumn !== undefined) {
    const whereColumn = opts.whereColumn
    const whereValue = opts.whereValue ?? ''
    filtered = records.filter((r) => r[whereColumn] === whereValue)
  }

  const totalRows = filtered.length
  const limited = opts.head !== undefined ? filtered.slice(0, opts.head) : filtered
  const rows = limited.map((r) => columns.map((c) => r[c] ?? ''))

  return { header: columns, rows, totalRows }
}

function quoteCsvCell(cell: string): string {
  // RFC 4180: quote cells containing comma, double quote, or newline.
  // Escape embedded quotes by doubling them.
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
    return `"${cell.replace(/"/g, '""')}"`
  }
  return cell
}

export function formatCsvTable(result: CsvQueryResult): string {
  const lines = [
    result.header.map(quoteCsvCell).join(','),
    ...result.rows.map((r) => r.map(quoteCsvCell).join(','))
  ]
  if (result.totalRows > result.rows.length) {
    lines.push(`...(${result.totalRows - result.rows.length} more rows elided; use --head to see more)`)
  }
  return lines.join('\n')
}
