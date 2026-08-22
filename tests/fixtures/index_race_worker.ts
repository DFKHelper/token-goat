/**
 * One process of the concurrent cold-start indexing race (see index_concurrent_write_race.test.ts).
 *
 * Indexes a shared set of source files into a shared index database and prints one line per file
 * that failed. Every worker points at the same database and the same files on purpose: the race
 * being reproduced needs several processes writing to a database that did not exist when they
 * started, which is what happens the first time two `token-goat index` runs, or an index run and
 * the worker daemon, overlap in a fresh project.
 *
 * Argv: <dbPath> <srcDir> <fileCount>
 */
import * as path from 'node:path'

import { indexFileSync } from '../../src/parser.js'

const dbPath = process.argv[2] ?? ''
const srcDir = process.argv[3] ?? ''
const fileCount = Number(process.argv[4] ?? '0')

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
