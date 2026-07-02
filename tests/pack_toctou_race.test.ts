// Regression (PACK-TOCTOU): collectFiles/estimateBudget used to validate a candidate's
// containment via fs.realpathSync(p) -- the "check" -- and then separately fs.statSync(p) and
// fs.readFileSync(p) the SAME PATH AGAIN -- the "use" -- to get the size and content. Between
// the check and the use, whatever `p` (a symlink, or a path behind a symlinked ancestor
// directory) resolves to could be swapped out by a concurrent process, so the bytes actually
// read never had to be the bytes that were validated as living inside the project root.
//
// This drives the REAL shipping entry points (collectFiles / estimateBudget), not a
// reimplementation. The only mocked boundary is node:fs.realpathSync itself, which is made to
// perform the symlink swap as a side effect of answering the very call collectFiles/
// estimateBudget use to validate containment -- modeling the worst case of the race: the check
// call's answer reflects reality up to the instant it returns, but the attacker's concurrent
// retarget has already landed by the time anything downstream touches the path again.
// vi.spyOn cannot patch node:fs (its namespace exports are non-configurable), so a module mock
// with hoisted state is the portable way to inject this, matching parser_sha_race.test.ts and
// worker_draining_rmfail.test.ts.
const mockState = vi.hoisted(() => ({ target: '', swapTarget: '', swapped: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedRealpathSync = (p: fs.PathLike, options?: fs.EncodingOption): string => {
    if (typeof p === 'string' && p === mockState.target && !mockState.swapped) {
      const originalReal = actual.realpathSync(p, options as never) as string
      mockState.swapped = true
      actual.unlinkSync(p)
      actual.symlinkSync(mockState.swapTarget, p)
      return originalReal
    }
    return actual.realpathSync(p, options as never) as string
  }
  return { ...actual, default: actual, realpathSync: guardedRealpathSync }
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { collectFiles, estimateBudget } from '../src/pack.js'

// Capability probe: creating a real symlink on Windows requires either an elevated shell or
// Developer Mode -- see the identical probe in pack.test.ts. Skip (not fail) cleanly when this
// environment can't create symlinks.
const CAN_SYMLINK = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toctou-probe-'))
  try {
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, path.join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

const LEGIT_CONTENT = 'legit inside-root content\n'
const SECRET_CONTENT = 'TOP_SECRET_OUTSIDE_ROOT_VALUE_MUCH_LONGER_THAN_THE_LEGIT_FILE\n'

describe('collectFiles/estimateBudget TOCTOU race (PACK-TOCTOU)', () => {
  let TMP: string
  let outsideDir: string
  let linkPath: string
  let secretPath: string

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toctou-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toctou-outside-'))
    secretPath = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(secretPath, SECRET_CONTENT)

    const insidePath = path.join(TMP, 'real-inside.txt')
    fs.writeFileSync(insidePath, LEGIT_CONTENT)

    linkPath = path.join(TMP, 'race-link.txt')
    fs.symlinkSync(insidePath, linkPath)

    mockState.target = linkPath
    mockState.swapTarget = secretPath
    mockState.swapped = false
  })

  afterEach(() => {
    mockState.target = ''
    mockState.swapTarget = ''
    mockState.swapped = false
    fs.rmSync(TMP, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it.skipIf(!CAN_SYMLINK)(
    'collectFiles reads the file it validated, not whatever the path resolves to after a mid-flight symlink swap',
    () => {
      const result = collectFiles(TMP, ['race-link.txt'])

      // The candidate was validated while race-link.txt pointed inside the project root, so its
      // content must come from the file that passed that check -- never from whatever the
      // symlink got swapped to afterward, even though every fs call after the check used the
      // same path and would have followed the swapped symlink straight to the secret.
      const leaked = result.files.some((f) => f.content.includes('TOP_SECRET_OUTSIDE_ROOT_VALUE'))
      expect(leaked).toBe(false)
      expect(result.files.some((f) => f.content === LEGIT_CONTENT)).toBe(true)
    },
  )

  it.skipIf(!CAN_SYMLINK)(
    'estimateBudget sizes the file it validated, not whatever the path resolves to after a mid-flight symlink swap',
    () => {
      const result = estimateBudget(TMP, ['race-link.txt'])

      const entry = result.entries.find((e) => e.rel_path.includes('race-link.txt'))
      expect(entry).toBeDefined()
      // size_bytes must reflect real-inside.txt (the validated file), never secret.txt (which is
      // deliberately a very different length so a leak is unambiguous).
      expect(entry?.size_bytes).toBe(Buffer.byteLength(LEGIT_CONTENT, 'utf8'))
      expect(entry?.size_bytes).not.toBe(Buffer.byteLength(SECRET_CONTENT, 'utf8'))
    },
  )
})
