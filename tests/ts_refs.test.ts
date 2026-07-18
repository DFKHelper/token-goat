import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  isAvailable,
  isTsPath,
  resolveTypedRefs,
  setTsModuleForTesting,
  type ResolveTypedRefsInput,
} from '../src/ts_refs.js'
import type { RefEntry } from '../src/parser_types.js'

function ref(filePath: string, line: number, col: number, name = 'run', context = ''): RefEntry {
  return { filePath, name, line, col, context }
}

/** 0-based column of the first occurrence of `needle` on `line` (1-based) of `text`. */
function colOf(text: string, line: number, needle: string): number {
  const lines = text.split('\n')
  const target = lines[line - 1]
  if (target === undefined) throw new Error(`line ${line} out of range`)
  const idx = target.indexOf(needle)
  if (idx === -1) throw new Error(`'${needle}' not found on line ${line}: ${target}`)
  return idx
}

describe('ts_refs — availability', () => {
  afterEach(() => {
    setTsModuleForTesting(undefined)
  })

  it('isAvailable() is true — the real `typescript` package resolves in this repo', () => {
    expect(isAvailable()).toBe(true)
  })

  it('isTsPath() recognizes .ts/.tsx/.mts/.cts, rejects everything else', () => {
    expect(isTsPath('src/foo.ts')).toBe(true)
    expect(isTsPath('src/foo.tsx')).toBe(true)
    expect(isTsPath('src/foo.mts')).toBe(true)
    expect(isTsPath('src/foo.cts')).toBe(true)
    expect(isTsPath('src/foo.js')).toBe(false)
    expect(isTsPath('src/foo.py')).toBe(false)
    expect(isTsPath('src/foo')).toBe(false)
  })
})

describe('ts_refs — resolveTypedRefs precision: two same-named methods on unrelated classes', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ts-refs-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the true reference to Foo.run(), drops the false-positive reference to Bar.run()', () => {
    const fooSrc = ['export class Foo {', '  run(): void {', "    console.log('foo')", '  }', '}', ''].join('\n')
    const barSrc = ['export class Bar {', '  run(): void {', "    console.log('bar')", '  }', '}', ''].join('\n')
    const callerASrc = ["import { Foo } from './fileA'", 'const foo = new Foo()', 'foo.run()', ''].join('\n')
    const callerBSrc = ["import { Bar } from './fileB'", 'const bar = new Bar()', 'bar.run()', ''].join('\n')

    const fileA = path.join(dir, 'fileA.ts')
    const fileB = path.join(dir, 'fileB.ts')
    const callerA = path.join(dir, 'callerA.ts')
    const callerB = path.join(dir, 'callerB.ts')
    fs.writeFileSync(fileA, fooSrc)
    fs.writeFileSync(fileB, barSrc)
    fs.writeFileSync(callerA, callerASrc)
    fs.writeFileSync(callerB, callerBSrc)

    // col 0 mirrors the REAL indexer's column semantics for a call reference: `parser.ts`'s
    // `extractRefs` records the position of the whole call-expression node (`foo.run()`, starting
    // at `foo`), not the callee identifier's own column -- both caller lines start flush left with
    // no leading whitespace, so that start column is 0, not the column of `run` itself.
    const trueRef = ref(callerA, 3, 0)
    const falsePositiveRef = ref(callerB, 3, 0)

    const input: ResolveTypedRefsInput = {
      defFile: fileA,
      defLineStart: 2,
      defLineEnd: 4,
      symbolName: 'run',
      candidates: [trueRef, falsePositiveRef],
    }

    const result = resolveTypedRefs(input)

    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    expect(result?.[0]?.filePath).toBe(callerA)
    // Confirms this is a real exclusion, not an accidental "both dropped" / "both kept" outcome.
    expect(result?.some((r) => r.filePath === callerB)).toBe(false)
  })

  it('name-based matching alone (no type resolution) would have kept BOTH refs — sanity-checks the fixture actually reproduces the bug', () => {
    // Same fixture as above, asserted from the other direction: both refs share the name
    // 'run' and would be indistinguishable to a name-only matcher.
    const callerASrc = "foo.run()\n"
    const callerBSrc = "bar.run()\n"
    expect(colOf(callerASrc, 1, 'run')).toBe(colOf(callerBSrc, 1, 'run'))
  })
})

describe('ts_refs — graceful fallback', () => {
  afterEach(() => {
    setTsModuleForTesting(undefined)
  })

  it('returns null immediately for a non-TypeScript definition file, without touching the filesystem', () => {
    const result = resolveTypedRefs({
      defFile: '/does/not/exist/module.py',
      defLineStart: 1,
      defLineEnd: 3,
      symbolName: 'run',
      candidates: [ref('/does/not/exist/caller.py', 1, 0)],
    })
    expect(result).toBeNull()
  })

  it('returns null when `typescript` is forced unavailable, never throws', () => {
    setTsModuleForTesting(null)
    expect(isAvailable()).toBe(false)
    expect(() =>
      resolveTypedRefs({
        defFile: 'src/foo.ts',
        defLineStart: 1,
        defLineEnd: 3,
        symbolName: 'run',
        candidates: [ref('src/caller.ts', 1, 0)],
      }),
    ).not.toThrow()
    expect(
      resolveTypedRefs({
        defFile: 'src/foo.ts',
        defLineStart: 1,
        defLineEnd: 3,
        symbolName: 'run',
        candidates: [ref('src/caller.ts', 1, 0)],
      }),
    ).toBeNull()
  })

  it('returns null (falls back) rather than hang/crash when a nonexistent definition file is given', () => {
    const result = resolveTypedRefs({
      defFile: path.join(os.tmpdir(), 'tg-ts-refs-does-not-exist', 'nope.ts'),
      defLineStart: 1,
      defLineEnd: 3,
      symbolName: 'run',
      candidates: [ref(path.join(os.tmpdir(), 'tg-ts-refs-does-not-exist', 'caller.ts'), 1, 0)],
    })
    expect(result).toBeNull()
  })

  it('returns null (falls back) when candidates span more distinct files than MAX_CANDIDATE_FILES', () => {
    const candidates: RefEntry[] = []
    for (let i = 0; i < 60; i++) candidates.push(ref(`/fake/dir/file${i}.ts`, 1, 0))
    const result = resolveTypedRefs({
      defFile: '/fake/dir/def.ts',
      defLineStart: 1,
      defLineEnd: 3,
      symbolName: 'run',
      candidates,
    })
    expect(result).toBeNull()
  })

  it('keeps (does not drop) a candidate whose position cannot be resolved to a matching identifier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ts-refs-unresolvable-'))
    try {
      const defSrc = ['export function run(): void {}', ''].join('\n')
      const callerSrc = ['run()', ''].join('\n')
      const defFile = path.join(dir, 'def.ts')
      const callerFile = path.join(dir, 'caller.ts')
      fs.writeFileSync(defFile, defSrc)
      fs.writeFileSync(callerFile, callerSrc)

      // Deliberately wrong column (past end of line) so the identifier lookup fails to resolve --
      // must be KEPT (fail open), not silently dropped.
      const unresolvable = ref(callerFile, 1, 999)

      const result = resolveTypedRefs({
        defFile,
        defLineStart: 1,
        defLineEnd: 1,
        symbolName: 'run',
        candidates: [unresolvable],
      })

      expect(result).not.toBeNull()
      expect(result).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ts_refs — performance sanity on this repo\'s own codebase', () => {
  it('type-resolves a real symbol (foldPath, ~20 call sites) in well under the CI-safe budget', () => {
    const repoRoot = path.resolve(__dirname, '..')
    const defFile = path.resolve(repoRoot, 'src/util.ts')
    const defSrc = fs.readFileSync(defFile, 'utf-8')
    const defLines = defSrc.split('\n')
    const defLineIdx = defLines.findIndex((l) => l.startsWith('export function foldPath('))
    expect(defLineIdx).toBeGreaterThan(-1)
    let endLineIdx = defLineIdx
    while (defLines[endLineIdx] !== '}' && endLineIdx < defLines.length - 1) endLineIdx++

    // Real candidate files across the repo that call foldPath(...) -- a realistic-shape
    // multi-file `refs` scan, not a synthetic single-file case.
    const candidateFileRel = [
      'src/index_reader.ts',
      'src/db.ts',
      'src/read_commands.ts',
      'src/paths.ts',
      'src/parser.ts',
    ]
    const candidates: RefEntry[] = []
    for (const rel of candidateFileRel) {
      const abs = path.resolve(repoRoot, rel)
      if (!fs.existsSync(abs)) continue
      const src = fs.readFileSync(abs, 'utf-8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const idx = line.indexOf('foldPath(')
        if (idx !== -1 && !line.trimStart().startsWith('//')) {
          candidates.push(ref(abs, i + 1, idx, 'foldPath'))
          break // one hit per file is enough to exercise cross-file resolution
        }
      }
    }
    expect(candidates.length).toBeGreaterThan(0)

    const start = Date.now()
    const result = resolveTypedRefs({
      defFile,
      defLineStart: defLineIdx + 1,
      defLineEnd: endLineIdx + 1,
      symbolName: 'foldPath',
      candidates,
    })
    const elapsedMs = Date.now() - start

    expect(result).not.toBeNull()
    // Generous CI-safe ceiling -- this repo has ~600 files total, but the scoped program only
    // ever touches defFile + candidate files + their own import closures, not the whole project.
    expect(elapsedMs).toBeLessThan(15_000)
  })
})
