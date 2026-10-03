import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { ADAPTER_EXTRACTORS } from '../src/languages/registry.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wrapped-spans-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function spans(language: 'scala' | 'elixir', content: string, file: string): string[] {
  const extract = ADAPTER_EXTRACTORS[language]
  if (extract === undefined) throw new Error(`no adapter for ${language}`)
  return extract(content, file).map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)
}

describe('Scala spans cover indentation bodies and next-line `=` bodies', () => {
  // Fixture provenance: HAND-DERIVED. Line numbers were counted from the snippet below by hand; the Scala 3 syntax follows the Scala 3 Reference "Optional Braces" page, not the extractor.
  it('spans Scala 3 `object Foo:` / `class Bar(...):` bodies and the defs inside them', () => {
    const content = [
      'object Registry:', //                                     1
      '  private val cache = Map.empty[String, Int]', //          2
      '', //                                                     3
      '  def lookup(key: String): Int =', //                      4
      '    val v = cache.getOrElse(key, 0)', //                   5
      '    if v > 0 then v', //                                   6
      '    else fallback(key)', //                                7
      '', //                                                     8
      '  def fallback(key: String): Int =', //                    9
      '    key.length', //                                       10
      '', //                                                    11
      'class Service(dep: Int):', //                             12
      '  def run(): Unit =', //                                  13
      '    println(dep)', //                                     14
      '    println(dep + 1)', //                                 15
      '', //                                                    16
      'def after(): Int = 1', //                                 17
    ].join('\n')
    expect(spans('scala', content, 'S3.scala')).toEqual([
      'Registry 1-10',
      'cache 2-2',
      'lookup 4-7',
      'fallback 9-10',
      'Service 12-15',
      'run 13-15',
      'after 17-17',
    ])
  })

  // Fixture provenance: HAND-DERIVED. Counted from the snippet; a braced Scala 2 class whose method body sits on the next line without braces.
  it('spans a braced Scala 2 class and a `def ... =` whose body is on the next line', () => {
    const content = [
      'class Container[A](items: List[A]) {', //        1
      '  def map[B](f: A => B): Container[B] =', //      2
      '    new Container(items.map(f))', //              3
      '', //                                           4
      '  def size: Int = items.size', //                 5
      '}', //                                           6
    ].join('\n')
    expect(spans('scala', content, 'App.scala')).toEqual(['Container 1-6', 'map 2-3', 'size 5-5'])
  })

  // Fixture provenance: HAND-DERIVED. Counted from the snippet. Scala 3 allows a closing `end Name` marker, which is part of the declaration; a comment and blank lines after the last code line are not.
  it('includes a closing `end Name` marker and stops at the last code line before a dedent', () => {
    const content = [
      'enum Color:', //            1
      '  case Red, Green', //      2
      'end Color', //              3
      '', //                       4
      'trait T:', //               5
      '  def f: Int =', //         6
      '    1', //                  7
      '', //                       8
      '    // trailing note', //   9
      '', //                      10
    ].join('\n')
    expect(spans('scala', content, 'End.scala')).toEqual(['Color 1-3', 'T 5-7', 'f 6-7'])
  })
})

describe('Elixir spans cover a def head that wraps before its `do`', () => {
  // Fixture provenance: HAND-DERIVED. Counted from the snippet; the three wrapped-head shapes (guard on the next line, multi-line params, `),` then `do: expr`) follow the Elixir syntax reference for def/2 and when guards.
  it('widens a def whose `when` guard, params or `do:` sit on later lines', () => {
    const content = [
      'defmodule Guard do', //                                                  1
      '  def handle(%{type: type, payload: payload} = event, state)', //          2
      '      when type in [:created, :updated] do', //                            3
      '    process(event, payload, state)', //                                    4
      '    {:ok, state}', //                                                      5
      '  end', //                                                                 6
      '', //                                                                     7
      '  def other, do: :ok', //                                                  8
      '', //                                                                     9
      '  def second(', //                                                        10
      '        a,', //                                                           11
      '        b', //                                                            12
      '      ) do', //                                                           13
      '    a + b', //                                                            14
      '  end', //                                                                15
      '', //                                                                    16
      '  def third(x),', //                                                      17
      '    do: x * 2', //                                                        18
      '', //                                                                    19
      '  def last(x) do', //                                                     20
      '    x', //                                                               21
      '  end', //                                                                22
      'end', //                                                                  23
    ].join('\n')
    expect(spans('elixir', content, 'guard.ex')).toEqual([
      'Guard 1-23',
      'handle 2-6',
      'other 8-8',
      'second 10-15',
      'third 17-18',
      'last 20-22',
    ])
  })

  // Fixture provenance: HAND-DERIVED. Counted from the snippet; a protocol's `def size(data)` has no body at all, so a head must not stay pending and swallow the next line.
  it('leaves bodiless protocol heads on one line and keeps the next def intact', () => {
    const content = [
      'defprotocol Size do', //   1
      '  def size(data)', //      2
      '  def other(data)', //     3
      'end', //                   4
    ].join('\n')
    expect(spans('elixir', content, 'size.ex')).toEqual(['Size 1-4', 'size 2-2', 'other 3-3'])
  })
})

describe('Ruby bare method calls are recorded as call-site refs', () => {
  // Fixture provenance: HAND-DERIVED. Line numbers counted from the snippet. The call/local split follows Ruby's own rule (an identifier is a local variable only after an assignment or a parameter earlier in the scope; otherwise a receiverless, argumentless call), not the extractor's.
  it('records `header` but never a parameter, assigned local or block parameter', async () => {
    const file = path.join(TMP, 'bare.rb')
    fs.writeFileSync(
      file,
      [
        'class Report', //                                  1
        '  def render', //                                  2
        '    header', //                                    3
        '    body_text', //                                 4
        '    footer()', //                                  5
        '    title = header', //                            6
        '    title.strip', //                               7
        '    puts "x #{footer}"', //                        8
        '    list(trailer)', //                             9
        '  end', //                                        10
        '  private', //                                    11
        '  def header', //                                 12
        '    "h"', //                                      13
        '  end', //                                        14
        '  def local_only(held)', //                       15
        '    held', //                                     16
        '    ready = 1', //                                17
        '    ready', //                                    18
        '    items.each { |item| item }', //               19
        '    ->(arg) { arg }', //                          20
        '  end', //                                        21
        '  def later', //                                  22
        '    held', //                                     23
        '  end', //                                        24
        'end', //                                          25
      ].join('\n'),
    )
    const { refs } = await parseFile(file)
    const at = (name: string): string[] => refs.filter((r) => r.name === name).map((r) => `${r.line}:${r.context}`)
    expect(at('header')).toEqual(['3:render', '6:render'])
    expect(at('body_text')).toEqual(['4:render'])
    expect(at('footer')).toEqual(['5:render', '8:render'])
    expect(at('trailer')).toEqual(['9:render'])
    // `held` is a parameter of local_only (line 16) but a bare call in `later`, which has no such parameter.
    expect(at('held')).toEqual(['23:later'])
    expect(at('items')).toEqual(['19:local_only'])
    for (const local of ['title', 'ready', 'item', 'arg', 'private']) expect(at(local)).toEqual([])
  })
})
