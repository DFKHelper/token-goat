// Batch D golden tests — git filter family. Faithfully ported from the Python suite (test_bash_compress_git.py and test_bash_compress_git_commit_push.py). These are the regression spec for the 7 filters in src/tool_filters/git.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { configPath } from '../src/constants.js'
import {
  GIT_FILTERS,
  GitBlameFilter,
  GitCommitFilter,
  GitDiffFilter,
  GitFilter,
  GitLogFilter,
  GitPushFilter,
  GitStatusVerboseFilter,
  TOOL_FILTERS,
  selectFilter,
} from '../src/tool_filters/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: { apply: (a: string, b: string, c: number, d: string[]) => { text: string } },
  stdout: string,
  argv: string[],
  opts: { stderr?: string; exitCode?: number } = {},
): string {
  return filter.apply(stdout, opts.stderr ?? '', opts.exitCode ?? 0, argv).text
}

const gitLogFilter = new GitLogFilter()
const gitDiffFilter = new GitDiffFilter()
const gitStatusFilter = new GitStatusVerboseFilter()
const gitBlameFilter = new GitBlameFilter()
const gitCommitFilter = new GitCommitFilter()
const gitPushFilter = new GitPushFilter()
const _gitFilter = new GitFilter()

// ---------------------------------------------------------------------------
// GIT_FILTERS array
// ---------------------------------------------------------------------------

describe('GIT_FILTERS', () => {
  it('exports 7 filter entries', () => {
    expect(GIT_FILTERS).toHaveLength(7)
  })

  it('GitFilter (generic) is last in GIT_FILTERS', () => {
    expect(GIT_FILTERS[GIT_FILTERS.length - 1]?.name).toBe('git')
  })

  it('specific filters precede GitFilter', () => {
    const genericIdx = GIT_FILTERS.findIndex((f) => f.name === 'git')
    for (const f of GIT_FILTERS.slice(0, genericIdx)) {
      expect(f.name).not.toBe('git')
    }
  })

  it('all filters are registered in TOOL_FILTERS', () => {
    for (const f of GIT_FILTERS) {
      expect(TOOL_FILTERS).toContain(f)
    }
  })

  it('git filters appear after linter filters in TOOL_FILTERS', () => {
    const linterIdx = TOOL_FILTERS.findIndex((f) => f.name === 'tsc')
    const gitIdx = TOOL_FILTERS.findIndex((f) => f.name === 'git-log')
    expect(gitIdx).toBeGreaterThan(linterIdx)
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitLogFilter dispatch', () => {
  it('is registered for git log', () => {
    const f = selectFilter(['git', 'log'])
    expect(f?.name).toBe('git-log')
  })

  it('does not match other git subcommands', () => {
    const f = selectFilter(['git', 'status'])
    expect(f?.name).not.toBe('git-log')
  })

  it('does not match non-git commands', () => {
    expect(gitLogFilter.matches(['hg', 'log'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — oneline format
// ---------------------------------------------------------------------------

function makeOneline(n: number): string {
  return Array.from({ length: n }, (_, i) => `abc${String(i).padStart(4, '0')}ef Short commit message ${i}`).join('\n')
}

describe('GitLogFilter oneline', () => {
  it('short oneline passthrough (≤50)', () => {
    const text = makeOneline(10)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline'])
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`Short commit message ${i}`)
    }
  })

  it('long oneline truncated to 50 with elided count', () => {
    const text = makeOneline(80)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline'])
    expect(result).toContain('+30 more commits')
    expect(result).toContain('abc0000ef')
    expect(result).not.toContain('abc0079ef')
  })

  it('oneline autodetected without flag (60 commits > cap of 50)', () => {
    const text = makeOneline(60)
    const result = apply(gitLogFilter, text, ['git', 'log'])
    expect(result).toContain('more commits')
  })

  it('49 oneline commits passthrough without truncation', () => {
    const text = makeOneline(49)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline'])
    expect(result).not.toContain('more commits')
    for (let i = 0; i < 49; i++) {
      expect(result).toContain(`Short commit message ${i}`)
    }
  })

  it('exactly 50 oneline commits passthrough', () => {
    const text = makeOneline(50)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline'])
    expect(result).not.toContain('more commits')
  })

  it('51 oneline commits triggers truncation', () => {
    const text = makeOneline(51)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline'])
    expect(result).toContain('+1 more commits')
  })

  // Regression: `git log --graph --oneline` intersperses real commit lines (each prefixed with
  // ASCII-art connectors like `* `/`| * `) with connector-only lines that carry no commit hash
  // (e.g. `|\  `, `|/  `, from a merge). The old cap counted every non-empty line as a commit,
  // so those connector-only lines inflated both the truncation point and the "+N more commits"
  // tally past the real commit count.
  it('--graph --oneline: connector-only lines are not counted as commits', () => {
    const commitLines = Array.from(
      { length: 55 },
      (_, i) => `* abc${String(i).padStart(4, '0')}ef Short commit message ${i}`,
    )
    // Splice in graph connector-only lines (no commit hash) that a real merge produces.
    const lines = [...commitLines]
    lines.splice(10, 0, '|\\  ')
    lines.splice(30, 0, '|/  ')
    const text = lines.join('\n')

    const result = apply(gitLogFilter, text, ['git', 'log', '--graph', '--oneline'])
    // 55 real commits, cap 50 -> exactly 5 elided, not 7 (which the connector-line-inflated
    // count would have reported).
    expect(result).toContain('+5 more commits')
    expect(result).not.toContain('+7 more commits')
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — --oneline combined with --stat/-p
// ---------------------------------------------------------------------------

function makeOnelineStat(n: number): string {
  const blocks = Array.from({ length: n }, (_, i) => {
    const hash = `abc${String(i).padStart(4, '0')}ef`
    return [
      `${hash} Commit subject ${i}`,
      ` src/module/file${i}.ts | 3 +++`,
      ' 1 file changed, 3 insertions(+)',
      '',
    ].join('\n')
  })
  return blocks.join('\n').replace(/\n$/, '')
}

describe('GitLogFilter --oneline --stat combo', () => {
  // Regression: --oneline combined with --stat interleaves each commit's one-line header with
  // its own stat lines, so the isOneline branch used to cap by raw non-empty LINE count instead
  // of commit count -- with ~20 real commits (well under the 50-commit cap) but ~80 raw lines
  // (over the 50-LINE cap this branch used to apply), it wrongly elided commits that should have
  // been shown in full.
  it('~20 commits: no bogus elision (commit count, not raw line count, drives the cap)', () => {
    const text = makeOnelineStat(20)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline', '--stat'])
    expect(result).not.toContain('more commits')
    for (let i = 0; i < 20; i++) {
      expect(result).toContain(`Commit subject ${i}`)
      expect(result).toContain(`file${i}.ts`)
    }
  })

  // 60 real commits, ~240 raw lines. The old line-based cap would report "+190 more commits"
  // (240 - 50) -- wildly wrong for only 60 actual commits. The fixed commit-block-based cap must
  // report exactly the 10 commits actually elided (60 - 50).
  it('60 commits: "+N more commits" reflects actual commit count, not raw stat-line count', () => {
    const text = makeOnelineStat(60)
    const result = apply(gitLogFilter, text, ['git', 'log', '--oneline', '--stat'])
    expect(result).toContain('+10 more commits')
    expect(result).toContain('Commit subject 0')
    expect(result).not.toContain('Commit subject 59')
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — full format
// ---------------------------------------------------------------------------

function makeFullCommits(n: number): string {
  const blocks: string[] = []
  for (let i = 0; i < n; i++) {
    blocks.push(
      `commit abc${String(i).padStart(4, '0')}ef1234567890\n` +
        `Author: Dev User <dev@example.com>\n` +
        `Date:   Mon Jan ${String(i + 1).padStart(2, '0')} 10:00:00 2025 +0000\n` +
        `\n` +
        `    Fix bug number ${i}\n`,
    )
  }
  return blocks.join('\n')
}

describe('GitLogFilter full format', () => {
  it('short log passthrough (≤10 commits)', () => {
    const text = makeFullCommits(5)
    const result = apply(gitLogFilter, text, ['git', 'log'])
    expect(result).toContain('Fix bug number 0')
    expect(result).toContain('Fix bug number 4')
  })

  it('long log (20 commits) collapsed to fewer lines', () => {
    const text = makeFullCommits(20)
    const result = apply(gitLogFilter, text, ['git', 'log'])
    const origNonEmpty = text.split('\n').filter((l) => l.trim()).length
    const resNonEmpty = result.split('\n').filter((l) => l.trim()).length
    expect(resNonEmpty).toBeLessThan(origNonEmpty)
    expect(result).toContain('abc0000ef')
  })

  it('merge commits preserved in collapsed output', () => {
    const block =
      'commit abcdef1234567890\n' +
      'Merge: aaa bbb\n' +
      'Author: User <u@e.com>\n' +
      'Date:   Mon Jan 01 10:00:00 2025 +0000\n\n    Merge branch feature\n'
    const text = Array.from({ length: 15 }, () => block).join('')
    const result = apply(gitLogFilter, text, ['git', 'log'])
    expect(result).toContain('Merge:')
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — patch format
// ---------------------------------------------------------------------------

function makePatchLog(nPatchLines: number): string {
  const diffLines = Array.from({ length: nPatchLines }, (_, i) => `+line ${i}`).join('\n')
  return (
    'commit abcdef1234567890\n' +
    'Author: User <u@e.com>\n' +
    'Date:   Mon Jan 01 10:00:00 2025 +0000\n\n    Big change\n\n' +
    'diff --git a/foo.py b/foo.py\n' +
    '--- a/foo.py\n+++ b/foo.py\n@@ -1,5 +1,5 @@\n' +
    diffLines
  )
}

describe('GitLogFilter patch format', () => {
  it('small patch (10 lines) passthrough', () => {
    const text = makePatchLog(10)
    const result = apply(gitLogFilter, text, ['git', 'log', '-p'])
    expect(result).not.toContain('omitted by token-goat')
  })

  it('large patch (60 lines) collapsed with omission marker', () => {
    const text = makePatchLog(60)
    const result = apply(gitLogFilter, text, ['git', 'log', '-p'])
    expect(result).toMatch(/patch:.*omitted by token-goat/)
  })
})

// ---------------------------------------------------------------------------
// GitLogFilter — stat format
// ---------------------------------------------------------------------------

function makeStatLog(nFiles: number): string {
  const statLines = Array.from({ length: nFiles }, (_, i) => ` src/file${i}.py | 5 +++++`).join('\n')
  return (
    'commit abcdef1234567890\n' +
    'Author: User <u@e.com>\n' +
    'Date:   Mon Jan 01 10:00:00 2025 +0000\n\n    Refactor many files\n\n' +
    statLines +
    `\n ${nFiles} files changed, ${nFiles * 5} insertions(+)`
  )
}

describe('GitLogFilter stat format', () => {
  it('small stat (5 files) passthrough', () => {
    const text = makeStatLog(5)
    const result = apply(gitLogFilter, text, ['git', 'log', '--stat'])
    expect(result).toContain('file0.py')
  })

  it('large stat (30 files) collapsed with omission marker', () => {
    const text = makeStatLog(30)
    const result = apply(gitLogFilter, text, ['git', 'log', '--stat'])
    expect(result).toContain('more stat lines omitted')
  })
})

// ---------------------------------------------------------------------------
// GitDiffFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitDiffFilter dispatch', () => {
  it('is registered for git diff', () => {
    expect(selectFilter(['git', 'diff'])?.name).toBe('git-diff')
  })

  it('is registered for git show', () => {
    expect(selectFilter(['git', 'show'])?.name).toBe('git-diff')
  })

  it('does not match git log', () => {
    expect(selectFilter(['git', 'log'])?.name).not.toBe('git-diff')
  })
})

// ---------------------------------------------------------------------------
// GitDiffFilter — binary files
// ---------------------------------------------------------------------------

describe('GitDiffFilter binary', () => {
  it('binary file collapsed to header + summary', () => {
    const text =
      'diff --git a/image.png b/image.png\n' +
      'index abc123..def456 100644\n' +
      'Binary files a/image.png and b/image.png differ\n'
    const result = apply(gitDiffFilter, text, ['git', 'diff'])
    expect(result).toContain('Binary files a/image.png and b/image.png differ')
    expect(result).toContain('diff --git a/image.png')
  })

  it('non-binary diff unchanged', () => {
    const text =
      'diff --git a/foo.py b/foo.py\n' +
      '--- a/foo.py\n+++ b/foo.py\n@@ -1,3 +1,3 @@\n-old\n+new\n'
    const result = apply(gitDiffFilter, text, ['git', 'diff'])
    expect(result).toContain('-old')
    expect(result).toContain('+new')
  })
})

// ---------------------------------------------------------------------------
// GitDiffFilter — large hunks
// ---------------------------------------------------------------------------

function makeLargeHunkDiff(nChanged: number): string {
  const hunkLines = Array.from({ length: nChanged }, (_, i) => `+line ${i}`).join('\n')
  return (
    'diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n@@ -1,100 +1,100 @@\n context\n' +
    hunkLines
  )
}

describe('GitDiffFilter large hunk', () => {
  it('small hunk (10 changed) passthrough', () => {
    const text = makeLargeHunkDiff(10)
    const result = apply(gitDiffFilter, text, ['git', 'diff'])
    expect(result).not.toContain('omitted by token-goat')
  })

  it('large hunk (80 changed) truncated', () => {
    const text = makeLargeHunkDiff(80)
    const result = apply(gitDiffFilter, text, ['git', 'diff'])
    expect(result).toContain('omitted by token-goat')
  })

  it('diff header lines preserved after large-hunk truncation', () => {
    const text = makeLargeHunkDiff(80)
    const result = apply(gitDiffFilter, text, ['git', 'diff'])
    expect(result).toContain('diff --git a/big.py')
    expect(result).toContain('--- a/big.py')
    expect(result).toContain('+++ b/big.py')
  })

  // Regression: `git diff --cc` (combined diffs from a merge-commit conflict resolution) use a
  // `diff --cc <path>` file-boundary line instead of `diff --git a/<path> b/<path>`. The file
  // boundary regex used to only recognize `diff --git `, so combined diffs never got split into
  // per-file blocks here at all -- the whole diff fell through as a single unprocessed block and
  // large-hunk compression never applied, even for a single huge hunk.
  it('git diff --cc gets per-file compression (binary collapse) like a normal diff', () => {
    const text =
      'diff --cc image.png\n' +
      'index abc123,def456..0000000\n' +
      'Binary files a/image.png and b/image.png differ\n'
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--cc', 'HEAD'])
    expect(result).toContain('diff --cc image.png')
    expect(result).toContain('Binary files a/image.png and b/image.png differ')
    // The `index` metadata line is dropped only when the block was recognized as a combined-diff
    // file boundary and ran through binary collapse (header + binary-summary line only). Before
    // the fix, `diff --cc` never matched the file-boundary regex, so the whole block (including
    // this line) fell through unprocessed.
    expect(result).not.toContain('index abc123,def456..0000000')
  })

  // Regression: _GIT_DIFF_BINARY_RE only matched the plain two-filename binary message
  // ("Binary files a/x and b/x differ"). Real `git diff --cc`/`git show --cc` binary-conflict
  // output omits filenames entirely ("Binary files differ"), so that combined-diff form never
  // matched and binary collapse never triggered for --cc binary conflicts.
  it('collapses a combined-diff (--cc) binary message that omits filenames', () => {
    const text =
      'diff --cc image.png\n' +
      'index abc123,def456..0000000\n' +
      'Binary files differ\n'
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--cc', 'HEAD'])
    expect(result).toContain('diff --cc image.png')
    expect(result).toContain('Binary files differ')
    expect(result).not.toContain('index abc123,def456..0000000')
  })

  // Regression: real `git diff --cc`/`git show --cc` output for a text conflict uses a
  // triple-`@` combined-diff hunk header (`@@@ -a,b -c,d +e,f @@@`), one extra `@` per merged
  // parent -- not the plain-diff `@@ -a,b +c,d @@`. Confirmed against a real merge-commit combined
  // diff (`git show --cc <merge-sha>`) during dogfooding: with only the file-boundary fix, a large
  // conflict hunk still passed through byte-identical to the pre-fix output, because
  // _GIT_DIFF_HUNK_RE never split it into hunks in the first place. Both the file-boundary AND the
  // hunk-boundary regex need to recognize the combined-diff format for large-hunk truncation to
  // actually engage on `--cc` output.
  it('git diff --cc: large combined-diff hunk (triple-@ header) gets truncated like a normal diff', () => {
    const changedLines = Array.from({ length: 80 }, (_, i) => `+line ${i}`).join('\n')
    const text =
      'diff --cc conflict.py\n' +
      'index abc123,def456..0000000\n' +
      '--- a/conflict.py\n+++ b/conflict.py\n@@@ -1,3 -1,3 +1,83 @@@\n  context\n' +
      changedLines
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--cc', 'HEAD'])
    expect(result).toContain('diff --cc conflict.py')
    expect(result).toContain('omitted by token-goat')
  })
})

// ---------------------------------------------------------------------------
// GitDiffFilter — JSONL hunk (semantic summary)
// ---------------------------------------------------------------------------

function makeJsonlDiff(n: number): string {
  const record = { ts: '2026-01-01T00:00:00Z', entity: 'campaign', op: 'create', success: true }
  const added = Array.from({ length: n }, (_, i) => `+${JSON.stringify({ ...record, i })}`).join('\n')
  return (
    'diff --git a/audit.jsonl b/audit.jsonl\n--- a/audit.jsonl\n+++ b/audit.jsonl\n@@ -1,3 +1,100 @@\n existing_line\n' +
    added
  )
}

describe('GitDiffFilter JSONL hunk', () => {
  it('large JSONL hunk (100 records) gets semantic summary', () => {
    const diff = makeJsonlDiff(100)
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).toContain('repetitive JSON/JSONL block')
    expect(result).toContain('+100 JSON records added')
  })

  it('semantic summary includes sample lines', () => {
    const diff = makeJsonlDiff(100)
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).toMatch(/"ts":/)
  })

  it('semantic summary includes bash-output recall hint', () => {
    const diff = makeJsonlDiff(100)
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).toContain('bash-output')
  })

  it('small JSONL hunk (5 records) uses normal truncation (no semantic summary)', () => {
    const diff = makeJsonlDiff(5)
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).not.toContain('repetitive JSON/JSONL block')
  })

  it('diff header preserved in semantic summary', () => {
    const diff = makeJsonlDiff(100)
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).toContain('diff --git a/audit.jsonl')
  })

  it('regression: 611-line JSONL append compressed to <10% of original', () => {
    const record = {
      ts: '2026-06-08T22:46:10.327Z',
      run_id: 'local-1780958770327',
      platform: 'google_ads',
      entity_type: 'campaign',
      operation: 'create',
      resource_name: null,
      campaign_name: null,
      before: null,
      after: null,
      module: 'TestModule',
      success: true,
    }
    const added = Array.from({ length: 611 }, (_, i) => `+${JSON.stringify({ ...record, i })}`).join('\n')
    const diff =
      'diff --git a/memory/ads/mutation-audit-log.jsonl b/memory/ads/mutation-audit-log.jsonl\n' +
      '--- a/memory/ads/mutation-audit-log.jsonl\n' +
      '+++ b/memory/ads/mutation-audit-log.jsonl\n' +
      '@@ -2403,3 +2403,611 @@\n existing_record\n' +
      added
    const result = apply(gitDiffFilter, diff, ['git', 'diff'])
    expect(result).toContain('repetitive JSON/JSONL block')
    expect(result.length).toBeLessThan(diff.length * 0.1)
  })
})

// ---------------------------------------------------------------------------
// GitDiffFilter — stat rollup
// ---------------------------------------------------------------------------

function makeStatDiff(nFiles: number): string {
  const statLines = Array.from(
    { length: nFiles },
    (_, i) => ` src/module/file${i}.py | ${i + 1} ${'+'.repeat(i + 1)}`,
  ).join('\n')
  const adds = Array.from({ length: nFiles }, (_, i) => i + 1).reduce((a, b) => a + b, 0)
  return statLines + `\n ${nFiles} files changed, ${adds} insertions(+)`
}

describe('GitDiffFilter stat rollup', () => {
  it('small stat (5 files) passthrough', () => {
    const text = makeStatDiff(5)
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('file0.py')
  })

  it('large stat (25 files) rolls up to directory summary', () => {
    const text = makeStatDiff(25)
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('src/ (25 files,')
    expect(result).not.toContain('file0.py')
  })

  it('large stat summary line always present', () => {
    const text = makeStatDiff(25)
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('files changed')
  })

  it('large stat with pathspec -- uses truncation not rollup', () => {
    const text = makeStatDiff(25)
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat', '--', 'src/'])
    expect(result).toContain('more files changed')
    expect(result).toContain('file0.py')
    expect(result).not.toContain('src/ (')
  })

  it('multi-directory rollup produces one line per top-level dir', () => {
    const lines = [
      ' alpha/a.py | 3 +++',
      ' alpha/b.py | 2 ++',
      ' beta/c.py | 5 +++++',
      ' beta/d.py | 1 +',
      ' gamma/e.py | 4 ++++',
    ]
    const repeated = Array.from({ length: 5 }, () => lines).flat()
    const summary = ' 25 files changed, 75 insertions(+)'
    const text = [...repeated, summary].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('alpha/ (')
    expect(result).toContain('beta/ (')
    expect(result).toContain('gamma/ (')
    expect(result).not.toContain('a.py')
  })

  it('root files (no slash) grouped under (root)', () => {
    const rootFiles = Array.from({ length: 25 }, (_, i) => ` file${i}.txt | 1 +`)
    const text = [...rootFiles, ' 25 files changed, 25 insertions(+)'].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('(root) (25 files,')
    expect(result).not.toContain('file0.txt')
  })

  // Regression: git's brace-compressed rename notation ("prefix/{old => new}/suffix") only had
  // its stray leading "{" / trailing "}" stripped when the braces spanned the ENTIRE path column
  // (no prefix or suffix outside them) -- the common real-world case of a prefix and/or suffix
  // left the braces mid-string, so e.g. "src/{old => new}/file.py" resolved to "new}/file.py"
  // and got rolled up under a garbage "new}/" directory instead of the correct "src/". The full
  // two-path form ("old/path => new/path", no braces) already worked and must keep working.
  it('rename notation (brace-compressed and full two-path) rolls up under the correct new-path directory', () => {
    const bracedWithPrefixSuffix = Array.from(
      { length: 11 },
      (_, i) => ` src/{old => new}/file${i}.py | ${i + 1} ${'+'.repeat(i + 1)}`,
    )
    const bracedWholeTopDir = Array.from(
      { length: 10 },
      (_, i) => ` {old-root => new-root}/file${i}.py | ${i + 1} ${'+'.repeat(i + 1)}`,
    )
    const summary = ' 21 files changed, 231 insertions(+)'
    const text = [...bracedWithPrefixSuffix, ...bracedWholeTopDir, summary].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('src/ (11 files,')
    expect(result).toContain('new-root/ (10 files,')
    // Not corrupted into a garbage directory carrying a stray brace character.
    expect(result).not.toMatch(/new\}/)
    expect(result).not.toMatch(/\{old/)
  })

  it('full two-path rename notation (no braces) still rolls up under the new path directory', () => {
    const renamed = Array.from(
      { length: 21 },
      (_, i) => ` old/dir/file${i}.py => new/dir/file${i}.py | ${i + 1} ${'+'.repeat(i + 1)}`,
    )
    const summary = ' 21 files changed, 231 insertions(+)'
    const text = [...renamed, summary].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('new/ (21 files,')
    expect(result).not.toContain('old/')
  })

  // Regression: git's --stat bar-graph glyphs are WIDTH-SCALED once a file's true change count
  // exceeds --stat-width -- the +/- ratio survives scaling but the absolute glyph count does not
  // (e.g. a real 900/100 split can render as only 45 '+' / 5 '-' characters). Counting bar glyphs
  // directly silently undercounted large diffs by up to ~20x; the fix recovers the true split from
  // the line's numeric total column instead.
  it('recovers real insert/delete counts from a width-scaled stat bar instead of undercounting', () => {
    const smallFiles = Array.from({ length: 20 }, (_, i) => ` small/file${i}.py | 1 +`)
    const bigFile = ` big/file.ts | 1000 ${'+'.repeat(45)}${'-'.repeat(5)}`
    const summary = ' 21 files changed, 1020 insertions(+), 100 deletions(-)'
    const text = [...smallFiles, bigFile, summary].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat'])
    expect(result).toContain('big/ (1 file, +900/-100)')
    expect(result).toContain('small/ (20 files, +20/-0)')
  })

  it('pathspec truncation branch also recovers real counts instead of undercounting the scaled bar', () => {
    const headFiles = Array.from({ length: 10 }, (_, i) => ` src/head${i}.py | 1 +`)
    const elidedSmall = Array.from({ length: 14 }, (_, i) => ` src/mid${i}.py | 1 +`)
    const bigFile = ` src/big.ts | 1000 ${'+'.repeat(45)}${'-'.repeat(5)}`
    const summary = ' 25 files changed, 1029 insertions(+), 100 deletions(-)'
    const text = [...headFiles, ...elidedSmall, bigFile, summary].join('\n')
    const result = apply(gitDiffFilter, text, ['git', 'diff', '--stat', '--', 'src/'])
    expect(result).toContain('+15 more files changed, +914 -100 lines')
  })
})

// ---------------------------------------------------------------------------
// GitStatusVerboseFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitStatusVerboseFilter dispatch', () => {
  it('is registered for git status', () => {
    expect(selectFilter(['git', 'status'])?.name).toBe('git-status')
  })
})

// ---------------------------------------------------------------------------
// GitStatusVerboseFilter — short format passthrough
// ---------------------------------------------------------------------------

describe('GitStatusVerboseFilter short format', () => {
  it('short/porcelain format passes through unchanged', () => {
    const text = 'M  src/foo.py\n?? src/bar.py\nD  src/old.py\n'
    const result = apply(gitStatusFilter, text, ['git', 'status'])
    expect(result).toContain('src/foo.py')
    expect(result).toContain('src/bar.py')
    expect(result).toContain('src/old.py')
  })
})

// ---------------------------------------------------------------------------
// GitStatusVerboseFilter — verbose format compression
// ---------------------------------------------------------------------------

describe('GitStatusVerboseFilter verbose format', () => {
  it('strips advice lines, groups file listing into count', () => {
    const text =
      'On branch main\n' +
      'Changes not staged for commit:\n' +
      '  (use "git add <file>..." to update what will be committed)\n' +
      '  (use "git restore <file>..." to discard changes in working directory)\n' +
      '\tmodified:   src/foo.py\n\n' +
      'no changes added to commit (use "git add" and/or "git commit -a")\n'
    const result = apply(gitStatusFilter, text, ['git', 'status'])
    expect(result).toContain('1 modified')
    expect(result).not.toContain('src/foo.py')
    expect(result).not.toContain('use "git add')
    expect(result).not.toContain('use "git restore')
    expect(result).not.toContain('no changes added to commit')
  })

  it('nothing to commit line preserved (clean tree)', () => {
    const text = 'On branch main\nnothing to commit, working tree clean\n'
    const result = apply(gitStatusFilter, text, ['git', 'status'])
    expect(result).toContain('nothing to commit, working tree clean')
    expect(result).toContain('On branch main')
  })

  it('untracked list grouped to count', () => {
    const files = Array.from({ length: 3 }, (_, i) => `\t    new_file_${i}.py`).join('\n')
    const text =
      'On branch main\n' +
      'Untracked files:\n' +
      '  (use "git add <file>..." to include in what will be committed)\n' +
      files +
      '\n'
    const result = apply(gitStatusFilter, text, ['git', 'status'])
    expect(result).toContain('3 untracked')
    expect(result).not.toContain('new_file_0.py')
  })

  it('large untracked list (15 files) grouped to count', () => {
    const files = Array.from({ length: 15 }, (_, i) => `\tnew_file_${i}.py`).join('\n')
    const text =
      'On branch main\n' +
      'Untracked files:\n' +
      '  (use "git add <file>..." to include in what will be committed)\n' +
      files +
      '\n'
    const result = apply(gitStatusFilter, text, ['git', 'status'])
    expect(result).toContain('15 untracked')
    expect(result).not.toContain('new_file_0.py')
    expect(result).not.toContain('new_file_14.py')
  })
})

// ---------------------------------------------------------------------------
// GitBlameFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitBlameFilter dispatch', () => {
  it('is registered for git blame', () => {
    expect(selectFilter(['git', 'blame'])?.name).toBe('git-blame')
  })

  it('does not match git log', () => {
    expect(selectFilter(['git', 'log'])?.name).not.toBe('git-blame')
  })
})

// ---------------------------------------------------------------------------
// GitBlameFilter — annotated format
// ---------------------------------------------------------------------------

function makeAnnotated(commit: string, author: string, nLines: number): string {
  return Array.from(
    { length: nLines },
    (_, i) =>
      `${commit} (Author Name ${author} 2025-01-01 10:00:00 +0000 ${i + 1})    def function_${i}(): pass`,
  ).join('\n')
}

describe('GitBlameFilter annotated', () => {
  it('single-commit run collapsed', () => {
    const text = makeAnnotated('^abc1234', 'Alice', 20)
    const result = apply(gitBlameFilter, text, ['git', 'blame'])
    expect(result).toContain('more lines by')
    expect(result.split('\n').filter((l) => l.trim()).length).toBeLessThan(20)
  })

  it('multiple authors all represented', () => {
    const alice = makeAnnotated('^abc1234', 'Alice', 10)
    const bob = makeAnnotated('^def5678', 'Bob', 10)
    const result = apply(gitBlameFilter, alice + '\n' + bob, ['git', 'blame'])
    expect(result).toContain('abc1234')
    expect(result).toContain('def5678')
  })

  it('short blame (single line per commit) passes through', () => {
    const text =
      '^abc1234 (Alice 2025-01-01 10:00:00 +0000  1)    line1\n' +
      '^def5678 (Bob   2025-01-02 10:00:00 +0000  2)    line2\n' +
      '^ghi9012 (Carol 2025-01-03 10:00:00 +0000  3)    line3\n'
    const result = apply(gitBlameFilter, text, ['git', 'blame'])
    expect(result).toContain('abc1234')
    expect(result).toContain('def5678')
    expect(result).toContain('ghi9012')
  })
})

// ---------------------------------------------------------------------------
// GitBlameFilter — porcelain format
// ---------------------------------------------------------------------------

function makePorcelain(commit: string, author: string, nLines: number): string {
  const fullHash = (commit.repeat(Math.ceil(40 / commit.length))).slice(0, 40)
  const rows: string[] = []
  for (let i = 0; i < nLines; i++) {
    rows.push(
      `${fullHash} ${i + 1} ${i + 1}`,
      `author ${author}`,
      'author-mail <dev@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer A. Name',
      'committer-mail <c@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      `summary Fix something ${i}`,
      'filename src/module.py',
      `\tcode line ${i}`,
    )
  }
  return rows.join('\n')
}

describe('GitBlameFilter porcelain', () => {
  it('porcelain run collapsed to fewer lines', () => {
    const text = makePorcelain('abcdef12', 'Dev Name', 5)
    const result = apply(gitBlameFilter, text, ['git', 'blame', '--porcelain'])
    expect(result.split('\n').length).toBeLessThan(text.split('\n').length)
  })
})

// ---------------------------------------------------------------------------
// GitFilter — generic fallback dispatch
// ---------------------------------------------------------------------------

describe('GitFilter fallback', () => {
  it('git fetch routes to generic git filter', () => {
    expect(selectFilter(['git', 'fetch'])?.name).toBe('git')
  })

  it('git push routes to git-push filter (not generic)', () => {
    expect(selectFilter(['git', 'push'])?.name).toBe('git-push')
  })

  it('git ls-files routes to generic git filter', () => {
    expect(selectFilter(['git', 'ls-files'])?.name).toBe('git')
  })

  it('git rev-parse routes to generic git filter', () => {
    expect(selectFilter(['git', 'rev-parse', 'HEAD'])?.name).toBe('git')
  })

  it('git grep routes to the grep filter, not the generic git catch-all', () => {
    expect(selectFilter(['git', 'grep', 'TODO'])?.name).toBe('grep')
  })
})

// ---------------------------------------------------------------------------
// GitCommitFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitCommitFilter dispatch', () => {
  it('is registered before generic GitFilter', () => {
    expect(selectFilter(['git', 'commit', '-m', 'msg'])?.name).toBe('git-commit')
  })

  it('does not match git push', () => {
    expect(selectFilter(['git', 'push'])?.name).not.toBe('git-commit')
  })

  it('does not match non-git commands', () => {
    expect(gitCommitFilter.matches(['hg', 'commit'])).toBe(false)
  })

  it('does not match git log', () => {
    expect(gitCommitFilter.matches(['git', 'log'])).toBe(false)
  })

  it('matches git commit --amend', () => {
    expect(gitCommitFilter.matches(['git', 'commit', '--amend'])).toBe(true)
  })

  it('matches git commit --fixup=abc', () => {
    expect(gitCommitFilter.matches(['git', 'commit', '--fixup=abc'])).toBe(true)
  })

  // Regression: a word inside a -m/--message value that happens to equal another filter's
  // subcommand keyword (e.g. "log", "push") must not hijack dispatch away from git-commit --
  // the tokenizer must skip the value token of value-taking git flags entirely, not scan it
  // for subcommand-looking words.
  it('routes to git-commit, not git-log, when the message value is the word "log"', () => {
    expect(selectFilter(['git', 'commit', '-m', 'log'])?.name).toBe('git-commit')
  })

  it('routes to git-commit, not git-push, when the message contains the word "push"', () => {
    expect(selectFilter(['git', 'commit', '-m', 'please push this and rebase later'])?.name).toBe('git-commit')
  })

  it('routes to git-commit when --message contains a subcommand-looking word', () => {
    expect(selectFilter(['git', 'commit', '--message', 'push and rebase'])?.name).toBe('git-commit')
  })
})

// ---------------------------------------------------------------------------
// GitCommitFilter — lefthook compression
// ---------------------------------------------------------------------------

const _LEFTHOOK_COMMIT_OUTPUT =
  '╭─────────────────────╮\n' +
  '│ 🥊 lefthook  v2.1.8  hook:  pre-commit │\n' +
  '╰─────────────────────╯\n' +
  '┃  lint ❯\n' +
  'All checks passed!\n' +
  '┃  wal-guard ❯\n' +
  'bringing up nodes...\n' +
  '....\n' +
  '4 passed in 4.58s\n' +
  '  ────────────────────────────────────\n' +
  'summary: (done in 5.37 seconds)\n' +
  '✔️ lint (0.11 seconds)\n' +
  '✔️ wal-guard (5.21 seconds)\n' +
  '[main d112339] feat(bash-cache): normalize command strings\n' +
  ' 2 files changed, 238 insertions(+), 1 deletion(-)'

describe('GitCommitFilter lefthook passing', () => {
  it('lefthook passing compressed to single non-empty line', () => {
    const result = apply(gitCommitFilter, _LEFTHOOK_COMMIT_OUTPUT, ['git', 'commit', '-m', 'msg'])
    const lines = result.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
  })

  it('contains hook checkmarks for all hooks', () => {
    const result = apply(gitCommitFilter, _LEFTHOOK_COMMIT_OUTPUT, ['git', 'commit', '-m', 'msg'])
    expect(result).toContain('lint')
    expect(result).toContain('wal-guard')
    expect(result).toContain('✔')
  })

  it('contains commit ref', () => {
    const result = apply(gitCommitFilter, _LEFTHOOK_COMMIT_OUTPUT, ['git', 'commit', '-m', 'msg'])
    expect(result).toContain('d112339')
    expect(result).toContain('feat(bash-cache)')
  })

  it('contains files changed stat', () => {
    const result = apply(gitCommitFilter, _LEFTHOOK_COMMIT_OUTPUT, ['git', 'commit', '-m', 'msg'])
    expect(result).toContain('2 files changed')
  })

  it('result much shorter than input', () => {
    const result = apply(gitCommitFilter, _LEFTHOOK_COMMIT_OUTPUT, ['git', 'commit', '-m', 'msg'])
    expect(result.length).toBeLessThan(_LEFTHOOK_COMMIT_OUTPUT.length / 2)
  })
})

describe('GitCommitFilter lefthook failing', () => {
  it('failing hook preserves error output', () => {
    const failingOutput =
      '╭─────────────────────╮\n' +
      '│ 🥊 lefthook  v2.1.8  hook:  pre-commit │\n' +
      '╰─────────────────────╯\n' +
      '┃  lint ❯\n' +
      'error: some lint error on line 42\n' +
      '  ────────────────────────────────────\n' +
      'summary: (done in 1.23 seconds)\n' +
      '✖ lint (1.20 seconds)\n' +
      '✔️ wal-guard (0.03 seconds)'
    const result = apply(gitCommitFilter, failingOutput, ['git', 'commit', '-m', 'msg'])
    expect(result).toContain('lint error on line 42')
  })
})

describe('GitCommitFilter no lefthook', () => {
  it('simple commit output passes through', () => {
    const simple = '[main d112339] feat: simple commit\n 1 file changed, 5 insertions(+)'
    const result = apply(gitCommitFilter, simple, ['git', 'commit', '-m', 'msg'])
    expect(result).toContain('d112339')
    expect(result).toContain('1 file changed')
  })
})

describe('GitCommitFilter amend with lefthook', () => {
  it('amend commit with lefthook compressed to one line', () => {
    const output =
      '╭─────────────────────╮\n' +
      '│ 🥊 lefthook  v2.1.8  hook:  pre-commit │\n' +
      '╰─────────────────────╯\n' +
      '┃  lint ❯\n' +
      'All checks passed!\n' +
      '  ────────────────────────────────────\n' +
      'summary: (done in 0.5 seconds)\n' +
      '✔️ lint (0.45 seconds)\n' +
      '[main d112339] feat: updated\n' +
      ' 1 file changed, 2 insertions(+)'
    const result = apply(gitCommitFilter, output, ['git', 'commit', '--amend', '-m', 'fix'])
    const lines = result.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
    expect(result).toContain('lint')
  })
})

// ---------------------------------------------------------------------------
// GitPushFilter — dispatch
// ---------------------------------------------------------------------------

describe('GitPushFilter dispatch', () => {
  it('is registered for git push', () => {
    expect(selectFilter(['git', 'push'])?.name).toBe('git-push')
  })

  it('does not match git commit', () => {
    expect(selectFilter(['git', 'commit', '-m', 'x'])?.name).not.toBe('git-push')
  })

  it('does not match non-git commands', () => {
    expect(gitPushFilter.matches(['hg', 'push'])).toBe(false)
  })

  it('does not match git pull', () => {
    expect(gitPushFilter.matches(['git', 'pull'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GitPushFilter — passing pytest dots
// ---------------------------------------------------------------------------

const _PYTEST_DOTS_PASSING =
  '.'.repeat(50) + ' [ 10%]\n' +
  '.'.repeat(50) + ' [ 20%]\n' +
  '.'.repeat(50) + ' [ 30%]\n' +
  '.'.repeat(50) + ' [ 40%]\n' +
  '.'.repeat(50) + ' [ 50%]\n' +
  '.'.repeat(50) + ' [ 60%]\n' +
  '.'.repeat(50) + ' [ 70%]\n' +
  '.'.repeat(50) + ' [ 80%]\n' +
  '.'.repeat(50) + ' [ 90%]\n' +
  '.'.repeat(50) + ' [100%]\n' +
  '8333 passed in 9m 21s\n' +
  '   abc123..def456  main -> origin/main'

describe('GitPushFilter passing tests', () => {
  it('compressed to ≤2 non-empty lines', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_PASSING, ['git', 'push'])
    const lines = result.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('contains test count', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_PASSING, ['git', 'push'])
    expect(result).toContain('8333')
    expect(result.toLowerCase()).toContain('passed')
  })

  it('contains ref update', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_PASSING, ['git', 'push'])
    expect(result).toMatch(/origin\/main|main/)
  })

  it('much shorter than input', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_PASSING, ['git', 'push'])
    expect(result.length).toBeLessThan(_PYTEST_DOTS_PASSING.length / 3)
  })

  it('simple push with no dots passes through', () => {
    const simple = '   abc123..def456  main -> origin/main\nBranch \'main\' set up to track remote branch \'main\'.'
    const result = apply(gitPushFilter, simple, ['git', 'push'])
    expect(result).toContain('origin/main')
  })
})

// ---------------------------------------------------------------------------
// GitPushFilter — failing pytest dots
// ---------------------------------------------------------------------------

const _PYTEST_DOTS_FAILING =
  '.'.repeat(40) + 'F' + '.'.repeat(9) + ' [ 10%]\n' +
  '.'.repeat(50) + ' [ 20%]\n' +
  'FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n' +
  '.'.repeat(48) + 'FF [100%]\n' +
  '3 failed, 8330 passed in 9m 45s\n' +
  '   abc123..def456  main -> origin/main'

describe('GitPushFilter failing tests', () => {
  it('preserves failure info in output', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_FAILING, ['git', 'push'], { exitCode: 1 })
    expect(result).toMatch(/FAILED|failed/i)
  })

  it('preserves error message', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_FAILING, ['git', 'push'], { exitCode: 1 })
    expect(result).toMatch(/AssertionError|test_bar/)
  })

  it('strips dot-only lines', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_FAILING, ['git', 'push'], { exitCode: 1 })
    for (const ln of result.split('\n')) {
      expect(ln).not.toMatch(/^[.sF ]+(?:\[\s*\d+%\])?$/)
    }
  })
})

// ---------------------------------------------------------------------------
// GitPushFilter — per-error-block truncation cap
// ---------------------------------------------------------------------------

function _tracebackLines(label: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `    traceback line ${i} for ${label}`).join('\n')
}

const _PYTEST_DOTS_SINGLE_BLOCK_OVERFLOW =
  '.'.repeat(40) + 'F' + '.'.repeat(9) + ' [ 10%]\n' +
  'FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n' +
  _tracebackLines('foo', 40) + '\n' +
  '\n' +
  '1 failed, 8330 passed in 9m 45s\n' +
  '   abc123..def456  main -> origin/main'

const _PYTEST_DOTS_TWO_BLOCKS_OVERFLOW =
  '.'.repeat(40) + 'F' + '.'.repeat(9) + ' [ 10%]\n' +
  'FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n' +
  _tracebackLines('foo', 40) + '\n' +
  '\n' +
  'FAILED tests/test_baz.py::test_qux - ValueError: bad value\n' +
  _tracebackLines('baz', 40) + '\n' +
  '\n' +
  '2 failed, 8330 passed in 9m 45s\n' +
  '   abc123..def456  main -> origin/main'

describe('GitPushFilter single failure block overflow', () => {
  it('emits exactly one omission marker with the correct count', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_SINGLE_BLOCK_OVERFLOW, ['git', 'push'], {
      exitCode: 1,
    })
    const markers = result.match(/\[token-goat: \+(\d+) more error lines omitted\]/g) ?? []
    expect(markers).toHaveLength(1)
    expect(result).toContain('[token-goat: +11 more error lines omitted]')
    expect(result).toContain('traceback line 0 for foo')
    expect(result).toContain('traceback line 28 for foo')
    expect(result).not.toContain('traceback line 30 for foo')
  })
})

describe('GitPushFilter two failure blocks each overflowing', () => {
  it('keeps both blocks and gives each its own accurate omission marker', () => {
    const result = apply(gitPushFilter, _PYTEST_DOTS_TWO_BLOCKS_OVERFLOW, ['git', 'push'], {
      exitCode: 1,
    })

    expect(result).toContain('test_bar')
    expect(result).toContain('test_qux')

    const markers = result.match(/\[token-goat: \+(\d+) more error lines omitted\]/g) ?? []
    expect(markers).toHaveLength(2)
    expect(result).toContain('[token-goat: +11 more error lines omitted]')

    expect(result).toContain('traceback line 0 for foo')
    expect(result).toContain('traceback line 28 for foo')
    expect(result).not.toContain('traceback line 30 for foo')

    expect(result).toContain('traceback line 0 for baz')
    expect(result).toContain('traceback line 28 for baz')
    expect(result).not.toContain('traceback line 30 for baz')
  })
})

// ---------------------------------------------------------------------------
// GitPushFilter — remote/local progress
// ---------------------------------------------------------------------------

const _REMOTE_PROGRESS_SMALL =
  'Enumerating objects: 5, done.\n' +
  'Counting objects:   0% (1/5)\n' +
  'Counting objects:  20% (1/5)\n' +
  'Counting objects:  40% (2/5)\n' +
  'Counting objects:  60% (3/5)\n' +
  'Counting objects:  80% (4/5)\n' +
  'Counting objects: 100% (5/5), done.\n' +
  'Delta compression using up to 8 threads\n' +
  'Compressing objects:  33% (1/3)\n' +
  'Compressing objects:  67% (2/3)\n' +
  'Compressing objects: 100% (3/3), done.\n' +
  'Writing objects:  33% (1/3)\n' +
  'Writing objects:  67% (2/3)\n' +
  'Writing objects: 100% (3/3), 1.02 KiB | 1.02 MiB/s, done.\n' +
  'Total 3 (delta 1), reused 0 (delta 0), pack-reused 0\n' +
  'remote: Resolving deltas:   0% (0/1)\n' +
  'remote: Resolving deltas: 100% (1/1), completed with 1 local object.\n' +
  'remote: \n' +
  'remote: Create a pull request for \'feat/new\' on GitHub by visiting:\n' +
  'remote:   https://github.com/owner/repo/pull/new/feat/new\n' +
  'remote: \n' +
  'To github.com:owner/repo.git\n' +
  '   7f3a1b2..9c4d5e6  feat/new -> feat/new'

describe('GitPushFilter remote progress', () => {
  it('activates and compresses (output shorter than input)', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result.length).toBeLessThan(_REMOTE_PROGRESS_SMALL.length)
  })

  it('strips intermediate progress lines', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).not.toContain('Counting objects:  20%')
    expect(result).not.toContain('Counting objects:  40%')
    expect(result).not.toContain('Compressing objects:  33%')
    expect(result).not.toContain('Writing objects:  33%')
    expect(result).not.toContain('remote: Resolving deltas:   0%')
  })

  it('keeps final stage line (100%)', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).toContain('Counting objects: 100%')
    expect(result).toContain('Compressing objects: 100%')
    expect(result).toContain('Writing objects: 100%')
    expect(result).toContain('remote: Resolving deltas: 100%')
  })

  it('drops blank remote: lines', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    for (const ln of result.split('\n')) {
      expect(ln.trim()).not.toBe('remote:')
    }
  })

  it('preserves PR URL', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).toContain('https://github.com/owner/repo/pull/new/feat/new')
  })

  it('preserves ref update line', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).toContain('7f3a1b2..9c4d5e6')
    expect(result).toContain('feat/new')
  })

  it('preserves To line', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).toContain('To github.com:owner/repo.git')
  })

  it('non-progress informational lines pass through', () => {
    const result = apply(gitPushFilter, _REMOTE_PROGRESS_SMALL, ['git', 'push'])
    expect(result).toContain('Enumerating objects: 5, done.')
    expect(result).toContain('Delta compression using up to 8 threads')
    expect(result).toContain('Total 3 (delta 1)')
  })

  it('no-progress input passes through unchanged', () => {
    const simple = 'To github.com:owner/repo.git\n   7f3a1b2..9c4d5e6  main -> main'
    const result = apply(gitPushFilter, simple, ['git', 'push'])
    expect(result).toBe(simple)
  })

  it('error line during push kept', () => {
    const output =
      'Counting objects:   0% (1/10)\n' +
      'Counting objects: 100% (10/10), done.\n' +
      "error: failed to push some refs to 'github.com:owner/repo.git'\n" +
      'hint: Updates were rejected because the remote contains work that you do not have locally.\n' +
      'To github.com:owner/repo.git\n' +
      ' ! [rejected]  main -> main (non-fast-forward)'
    const result = apply(gitPushFilter, output, ['git', 'push'], { exitCode: 1 })
    expect(result).toContain('error: failed to push some refs')
    expect(result).toContain('hint: Updates were rejected')
    expect(result).toContain('[rejected]')
  })
})

// ---------------------------------------------------------------------------
// GitCommitFilter — CRLF warning stripping (postNormalise)
// ---------------------------------------------------------------------------

describe('GitCommitFilter CRLF warning stripping', () => {
  it('strips modern single-line CRLF warning', () => {
    const crlfWarning =
      "warning: in the working copy of 'src/a.py', LF will be replaced by CRLF the next time Git touches it"
    const commitOutput = '[main abc1234] feat: test\n 1 file changed'
    // The filter should strip the CRLF warning via postNormalise
    const result = apply(gitCommitFilter, crlfWarning + '\n' + commitOutput, ['git', 'commit', '-m', 'x'])
    expect(result).not.toContain('next time Git touches it')
    expect(result).toContain('abc1234')
  })

  it('strips legacy two-line CRLF warning pair', () => {
    const crlfPair =
      'warning: LF will be replaced by CRLF in src/a.py.\n' +
      'The file will have its original line endings in your working directory'
    const commitOutput = '[main abc1234] feat: test\n 1 file changed'
    const result = apply(gitCommitFilter, crlfPair + '\n' + commitOutput, ['git', 'commit', '-m', 'x'])
    expect(result).not.toContain('will be replaced')
    expect(result).not.toContain('original line endings')
    expect(result).toContain('abc1234')
  })
})

// GitBlameFilter regex fix for filename column (-C/-M)
describe('GitBlameFilter with filename column', () => {
  it('matches blame lines with optional filename between hash and author', () => {
    // The regex now allows an optional filename column (e.g., from git blame -C/-M)
    // before the (Author Name date) parenthesis
    const text = [
      'abc1234a src/module.py (Alice 2025-01-01 10:00:00 +0000  1)    def function_1(): pass',
      'abc1234a src/module.py (Alice 2025-01-01 10:00:00 +0000  2)    def function_2(): pass',
      'abc1234a src/module.py (Alice 2025-01-01 10:00:00 +0000  3)    def function_3(): pass',
      'def5678b src/other.py   (Bob   2025-01-02 10:00:00 +0000  4)    def function_4(): pass',
    ].join('\n')
    const result = apply(gitBlameFilter, text, ['git', 'blame'])
    // Should properly collapse Alice's 3 consecutive lines
    expect(result).toContain('more lines by Alice')
    expect(result).toContain('abc1234')
    expect(result).toContain('Bob')
  })

  it('still handles normal blame without filename column', () => {
    // Verify the regex change doesn't break normal (no filename) blame output
    const text =
      '^abc1234 (Alice 2025-01-01 10:00:00 +0000  1)    line1\n' +
      '^abc1234 (Alice 2025-01-01 10:00:00 +0000  2)    line2\n' +
      '^abc1234 (Alice 2025-01-01 10:00:00 +0000  3)    line3\n' +
      '^def5678 (Bob   2025-01-02 10:00:00 +0000  4)    line4\n'
    const result = apply(gitBlameFilter, text, ['git', 'blame'])
    expect(result).toContain('Alice')
    expect(result).toContain('Bob')
    expect(result).toContain('more lines by Alice')
  })
})

// ---------------------------------------------------------------------------
// GitFilter (generic catch-all) diff/show branch — [bash_diff].max_hunks_per_file
//
// Note: in production, `selectFilter` picks GitDiffFilter (registered before
// GitFilter in GIT_FILTERS, subcommands ['diff', 'show']) for real `git diff`/
// `git show` invocations, so this branch inside GitFilter.compress is not
// reached via the live dispatch path. It remains real, directly-testable
// code (exercised here the same way the rest of this suite exercises
// GitFilter), so the hardcoded-vs-config behavior is still verified against
// the actual compression function, per this project's precedent for
// tool-filter internals with no CLI-level exercise path.
// ---------------------------------------------------------------------------

function makeMultiHunkDiff(nHunks: number): string {
  const hunks: string[] = []
  for (let h = 0; h < nHunks; h++) {
    hunks.push(`@@ -${h * 10 + 1},3 +${h * 10 + 1},3 @@`)
    hunks.push(' context line')
    hunks.push(`-old line ${h}`)
    hunks.push(`+new line ${h}`)
  }
  return ['diff --git a/big.py b/big.py', '--- a/big.py', '+++ b/big.py', ...hunks].join('\n')
}

describe('GitFilter diff/show honors [bash_diff].max_hunks_per_file (not hardcoded 3)', () => {
  // saveConfig does not create configPath()'s parent directory itself; make
  // sure it exists before writing (same pattern as bash_runner.test.ts).
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })

  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(configPath())
    } catch {
      // ok — may not exist
    }
  })

  it('a configured max_hunks_per_file lower than the hardcoded default of 3 elides more hunks', () => {
    const cfg = defaultConfig()
    cfg.bash_diff.max_hunks_per_file = 2 // config.ts's validated floor is 1
    saveConfig(cfg)

    const out = apply(_gitFilter, makeMultiHunkDiff(6), ['git', 'diff'])
    // With the hardcoded default of 3, this 6-hunk diff would elide 3 hunks
    // ("+3 more hunks..."); a configured cap of 2 must elide 4 instead.
    expect(out).toContain('[token-goat: +4 more hunks in this file elided]')
    expect(out).not.toContain('+3 more hunks in this file elided')
  })

  it('an unconfigured (default) max_hunks_per_file of 10 keeps all hunks of a 6-hunk diff, unlike the old hardcoded 3', () => {
    invalidateConfigCache()
    const out = apply(_gitFilter, makeMultiHunkDiff(6), ['git', 'diff'])
    expect(out).not.toContain('more hunks in this file elided')
    expect(out).toContain('new line 0')
    expect(out).toContain('new line 5')
  })
})
