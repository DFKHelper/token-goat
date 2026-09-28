/** Every file-spec command resolves a path typed as `~/...` (home directory) or, on Windows, as a Git Bash mount path `/c/...` to the same file as its drive-letter spelling. `read`/`outline` already translated `/c/...` through resolveIndexPath, but `section` read the spec's file straight off disk through resolveAgainstProjectRoot, which did neither, so `section "/c/Projects/x.md::Heading"` answered "File not found" for a file `read` could open. No command expanded `~`: a quoted spec reaches the program with the tilde intact, since only an unquoted word is expanded by the shell. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveAgainstProjectRoot, runRead } from '../src/read_commands.js'
import { runOutline } from '../src/read_outline.js'
import { runSection } from '../src/read_section.js'
import { normalizePath } from '../src/paths.js'
import { resolveSpecPath } from '../src/spec_path.js'

// HAND-DERIVED: Git Bash (MSYS) spells drive C: as `/c/`, so `C:\Users\x\a.md` is `/c/Users/x/a.md`; computed here from the temp path, not from token-goat's own MSYS regex.
function msysForm(winPath: string): string {
  const fwd = winPath.replace(/\\/g, '/')
  return `/${fwd[0]!.toLowerCase()}${fwd.slice(2)}`
}

const DOC = '# Intro\n\nintro body line\n\n## Other\n\nother body line\n'

let fakeHome: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  fakeHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spec-home-')))
  fs.mkdirSync(path.join(fakeHome, 'notes'))
  fs.writeFileSync(path.join(fakeHome, 'notes', 'doc.md'), DOC)
  fs.writeFileSync(path.join(fakeHome, 'notes', 'two.md'), DOC)
  for (const k of ['HOME', 'USERPROFILE']) saved[k] = process.env[k]
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere, at call time.
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('section resolves ~ and shell mount paths', () => {
  it('reads ~/notes/doc.md::Intro from the home directory', () => {
    const r = runSection({ spec: '~/notes/doc.md::Intro' })
    expect(r.text).toContain('intro body line')
    expect(r.code).toBe(0)
  })

  it('reads a cross-file spec whose files both start with ~/', () => {
    const r = runSection({ spec: '~/notes/doc.md::Intro,~/notes/two.md::Other' })
    expect(r.text).toContain('intro body line')
    expect(r.text).toContain('other body line')
    expect(r.code).toBe(0)
  })

  it.runIf(process.platform === 'win32')('reads a Git Bash /c/ spelling of a drive path', () => {
    const r = runSection({ spec: `${msysForm(path.join(fakeHome, 'notes', 'doc.md'))}::Intro` })
    expect(r.text).toContain('intro body line')
    expect(r.code).toBe(0)
  })

  it.runIf(process.platform === 'win32')('reads a cross-file spec in /c/ spelling', () => {
    const a = msysForm(path.join(fakeHome, 'notes', 'doc.md'))
    const b = msysForm(path.join(fakeHome, 'notes', 'two.md'))
    const r = runSection({ spec: `${a}::Intro,${b}::Other` })
    expect(r.text).toContain('intro body line')
    expect(r.text).toContain('other body line')
  })
})

describe('index-backed commands resolve ~ to the same file', () => {
  it('read ~/x.ts::fn and outline ~/x.ts answer from the file in the home directory', () => {
    // HAND-DERIVED: one function whose body line is a unique string.
    fs.writeFileSync(path.join(fakeHome, 'notes', 'tilde_probe.ts'), 'export function tildeProbe(): string {\n  return "tilde-probe-body"\n}\n')
    const read = runRead({ spec: '~/notes/tilde_probe.ts::tildeProbe' })
    expect(read.text).toContain('tilde-probe-body')
    expect(read.code).toBe(0)
    const outline = runOutline({ file: '~/notes/tilde_probe.ts' })
    expect(outline.text).toContain('tildeProbe')
    expect(outline.code).toBe(0)
  })
})

describe('the shared resolvers expand ~ and leave ~user alone', () => {
  it('resolveSpecPath keys ~/x the same as the absolute home path', () => {
    expect(resolveSpecPath('~/notes/doc.md')).toBe(normalizePath(path.join(fakeHome, 'notes', 'doc.md')))
    expect(resolveSpecPath('~')).toBe(normalizePath(fakeHome))
  })

  it('resolveAgainstProjectRoot opens ~/x under the home directory, not under the project root', () => {
    const resolved = resolveAgainstProjectRoot('~/notes/doc.md', path.join(os.tmpdir(), 'some-project'))
    expect(fs.readFileSync(resolved, 'utf8')).toBe(DOC)
  })

  it('does not expand ~user, which names another account rather than this one', () => {
    const base = path.join(os.tmpdir(), 'tg-base')
    expect(resolveSpecPath('~bob/a.ts', base)).toBe(normalizePath(path.resolve(base, '~bob/a.ts')))
  })
})
