/** Members whose block or declaration runs onto later lines of a type body, for the line-at-a-time adapters. PROVENANCE: HAND-DERIVED. Each expected row and span is counted by hand from the fixture lines (the trailing comment on a line is its number), independently of the extractors. */
import { describe, expect, it } from 'vitest'

import { bodyResumeAt } from '../src/languages/body_segments.js'
import { parseFixture } from './helpers/parse-fixture.js'

async function rowsFor(file: string, lines: readonly string[]): Promise<string[]> {
  const { symbols } = await parseFixture(file, `${lines.join('\n')}\n`)
  return symbols
    .map((s) => `${s.kind} ${s.name} ${s.parent ?? ''} ${s.lineStart}-${s.lineEnd}`)
    .sort()
}

describe('bodyResumeAt', () => {
  it('returns the offset past the brace that closes the last open block, or -1 when the line never gets out', () => {
    expect(bodyResumeAt('x; } y', 1)).toBe(4)
    expect(bodyResumeAt('{ a } } y', 1)).toBe(7)
    expect(bodyResumeAt('x; } y', 0)).toBe(0)
    expect(bodyResumeAt('x; }', 2)).toBe(-1)
  })
})

describe('PHP members past a block opened on an earlier line', () => {
  it('spans a method whose `{` is on the line after a signature that shares the class header line', async () => {
    expect(await rowsFor('p1.php', [
      '<?php', // 1
      'class C { public function m()', // 2
      '{', // 3
      '    return 1;', // 4
      '}', // 5
      '}', // 6
    ])).toEqual(['class C  2-6', 'method m C 2-5'])
  })

  it('spans a method whose `{` is on the line after a signature that follows another member', async () => {
    expect(await rowsFor('p2.php', [
      '<?php', // 1
      'class C {', // 2
      '    private $x = 1; public function m()', // 3
      '    {', // 4
      '        return 1;', // 5
      '    }', // 6
      '}', // 7
    ])).toEqual(['class C  2-7', 'method m C 3-6', 'var x C 3-3'])
    expect(await rowsFor('p3.php', [
      '<?php', // 1
      'class C {', // 2
      '    function f() { return 1; } function g()', // 3
      '    {', // 4
      '        return 2;', // 5
      '    }', // 6
      '}', // 7
    ])).toEqual(['class C  2-7', 'method f C 3-3', 'method g C 3-6'])
  })

  it('does not stretch an interface method that ends in `;` over the rest of the interface', async () => {
    expect(await rowsFor('iface.php', [
      '<?php', // 1
      'interface I { public function a();', // 2
      '    public function b();', // 3
      '}', // 4
    ])).toEqual(['interface I  2-4', 'method a I 2-2', 'method b I 3-3'])
  })

  it('indexes the members declared after the `}` that closes a method opened on an earlier line', async () => {
    expect(await rowsFor('p4.php', [
      '<?php', // 1
      'class C {', // 2
      '    function f()', // 3
      '    {', // 4
      '        return 1; } function g() {}', // 5
      '}', // 6
    ])).toEqual(['class C  2-6', 'method f C 3-5', 'method g C 5-5'])
    expect(await rowsFor('d.php', [
      '<?php', // 1
      'class E {', // 2
      '    public function m()', // 3
      '    {', // 4
      '        return 1;', // 5
      '    } function g() {}', // 6
      '}', // 7
    ])).toEqual(['class E  2-7', 'method g E 6-6', 'method m E 3-6'])
  })

  it('indexes a top-level function declared after the `}` that closes another', async () => {
    expect(await rowsFor('c.php', [
      '<?php', // 1
      'function f()', // 2
      '{', // 3
      '    return 1; } function g() {}', // 4
      'function h() { return 3; }', // 5
    ])).toEqual(['function f  2-4', 'function g  4-4', 'function h  5-5'])
  })

  it('keeps a member after a block comment holding a quote', async () => {
    expect(await rowsFor('quote.php', [
      '<?php', // 1
      'class C { function a() {} /* " */ function b() {} }', // 2
    ])).toEqual(['class C  2-2', 'method a C 2-2', 'method b C 2-2'])
  })
})

describe('Kotlin nested types and top-level functions opened or declared on one line', () => {
  it('keeps the members of a nested type whose body opens on its parent type header line, and ends its span at its own close', async () => {
    expect(await rowsFor('k1.kt', [
      'class C { class B {', // 1
      '    fun x() = 1', // 2
      '}', // 3
      '    fun after() = 2', // 4
      '}', // 5
      'fun top() = 3', // 6
    ])).toEqual(['class B C 1-3', 'class C  1-5', 'function top  6-6', 'method after C 4-4', 'method x B 2-2'])
  })

  it('nests as deep as the line does', async () => {
    expect(await rowsFor('k6.kt', [
      'class C { class B { class A {', // 1
      '    fun x() = 1', // 2
      '}', // 3
      '    fun y() = 2', // 4
      '}', // 5
      '    fun z() = 3', // 6
      '}', // 7
    ])).toEqual(['class A B 1-3', 'class B C 1-5', 'class C  1-7', 'method x A 2-2', 'method y B 4-4', 'method z C 6-6'])
  })

  it('opens a nested type after another member of a body line', async () => {
    expect(await rowsFor('k7.kt', [
      'class C {', // 1
      '    fun a() = 1; class B {', // 2
      '        fun x() = 1', // 3
      '    }', // 4
      '    fun after() = 2', // 5
      '}', // 6
    ])).toEqual(['class B C 2-4', 'class C  1-6', 'method a C 2-2', 'method after C 5-5', 'method x B 3-3'])
  })

  it('indexes the top-level functions after the first on a line, and leaves a local one out', async () => {
    expect(await rowsFor('k2.kt', [
      'fun a() {}; fun b() {}', // 1
      'fun c() { val q = 1; fun d() {}', // 2
      '}', // 3
      'fun e() = 1', // 4
    ])).toEqual(['function a  1-1', 'function b  1-1', 'function c  2-3', 'function e  4-4'])
  })

  it('keeps a member after a block comment holding a quote', async () => {
    expect(await rowsFor('quote.kt', [
      'class C { fun a() {} /* " */ fun b() {} }', // 1
    ])).toEqual(['class C  1-1', 'method a C 1-1', 'method b C 1-1'])
  })

  it('indexes the member declared after the `}` that closes one opened on an earlier line', async () => {
    expect(await rowsFor('r1.kt', [
      'class C {', // 1
      '    fun prev() {', // 2
      '        val a = 1', // 3
      '    } fun next() {}', // 4
      '    fun last() {}', // 5
      '}', // 6
    ])).toEqual(['class C  1-6', 'method last C 5-5', 'method next C 4-4', 'method prev C 2-4'])
  })
})

describe('C# nested types and members past a closed block', () => {
  it('keeps the members of a nested type whose body opens on its parent type header line', async () => {
    expect(await rowsFor('c1.cs', [
      'class C { class B {', // 1
      '    void X() {}', // 2
      '}', // 3
      '    void After() {}', // 4
      '}', // 5
      'class Z { void Q() {} }', // 6
    ])).toEqual(['class B C 1-3', 'class C  1-5', 'class Z  6-6', 'method After C 4-4', 'method Q Z 6-6', 'method X B 2-2'])
  })

  it('nests as deep as the line does, and across a struct', async () => {
    expect(await rowsFor('c6.cs', [
      'class C { class B { struct A {', // 1
      '    void X() {}', // 2
      '}', // 3
      '    void Y() {}', // 4
      '}', // 5
      '    void Z() {}', // 6
      '}', // 7
    ])).toEqual(['class B C 1-5', 'class C  1-7', 'method X A 2-2', 'method Y B 4-4', 'method Z C 6-6', 'struct A B 1-3'])
  })

  it('opens a nested type after another member of a body line', async () => {
    expect(await rowsFor('c7.cs', [
      'class C {', // 1
      '    void A() {} class B {', // 2
      '        void X() {}', // 3
      '    }', // 4
      '    void After() {}', // 5
      '}', // 6
    ])).toEqual(['class B C 2-4', 'class C  1-6', 'method A C 2-2', 'method After C 5-5', 'method X B 3-3'])
  })

  it('indexes the member declared after the `}` that closes one opened on an earlier line', async () => {
    expect(await rowsFor('c2.cs', [
      'class C {', // 1
      '    void Prev() {', // 2
      '    } void Next() {}', // 3
      '    void Last() {}', // 4
      '}', // 5
    ])).toEqual(['class C  1-5', 'method Last C 4-4', 'method Next C 3-3', 'method Prev C 2-3'])
  })

  it('does not take a block closed inside a method for the end of the method', async () => {
    expect(await rowsFor('c8.cs', [
      'class C {', // 1
      '    void Prev() {', // 2
      '        if (x) {', // 3
      '        } else { y(); }', // 4
      '    } void Next() { void Local() {} }', // 5
      '}', // 6
    ])).toEqual(['class C  1-6', 'method Next C 5-5', 'method Prev C 2-5'])
  })

  it('keeps a member after a block comment holding a quote', async () => {
    expect(await rowsFor('quote.cs', [
      'class C { void A() {} /* " */ void B() {} }', // 1
    ])).toEqual(['class C  1-1', 'method A C 1-1', 'method B C 1-1'])
  })
})

describe('Swift nested types, members past a closed block, and enum cases', () => {
  it('keeps the members of a nested type opened on its parent header line, and the top-level functions after the first on a line', async () => {
    expect(await rowsFor('s1.swift', [
      'class C { class B {', // 1
      '    func x() {}', // 2
      '}', // 3
      '    func after() {}', // 4
      '}', // 5
      'func top() {}; func top2() {}', // 6
    ])).toEqual(['class B C 1-3', 'class C  1-5', 'function top  6-6', 'function top2  6-6', 'method after C 4-4', 'method x B 2-2'])
  })

  it('nests as deep as the line does, and opens a nested type after another member', async () => {
    expect(await rowsFor('s6.swift', [
      'class C { struct B { enum A {', // 1
      '    func x() {}', // 2
      '}', // 3
      '    func y() {}', // 4
      '}', // 5
      '    func z() {}', // 6
      '}', // 7
    ])).toEqual(['class C  1-7', 'enum A B 1-3', 'method x A 2-2', 'method y B 4-4', 'method z C 6-6', 'struct B C 1-5'])
    expect(await rowsFor('s7.swift', [
      'class C {', // 1
      '    func a() {}; struct B {', // 2
      '        func x() {}', // 3
      '    }', // 4
      '    func after() {}', // 5
      '}', // 6
    ])).toEqual(['class C  1-6', 'method a C 2-2', 'method after C 5-5', 'method x B 3-3', 'struct B C 2-4'])
  })

  it('indexes the member declared after the `}` that closes one opened on an earlier line', async () => {
    expect(await rowsFor('r1.swift', [
      'class C {', // 1
      '    func prev() {', // 2
      '        let a = 1', // 3
      '    } func next() {}', // 4
      '    func last() {}', // 5
      '}', // 6
    ])).toEqual(['class C  1-6', 'method last C 5-5', 'method next C 4-4', 'method prev C 2-4'])
  })

  it('indexes every case of an enum, however many one `case` keyword lists', async () => {
    // Swift book, "Enumerations": `case a(Int), b` and `case c = 1, d = 2` each declare two cases; `indirect` and backticks are legal on a case.
    expect(await rowsFor('en.swift', [
      'enum E {', // 1
      '    case one, two', // 2
      '    case a(Int), b', // 3
      '    case c', // 4
      '    case d = 4, e = 5', // 5
      '    indirect case f(E)', // 6
      '    case `default`', // 7
      '    func m() {}', // 8
      '}', // 9
    ])).toEqual([
      'enum E  1-9',
      'enum_member a E 3-3',
      'enum_member b E 3-3',
      'enum_member c E 4-4',
      'enum_member d E 5-5',
      'enum_member default E 7-7',
      'enum_member e E 5-5',
      'enum_member f E 6-6',
      'enum_member one E 2-2',
      'enum_member two E 2-2',
      'method m E 8-8',
    ])
    expect(await rowsFor('en1.swift', ['enum F { case x, y; func m() {} }'])).toEqual(['enum F  1-1', 'enum_member x F 1-1', 'enum_member y F 1-1', 'method m F 1-1'])
  })

  it('keeps an apostrophe in a string from swallowing the declarations after it', async () => {
    expect(await rowsFor('ap.swift', [
      'struct S {', // 1
      '    func a() { print("it\'s") }', // 2
      '    func b() {', // 3
      '        print("don\'t")', // 4
      '    }', // 5
      '    func c() {}', // 6
      '}', // 7
    ])).toEqual(['method a S 2-2', 'method b S 3-5', 'method c S 6-6', 'struct S  1-7'])
  })

  it('keeps the doc comment on the type row, and gives the members sharing its line none', async () => {
    const { symbols } = await parseFixture('doc.swift', [
      '/// Doc for S.', // 1
      '/// Second line.', // 2
      'struct S { var a = 0; func f() {} }', // 3
    ].join('\n') + '\n')
    const doc = (name: string): string | undefined => symbols.find((s) => s.name === name)?.docstring
    expect(doc('S')).toBe('Doc for S.\nSecond line.')
    expect(doc('a')).toBe('')
    expect(doc('f')).toBe('')
  })

  it('keeps a member after a block comment holding a quote', async () => {
    expect(await rowsFor('quote.swift', [
      'class C { func a() {} /* " */ func b() {} }', // 1
    ])).toEqual(['class C  1-1', 'method a C 1-1', 'method b C 1-1'])
  })
})

describe('Scala nested types, members past a closed block, and parameterless defs', () => {
  it('indexes a def with no parameter list or result type, and spans its indented body', async () => {
    expect(await rowsFor('sc2.scala', [
      'object O {', // 1
      '  def b =', // 2
      '    1 + 2', // 3
      '  def c = 3', // 4
      '}', // 5
    ])).toEqual(['function b O 2-3', 'function c O 4-4', 'object O  1-5'])
  })

  it('indexes every def of a one-line body, and leaves a def local to a block out', async () => {
    expect(await rowsFor('sc3.scala', ['object O { def one = 1; def two = 2 }'])).toEqual(['function one O 1-1', 'function two O 1-1', 'object O  1-1'])
    expect(await rowsFor('sc4.scala', ['object O { def foo = { def baz = 1; baz } }'])).toEqual(['function foo O 1-1', 'object O  1-1'])
  })

  it('keeps the members of a nested type opened on its parent header line, as deep as the line goes', async () => {
    expect(await rowsFor('sc1.scala', [
      'class C { class B { class A {', // 1
      '  def x = 1', // 2
      '}', // 3
      '  def y = 2', // 4
      '}', // 5
      '  def z = 3', // 6
      '}', // 7
    ])).toEqual(['class A B 1-3', 'class B C 1-5', 'class C  1-7', 'function x A 2-2', 'function y B 4-4', 'function z C 6-6'])
  })

  it('indexes the member declared after the `}` that closes one opened on an earlier line, and top-level defs after the first on a line', async () => {
    expect(await rowsFor('c.scala', [
      'class C {', // 1
      '  def prev() = {', // 2
      '    val a = 1', // 3
      '  } ; def next() = 2', // 4
      '  def last() = 3', // 5
      '}', // 6
    ])).toEqual(['class C  1-6', 'function last C 5-5', 'function next C 4-4', 'function prev C 2-4'])
    expect(await rowsFor('d.scala', ['def a = 1; def b = 2'])).toEqual(['function a  1-1', 'function b  1-1'])
  })

  it('keeps a member after a block comment holding a quote', async () => {
    expect(await rowsFor('e.scala', [
      'class C { def a = 1; /* " */ def b = 2 }', // 1
    ])).toEqual(['class C  1-1', 'function a C 1-1', 'function b C 1-1'])
  })
})

describe('a bodiless declaration ends on its own line, not at the next block', () => {
  it('Kotlin: an abstract or interface member followed by an init block, a secondary constructor or a companion', async () => {
    expect(await rowsFor('a.kt', [
      'abstract class A {', // 1
      '    abstract fun f(): Int', // 2
      '    init {', // 3
      '        println(1)', // 4
      '    }', // 5
      '    fun g() = 1', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'method f A 2-2', 'method g A 6-6'])
    expect(await rowsFor('b.kt', [
      'abstract class A {', // 1
      '    abstract fun f(): Int', // 2
      '    // a comment between the two', // 3
      '    constructor(x: Int) : this() {', // 4
      '        println(1)', // 5
      '    }', // 6
      '    fun g() = 1', // 7
      '}', // 8
    ])).toEqual(['class A  1-8', 'method f A 2-2', 'method g A 7-7'])
    expect(await rowsFor('c.kt', [
      'interface I {', // 1
      '    fun f(): Int', // 2
      '    fun h(): Int {', // 3
      '        return 1', // 4
      '    }', // 5
      '}', // 6
    ])).toEqual(['interface I  1-6', 'method f I 2-2', 'method h I 3-5'])
  })

  it('Kotlin: a one-line expression body ends on its line even when an init block follows, and a multi-line one ends with its expression', async () => {
    expect(await rowsFor('d.kt', [
      'class K {', // 1
      '    fun one() = 1', // 2
      '    init {', // 3
      '    }', // 4
      '    fun two() = listOf(1,', // 5
      '        2)', // 6
      '    fun three() {', // 7
      '    }', // 8
      '}', // 9
    ])).toEqual(['class K  1-9', 'method one K 2-2', 'method three K 7-8', 'method two K 5-6'])
  })

  it('Scala: an abstract def followed by a `locally` block, and Groovy: an abstract method followed by a static initializer', async () => {
    expect(await rowsFor('f.scala', [
      'abstract class A {', // 1
      '  def f(): Int', // 2
      '  locally {', // 3
      '    println(1)', // 4
      '  }', // 5
      '  def g() = 1', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'function f A 2-2', 'function g A 6-6'])
    expect(await rowsFor('g.groovy', [
      'abstract class A {', // 1
      '    abstract int f()', // 2
      '    static {', // 3
      '        x()', // 4
      '    }', // 5
      '    int g() { return 1 }', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'method f A 2-2', 'method g A 6-6'])
  })

  it('a class header that continues on a `constructor(` line still owns the constructor block', async () => {
    expect(await rowsFor('h.kt', [
      'class A', // 1
      '    constructor(x: Int) {', // 2
      '        println(x)', // 3
      '    }', // 4
    ])).toEqual(['class A  1-4'])
  })

  it('a call or identifier named like a member-start word does not end the member before its body', async () => {
    expect(await rowsFor('n1.kt', [
      'class A {', // 1
      '    val static = 1', // 2
      '    fun g() {', // 3
      '        init(3)', // 4
      '        locally()', // 5
      '    }', // 6
      '    fun h() = 2', // 7
      '}', // 8
    ])).toEqual(['class A  1-8', 'method g A 3-6', 'method h A 7-7'])
    expect(await rowsFor('n2.kt', [
      'class A {', // 1
      '    fun f() =', // 2
      '        init(3)', // 3
      '    fun g() {', // 4
      '    }', // 5
      '}', // 6
    ])).toEqual(['class A  1-6', 'method f A 2-3', 'method g A 4-5'])
    expect(await rowsFor('n3.scala', [
      'class A {', // 1
      '  def f(x: Int): Int =', // 2
      '    locally(x)', // 3
      '  def g() = 1', // 4
      '  val static = 1', // 5
      '  def h(): Int =', // 6
      '    init { 3 }', // 7
      '}', // 8
    ])).toEqual(['class A  1-8', 'function f A 2-3', 'function g A 4-4', 'function h A 6-7', 'val static A 5-5'])
    expect(await rowsFor('n4.groovy', [
      'class A {', // 1
      '    int f()', // 2
      '    {', // 3
      '        static_x()', // 4
      '    }', // 5
      '    int g() { return 1 }', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'method f A 2-5', 'method g A 6-6'])
  })

  it('Scala: an abstract val followed by a bare block ends on its own line', async () => {
    expect(await rowsFor('v.scala', [
      'class A {', // 1
      '  val x: Int', // 2
      '  {', // 3
      '    println(1)', // 4
      '  }', // 5
      '  def g() = 1', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'function g A 6-6', 'val x A 2-2'])
  })

  it('Java, C# and Swift already end a bodiless member at its own line', async () => {
    expect(await rowsFor('A.java', [
      'abstract class A {', // 1
      '    abstract int f();', // 2
      '    static {', // 3
      '        x();', // 4
      '    }', // 5
      '    int g() { return 1; }', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'method f  2-2', 'method g  6-6'])
    expect(await rowsFor('A.cs', [
      'abstract class A {', // 1
      '    public abstract int F();', // 2
      '    static A() {', // 3
      '        X();', // 4
      '    }', // 5
      '    int G() { return 1; }', // 6
      '}', // 7
    ])).toEqual(['class A  1-7', 'method A A 3-5', 'method F A 2-2', 'method G A 6-6'])
    expect(await rowsFor('P.swift', [
      'protocol P {', // 1
      '    func f() -> Int', // 2
      '    init(x: Int)', // 3
      '}', // 4
    ])).toEqual(['method f P 2-2', 'method init P 3-3', 'protocol P  1-4'])
  })
})

// PROVENANCE: HAND-DERIVED from the Scala 3 reference, "Optional Braces": https://docs.scala-lang.org/scala3/reference/other-new-features/indentation.html (a template body after a trailing `:` is the indented block that follows, closed by a dedent or an `end` marker).
describe('Scala 3 indentation (braceless) bodies nest types and keep their members', () => {
  it('indexes a nested braceless class and object, with the members of each and an `end` marker', async () => {
    expect(await rowsFor('a3.scala', [
      'class C(x: Int):', // 1
      '  class B(y: Int):', // 2
      '    def f = 1', // 3
      '    def g(): Int =', // 4
      '      val q = 2', // 5
      '      q', // 6
      '  object Inner:', // 7
      '    val v = 1', // 8
      '    def h = 2', // 9
      '  def after = 3', // 10
      'end C', // 11
      'def top = 9', // 12
    ])).toEqual([
      'class B C 2-6',
      'class C  1-11',
      'function after C 10-10',
      'function f B 3-3',
      'function g B 4-6',
      'function h Inner 9-9',
      'function top  12-12',
      'object Inner C 7-9',
      'val v Inner 8-8',
    ])
  })

  it('nests three deep, across blank and comment lines, and inside a braced parent', async () => {
    expect(await rowsFor('c3.scala', [
      'class C:', // 1
      '  class B:', // 2
      '    class A:', // 3
      '      def deep = 1', // 4
      '    def mid = 2', // 5
      '  def top = 3', // 6
    ])).toEqual(['class A B 3-4', 'class B C 2-5', 'class C  1-6', 'function deep A 4-4', 'function mid B 5-5', 'function top C 6-6'])
    expect(await rowsFor('f3.scala', [
      'class C:', // 1
      '  def one = 1', // 2
      '', // 3
      '  // comment', // 4
      '  class B:', // 5
      '', // 6
      '    def two = 2', // 7
      '', // 8
      '  def three = 3', // 9
    ])).toEqual(['class B C 5-7', 'class C  1-9', 'function one C 2-2', 'function three C 9-9', 'function two B 7-7'])
    expect(await rowsFor('e3.scala', [
      'class C {', // 1
      '  class B:', // 2
      '    def x = 1', // 3
      '  def y = 2', // 4
      '}', // 5
    ])).toEqual(['class B C 2-3', 'class C  1-5', 'function x B 3-3', 'function y C 4-4'])
  })

  it('leaves a class declared inside a method body out', async () => {
    expect(await rowsFor('d3.scala', [
      'class C:', // 1
      '  def m(): Unit =', // 2
      '    class Local:', // 3
      '      def hidden = 1', // 4
      '    println(1)', // 5
      '  def next = 2', // 6
    ])).toEqual(['class C  1-6', 'function m C 2-5', 'function next C 6-6'])
  })
})

describe('a Kotlin or Scala expression body whose `=` starts on the next line', () => {
  it('ends an expression body whose `=` starts the next line at the end of that expression', async () => {
    expect(await rowsFor('n1.kt', [
      'class A {', // 1
      '    fun f(): Int', // 2
      '        = init(3)', // 3
      '    fun g(): Int', // 4
      '        // why', // 5
      '', // 6
      '        = compute(', // 7
      '            4)', // 8
      '    fun h() = 1', // 9
      '}', // 10
    ])).toEqual(['class A  1-10', 'method f A 2-3', 'method g A 4-8', 'method h A 9-9'])
    expect(await rowsFor('n2.scala', [
      'class A {', // 1
      '  def f(): Int', // 2
      '    = init(3)', // 3
      '  def g(): Int', // 4
      '    = compute(', // 5
      '      4)', // 6
      '  def h = 1', // 7
      '}', // 8
    ])).toEqual(['class A  1-8', 'function f A 2-3', 'function g A 4-6', 'function h A 7-7'])
  })

  it('leaves an abstract member next to an expression-bodied one on their own lines', async () => {
    expect(await rowsFor('n3.kt', [
      'abstract class A {', // 1
      '    abstract fun f(): Int', // 2
      '    fun g() = 1', // 3
      '}', // 4
    ])).toEqual(['class A  1-4', 'method f A 2-2', 'method g A 3-3'])
  })
})
