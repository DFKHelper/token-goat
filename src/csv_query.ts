/**
 * Narrow CSV projection/filter for `token-goat csv-query`, so a multi-thousand
 * row CSV never needs a full `Read` just to answer "what's in column X where
 * Y = Z". Deliberately no query language beyond column projection + one
 * equality filter -- matches the project's "no premature abstraction" bar.
 */

import { parse } from 'csv-parse/sync'

export type CsvWhereOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~='

export interface CsvWhere {
  column: string
  op: CsvWhereOp
  value: string
}

export interface CsvQueryOptions {
  columns?: string[]
  wheres?: CsvWhere[]
  head?: number
  delimiter?: string
  noHeader?: boolean
}

function parseRecords(content: string, opts: { delimiter?: string; noHeader?: boolean }): Array<Record<string, string>> {
  const delimiter = opts.delimiter ?? ','
  if (opts.noHeader === true) {
    const rows = parse(content, { columns: false, skip_empty_lines: true, trim: true, delimiter, bom: true }) as string[][]
    return rows.map((row) => Object.fromEntries(row.map((cell, i) => [`col${i + 1}`, cell])))
  }
  return parse(content, { columns: true, skip_empty_lines: true, trim: true, delimiter, bom: true }) as Array<Record<string, string>>
}

export interface CsvQueryResult {
  header: string[]
  rows: string[][]
  totalRows: number
}

// The column-capture excludes = < > ~ outright (they can each start a real single-char
// operator, so a naive split must stop there and defer to resolveWhereColumn below). A bare
// '!' is different: it is never a valid standalone operator on its own, only '!=' is, so it
// is only excluded when immediately followed by '=' -- this lets a column literally named
// e.g. 'wow!thing' parse directly instead of hard-failing with no operator match at all.
const WHERE_SPEC_RE = /^((?:[^=<>~!]|!(?!=))+)(!=|~=|>=|<=|=|>|<)(.*)$/

/** Parses `col=value`/`col!=value`/`col>value`/`col<value`/`col>=value`/`col<=value`/`col~=regex`
 * specs from repeatable `--where` flags into structured filters, ANDed together by queryCsv. */
export function parseWhereSpecs(specs: string[] | undefined): CsvWhere[] | undefined {
  if (specs === undefined || specs.length === 0) return undefined
  return specs.map((spec) => {
    const m = WHERE_SPEC_RE.exec(spec)
    if (!m) throw new Error(`invalid --where spec: ${spec} (expected col=value, col!=value, col>value, col<value, col>=value, or col<=value, or col~=regex)`)
    return { column: (m[1] as string).trim(), op: m[2] as CsvWhereOp, value: m[3] as string }
  })
}

/**
 * `WHERE_SPEC_RE`'s column capture excludes `= < > ~ !` outright, so it always stops at the
 * FIRST operator-class character in the spec -- a column literally named e.g. `a<b` can never
 * be parsed correctly (`a<b=x` always splits as column `a`, op `<`, value `b=x`, even when a
 * genuine `a<b` column exists and was the intended target).
 *
 * Re-checks the naive split against the real header: reconstructs the raw spec text from
 * `where`'s own fields (invertible, since parseWhereSpecs never drops characters from column,
 * op, or value) and looks for a LONGER header entry that is a prefix of that raw text with a
 * remainder that still parses as a valid `op value` pair. The longest such header entry wins,
 * so an unambiguous shorter column (e.g. `a`) only loses to a genuine longer column (e.g.
 * `a<b`) that is actually present in this file's header -- never to an arbitrary substring.
 */
function resolveWhereColumn(where: CsvWhere, allColumns: string[]): CsvWhere {
  const rawSpec = where.column + where.op + where.value
  let best: CsvWhere = where
  for (const col of allColumns) {
    if (col.length <= best.column.length) continue
    if (!rawSpec.startsWith(col)) continue
    const rest = rawSpec.slice(col.length)
    const m = /^(!=|~=|>=|<=|=|>|<)(.*)$/.exec(rest)
    if (m) {
      best = { column: col, op: m[1] as CsvWhereOp, value: m[2] as string }
    }
  }
  return best
}

function matchesWhere(row: Record<string, string>, where: CsvWhere): boolean {
  const cell = row[where.column] ?? ''
  switch (where.op) {
    case '=':
      return cell === where.value
    case '!=':
      return cell !== where.value
    case '~=':
      return new RegExp(where.value).test(cell)
    case '>':
    case '<':
    case '>=':
    case '<=': {
      // `Number('')` is 0, not NaN, so a blank cell would otherwise be silently coerced to
      // the literal value 0 and wrongly match filters like `col<10` or `col>-1`. Treat a
      // blank cell as "no value" -- it never satisfies a numeric comparison -- unless the
      // cell is genuinely the string "0" (which is non-blank and compares normally below).
      if (cell.trim() === '') return false
      const cellNum = Number(cell)
      const valNum = Number(where.value)
      const useNum = !Number.isNaN(cellNum) && !Number.isNaN(valNum)
      const lhs: number | string = useNum ? cellNum : cell
      const rhs: number | string = useNum ? valNum : where.value
      switch (where.op) {
        case '>':
          return lhs > rhs
        case '<':
          return lhs < rhs
        case '>=':
          return lhs >= rhs
        case '<=':
          return lhs <= rhs
      }
    }
  }
}

export function queryCsv(content: string, opts: CsvQueryOptions): CsvQueryResult {
  const records = parseRecords(content, opts)

  const allColumns = records.length > 0 ? Object.keys(records[0] as Record<string, string>) : []
  const columns = opts.columns && opts.columns.length > 0 ? opts.columns : allColumns

  for (const c of columns) {
    if (!allColumns.includes(c)) {
      throw new Error(`unknown column: ${c} (available: ${allColumns.join(', ')})`)
    }
  }
  const wheres = (opts.wheres ?? []).map((w) => resolveWhereColumn(w, allColumns))

  for (const w of wheres) {
    if (!allColumns.includes(w.column)) {
      throw new Error(`unknown column: ${w.column} (available: ${allColumns.join(', ')})`)
    }
  }

  let filtered = records
  if (wheres.length > 0) {
    filtered = records.filter((r) => wheres.every((w) => matchesWhere(r, w)))
  }

  const totalRows = filtered.length
  const limited = opts.head !== undefined ? filtered.slice(0, opts.head) : filtered
  const rows = limited.map((r) => columns.map((c) => r[c] ?? ''))

  return { header: columns, rows, totalRows }
}

export function quoteCsvCell(cell: string): string {
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

export interface CsvColumnProfile {
  name: string
  inferredType: 'number' | 'date' | 'string'
  nullCount: number
  distinctCount: number
  min?: string
  max?: string
  topValues?: Array<{ value: string; count: number }>
}

/** Per-column type inference + null/distinct counts + min/max (or top values for
 * low-cardinality columns), so an agent can understand a CSV's shape without
 * reading every row. */
export function profileCsv(content: string, opts: { delimiter?: string; noHeader?: boolean } = {}): CsvColumnProfile[] {
  const records = parseRecords(content, opts)
  const columns = records.length > 0 ? Object.keys(records[0] as Record<string, string>) : []

  return columns.map((col) => {
    const values = records.map((r) => r[col] ?? '')
    const nullCount = values.filter((v) => v.trim() === '').length
    const nonEmpty = values.filter((v) => v.trim() !== '')
    const distinct = new Set(nonEmpty)
    const isNumber = nonEmpty.length > 0 && nonEmpty.every((v) => v.trim() !== '' && !Number.isNaN(Number(v)))
    const isDate = !isNumber && nonEmpty.length > 0 && nonEmpty.every((v) => !Number.isNaN(Date.parse(v)))
    const inferredType: CsvColumnProfile['inferredType'] = isNumber ? 'number' : isDate ? 'date' : 'string'

    const profile: CsvColumnProfile = { name: col, inferredType, nullCount, distinctCount: distinct.size }

    if (nonEmpty.length > 0) {
      if (isNumber) {
        const nums = nonEmpty.map(Number)
        profile.min = String(nums.reduce((a, b) => Math.min(a, b)))
        profile.max = String(nums.reduce((a, b) => Math.max(a, b)))
      } else {
        const sorted = [...nonEmpty].sort()
        profile.min = sorted[0] as string
        profile.max = sorted[sorted.length - 1] as string
      }
    }
    if (distinct.size > 0 && distinct.size <= 10) {
      const counts = new Map<string, number>()
      for (const v of nonEmpty) counts.set(v, (counts.get(v) ?? 0) + 1)
      profile.topValues = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }))
    }
    return profile
  })
}

export function formatCsvProfile(profiles: CsvColumnProfile[]): string {
  return profiles
    .map((p) => {
      const lines = [`${p.name}  (${p.inferredType})`, `  nulls: ${p.nullCount}  distinct: ${p.distinctCount}`]
      if (p.min !== undefined) lines.push(`  range: ${p.min} .. ${p.max}`)
      if (p.topValues !== undefined) lines.push(`  values: ${p.topValues.map((t) => `${t.value} (${t.count})`).join(', ')}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
