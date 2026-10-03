import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { parseFixture } from './helpers/parse-fixture.js'

// A string interpolation hole holds code, and that code can hold a string with a brace in it: `"${raw.replace("}", "")}"`. Both walkers that count braces read the nested `"` as closing the outer string, so the nested literal's `}` (or `{`) was counted as a real brace: a class or method span ended early, or ran past its own end into the next symbol, and later symbols were lost or misparented. Swift's `\( ... )` hole was not recognised by the string stripper at all.

// Provenance: every file below is HAND-DERIVED. The spans are the line numbers of the brace that opens and the brace that closes each declaration, counted by hand from the text, independently of the indexer. The hole syntax is read off each language's specification: Swift "String Interpolation" (docs.swift.org, The Swift Programming Language, Lexical Structure), Kotlin "String templates" (kotlinlang.org/docs/strings.html), Dart "Strings" (dart.dev/language/built-in-types#strings), Scala "String Interpolation" (docs.scala-lang.org/overviews/core/string-interpolation.html), and C# "Interpolated strings" (learn.microsoft.com/dotnet/csharp/language-reference/tokens/interpolated).

interface Expected {
  name: string
  start: number
  end: number
  parent?: string
}

interface Case {
  title: string
  file: string
  lines: string[]
  expected: Expected[]
}

const CASES: Case[] = [
  {
    title: 'Swift: a nested literal holding "}" inside \\( ... )',
    file: 'Hole.swift',
    lines: [
      'struct H {',
      '    func label(name: String) -> String {',
      '        return "Hello \\(name.isEmpty ? "}" : name)"',
      '    }',
      '',
      '    func next() -> Int {',
      '        return 1',
      '    }',
      '}',
      '',
      'func afterH() {}',
    ],
    expected: [
      { name: 'H', start: 1, end: 9 },
      { name: 'label', start: 2, end: 4, parent: 'H' },
      { name: 'next', start: 6, end: 8, parent: 'H' },
      { name: 'afterH', start: 11, end: 11, parent: '' },
    ],
  },
  {
    title: 'Swift: a nested literal holding "{" inside \\( ... ), after a subscript with its own string',
    file: 'Open.swift',
    lines: [
      'struct E {',
      '    func render(dict: [String: String]) -> String {',
      '        return "value: \\(dict["key"] ?? "{")"',
      '    }',
      '}',
      '',
      'func afterE() {}',
    ],
    expected: [
      { name: 'E', start: 1, end: 5 },
      { name: 'render', start: 2, end: 4, parent: 'E' },
      { name: 'afterE', start: 7, end: 7, parent: '' },
    ],
  },
  {
    title: 'Swift: an interpolation inside a nested interpolation, and a closure brace in the hole',
    file: 'Deep.swift',
    lines: [
      'struct D {',
      '    func a(xs: [Int]) -> String {',
      '        return "n \\(xs.map { "\\($0)}" }.count)"',
      '    }',
      '    func b() {}',
      '}',
    ],
    expected: [
      { name: 'D', start: 1, end: 6 },
      { name: 'a', start: 2, end: 4, parent: 'D' },
      { name: 'b', start: 5, end: 5, parent: 'D' },
    ],
  },
  {
    title: 'Kotlin: a nested literal holding "}" inside ${ ... }',
    file: 'Formatter.kt',
    lines: [
      'class Formatter {',
      '    fun clean(raw: String): String {',
      '        val x = "${raw.replace("}", "")}"',
      '        return x',
      '    }',
      '    fun after() {',
      '    }',
      '}',
    ],
    expected: [
      { name: 'Formatter', start: 1, end: 8 },
      { name: 'clean', start: 2, end: 5, parent: 'Formatter' },
      { name: 'after', start: 6, end: 7, parent: 'Formatter' },
    ],
  },
  {
    title: 'Kotlin: a nested literal holding "{" inside ${ ... }',
    file: 'Opener.kt',
    lines: [
      'class Opener {',
      '    fun clean(raw: String): String {',
      '        return "${raw.replace("{", "")}"',
      '    }',
      '}',
      '',
      'fun afterO() {',
      '    println(1)',
      '}',
    ],
    expected: [
      { name: 'Opener', start: 1, end: 5 },
      { name: 'clean', start: 2, end: 4, parent: 'Opener' },
      { name: 'afterO', start: 7, end: 9, parent: '' },
    ],
  },
  {
    title: 'Dart: a nested literal holding "}" inside ${ ... }, in double and single quotes',
    file: 'hole.dart',
    lines: [
      'class D {',
      '  String label(Map<String, String> m) {',
      '    return "v ${m["}"]}";',
      '  }',
      '  String other(Map<String, String> m) {',
      "    return 'v ${m['}']}';",
      '  }',
      '  void after() {}',
      '}',
    ],
    expected: [
      { name: 'D', start: 1, end: 9 },
      { name: 'label', start: 2, end: 4, parent: 'D' },
      { name: 'other', start: 5, end: 7, parent: 'D' },
      { name: 'after', start: 8, end: 8, parent: 'D' },
    ],
  },
  {
    title: 'Scala: a nested literal holding "}" inside an s-string hole',
    file: 'Hole.scala',
    lines: [
      'class S {',
      '  def label(m: Map[String, String]): String = {',
      '    s"v ${m("}")}"',
      '  }',
      '  def after(): Unit = {}',
      '}',
    ],
    expected: [
      { name: 'S', start: 1, end: 6 },
      { name: 'label', start: 2, end: 4, parent: 'S' },
      { name: 'after', start: 5, end: 5, parent: 'S' },
    ],
  },
  {
    title: 'Scala: a plain string holding "${" is not a hole and does not swallow what follows',
    file: 'Plain.scala',
    lines: [
      'class P {',
      '  def a(): String = {',
      '    "cost: ${"',
      '  }',
      '  def b(): Int = {',
      '    1',
      '  }',
      '}',
    ],
    expected: [
      { name: 'P', start: 1, end: 8 },
      { name: 'a', start: 2, end: 4, parent: 'P' },
      { name: 'b', start: 5, end: 7, parent: 'P' },
    ],
  },
  {
    title: 'C#: a nested literal holding "}" inside { ... } of a $-string',
    file: 'Hole.cs',
    lines: [
      'public class C',
      '{',
      '    public string Label(System.Collections.Generic.Dictionary<string, string> m)',
      '    {',
      '        return $"v {m["}"]}";',
      '    }',
      '    public void After() { }',
      '}',
    ],
    expected: [
      { name: 'C', start: 1, end: 8 },
      { name: 'Label', start: 3, end: 6, parent: 'C' },
      { name: 'After', start: 7, end: 7, parent: 'C' },
    ],
  },
  {
    title: 'C#: an escaped {{ in a $-string is a literal brace, not a hole',
    file: 'Escaped.cs',
    lines: [
      'public class Q',
      '{',
      '    public string A()',
      '    {',
      '        return $"{{ {1}";',
      '    }',
      '    public string B()',
      '    {',
      '        return "b";',
      '    }',
      '}',
    ],
    expected: [
      { name: 'Q', start: 1, end: 11 },
      { name: 'A', start: 3, end: 6, parent: 'Q' },
      { name: 'B', start: 7, end: 10, parent: 'Q' },
    ],
  },
]

describe('brace spans and member parents survive a brace in a literal nested in an interpolation hole', () => {
  for (const c of CASES) {
    it(c.title, async () => {
      const result = await parseFixture(c.file, c.lines.join('\n') + '\n')
      for (const e of c.expected) {
        const sym = result.symbols.find((s) => s.name === e.name)
        expect(sym, `${c.file}: symbol ${e.name}`).toBeDefined()
        expect([sym?.lineStart, sym?.lineEnd], `${c.file}: span of ${e.name}`).toEqual([e.start, e.end])
        if (e.parent !== undefined) expect(sym?.parent, `${c.file}: parent of ${e.name}`).toBe(e.parent)
      }
    })
  }
})

describe('the built bundle indexes a project whose literals hold a brace inside an interpolation hole', () => {
  let root: string
  let project: string
  let env: NodeJS.ProcessEnv

  function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-interp-holes-'))
    project = path.join(root, 'project')
    const home = path.join(root, 'home')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
    env = {
      ...process.env,
      TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
      LOCALAPPDATA: path.join(root, 'data'),
      XDG_DATA_HOME: path.join(root, 'data'),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
    }
    for (const c of CASES.filter((k) => ['Hole.swift', 'Formatter.kt', 'Opener.kt'].includes(k.file))) {
      fs.writeFileSync(path.join(project, c.file), c.lines.join('\n') + '\n')
    }
    const idx = tg(['index', '.', '--walk'])
    expect(idx.status, idx.stderr).toBe(0)
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('resolves a Swift symbol that follows the interpolation, and a member of the type that holds it', () => {
    const after = tg(['read', 'Hole.swift::afterH'])
    expect(after.status, after.stderr).toBe(0)
    expect(after.stdout).toContain('func afterH() {}')
    const next = tg(['read', 'Hole.swift::H.next'])
    expect(next.status, next.stderr).toBe(0)
    expect(next.stdout).toContain('return 1')
    const type = tg(['read', 'Hole.swift::H'])
    expect(type.stdout).toContain('func next() -> Int {')
  })

  it('reads a whole Kotlin method down to its closing brace', () => {
    const clean = tg(['read', 'Formatter.kt::Formatter.clean'])
    expect(clean.status, clean.stderr).toBe(0)
    expect(clean.stdout).toContain('return x')
    const opener = tg(['read', 'Opener.kt::Opener.clean'])
    expect(opener.status, opener.stderr).toBe(0)
    expect(opener.stdout).toContain('return "${raw.replace("{", "")}"')
    expect(opener.stdout).not.toContain('fun afterO')
    const outline = tg(['outline', 'Opener.kt'])
    expect(outline.stdout).toMatch(/1-5\s+\S+\s+Opener/)
    expect(outline.stdout).toMatch(/7-9\s+\S+\s+afterO/)
  })
})
