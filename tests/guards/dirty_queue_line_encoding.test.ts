/**
 * Guard: a file name must survive the dirty queue's line format.
 *
 * The queue is one path per line, written as `path + '\n'` and read back by splitting on '\n' and
 * trimming each line. Newlines are legal in file names on Linux and macOS, and so are leading and
 * trailing spaces, so a file called `weird\nname.ts` was appended as two lines and came back as two
 * paths, neither of which was the file. The real file was then never reindexed and never pruned
 * when it was deleted -- the silent index staleness this project treats as its highest-priority
 * failure class -- while the two fragments were processed as if they were paths of their own, each
 * one either reindexing an unrelated file that happened to match or driving a prune for a path that
 * does not exist. A trailing space was quieter and just as permanent: the path went in intact and
 * came back trimmed, so it never matched the file again.
 *
 * Why didn't a test catch this: every dirty-queue fixture in the suite is a tidy path like
 * `/a/one.ts`, so the round trip was only ever exercised on inputs the format happens to survive.
 * The gap was in the input domain rather than the logic. These cases put a path the format cannot
 * hold in one end and require the same string out of the other.
 *
 * The controls are the load-bearing half. An ordinary path must still be written as itself followed
 * by a newline, byte for byte, because that on-disk shape is what a queue written by an older build
 * looks like and what the rest of the suite reads; and a queue file written before this encoding
 * existed must still parse. A fix that encoded every line would pass the round trip and silently
 * break both.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-queueline-'))

vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return {
    ...actual,
    dataDir: () => DATA_DIR,
    globalDbPath: () => path.join(DATA_DIR, 'global.db'),
  }
})

const { appendDirtyPath, clearDirtyQueue, dirtyQueuePath } = await import('../../src/hooks_index.js')
const { parseDirtyQueueLines } = await import('../../src/worker.js')

/** Exactly what a drain sees: the bytes on disk, parsed by the parser the drain uses. */
function roundTrip(): string[] {
  return parseDirtyQueueLines(fs.readFileSync(dirtyQueuePath(), 'utf8'))
}

beforeEach(() => {
  clearDirtyQueue()
  fs.rmSync(path.join(DATA_DIR, 'queue'), { recursive: true, force: true })
})

describe('the dirty queue line format', () => {
  it('carries a path containing a newline as one entry, not two', () => {
    const weird = '/repo/weird\nname.ts'
    appendDirtyPath(weird)
    expect(roundTrip(), 'a newline in the name split one queued file into two bogus paths').toEqual([weird])
  })

  it('carries a path containing a carriage return', () => {
    const weird = '/repo/weird\rname.ts'
    appendDirtyPath(weird)
    expect(roundTrip()).toEqual([weird])
  })

  // The name's last character, not a space somewhere inside it: the reader trims each line, so only
  // a path whose own final character is whitespace is at risk.
  it('keeps a name that ends in a space rather than trimming it into a different file', () => {
    const spaced = '/repo/trailing.ts '
    appendDirtyPath(spaced)
    expect(roundTrip(), 'the trimmed path names a file that does not exist').toEqual([spaced])
  })

  it('keeps a name that ends in a tab', () => {
    const tabbed = '/repo/tabbed.ts\t'
    appendDirtyPath(tabbed)
    expect(roundTrip()).toEqual([tabbed])
  })

  it('still separates two ordinary paths queued back to back', () => {
    appendDirtyPath('/repo/one.ts')
    appendDirtyPath('/repo/two.ts')
    expect(roundTrip()).toEqual(['/repo/one.ts', '/repo/two.ts'])
  })

  it('writes an ordinary path as itself, so the file on disk is what it always was', () => {
    appendDirtyPath('/repo/one.ts')
    appendDirtyPath('/repo/two.ts')
    expect(fs.readFileSync(dirtyQueuePath(), 'utf8'), 'the on-disk format changed for ordinary paths').toBe(
      '/repo/one.ts\n/repo/two.ts\n',
    )
  })

  it('reads a queue file written before this encoding existed', () => {
    fs.mkdirSync(path.dirname(dirtyQueuePath()), { recursive: true })
    fs.writeFileSync(dirtyQueuePath(), 'c:/repo/legacy.ts\n/repo/other.ts\n')
    expect(roundTrip(), 'an older build\u2019s queue stopped parsing').toEqual(['c:/repo/legacy.ts', '/repo/other.ts'])
  })

  it('leaves a path that merely starts with the marker character alone', () => {
    // The marker is only meaningful on a line the writer encoded, and an encoded line is valid JSON
    // after it. A raw path beginning with the same character must not be mistaken for one.
    fs.mkdirSync(path.dirname(dirtyQueuePath()), { recursive: true })
    fs.writeFileSync(dirtyQueuePath(), '!not-encoded.ts\n')
    expect(roundTrip()).toEqual(['!not-encoded.ts'])
  })

  it('still deduplicates, including by case where the filesystem folds case', () => {
    appendDirtyPath('/repo/dup.ts')
    appendDirtyPath('/repo/dup.ts')
    expect(roundTrip()).toEqual(['/repo/dup.ts'])
  })
})
