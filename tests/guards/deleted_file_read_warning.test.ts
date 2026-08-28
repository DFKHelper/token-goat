/**
 * Guard: reading an indexed file that has since been deleted must say so.
 *
 * `staleWarning` compared the on-disk SHA against the indexed one and returned '' whenever
 * `fingerprintFile` gave back null. null means two different things -- "the file is gone" and "the
 * file is there but momentarily unreadable" -- and only the second one is harmless. So a read of a
 * deleted file returned its indexed body, byte-identical to a live read, exit 0, with nothing to
 * suggest the file no longer existed. A caller would go on to edit or quote code that is not there.
 *
 * Why didn't a test catch this: the existing missing-file guard covers paths that were never
 * indexed, which do say "Could not read". Nothing covered the indexed-then-deleted case, where the
 * body is still in the database and the read succeeds. The two halves are asserted separately
 * below, because a fix that shouted about every unreadable file would satisfy the first alone: a
 * deleted file warns, and a present, unchanged file stays silent.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const DELETED_MARKER = '⚠ DELETED'
const STALE_MARKER = '⚠ STALE'

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [BUNDLE, ...args], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        TOKEN_GOAT_HOME: homeDir,
        LOCALAPPDATA: homeDir,
        XDG_DATA_HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    return { status: 0, out: stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-deleted-read-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-deleted-home-'))
  // `gone.ts` is deleted after indexing; `stays.ts` never is, and anchors the silent half.
  writeFileSync(join(projectDir, 'gone.ts'), 'export function vanishes(x: number): number {\n  return x + 1\n}\n')
  writeFileSync(join(projectDir, 'stays.ts'), 'export function remains(x: number): number {\n  return x + 2\n}\n')
  run(['index', '.', '--walk'])
  rmSync(join(projectDir, 'gone.ts'))
})

describe('reading a file that was indexed and then deleted', () => {
  it('still returns the indexed body (the body is what makes the silence dangerous)', () => {
    const { status, out } = run(['read', 'gone.ts::vanishes'])
    expect(status).toBe(0)
    expect(out).toContain('return x + 1')
  })

  for (const args of [
    ['read', 'gone.ts::vanishes'],
    ['outline', 'gone.ts'],
    ['skeleton', 'gone.ts'],
    ['symbol', 'vanishes'],
  ]) {
    it(`${args[0]} warns that the file is gone`, () => {
      const { out } = run(args)
      expect(out, `${args.join(' ')} served indexed content for a deleted file with no warning`).toContain(
        DELETED_MARKER,
      )
    })
  }

  it('symbol --json marks the row deleted rather than passing it off as a live file', () => {
    const { out } = run(['symbol', 'vanishes', '--json'])
    const payload = JSON.parse(out) as { items: { filePath: string; deleted?: boolean }[] }
    const row = payload.items.find((i) => i.filePath.includes('gone.ts'))
    expect(row, 'symbol --json dropped the deleted file entirely').toBeDefined()
    expect(row?.deleted).toBe(true)
  })

  for (const args of [
    ['read', 'gone.ts::vanishes', '--json'],
    ['outline', 'gone.ts', '--json'],
    ['skeleton', 'gone.ts', '--json'],
  ]) {
    it(`${args[0]} --json carries deleted: true`, () => {
      const { out } = run(args)
      const payload = JSON.parse(out) as { deleted?: boolean }
      expect(payload.deleted, `${args.join(' ')} passed a deleted file off as a live read`).toBe(true)
    })
  }

  it('does not mislabel a deleted file as merely stale', () => {
    const { out } = run(['read', 'gone.ts::vanishes'])
    expect(out).not.toContain(STALE_MARKER)
  })
})

describe('a file that is still on disk', () => {
  it('reads with no warning of either kind', () => {
    const { status, out } = run(['read', 'stays.ts::remains'])
    expect(status).toBe(0)
    expect(out).toContain('return x + 2')
    expect(out).not.toContain(DELETED_MARKER)
    expect(out).not.toContain(STALE_MARKER)
  })

  it('outline stays clean too, so the warning is not simply printed for every file', () => {
    const { out } = run(['outline', 'stays.ts'])
    expect(out).not.toContain(DELETED_MARKER)
  })

  for (const args of [
    ['read', 'stays.ts::remains', '--json'],
    ['outline', 'stays.ts', '--json'],
    ['skeleton', 'stays.ts', '--json'],
  ]) {
    it(`${args[0]} --json keeps its existing shape for a live file`, () => {
      const { out } = run(args)
      expect('deleted' in (JSON.parse(out) as Record<string, unknown>)).toBe(false)
    })
  }

  it('carries no "deleted" key in --json, so live output keeps its existing shape', () => {
    const { out } = run(['symbol', 'remains', '--json'])
    const payload = JSON.parse(out) as { items: { filePath: string; deleted?: boolean }[] }
    const row = payload.items.find((i) => i.filePath.includes('stays.ts'))
    expect(row).toBeDefined()
    expect(row === undefined ? true : 'deleted' in row).toBe(false)
  })
})
