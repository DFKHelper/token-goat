/** Counts the work a command does against the `symbols` table through the real shared connection: every statement that reads it, the arguments each run bound, the rows each returned, and how many of those rows carried a `body`. For tests that pin how much a read path reads rather than how long it takes, which CI cannot measure. */
import { globalDbPath } from '../../src/constants.js'
import { getDb } from '../../src/db.js'

export interface SymbolRun {
  sql: string
  args: unknown[]
  rows: number
}

export interface SymbolWork {
  statements: number
  rows: number
  bodyRows: number
  sql: string[]
  runs: SymbolRun[]
}

/** Wrap the shared connection's `prepare` so every statement that reads `symbols` is counted. Call `restore` in a `finally`. */
export function instrumentSymbolReads(): { work: SymbolWork; restore: () => void } {
  const db = getDb(globalDbPath()) as unknown as { prepare: (sql: string) => object }
  const original = db.prepare
  const work: SymbolWork = { statements: 0, rows: 0, bodyRows: 0, sql: [], runs: [] }
  db.prepare = function (this: unknown, sql: string): object {
    const stmt = original.call(this, sql) as Record<string, (...a: unknown[]) => unknown>
    if (!/\bFROM\s+symbols\b/i.test(sql)) return stmt
    work.statements++
    work.sql.push(sql)
    const readsBody = /\bbody\b/i.test(sql.split(/\bFROM\b/i)[0] ?? '')
    const record = (args: unknown[], n: number): void => {
      work.runs.push({ sql, args, rows: n })
      work.rows += n
      if (readsBody) work.bodyRows += n
    }
    const proxy: object = new Proxy(stmt, {
      get(target, prop): unknown {
        const value = target[prop as string]
        if (typeof value !== 'function') return value
        if (prop === 'all') return (...a: unknown[]) => { const r = value.apply(target, a) as unknown[]; record(a, r.length); return r }
        if (prop === 'get') return (...a: unknown[]) => { const r = value.apply(target, a); record(a, r === undefined ? 0 : 1); return r }
        if (prop === 'iterate') return function* (...a: unknown[]) { let n = 0; for (const r of value.apply(target, a) as Iterable<unknown>) { n++; yield r } record(a, n) }
        if (prop === 'pluck') return (...a: unknown[]) => { value.apply(target, a); return proxy }
        return value.bind(target)
      },
    })
    return proxy
  }
  return { work, restore: () => { db.prepare = original } }
}

/** The plan SQLite would choose for one recorded run, one detail line per step. */
export function queryPlan(run: SymbolRun): string[] {
  const db = getDb(globalDbPath())
  return (db.prepare(`EXPLAIN QUERY PLAN ${run.sql}`).all(...(run.args as Array<string | number>)) as Array<{ detail: string }>).map((r) => r.detail)
}
