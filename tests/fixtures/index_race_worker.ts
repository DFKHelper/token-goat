/**
 * One process of the concurrent cold-start indexing race (see index_concurrent_write_race.test.ts).
 *
 * Indexes a shared set of source files into a shared index database and prints one line per file
 * that failed. Every worker points at the same database and the same files on purpose: the race
 * being reproduced needs several processes writing to a database that did not exist when they
 * started, which is what happens the first time two `token-goat index` runs, or an index run and
 * the worker daemon, overlap in a fresh project.
 *
 * Every worker waits at a barrier before touching the database, so the collision this reproduces
 * happens on purpose rather than by luck. Without it each worker starts whenever its own `tsx`
 * finished transpiling, which spreads the starts over hundreds of milliseconds and leaves the
 * first-file collision -- the one that decides whether the database gets created once or six times
 * at once -- to chance: the failure it exists to catch showed up in roughly one run in four.
 *
 * Argv: <dbPath> <srcDir> <fileCount> <barrierPath>
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { indexFileSync } from '../../src/parser.js'
import { sleepSync } from '../../src/util.js'

const dbPath = process.argv[2] ?? ''
const srcDir = process.argv[3] ?? ''
const fileCount = Number(process.argv[4] ?? '0')
const barrierPath = process.argv[5] ?? ''

if (barrierPath) {
  // Announce readiness, then spin until the parent drops the barrier. Everything expensive --
  // module loading, transpiling, the first parse -- is already paid for by this point, so what
  // follows the barrier is the database work itself.
  process.stderr.write('ready\n')
  const deadline = Date.now() + 60_000
  while (!fs.existsSync(barrierPath) && Date.now() < deadline) sleepSync(2)
}

for (let i = 0; i < fileCount; i++) {
  const file = path.join(srcDir, `mod${i}.ts`)
  try {
    indexFileSync(file, dbPath)
  } catch (e) {
    // Printed rather than thrown so one failure does not hide the ones after it, and so the parent
    // can assert on the exact message. The production caller (cmdIndex) behaves the same way: it
    // counts the file as failed and carries on, which is precisely why this defect could drop a
    // file from the index while the command still exited 0.
    process.stdout.write(`FAILED ${path.basename(file)}: ${(e as Error).message}\n`)
  }
}
