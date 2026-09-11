/**
 * Guard: a path that does not exist must be reported as unreadable, never as a real file that
 * happens to hold nothing.
 *
 * "No indexed symbols found in 'src/nope.ts'" reads as a definitive statement about a file that
 * exists, so a caller who typo'd a path or guessed one from a stale memory concludes there is
 * nothing there and moves on, instead of fixing the path. `exports`, `imports`, `deps`, and
 * `test-for` already close this gap with the wording asserted below; `outline`, `skeleton`, and
 * `types` were the missed siblings.
 *
 * Both halves matter and are asserted per command: a missing file says "Could not read", and a file
 * that exists but has no indexed symbols keeps its original message. A fix that reported everything
 * as unreadable would satisfy the first half alone.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { ISSUES_URL, SUPPORT_EMAIL } from '../../src/version.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [BUNDLE, ...args], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
    })
    return { status: 0, out: stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-missing-file-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-missing-home-'))
  writeFileSync(join(projectDir, 'a.ts'), 'export function alpha(x: number): number { return x + 1 }\n')
  // A real file whose language has an extractor but which declares nothing: this is the
  // "exists but empty" control, and it must NOT be reported as unreadable.
  writeFileSync(join(projectDir, 'blank.ts'), '\n')
  // A real file with no markdown headings: the "exists but no sections" control for `section --list`.
  writeFileSync(join(projectDir, 'blank.md'), 'plain text, no headings\n')
  // A file in a named unsupported language (only its `.rpg` extension matters; the content is never parsed) and a file with an extension nothing maps.
  writeFileSync(join(projectDir, 'legacy.rpg'), 'placeholder, never parsed\n')
  writeFileSync(join(projectDir, 'notes.xyz'), 'Foo bar\n')
  run(['index', '.', '--walk'])
})

describe('missing path vs empty result', () => {
  for (const cmd of ['outline', 'skeleton', 'types'] as const) {
    it(`${cmd} reports a nonexistent path as unreadable`, () => {
      const r = run([cmd, 'nope.ts'])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('Could not read: nope.ts')
      expect(r.out).not.toContain('No indexed symbols found')
      expect(r.out).not.toContain('No type declarations found')
    })
  }

  // The control. `outline`/`skeleton` and `types` phrase their empty result differently, so each is
  // asserted against its own wording rather than a shared substring.
  it('outline keeps its empty-result wording for a file that exists', () => {
    const r = run(['outline', 'blank.ts'])
    expect(r.out).toContain('No indexed symbols found')
    expect(r.out).not.toContain('Could not read')
  })

  it('skeleton keeps its empty-result wording for a file that exists', () => {
    const r = run(['skeleton', 'blank.ts'])
    expect(r.out).toContain('No indexed symbols found')
    expect(r.out).not.toContain('Could not read')
  })

  it('types keeps its empty-result wording for a file that exists', () => {
    const r = run(['types', 'blank.ts'])
    expect(r.out).toContain('No type declarations found')
    expect(r.out).not.toContain('Could not read')
  })

  it('section --list reports a nonexistent path as unreadable', () => {
    const r = run(['section', 'nope.md', '--list'])
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('Could not read: nope.md')
    expect(r.out).not.toContain('No sections found')
  })

  it('section --list keeps its empty-result wording for a file that exists', () => {
    const r = run(['section', 'blank.md', '--list'])
    expect(r.out).toContain('No sections found')
    expect(r.out).not.toContain('Could not read')
  })

  // A file type with no extractor says so, with the one-line invitation, instead of implying an empty or stale index.
  for (const [cmd, file, what] of [
    ['outline', 'legacy.rpg', 'RPG II or RPG III, .rpg'],
    ['skeleton', 'legacy.rpg', 'RPG II or RPG III, .rpg'],
    ['outline', 'notes.xyz', '.xyz'],
  ] as const) {
    it(`${cmd} ${file} names the missing extractor and how to ask for one`, () => {
      const r = run([cmd, file])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain(`token-goat has no symbol extractor for this file type (${what})`)
      expect(r.out).toContain(ISSUES_URL)
      expect(r.out).toContain(SUPPORT_EMAIL)
      expect(r.out).not.toContain('No indexed symbols found')
    })
  }

  it('read file::Name on a file type with no extractor carries the same invitation', () => {
    const r = run(['read', 'notes.xyz::Foo'])
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('token-goat has no symbol extractor for this file type (.xyz)')
    expect(r.out).toContain(ISSUES_URL)
    expect(r.out).toContain(SUPPORT_EMAIL)
  })

  it('does not print the invitation for a supported language', () => {
    expect(run(['outline', 'blank.ts']).out).not.toContain(SUPPORT_EMAIL)
  })

  // The already-fixed siblings, pinned so the family cannot drift back apart one command at a time.
  for (const cmd of ['exports', 'imports', 'deps', 'test-for'] as const) {
    it(`${cmd} still reports a nonexistent path as unreadable`, () => {
      const r = run([cmd, 'nope.ts'])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('Could not read: nope.ts')
    })
  }
})
