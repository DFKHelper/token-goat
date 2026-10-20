import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'

import { expect } from 'vitest'

/** Put the file's mtime on a whole second an hour back, before anything is recorded: a whole-second value survives the float-seconds round trip `utimesSync` takes, while a fractional one comes back off by a fraction of a millisecond and would no longer match what the session recorded. */
export function stampWholeSecondMtime(file: string): void {
  const wholeSecond = Math.floor(Date.now() / 1000) - 3600
  utimesSync(file, wholeSecond, wholeSecond)
}

/** A rewrite the file system cannot tell from the original by stat: line `lineNo` changes in one character, so the size is unchanged, and the mtime is put back to the exact value it had (what `touch -r`, `cp -p` or a tool restoring timestamps does, and what a coarse-stamp file system does on its own inside one tick). Call {@link stampWholeSecondMtime} before the first read. The precondition asserts the restore took, so a file system that cannot hold the value fails loudly instead of passing for the wrong reason. */
export function rewriteKeepingSizeAndMtime(file: string, lineNo: number): void {
  const before = statSync(file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines[lineNo - 1] = (lines[lineNo - 1] as string).replace(/.$/, (c) => (c === '9' ? '8' : '9'))
  writeFileSync(file, lines.join('\n'))
  utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000)
  const after = statSync(file)
  expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs })
}
