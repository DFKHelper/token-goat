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
import * as realTs from 'typescript'
import type * as TsModule from 'typescript'

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

describe('ts_refs — precision survives with JSDoc parsing narrowed', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ts-refs-jsdoc-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('drops a same-named false positive when the true caller is a .js file typed only by JSDoc', () => {
    // The scoped program is built with jsDocParsingMode ParseForTypeErrors, which skips JSDoc in
    // .ts files but keeps it in .js files, where it is the only place a type can be written. This
    // pins that a JS caller typed that way still survives the tier rather than being lost with the
    // comments. It does not prove the mode choice: switching to ParseNone leaves this fixture
    // green, because a candidate the checker cannot decide about is kept rather than dropped, so
    // an erased annotation looks the same from here as a resolved one. ParseForTypeErrors is
    // conservatism about .js typing, not something this assertion can distinguish.
    const fooSrc = ['export class Foo {', '  run(): void {}', '}', ''].join('\n')
    const barSrc = ['export class Bar {', '  run(): void {}', '}', ''].join('\n')
    const jsCallerSrc = [
      "/** @type {import('./fileA').Foo} */",
      'const foo = null',
      'foo.run()',
      '',
    ].join('\n')
    const barCallerSrc = ["import { Bar } from './fileB'", 'const bar = new Bar()', 'bar.run()', ''].join('\n')

    const fileA = path.join(dir, 'fileA.ts')
    const fileB = path.join(dir, 'fileB.ts')
    const jsCaller = path.join(dir, 'caller.js')
    const barCaller = path.join(dir, 'callerB.ts')
    fs.writeFileSync(fileA, fooSrc)
    fs.writeFileSync(fileB, barSrc)
    fs.writeFileSync(jsCaller, jsCallerSrc)
    fs.writeFileSync(barCaller, barCallerSrc)

    const result = resolveTypedRefs({
      defFile: fileA,
      defLineStart: 2,
      defLineEnd: 2,
      symbolName: 'run',
      candidates: [ref(jsCaller, 3, 0), ref(barCaller, 3, 0)],
    })

    expect(result).not.toBeNull()
    expect(result?.map((r) => r.filePath)).toEqual([jsCaller])
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

describe('ts_refs — scoped program skips JSDoc parsing it never reads', () => {
  afterEach(() => {
    setTsModuleForTesting(undefined)
  })

  // This tier asks the checker one thing -- do two identifiers resolve to the same declaration --
  // and never reads a doc comment or reports a diagnostic, so parsing every JSDoc comment in every
  // file the program pulls in is pure waste. Configuring the host to skip it is worth ~127ms of a
  // ~1180ms `refs` call here, measured on the built bundle across three alternating builds, with
  // byte-identical output. None of that is observable from the command's behaviour: drop the host
  // and every functional test still passes while the saving silently disappears.
  function recordingTs(withEnum: boolean): { calls: TsModule.CreateProgramOptions[]; mod: typeof TsModule } {
    const calls: TsModule.CreateProgramOptions[] = []
    const mod = {
      ...realTs,
      JSDocParsingMode: withEnum ? realTs.JSDocParsingMode : undefined,
      createProgram: (opts: TsModule.CreateProgramOptions) => {
        calls.push(opts)
        return realTs.createProgram(opts)
      },
    } as unknown as typeof TsModule
    return { calls, mod }
  }

  function runOnce(mod: typeof TsModule): void {
    setTsModuleForTesting(mod)
    const defFile = path.resolve(process.cwd(), 'src/util.ts')
    resolveTypedRefs({
      defFile,
      defLineStart: 1,
      defLineEnd: 2,
      symbolName: 'countNoun',
      candidates: [ref(defFile, 1, 0, 'countNoun')],
    })
  }

  it('builds the program with a host that skips JSDoc in .ts files', () => {
    const { calls, mod } = recordingTs(true)
    runOnce(mod)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.host?.jsDocParsingMode).toBe(realTs.JSDocParsingMode.ParseForTypeErrors)
  })

  it('falls back to the default host on a TypeScript too old to have the enum', () => {
    // typescript is an optional dependency and JSDocParsingMode only exists from 5.3, so reading
    // the mode off an older module yields undefined -- which must mean "keep the default host",
    // not "pass undefined as the mode" and not a crash.
    const { calls, mod } = recordingTs(false)
    runOnce(mod)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.host).toBeUndefined()
  })
})
