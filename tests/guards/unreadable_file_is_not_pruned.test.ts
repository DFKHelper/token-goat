/**
 * Guard: a dirty file that cannot be examined must never be pruned from the index.
 *
 * `processDirtyBatch` decided a queued path had been deleted with `fs.existsSync`, and on a false
 * it called `remove`, dropping that file's symbols, references, sections and embedding chunks.
 * `fs.existsSync` is a stat inside a bare catch: it answers false for a permission or I/O error
 * exactly as it does for a missing file. So a file held open by an antivirus scanner, sitting
 * behind a deny ACE, or on a share that blinked, was erased from the index while still on disk --
 * silently, with `symbol Foo` returning nothing afterwards until something edited the file again.
 * The branch immediately below it already treated this same class of failure as transient, logging
 * and requeueing it; only the existence check acted on the ambiguity destructively.
 *
 * Why didn't a test catch this: every existing test of the deletion branch deletes the file for
 * real, and a real ENOENT is the one case where `existsSync` and a proper ENOENT check agree. The
 * unreadable-but-present case was never constructed, because constructing it takes an actual
 * permission change rather than a stub. This file makes one.
 *
 * The permission tests assert their own precondition first -- that `fs.existsSync` really does
 * answer false for the file they just created -- and skip if the sandbox would not let them set
 * that up (a root or elevated runner ignores the restriction). A skip means the environment could
 * not host the test, never that the behaviour passed.
 */
import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { sealDirectory, unsealDirectory } from '../helpers/seal-directory.js'
import { dataDir } from '../../src/constants.js'
import { fileIsAbsent } from '../../src/fingerprint.js'
import { querySymbols } from '../../src/index_reader.js'
import { indexFileSync } from '../../src/parser.js'
import { normalizePath } from '../../src/util.js'
import { processDirtyBatch } from '../../src/worker.js'

/** A file that exists but that this process cannot stat, or null when the sandbox refused. */
let unreadable: string | null = null
/** Directories whose permissions must be restored before the temp tree can be removed. */
const toRestore: string[] = []

// Run at collection time, not in beforeAll, so `it.skipIf` below can see the result and a runner
// that would not let us seal the directory reports skipped tests rather than silently passing ones.
const root = mkdtempSync(join(tmpdir(), 'tg-unreadable-'))
{
  const sealed = join(root, 'sealed')
  fs.mkdirSync(sealed)
  const file = join(sealed, 'live.ts')
  writeFileSync(file, 'export function alive(): number {\n  return 1\n}\n')
  if (sealDirectory(sealed)) toRestore.push(sealed)
  if (!fs.existsSync(file)) unreadable = file
}
const sealedFile = unreadable
const cannotSeal = sealedFile === null

// A second file, indexed for real before its directory is sealed, so one case can assert on the
// database rather than on injected callbacks.
let indexedThenSealed: string | null = null
{
  const dir = join(root, 'indexed')
  fs.mkdirSync(dir)
  const file = normalizePath(join(dir, 'kept.ts'))
  writeFileSync(file, 'export function survives(): number {\n  return 7\n}\n')
  indexFileSync(file)
  if (sealDirectory(dir)) toRestore.push(dir)
  if (!fs.existsSync(file)) indexedThenSealed = file
}
const cannotIndex = indexedThenSealed === null

afterAll(() => {
  for (const dir of toRestore) unsealDirectory(dir)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // A directory the runner would not let us restore stays behind; it is under the temp root.
  }
})

describe('fileIsAbsent', () => {
  it('is true for a path that genuinely does not exist', () => {
    expect(fileIsAbsent(join(root, 'never-written.ts'))).toBe(true)
  })

  it('is false for a file that is right there', () => {
    const p = join(root, 'plain.ts')
    writeFileSync(p, 'export const x = 1\n')
    expect(fileIsAbsent(p)).toBe(false)
  })

  it('is false for a directory, which exists but cannot be read as a file', () => {
    expect(fileIsAbsent(root)).toBe(false)
  })

  it.skipIf(cannotSeal)('is false for a file it cannot examine, where fs.existsSync says false', () => {
    const target = sealedFile as string
    expect(fs.existsSync(target), 'precondition: existsSync must be wrong here').toBe(false)
    expect(
      fileIsAbsent(target),
      'an unreadable file was reported as absent, which is what erased it from the index',
    ).toBe(false)
  })
})

describe('processDirtyBatch on a file it cannot examine', () => {
  it.skipIf(cannotSeal)('requeues it instead of deleting its index rows', () => {
    const target = sealedFile as string
    expect(fs.existsSync(target), 'precondition: existsSync must be wrong here').toBe(false)

    const removed: string[] = []
    const requeued: string[] = []
    const indexed: string[] = []
    processDirtyBatch(
      [target],
      (p) => {
        indexed.push(p)
        return true
      },
      (p) => {
        removed.push(p)
      },
      root,
      (_dir, p) => {
        requeued.push(p)
      },
    )

    expect(removed, 'a file that is still on disk had its index rows pruned').toEqual([])
    expect(requeued, 'an unreadable file was dropped rather than retried later').toEqual([target])
    expect(indexed, 'a file that could not be read cannot have been indexed').toEqual([])
  })

  it.skipIf(cannotIndex)('leaves its rows in the real index, with no callbacks injected', () => {
    // The case above injects `remove` and `requeue` to watch which branch is taken, which cannot
    // show what the shipping path actually does to the database. This one indexes a real file,
    // takes the permission away, and drains it through processDirtyBatch's own default callbacks:
    // the symbol has to still be there afterwards.
    const target = indexedThenSealed as string
    expect(fs.existsSync(target), 'precondition: existsSync must be wrong here').toBe(false)
    expect(
      querySymbols({ name: 'survives' }).map((s) => s.filePath),
      'precondition: the file must be in the index before the drain',
    ).toContain(target)

    processDirtyBatch([target], undefined, undefined, dataDir())

    expect(
      querySymbols({ name: 'survives' }).map((s) => s.filePath),
      'a file still on disk lost its symbols from the index',
    ).toContain(target)
  })

  it('still prunes a file that is genuinely gone, so deletions are reconciled as before', () => {
    const gone = join(root, 'deleted.ts')
    writeFileSync(gone, 'export const y = 2\n')
    rmSync(gone)

    const removed: string[] = []
    const requeued: string[] = []
    processDirtyBatch(
      [gone],
      () => true,
      (p) => {
        removed.push(p)
      },
      root,
      (_dir, p) => {
        requeued.push(p)
      },
    )

    expect(removed).toEqual([gone])
    expect(requeued).toEqual([])
  })

  it('still indexes a file that reads normally', () => {
    const fine = join(root, 'fine.ts')
    writeFileSync(fine, 'export const z = 3\n')

    const removed: string[] = []
    const indexed: string[] = []
    const count = processDirtyBatch(
      [fine],
      (p) => {
        indexed.push(p)
        return true
      },
      (p) => {
        removed.push(p)
      },
      root,
      () => {},
    )

    expect(count).toBe(1)
    expect(indexed).toEqual([fine])
    expect(removed).toEqual([])
  })
})
