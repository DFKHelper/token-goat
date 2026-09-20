/** A public repository is a publication. Two planning notes naming a consulting client, its NDA, its purchase order and its invoices were committed here and pushed, and nothing objected -- the notes even said in their own text that the name must not appear in anything that ships. Prose asking the author to remember is not a control; this guard is. The names themselves are deliberately NOT in this repository: keeping a denylist of confidential words inside the artifact the denylist exists to protect would publish exactly what it is meant to withhold. The list lives in the user's home directory instead, and its absence is a failure rather than a pass, because a guard that silently finds nothing to check is indistinguishable from one that found nothing wrong. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { trackedFiles } from '../helpers/tracked-files.js'

const REPO_ROOT = join(__dirname, '..', '..')

/** Overridable so a machine that keeps its list elsewhere can point at it without editing this file. `userInfo().homedir` rather than `homedir()`: the latter reads `HOME`, which tests/setup/isolate-home.ts repoints at a per-run temp directory, so this guard went looking for the denylist inside the sandbox and failed on its absence every time. `userInfo` asks the operating system for the account's directory and is unaffected by that isolation, which is what a file deliberately kept outside the repository needs. */
function listPath(): string {
  if (process.env['TOKEN_GOAT_CONFIDENTIAL_NAMES']) return process.env['TOKEN_GOAT_CONFIDENTIAL_NAMES']
  const candidates = [
    join(userInfo().homedir, '.token-goat', 'confidential-names.txt'),
    ...(process.platform === 'win32' && process.env['USERPROFILE'] ? [join(process.env['USERPROFILE'], '.token-goat', 'confidential-names.txt')] : []),
    ...(process.platform === 'win32' && process.env['HOMEDRIVE'] && process.env['HOMEPATH'] ? [join(process.env['HOMEDRIVE'], process.env['HOMEPATH'], '.token-goat', 'confidential-names.txt')] : []),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

/** One name per line; `#` starts a comment. Blank lines are dropped so a trailing newline cannot become an empty pattern that matches every file. */
function confidentialNames(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
}

/** Tracked files whose contents match `pattern`, case-insensitively. `git grep` rather than a walk of the working tree: an untracked scratch file is not published and is none of this guard's business, while a tracked one is exactly its business. `--cached` scans the index, not `HEAD` -- this runs from lefthook's pre-commit, where `HEAD` is still the commit *before* the one being made, so pinning it there would let the leak land and only object on the next commit. Returns [] on exit code 1, which is git's "no matches" and not an error. */
function trackedFilesMatching(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-Iil', '--cached', '--fixed-strings', '-e', pattern, '--', '.'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    return out.split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

/** Tracked file paths matching `pattern`, case-insensitively. A filename alone can leak a client name even if its content is clean or binary. */
function trackedPathsMatching(pattern: string): string[] {
  try {
    const lower = pattern.toLowerCase()
    return trackedFiles({ repo: REPO_ROOT }).filter((p) => p.toLowerCase().includes(lower))
  } catch {
    return []
  }
}

// CI has no home directory list and must not be blocked by its absence; the gate that matters runs on the machine where the commit is authored, before the push that would publish it.
const runningInCi = process.env['CI'] !== undefined && process.env['CI'] !== ''

describe.skipIf(runningInCi)('a confidential name never reaches a tracked file', () => {
  it('has a denylist to check against, because an empty one would make every assertion below vacuous', () => {
    const path = listPath()
    expect(existsSync(path), `no confidential-name denylist at ${path}. Create it (one name per line, # for comments) or set TOKEN_GOAT_CONFIDENTIAL_NAMES. An absent list is failed rather than skipped: this guard exists because a client name reached a public repository once already.`).toBe(true)
    expect(confidentialNames(path).length, `the denylist at ${path} has no names in it, so this guard would pass no matter what was committed`).toBeGreaterThan(0)
  })

  it('finds a word that is certainly present, so a clean result below means clean and not broken', () => {
    // Calibration. Without it a mistyped pathspec, a git that is not on PATH, or a cwd outside the work tree all produce the same empty list as a genuinely clean repository, and this guard would certify a leak for the rest of its life.
    expect(trackedFilesMatching('token-goat').length, 'the scan found no tracked file containing the project’s own name, so the scan itself is broken').toBeGreaterThan(0)
    expect(trackedPathsMatching('package.json').length, 'the scan found no tracked path containing package.json, so the path scan is broken').toBeGreaterThan(0)
  })

  it('matches no tracked file against any name on the denylist', () => {
    // Asserted unconditionally on a list that is empty when the file is absent, rather than returning early: a body that can finish having asserted nothing reports PASSED when it does, which tests/guards/test_bodies_assert_before_returning.test.ts exists to forbid. The empty-list case is not left unobserved -- the first test above fails loudly on a missing or empty denylist, which is the only way this one can be vacuous.
    const path = listPath()
    const names = existsSync(path) ? confidentialNames(path) : []
    // Paths only, never the matched name: this message goes to a terminal, a CI log and anywhere else a failed run is pasted, and printing the confidential word to report that it leaked would leak it again.
    const leaked = [...new Set(names.flatMap((name) => [...trackedFilesMatching(name), ...trackedPathsMatching(name)]))]
    expect(leaked, `a name on the denylist appears in these tracked files or paths: ${leaked.join(', ')}. Tracked means it goes out with the next push. Remove the text or rename the file, not this guard.`).toEqual([])
  })

  it('matches no reachable commit message against any name on the denylist', () => {
    const path = listPath()
    const names = existsSync(path) ? confidentialNames(path) : []
    const RECORD = String.fromCharCode(0x1e)
    const FIELD = String.fromCharCode(0x00)
    let commits: { sha: string; body: string }[]
    try {
      const raw = execFileSync('git', ['log', '--format=%H%x00%B%x1e', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      commits = raw
        .split(RECORD)
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
        .map((r) => {
          const [sha, ...rest] = r.split(FIELD)
          return { sha: sha ?? '', body: rest.join(FIELD) }
        })
    } catch {
      commits = []
    }
    const leakedCommits: string[] = []
    for (const name of names) {
      const lower = name.toLowerCase()
      for (const c of commits) {
        if (c.body.toLowerCase().includes(lower)) {
          leakedCommits.push(c.sha)
        }
      }
    }
    expect(leakedCommits, `a name on the denylist appears in reachable commit messages: ${leakedCommits.join(', ')}. Rewrite or drop the commit message before pushing.`).toEqual([])
  })
})
