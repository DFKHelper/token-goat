/** package-lock.json must agree with itself: every dependency spec an entry declares is met by the entry node resolves for it. Commit b479903b shipped a lock whose lefthook entry still named the 2.1.14 platform packages beside top-level 2.1.15 ones, so every `npm install` nested a second copy and rewrote the file; nothing in the suite looked at that, and a70cefd3 fixed it by hand. The checker is `scripts/lock-consistency.mjs`, the same module `scripts/refresh-dependabot-lock.mjs` runs at the end of a refresh. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkLockFiles, formatProblem } from '../../scripts/lock-consistency.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('package-lock.json consistency', () => {
  it('has no entry whose declared dependency specs the resolved tree fails to meet', () => {
    const problems = checkLockFiles(ROOT)
    expect(problems.map(formatProblem)).toEqual([])
  })
})
