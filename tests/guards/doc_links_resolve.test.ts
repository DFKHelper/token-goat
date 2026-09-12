/**
 * Guard against a documented file path outliving the file.
 *
 * `CLAUDE.arch.md` carries the component map, and `CLAUDE.md` tells an agent to read it on demand
 * to find where a thing lives. Four of its rows pointed at files that do not exist: two named a
 * module whose contents had moved (`src/git_history.ts` into `src/read_commands.ts`, `src/ask.ts`
 * into `src/cli.ts`), one named a file that never survived the TypeScript port under that name
 * (`src/worker_daemon.ts`), and one named a file deliberately retired in 6ee387df on 2026-07-05
 * (`src/code_compress.ts`), whose row outlived it by two months. An agent following the map was
 * sent to a path that is not there, and a reader on the published docs site got a 404.
 *
 * Nothing objected, because a stale link fails silently: the doc still renders, the table still
 * looks complete, and the only symptom is a reader arriving nowhere.
 *
 * `git ls-files` is the oracle rather than the filesystem. The filesystem here is
 * case-insensitive and would happily resolve `security.md` against `SECURITY.md`, while the
 * published site and a Linux CI checkout would not.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Changelogs are a historical record: an entry describing a release correctly names the file that
 * release touched, even after the file is later renamed or retired. Rewriting those links would
 * falsify the history the file exists to keep, so they are out of scope here rather than exempt
 * for convenience. Every other tracked document is covered.
 */
const HISTORICAL = new Set(['CHANGELOG.md', 'CHANGELOG-ARCHIVE.md'])

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g

interface Broken { doc: string, line: number, target: string, trackedAs?: string }

function trackedFiles(repo: string = REPO): string[] {
  // A `git commit -- <pathspec>` hands its pre-commit hooks GIT_INDEX_FILE pointing at a
  // temporary partial-commit index: `git ls-files` against it sees only the pathspec'd paths
  // merged onto HEAD, so a file staged (or renamed) outside that pathspec vanishes from the
  // listing even though it is genuinely tracked. Unsetting it here makes every call read the
  // real `.git/index`, which already reflects everything staged for this commit, so the guard
  // stays correct on both a full commit and a narrow pathspec one.
  const env = { ...process.env }
  delete env.GIT_INDEX_FILE
  return execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 64e6, env })
    .split('\n')
    .filter((p) => p !== '')
}

/** Collapse `.` and `..` without touching the filesystem, so the check stays case-exact. */
function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

function findBrokenLinks(): { broken: Broken[], checked: number, docs: number } {
  const tracked = trackedFiles()
  const trackedSet = new Set(tracked)
  const trackedLower = new Map(tracked.map((p) => [p.toLowerCase(), p]))
  const docs = tracked.filter((p) => p.endsWith('.md') && !HISTORICAL.has(p))

  const broken: Broken[] = []
  let checked = 0

  for (const doc of docs) {
    const docDir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : ''
    const lines = fs.readFileSync(path.join(REPO, doc), 'utf8').split(/\r?\n/)

    lines.forEach((line, i) => {
      LINK.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LINK.exec(line)) !== null) {
        const raw = m[1] ?? ''
        if (/^(https?:|mailto:|#)/.test(raw)) continue
        const bare = raw.split('#')[0] ?? ''
        if (bare === '' || bare.startsWith('/')) continue

        // A markdown link resolves against the directory holding the document, not the repo root.
        const rel = bare.startsWith('./') ? bare.slice(2) : bare
        const fromDoc = normalize(docDir === '' ? rel : `${docDir}/${rel}`)
        const fromRoot = normalize(rel)

        // Only judge links that look like they name a file in this repository. A bare word with no
        // extension is a heading anchor or an external shorthand, not a path this guard can rule on.
        const looksLikeRepoPath =
          /^(src|tests|docs|scripts|\.github|assets)\//.test(fromRoot) ||
          /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|py|sh|ps1)$/.test(fromRoot)
        if (!looksLikeRepoPath) continue

        checked++
        if (trackedSet.has(fromDoc) || trackedSet.has(fromRoot)) continue
        // A link to a directory is fine when anything tracked lives under it.
        if (tracked.some((p) => p.startsWith(`${fromDoc}/`) || p.startsWith(`${fromRoot}/`))) continue

        const caseHit = trackedLower.get(fromDoc.toLowerCase()) ?? trackedLower.get(fromRoot.toLowerCase())
        broken.push({ doc, line: i + 1, target: bare, ...(caseHit === undefined ? {} : { trackedAs: caseHit }) })
      }
    })
  }

  return { broken, checked, docs: docs.length }
}

describe('trackedFiles under a partial-pathspec commit index', () => {
  it('still lists a file staged for this commit but outside the pathspec being committed', () => {
    // FORMAT-DERIVED: this rebuilds, via `git read-tree` + `git update-index`, the exact shape
    // empirically confirmed for the real thing -- a `git commit -m msg -- a.txt` on a repo with
    // an unrelated staged file leaves that file out of the temporary index git hands the
    // pre-commit hook via GIT_INDEX_FILE, even though `git ls-files` (no GIT_INDEX_FILE) against
    // the real index still reports it.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-links-partial-'))
    const savedIndexFile = process.env.GIT_INDEX_FILE
    try {
      const run = (args: string[], env?: NodeJS.ProcessEnv): void => {
        execFileSync('git', args, { cwd: scratch, env: env ?? process.env })
      }
      run(['init', '-q'])
      run(['config', 'user.email', 'a@b.com'])
      run(['config', 'user.name', 'Test'])
      fs.writeFileSync(path.join(scratch, 'a.txt'), 'a\n')
      run(['add', 'a.txt'])
      run(['commit', '-q', '-m', 'init'])

      // Stage a second file into the REAL index -- outside the pathspec of the partial commit
      // being simulated below.
      fs.writeFileSync(path.join(scratch, 'readme.md'), '# doc\n')
      run(['add', 'readme.md'])
      fs.writeFileSync(path.join(scratch, 'a.txt'), 'a2\n')

      // Build the partial-commit temp index by hand: start from HEAD, then merge in only a.txt,
      // exactly as `git commit -- a.txt` does for its pre-commit hook.
      const tempIndex = path.join(scratch, '.git', 'partial-index')
      const partialEnv = { ...process.env, GIT_INDEX_FILE: tempIndex }
      run(['read-tree', 'HEAD'], partialEnv)
      run(['update-index', '--add', 'a.txt'], partialEnv)

      // Sanity: prove the trap is real before asking whether trackedFiles() dodges it -- a raw
      // `git ls-files` while GIT_INDEX_FILE points at the partial index misses the staged file.
      process.env.GIT_INDEX_FILE = tempIndex
      const seenByThisPartialIndex = execFileSync('git', ['-C', scratch, 'ls-files'], { encoding: 'utf8' })
        .split('\n')
        .filter((p) => p !== '')
      expect(seenByThisPartialIndex).not.toContain('readme.md')

      // The function under test, run under the same ambient GIT_INDEX_FILE a pre-commit hook
      // would inherit, must still see it.
      expect(trackedFiles(scratch)).toContain('readme.md')
    } finally {
      if (savedIndexFile === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = savedIndexFile
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('documented file paths resolve', () => {
  it('every repo-relative link in a living document names a tracked file', () => {
    const { broken, checked, docs } = findBrokenLinks()

    // A guard whose population emptied silently proves nothing. If a refactor moves the docs or
    // changes the link syntax, this fails first and says so, rather than passing on zero links.
    expect(
      docs,
      'No living documents were found to check. Either every .md file is now in HISTORICAL or the ' +
      'tracked-file listing failed; this guard cannot pass on an empty population.',
    ).toBeGreaterThan(5)
    expect(
      checked,
      'No repo-relative links were found across the living documents. The link regex or the ' +
      'repo-path heuristic in this guard has probably stopped matching what the docs actually write.',
    ).toBeGreaterThan(200)

    const detail = broken
      .map((b) => `  ${b.doc}:${b.line}  ->  ${b.target}` +
        (b.trackedAs === undefined ? '' : `   (tracked as "${b.trackedAs}" -- wrong case)`))
      .join('\n')

    expect(
      broken,
      `${broken.length} documented path(s) do not name a tracked file, out of ${checked} checked ` +
      `across ${docs} document(s):\n${detail}\n\n` +
      'Repoint the link at where the code actually lives, or delete the row if the file was ' +
      'retired. Case matters: this repo\'s filesystem is case-insensitive but the published docs ' +
      'site and a Linux checkout are not.',
    ).toEqual([])
  })
})
