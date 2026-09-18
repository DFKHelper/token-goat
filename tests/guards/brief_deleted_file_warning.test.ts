/** Guard: `brief` must carry the same deleted-file warning every other single-file surgical-read command (`read`, `outline`, `skeleton`, `symbol`) already carries -- see tests/guards/deleted_file_read_warning.test.ts for the shared root cause. `runBriefCore` resolved its symbol through `resolveSymbolSpec`, which does heal a stale-but-still-present file in place, but never called the trailing `staleWarning` check `runRead` makes to catch what healing cannot fix: a file that is gone entirely. So `brief` on an indexed-then-deleted file served the old body with no warning at all, in both its text and `--json` forms, while `read` on the identical spec printed the `⚠ DELETED` banner. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const DELETED_MARKER = '⚠ DELETED'

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
  projectDir = mkdtempSync(join(tmpdir(), 'tg-brief-deleted-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-brief-deleted-home-'))
  writeFileSync(
    join(projectDir, 'gone.ts'),
    'export function vanishes(x: number): number {\n  return x + 1\n}\nexport function callsIt(): number {\n  return vanishes(1)\n}\n',
  )
  run(['index', '.', '--walk'])
  rmSync(join(projectDir, 'gone.ts'))
})

describe('brief on a file that was indexed and then deleted', () => {
  it('still returns the indexed body (the body is what makes the silence dangerous)', () => {
    const { status, out } = run(['brief', 'gone.ts::vanishes'])
    expect(status).toBe(0)
    expect(out).toContain('return x + 1')
  })

  it('warns that the file is gone, matching read on the identical spec', () => {
    const { out } = run(['brief', 'gone.ts::vanishes'])
    expect(out, 'brief served indexed content for a deleted file with no warning').toContain(DELETED_MARKER)
  })

  it('--json marks the row deleted rather than passing it off as a live file', () => {
    const { out } = run(['brief', 'gone.ts::vanishes', '--json'])
    const payload = JSON.parse(out) as { deleted?: boolean }
    expect(payload.deleted, 'brief --json passed a deleted file off as a live read').toBe(true)
  })
})
