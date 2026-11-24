// Fixture provenance: HAND-DERIVED; the files, their bytes and the forced write failure are written here.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createdBackupsFor, undoCreatedOnFailure } from '../src/bridges/created_configs.js'
import { atomicWriteBytes, backupFile } from '../src/util.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-failed-restore-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

const EARLIER = '{"earlier":true}\n'
const REWRITTEN = '{"rewritten":true}\n'
const DISK_FULL = 'ENOSPC: no space left on device, write'

function install(p: string): void {
  backupFile(p)
  atomicWriteBytes(p, Buffer.from(REWRITTEN))
}

describe('a failed install whose restore of one file fails', () => {
  it('keeps that file backup, names both paths, and still restores the other file', () => {
    const a = path.join(TMP, 'a.json')
    const b = path.join(TMP, 'b.json')
    fs.writeFileSync(a, EARLIER)
    fs.writeFileSync(b, EARLIER)
    const failing = (p: string, bytes: Buffer): void => {
      if (p === a) throw new Error(DISK_FULL)
      atomicWriteBytes(p, bytes)
    }
    let reported = ''
    try {
      undoCreatedOnFailure(
        [a, b],
        () => {
          install(a)
          install(b)
          throw new Error('the probe failed')
        },
        failing,
      )
    } catch (error) {
      reported = (error as Error).message
    }
    const kept = fs.readdirSync(TMP).filter((f) => f.startsWith('a.json.bak.')).map((f) => path.join(TMP, f))
    expect(kept.length, 'backup still exists').toBe(1)
    const same = (list: string[]): string[] => list.map((p) => fs.realpathSync.native(path.resolve(p)).toLowerCase())
    const canonicalBackup = fs.realpathSync.native(path.resolve(kept[0]!))
    expect(same(createdBackupsFor(a)), 'the ledger still names it').toEqual(same(kept))
    expect(fs.readFileSync(kept[0]!, 'utf8'), 'the backup holds the earlier bytes').toBe(EARLIER)
    expect(reported, 'the error names the file').toContain(a)
    expect(reported.toLowerCase(), 'the error names the backup').toContain(canonicalBackup.toLowerCase())
    expect(reported, 'the error still carries the install failure').toContain('the probe failed')
    expect(fs.readFileSync(b, 'utf8'), 'the second file was restored').toBe(EARLIER)
    expect(createdBackupsFor(b), 'the restored file has no backup of this install left').toEqual([])
    expect(reported, 'a restored file is not reported').not.toContain(b)
  })

  it('removes the backups of every file when each restore is confirmed', () => {
    const a = path.join(TMP, 'a.json')
    fs.writeFileSync(a, EARLIER)
    expect(() =>
      undoCreatedOnFailure(
        [a],
        () => {
          install(a)
          throw new Error('the probe failed')
        },
        atomicWriteBytes,
      ),
    ).toThrow('the probe failed')
    expect(fs.readFileSync(a, 'utf8')).toBe(EARLIER)
    expect(createdBackupsFor(a)).toEqual([])
    expect(fs.readdirSync(TMP).filter((f) => f.includes('.bak.'))).toEqual([])
  })

  it('treats a write that returns without putting the bytes back as not restored', () => {
    const a = path.join(TMP, 'a.json')
    fs.writeFileSync(a, EARLIER)
    let reported = ''
    try {
      undoCreatedOnFailure(
        [a],
        () => {
          install(a)
          throw new Error('the probe failed')
        },
        () => undefined,
      )
    } catch (error) {
      reported = (error as Error).message
    }
    expect(createdBackupsFor(a), 'backup kept after a restore that read back wrong').toHaveLength(1)
    expect(reported).toContain(a)
  })
})
