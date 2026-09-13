/**
 * Every tracked text file must check out with LF on every platform.
 *
 * `.gitattributes` used to say `* text=auto`, which normalizes to LF in the INDEX and then leaves
 * the working-tree ending to `core.autocrlf` -- which GitHub's `windows-latest` runner sets to
 * `true`. So a file the generator writes with LF, and git stores with LF, arrived on that one runner
 * with CRLF. Two guards failed there and nowhere else: `third_party_notices` compares generated
 * bytes to on-disk bytes, and `multiline_lang_dispatch_coverage` slices a source file on a literal
 * `\n}\n` and got `-1`. Neither failure said anything about line endings.
 *
 * The oracle is `git check-attr`, not a string match on `.gitattributes`. A pattern list can be
 * rewritten in a way that still contains `eol=lf` while no longer covering the file you care about;
 * asking git what it will actually do to a named path cannot drift that way.
 */
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `git check-attr <attr>` for each path, as a `path -> value` map. */
function attrOf(attr: string, paths: readonly string[]): Map<string, string> {
  // Paths go in over stdin: the whole-repo pass is ~1,700 of them, which is past the OS argv limit
  // (`ENAMETOOLONG` from `spawnSync`, not a truncated answer, so at least it fails loudly).
  const out = execFileSync('git', ['check-attr', '--stdin', '-z', attr], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24, input: `${paths.join('\0')}\0` })
  const fields = out.split('\0')
  const map = new Map<string, string>()
  // `-z` emits <path> NUL <attr> NUL <value> NUL per record.
  for (let i = 0; i + 2 < fields.length; i += 3) map.set(fields[i]!, fields[i + 2]!)
  return map
}

const eolAttr = (paths: readonly string[]): Map<string, string> => attrOf('eol', paths)

describe('every tracked text file checks out with LF', () => {
  it('pins eol=lf for the file kinds whose bytes a guard compares', () => {
    // One representative of each shape that has broken, plus the two extensions the whole suite is
    // written in. Named individually rather than sampled, so a pattern that stops covering one of
    // them fails here by name.
    const named = ['THIRD_PARTY_NOTICES.md', 'src/languages/registry.ts', 'package.json', 'README.md', '.lefthook/pre-push/test.sh', 'tests/fixtures/tool_output/.keep']
    const attrs = eolAttr(named)
    expect(attrs.size, 'git check-attr returned nothing, so this guard would certify an empty set').toBe(named.length)
    expect(
      [...attrs].filter(([, v]) => v !== 'lf').map(([p, v]) => `${p}: ${v}`),
      'paths whose checkout ending is not pinned to LF, so core.autocrlf decides them',
    ).toEqual([])
  })

  it('pins it for every tracked text file, not only the named ones', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\0')
      .filter((s) => s !== '' && !s.endsWith('.pdf'))
    expect(tracked.length, 'no tracked files found -- a vacuous pass').toBeGreaterThan(500)
    const attrs = eolAttr(tracked)
    // The named-list case above already pins this; without it here, a `check-attr` invocation that
    // answers for a subset -- a truncated pipe, an argv limit, a path git declines to parse -- makes
    // the assertion below true of the handful it did answer for and silent about the rest.
    expect(attrs.size, 'git check-attr answered for fewer paths than were tracked, so this guard is certifying a subset').toBe(tracked.length)
    const unpinned = [...attrs].filter(([, v]) => v !== 'lf').map(([p]) => p)
    expect(unpinned.slice(0, 20), `${unpinned.length} tracked files are not pinned to eol=lf`).toEqual([])
  })

  it('leaves binaries alone, so the rule is a text rule and not a blanket one', () => {
    // Calibration: if `*.pdf binary` ever stopped applying, the check above would still pass while
    // git started mangling PDFs on Windows checkouts.
    //
    // The attribute asked for is `text`, not `eol`. `eol=lf` from the `*` rule still REPORTS as `lf`
    // on a PDF -- `binary` is the macro `-diff -merge -text`, and it is the unset `text` that stops
    // any conversion, whatever `eol` says. Asserting on `eol` here would have been a guard that can
    // only fail, which is how this calibration was first written.
    const pdf = execFileSync('git', ['ls-files', '-z', '--', '*.pdf'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 20 })
      .split('\0')
      .filter((s) => s !== '')
    expect(pdf.length, 'no tracked PDF to calibrate against').toBeGreaterThan(0)
    const attrs = attrOf('text', pdf)
    expect([...attrs].filter(([, v]) => v !== 'unset').map(([p, v]) => `${p}: text=${v}`), 'PDFs must have `text` unset, or git converts their bytes').toEqual([])
  })
})
