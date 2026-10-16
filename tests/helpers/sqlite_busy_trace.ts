/** A Node preload for a spawned token-goat process that records every `busy_timeout` the process sets on a SQLite connection, so a test can assert the wait a connection was given without waiting on a lock or reading a clock. HAND-DERIVED: the connection facade (src/sqlite_driver.ts) sets the wait by preparing `PRAGMA busy_timeout = N` on node:sqlite's DatabaseSync, and a CommonJS preload patching that prototype sees the same class object the bundle loads. With `exitAtMs` the preload also ends the process with status 97 the moment a wait of at least that many milliseconds is set, so a regression to the long budget fails the case at once instead of after the long wait. */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Exit status the preload ends the process with when a wait reaches `exitAtMs`. */
export const BUSY_TRIPWIRE_STATUS = 97

/** Environment variable naming the file the preload appends each observed busy_timeout to, one number per line. */
const TRACE_ENV = 'TG_TEST_BUSY_TRACE'
/** Environment variable carrying the tripwire threshold in milliseconds, absent when the preload only records. */
const EXIT_ENV = 'TG_TEST_BUSY_EXIT_AT_MS'

const PRELOAD_SOURCE = [
  "const fs = require('node:fs')",
  "const { DatabaseSync } = require('node:sqlite')",
  'const pattern = /busy_timeout\\s*=\\s*(\\d+)/',
  `const traceFile = process.env.${TRACE_ENV}`,
  `const exitAt = Number(process.env.${EXIT_ENV} || 0)`,
  'function observe(sql) {',
  '  const m = pattern.exec(String(sql))',
  '  if (m === null || !traceFile) return',
  "  fs.appendFileSync(traceFile, m[1] + '\\n')",
  `  if (exitAt > 0 && Number(m[1]) >= exitAt) process.exit(${BUSY_TRIPWIRE_STATUS})`,
  '}',
  'for (const name of ["prepare", "exec"]) {',
  '  const original = DatabaseSync.prototype[name]',
  '  DatabaseSync.prototype[name] = function (sql) {',
  '    observe(sql)',
  '    return original.apply(this, arguments)',
  '  }',
  '}',
].join('\n')

export interface BusyTrace {
  /** Environment to add to the spawned process; any NODE_OPTIONS already set is kept. */
  env: Record<string, string>
  /** Every busy_timeout the traced processes have set so far, in milliseconds. */
  seen(): number[]
}

/** Write the preload and an empty trace file under `dir` and return the environment that arms them. */
export function busyTrace(dir: string, opts: { exitAtMs?: number } = {}): BusyTrace {
  const preload = path.join(dir, 'busy_trace_preload.cjs')
  const traceFile = path.join(dir, 'busy_trace.txt')
  fs.writeFileSync(preload, PRELOAD_SOURCE)
  fs.writeFileSync(traceFile, '')
  const inherited = process.env['NODE_OPTIONS']
  const env: Record<string, string> = {
    NODE_OPTIONS: `${inherited ? `${inherited} ` : ''}--require ${JSON.stringify(preload.split(path.sep).join('/'))}`,
    [TRACE_ENV]: traceFile,
  }
  if (opts.exitAtMs !== undefined) env[EXIT_ENV] = String(opts.exitAtMs)
  return {
    env,
    seen: () => fs.readFileSync(traceFile, 'utf8').split('\n').filter((line) => line !== '').map(Number),
  }
}
