/**
 * Four commands hand a stored symbol range to git, or compare one against a range git produced:
 * `log` (as `-L<start>,<end>:<file>`), `diff` (hunk overlap), `changed --symbol` (hunk overlap) and
 * `grep --symbol` (which symbol encloses this hit's line). Every one of those ranges addresses the
 * file on disk. A `.ipynb` is indexed from a flattened virtual Python document, so its stored ranges
 * address something else entirely, and all four answered about the wrong document -- three of them
 * silently.
 *
 * Measured before the fix, each beside an equivalent `.py` control that got the right answer:
 * `log nb.ipynb::helper` printed the history of two markdown lines under the header
 * `# helper (function)`; `diff nb.ipynb::helper` said "No changes to 'helper'" about a symbol that
 * had just changed; `changed --symbol` listed the `.py`'s helper and omitted the notebook's;
 * `grep --symbol` labelled the `.py` hit and left the notebook's bare.
 *
 * The fix is one rule, not four: where the two coordinate systems meet, widen to the whole file and
 * say so. The controls are load-bearing -- "no notebook answer" and "the right notebook answer" are
 * distinguishable only against a file where the same code demonstrably works.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import { runDiff, runLog, runGrep, runChanged } from '../../src/read_commands.js'
import { indexFileSync } from '../../src/parser.js'
import { normalizePath } from '../../src/paths.js'
import { captureStdout } from '../helpers/capture-stdout.js'

/** PROVENANCE: HAND-DERIVED, in the nbformat 4 shape (`cells[].cell_type`, `cells[].source` as a line array) documented at nbformat.readthedocs.io/en/latest/format_description.html. The markdown cell exists to push the code cells off their own JSON lines; without it the two coordinate systems coincide and none of this is observable. */
function notebook(returned: string): string {
  return JSON.stringify(
    {
      cells: [
        { cell_type: 'markdown', source: ['# Notes\n', '\n', 'prose here\n', '\n', 'more prose\n'] },
        { cell_type: 'code', source: ['def helper():\n', `    return ${returned}\n`] },
        { cell_type: 'code', source: ['def caller():\n', '    return helper()\n'] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )
}

/** The same Python the notebook's cells flatten to, as its own file. */
function control(returned: string): string {
  return `# Notes\n#\n# prose here\n#\n# more prose\n\ndef helper():\n    return ${returned}\n\ndef caller():\n    return helper()\n`
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-nbgit-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: root, stdio: 'ignore' })
  }
  git('init')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'Fixture')
  writeFileSync(join(root, 'nb.ipynb'), notebook('1'), 'utf-8')
  writeFileSync(join(root, 'ctl.py'), control('1'), 'utf-8')
  git('add', '-A')
  git('commit', '-m', 'init')
  // Both files change the same way, so any difference in what the commands report below is about the coordinate systems and not about the edit.
  writeFileSync(join(root, 'nb.ipynb'), notebook('999'), 'utf-8')
  writeFileSync(join(root, 'ctl.py'), control('999'), 'utf-8')
  indexFileSync(normalizePath(join(root, 'nb.ipynb')))
  indexFileSync(normalizePath(join(root, 'ctl.py')))
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** The marker the shared note always carries, whatever each command appends to it. */
const NOTE = 'is a notebook: its indexed line numbers address the flattened cell source'

describe('a git-backed command never scopes a notebook by its index line numbers', () => {
  it('diff reports the change instead of denying it, and the control is untouched', () => {
    const ctl = captureStdout(() => runDiff({ spec: `${join(root, 'ctl.py')}::helper`, projectRoot: root }))
    expect(ctl, 'the control reported no diff, so the notebook assertion below measures nothing').toContain('+    return 999')
    expect(ctl, 'the note leaked onto an ordinary file').not.toContain(NOTE)

    const nb = captureStdout(() => runDiff({ spec: `${join(root, 'nb.ipynb')}::helper`, projectRoot: root }))
    expect(nb, 'a changed notebook symbol was reported as unchanged').not.toContain('No changes')
    expect(nb).toContain('return 999')
    expect(nb, 'the answer was widened without saying so').toContain(NOTE)
  })

  it('log follows the file rather than whichever JSON lines share the numbers', () => {
    const ctl = captureStdout(() => runLog({ spec: `${join(root, 'ctl.py')}::helper`, projectRoot: root }))
    expect(ctl).toContain('init')
    expect(ctl).not.toContain(NOTE)

    const nb = captureStdout(() => runLog({ spec: `${join(root, 'nb.ipynb')}::helper`, projectRoot: root }))
    expect(nb).toContain('init')
    expect(nb).toContain(NOTE)
    // The precise defect: `-L9,10:nb.ipynb` walked the markdown cell's JSON lines and printed their history under a header naming a function. Either of those lines appearing is that walk still happening.
    expect(nb, 'the history of an unrelated JSON line was printed under the symbol header').not.toContain('more prose')
  })

  it('changed --symbol lists the notebook symbol beside the control', () => {
    const out = captureStdout(() => runChanged({ symbolMode: true, ref: 'HEAD', projectRoot: root }))
    expect(out, 'the control vanished too, so this is not measuring the notebook').toContain('ctl.py')
    expect(out, 'a notebook whose code changed was omitted from the report').toContain('nb.ipynb')
  })

  it('grep --symbol says why a notebook hit carries no label rather than leaving it blank', () => {
    const out = captureStdout(() => runGrep({ pattern: 'return 999', symbol: true, projectRoot: root, path: root }))
    expect(out, 'the control carried no label either, so a missing one proves nothing').toContain('[helper (function)]')
    expect(out).toContain(NOTE)
    // One line per file, not one per hit: a notebook with fifty matches must not repeat the sentence fifty times.
    expect(out.split(NOTE).length - 1).toBe(1)
  })
})
