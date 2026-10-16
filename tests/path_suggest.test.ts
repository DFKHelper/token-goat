/** suggestPaths (src/path_suggest.ts): the existing paths a missing one was probably meant to name. Every expectation is HAND-DERIVED: the project tree is built in a temp directory below and the expected answer is the path written there, not anything computed with the module's own rewrites. The two filesystem-dependent rungs (Unicode normalization forms, case-only names) assert only where the filesystem under test distinguishes the spellings, because on one that folds them the missing path is not missing. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { MAX_PATH_SUGGESTIONS, suggestPaths } from '../src/path_suggest.js'

let project: string

/** Whether the filesystem under the temp directory answers for `second` once only `first` was created: true on a case-insensitive or normalization-folding volume, where the rungs that tell the two spellings apart have nothing to repair. */
function folds(first: string, second: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'tg-fold-probe-'))
  try {
    writeFileSync(join(dir, first), 'x')
    return existsSync(join(dir, second))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const FOLDS_NFD = folds('café.txt', 'café.txt')
const FOLDS_CASE = folds('Probe_Name.txt', 'probe_name.txt')

function put(rel: string, body = 'export const marker = 1\n'): string {
  const file = join(project, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body, 'utf8')
  return file
}

function indexed(rel: string): void {
  indexFileSync(normalizePath(put(rel)))
}

const ask = (missing: string, root: string | null = project): string[] => suggestPaths(missing, project, root)

beforeAll(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-path-suggest-')))
  writeFileSync(join(project, 'package.json'), '{"name":"suggest"}\n')
  indexed('src/hooks_tool_failure.ts')
  indexed('src/token_estimate.ts')
  indexed('src/config.ts')
  indexed('docs/guide.md')
  // A name that exists only in a vendored tree, which no suggestion may name.
  indexed('node_modules/dep/vendored_only_name.ts')
  put('lib/unindexed_helper.ts')
})

afterAll(() => rmSync(project, { recursive: true, force: true }))

describe('rung 1: spelling variants', () => {
  it('maps a typed ASCII space before PM to the U+202F the file was saved with', () => {
    put('shots/Screenshot at 3.04.05 PM.png', 'x')
    put('shots/Screenshot at 3.04.06 PM.png', 'x')
    expect(ask('shots/Screenshot at 3.04.05 PM.png')).toEqual(['shots/Screenshot at 3.04.05 PM.png'])
  })

  it('maps a typed U+202F before AM to the plain space the file was saved with', () => {
    put('shots/Capture at 9.15.00 AM.png', 'x')
    put('shots/Capture at 9.15.01 AM.png', 'x')
    expect(ask('shots/Capture at 9.15.00 AM.png')).toEqual(['shots/Capture at 9.15.00 AM.png'])
  })

  it('maps a typed NBSP to the plain space the file was saved with', () => {
    put('notes/meeting minutes.md', 'x')
    put('notes/meeting minutes.mx', 'x')
    expect(ask('notes/meeting minutes.md')).toEqual(['notes/meeting minutes.md'])
  })

  it('swaps a straight apostrophe for the curly one on disk, and back', () => {
    put('notes/it’s what’s that’s.md', 'x')
    put("notes/don't won't can't.md", 'x')
    expect(ask("notes/it's what's that's.md")).toEqual(['notes/it’s what’s that’s.md'])
    expect(ask('notes/don’t won’t can’t.md')).toEqual(["notes/don't won't can't.md"])
  })

  it('strips a leading @ mention', () => {
    expect(ask('@src/config.ts')).toEqual(['src/config.ts'])
  })

  it.each([':12', ':12-30', '#L12', '#L12-L30'])('strips the trailing position suffix %s', (suffix) => {
    expect(ask(`src/config.ts${suffix}`)).toEqual(['src/config.ts'])
  })

  it.skipIf(FOLDS_NFD)('maps a decomposed (NFD) spelling to the composed one on disk, where the filesystem tells them apart', () => {
    const composed = 'café.txt'
    const decomposed = 'café.txt'
    put(`names/${composed}`, 'x')
    expect(ask(`names/${decomposed}`)).toEqual([`names/${composed}`])
  })

  it('combines rewrites: an @ mention, a line suffix and a U+202F space in one path', () => {
    put('shots/Shot 1.00.00 PM.png', 'x')
    expect(ask('@shots/Shot 1.00.00 PM.png:3')).toEqual(['shots/Shot 1.00.00 PM.png'])
  })

  it('stops at a spelling that exists: it decides the answer alone', () => {
    put('src/config.tsx')
    expect(ask('@src/config.ts')).toEqual(['src/config.ts'])
  })
})

describe('rung 2: an indexed file with the same name', () => {
  it('finds the indexed file by its bare basename', () => {
    expect(ask('hooks_tool_failure.ts')).toEqual(['src/hooks_tool_failure.ts'])
  })

  it('finds it when only the directory was wrong', () => {
    expect(ask('app/hooks_tool_failure.ts')).toEqual(['src/hooks_tool_failure.ts'])
  })

  it('finds the same stem under another extension', () => {
    expect(ask('src/config.js')[0]).toBe('src/config.ts')
  })

  it('never names a file that exists only under a vendored tree', () => {
    expect(ask('vendored_only_name.ts')).toEqual([])
  })

  it('does not offer an unindexed file elsewhere on disk for a bare name', () => {
    expect(ask('unindexed_helper.ts')).toEqual([])
  })

  it('answers from the disk alone when there is no index root', () => {
    expect(ask('hooks_tool_failure.ts', null)).toEqual([])
    expect(ask('src/hooks_tool_failur.ts', null)).toEqual(['src/hooks_tool_failure.ts'])
  })

  it('narrows to the candidates sharing a parent directory when more than the cap carry the name', () => {
    for (const dir of ['a/pages', 'b/pages', 'c/other', 'd/other', 'e/misc']) indexed(`${dir}/index_view.ts`)
    expect(ask('x/pages/index_view.ts').sort()).toEqual(['a/pages/index_view.ts', 'b/pages/index_view.ts'])
  })
})

describe('rung 3: a basename within edit distance', () => {
  it('finds a one-letter typo beside the missing path', () => {
    expect(ask('src/hooks_tool_failur.ts')).toEqual(['src/hooks_tool_failure.ts'])
  })

  it('finds a typo of a file in another directory through the index', () => {
    expect(ask('token_estimat.ts')).toEqual(['src/token_estimate.ts'])
  })

  it('finds a typo of a non-source file beside the missing path', () => {
    expect(ask('packge.json')).toEqual(['package.json'])
  })

  it('allows two edits only for a long name', () => {
    expect(ask('src/hooks_tool_faliure.ts')).toEqual(['src/hooks_tool_failure.ts'])
    expect(ask('src/conf.ts')).toEqual([])
  })

  it('offers nothing for a short stem, where every name is one letter from another', () => {
    put('tiny/ab.ts')
    expect(ask('tiny/ac.ts')).toEqual([])
  })

  it('ranks a name beside the missing path ahead of one in another directory', () => {
    put('rank/token_estimat.tsx')
    expect(ask('rank/token_estimat.ts')[0]).toBe('rank/token_estimat.tsx')
  })

  it('does not list the missing path itself or a name that is too far', () => {
    expect(ask('src/completely_different_name.ts')).toEqual([])
  })
})

describe('rung 4: a case-only mismatch', () => {
  it.skipIf(FOLDS_CASE)('corrects a segment that differs only in case, where the filesystem is case-sensitive', () => {
    put('Case/Sensitive_Name.txt', 'x')
    expect(ask('case/sensitive_name.txt')).toEqual(['Case/Sensitive_Name.txt'])
  })
})

describe('bounds and refusals', () => {
  it('returns at most the cap, every one of them on disk', () => {
    for (let i = 0; i < 6; i++) put(`many/handler_${i}.ts`)
    const found = ask('many/handler_x.ts')
    expect(found.length).toBe(MAX_PATH_SUGGESTIONS)
    for (const f of found) expect(existsSync(join(project, f))).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['a newline', 'src/a\nb.ts'],
    ['a NUL', 'src/a\0b.ts'],
    ['over-long', `src/${'x'.repeat(1100)}.ts`],
  ])('refuses %s input', (_label, input) => {
    expect(ask(input)).toEqual([])
  })

  it('returns nothing for an unrelated name', () => {
    expect(ask('zzqq_nothing_like_it.rs')).toEqual([])
  })
})

describe('a working directory spelled through a link or a Windows short name', () => {
  it('still shows an indexed file relative to the working directory, not as an absolute path', () => {
    // HAND-DERIVED: the junction names the same directory the index root does, spelled differently, as an 8.3 short name does for the runner temp directory on Windows CI.
    const link = join(mkdtempSync(join(tmpdir(), 'tg-path-suggest-link-')), 'via')
    try {
      symlinkSync(project, link, 'junction')
      expect(suggestPaths('token_estimate.ts', link, project)).toEqual(['src/token_estimate.ts'])
    } finally {
      rmSync(join(link, '..'), { recursive: true, force: true })
    }
  })
})
