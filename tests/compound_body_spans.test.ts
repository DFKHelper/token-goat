import { describe, it, expect } from 'vitest'
import { extractBash } from '../src/languages/bash_idx.js'
import { ADAPTER_EXTRACTORS } from '../src/languages/registry.js'
import { parseFixture } from './helpers/parse-fixture.js'

function spans(symbols: readonly { name: string; lineStart: number; lineEnd: number }[]): Record<string, string> {
  return Object.fromEntries(symbols.map((s) => [s.name, `${s.lineStart}-${s.lineEnd}`]))
}

describe('bash functions whose body is not a brace group', () => {
  it('spans a subshell-bodied function and does not swallow the next function', () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based).
    const content = [
      '#!/bin/bash',
      '',
      'in_dir() ( cd "$1" && shift && "$@" )',
      '',
      'build() {',
      '  make',
      '}',
      '',
      'deploy()',
      '(',
      '  rsync -a . host:',
      ')',
      '',
    ].join('\n')
    const got = spans(extractBash(content, 'a.sh').filter((s) => s.kind === 'function'))
    expect(got).toEqual({ in_dir: '3-3', build: '5-7', deploy: '9-12' })
  })

  it('spans [[ ]], loop and if bodies and keeps the following brace function intact', () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based).
    const content = [
      'check() [[ -n "$1" ]]',
      'loop() while read l; do echo "$l"; done',
      'multi() if [ -f x ]; then',
      '  echo yes',
      'fi',
      'after() {',
      '  true',
      '}',
      '',
    ].join('\n')
    const got = spans(extractBash(content, 'b.sh').filter((s) => s.kind === 'function'))
    expect(got).toEqual({ check: '1-1', loop: '2-2', multi: '3-5', after: '6-8' })
  })

  it('spans a multi-line subshell body whose parens nest', () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based).
    const content = ['f() (', '  x=$(date)', '  echo "$x"', ')', 'g() {', '  :', '}', ''].join('\n')
    const got = spans(extractBash(content, 'c.sh').filter((s) => s.kind === 'function'))
    expect(got).toEqual({ f: '1-4', g: '5-7' })
  })

  it('does not end a subshell body at a case pattern paren', () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based); bash accepts both `a)` and `(b)` pattern forms and a last arm without `;;`.
    const content = [
      'route() (',
      '  case "$1" in',
      '    a) echo one ;;',
      '    (b|c) echo two',
      '      ;;',
      '    *) echo other',
      '  esac',
      '  echo done',
      ')',
      'tail_fn() {',
      '  :',
      '}',
      'inline() ( case $1 in x) echo x;; esac )',
      '',
    ].join('\n')
    const got = spans(extractBash(content, 'd.sh').filter((s) => s.kind === 'function'))
    expect(got).toEqual({ route: '1-9', tail_fn: '10-12', inline: '13-13' })
  })
})

describe('csharp expression-bodied members', () => {
  const run = (content: string) => spans(ADAPTER_EXTRACTORS.csharp(content, 'Calc.cs').filter((s) => s.kind === 'method' || s.kind === 'var'))

  it('spans a multi-line => body through its terminating semicolon and leaves one-liners alone', () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based); the `;` inside the plain and interpolated strings on line 14 must not end Compute.
    const content = [
      'using System;', // 1
      'class Calc', // 2
      '{', // 3
      '    public int One(int x) => x;', // 4
      '    public int Twice(int x) =>', // 5
      '        x * 2;', // 6
      '', // 7
      '    public bool Active => a &&', // 8
      '        b &&', // 9
      '        c;', // 10
      '', // 11
      '    public int Compute(int x) =>', // 12
      '        Helper(x,', // 13
      '            "a;b", $"{x};{{")', // 14
      '        + 1;', // 15
      '', // 16
      '    public string Name => "n";', // 17
      '', // 18
      '    public int Block(int x)', // 19
      '    {', // 20
      '        return x;', // 21
      '    }', // 22
      '    public int Expr =>', // 23
      '        42;', // 24
      '}', // 25
      '',
    ].join('\n')
    expect(run(content)).toMatchObject({
      One: '4-4',
      Twice: '5-6',
      Active: '8-10',
      Compute: '12-15',
      Name: '17-17',
      Block: '19-22',
      Expr: '23-24',
    })
  })

  it('spans them on the production parse path, not only through the adapter registry', async () => {
    // HAND-DERIVED: line numbers counted by hand from the fixture below (1-based).
    const content = 'class Calc\n{\n    public int Twice(int x) =>\n        x * 2;\n}\n'
    const parsed = await parseFixture('Calc.cs', content)
    expect(spans(parsed.symbols.filter((s) => s.name === 'Twice'))).toEqual({ Twice: '3-4' })
  })
})
