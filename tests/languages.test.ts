import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseFile } from '../src/parser.js'
import { extractCsharp } from '../src/languages/csharp.js'
import { extractPhp } from '../src/languages/php.js'
import { extractHtml } from '../src/languages/html.js'
import { extractLiquid } from '../src/languages/liquid.js'
import { extractKotlin } from '../src/languages/kotlin.js'
import { extractGraphql } from '../src/languages/graphql_idx.js'
import { stripHashComments } from '../src/languages/common.js'
import { extractSql } from '../src/languages/sql_idx.js'
import { extractIni, extractEnv } from '../src/languages/ini_idx.js'
import { extractMakefile } from '../src/languages/makefile_idx.js'
import { extractProto } from '../src/languages/proto_idx.js'
import { extractTerraform } from '../src/languages/terraform_idx.js'
import { extractPowershell } from '../src/languages/powershell_idx.js'
import { extractBash } from '../src/languages/bash_idx.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lang-test-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

describe('csharp adapter', () => {
  it('extracts class, method, namespace, and using import', () => {
    const content = `using System;
using System.Collections.Generic;

namespace MyApp.Services {

public class UserService {
  public string GetUser(int id) {
    return "";
  }
}
}
`
    const { symbols, imports } = extractCsharp(content, 'UserService.cs')
    expect(symbols.length).toBeGreaterThan(0)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('UserService')
    expect(imports.some((i) => i.target === 'System')).toBe(true)
  })

  it('extracts a class, method, property, and constructor that carry a same-line attribute (regression: CLASS_HEADER_RE/CONSTRUCTOR_RE/PROPERTY_RE/PROPERTY_HEADER_RE/PROPERTY_ARROW_RE/METHOD_RE are all anchored against the modifier alternation or return type directly, with no room for a leading [Attr] list, so [Obsolete] public class Foo / [Test] public Foo() / [JsonProperty("name")] public string Name { get; set; } -- all idiomatic C# -- silently dropped the whole declaration, and for a class, every member inside it)', () => {
    const content = `namespace App {
[Obsolete] public class Foo
{
    [Obsolete("x")] public void OldMethod()
    { }

    [JsonProperty("name")] public string Name { get; set; }

    [Test] public Foo()
    { }
}
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('OldMethod')
    expect(names).toContain('Name')
    expect(symbols.filter((s) => s.name === 'Foo' && s.kind === 'method')).toHaveLength(1)
  })

  it('indexes a readonly struct and its members, plus ref struct and file class (regression: CLASS_HEADER_RE\'s modifier alternation only recognized public/protected/private/internal/abstract/sealed/static/partial, so readonly, ref, unsafe, and file -- all legal C# type-declaration modifiers -- caused the whole header line to fail to match, silently dropping the type and misattributing every member inside it)', () => {
    const content = `namespace Demo {
    public readonly struct Point
    {
        public int X { get; }
        public int Y { get; }
        public Point(int x, int y) { X = x; Y = y; }
        public int Sum() => X + Y;
    }

    public ref struct Span { }

    file class Helper { }
}
`
    const { symbols } = extractCsharp(content, 'Point.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Point')
    expect(names).toContain('Sum')
    expect(symbols.find((s) => s.name === 'Sum')?.docstring).toBe('Point')
    expect(names).toContain('Span')
    expect(names).toContain('Helper')
  })

  it('names a record struct / record class by its actual type name, not the trailing "struct"/"class" keyword (regression: CLASS_HEADER_RE required exactly one whitespace-separated word between the record/class/struct/... keyword and the name, so a two-token type keyword like "record struct" or "record class" phantom-captured the second keyword token ("struct"/"class") as the name instead of the real identifier)', () => {
    const content = `namespace Demo {
    public readonly record struct Point(int X, int Y);
    public record class Wrapper(string Value);
}
`
    const { symbols } = extractCsharp(content, 'Point.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Point')
    expect(names).not.toContain('struct')
    expect(names).toContain('Wrapper')
    expect(names).not.toContain('class')
  })

  it('emits a namespace declaration with kind namespace, not const', () => {
    const content = `namespace Acme.Core;

public class Widget {
    public void Run() {}
}
`
    const { symbols } = extractCsharp(content, 'Widget.cs')
    const ns = symbols.find((s) => s.name === 'Acme.Core')
    expect(ns).toBeDefined()
    expect(ns?.kind).toBe('namespace')
    expect(symbols.find((s) => s.name === 'Widget')?.kind).toBe('class')
  })

  it('indexes methods with no access modifier and rejects field/statement lines', () => {
    const content = `public class Calc {
  public string GetUser(int id) { return ""; }
  int Add(int a, int b) { return a + b; }
  void Run() { Add(1, 2); }
  new void Hide() {}
  private int count;
  List<int> items;
  int Count => count;
}
`
    const { symbols } = extractCsharp(content, 'Calc.cs')
    const methods = symbols.filter((s) => s.kind === 'method').map((s) => s.name)
    // No-modifier, return-type-only, and new-modified methods are all indexed.
    expect(methods).toContain('GetUser')
    expect(methods).toContain('Add')
    expect(methods).toContain('Run')
    expect(methods).toContain('Hide')
    // Fields and expression-bodied properties are not methods.
    expect(methods).not.toContain('count')
    expect(methods).not.toContain('items')
  })

  it('indexes an expression-bodied property as a var symbol, not a method', () => {
    const content = `public class Calc {
  private int count;
  public int Count => count;
  public string Label => "total";
  public int Add(int a, int b) => a + b;
}
`
    const { symbols } = extractCsharp(content, 'Calc.cs')
    const countProp = symbols.find((s) => s.name === 'Count')
    expect(countProp?.kind).toBe('var')
    expect(countProp?.docstring).toBe('Calc')
    const labelProp = symbols.find((s) => s.name === 'Label')
    expect(labelProp?.kind).toBe('var')
    // Regression: an expression-bodied METHOD (parens between name and `=>`) must still be
    // indexed as a method, not misdetected as a property by PROPERTY_ARROW_RE.
    const add = symbols.find((s) => s.name === 'Add')
    expect(add?.kind).toBe('method')
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractCsharp('', 'empty.cs')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('attaches methods to an Allman-style class (opening brace on its own line)', () => {
    const content = `public class Foo
{
    public void Bar()
    {
        DoSomething();
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('ignores braces inside a /* */ block comment when tracking scope depth', () => {
    const content = `public class Foo {
    /*
    if (false) {
    */
    public void Real() {
    }
    /*
    }
    */
}

public class Bar {
    public void Other() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: an unmatched brace inside a commented-out code block must not be counted
    // toward braceDepth - otherwise depthInClass drifts and Real is never detected as a method.
    const real = symbols.find((s) => s.name === 'Real')
    expect(real?.kind).toBe('method')
    expect(real?.docstring).toBe('Foo')
    const other = symbols.find((s) => s.name === 'Other')
    expect(other?.kind).toBe('method')
    expect(other?.docstring).toBe('Bar')
  })

  it('does not leave a brace-less positional record "stuck" as the current class for later declarations', () => {
    const content = `public record Point(int X, int Y);

public class Foo {
    public void Bar() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Point.cs')
    // Regression: a brace-less one-line positional record never opens a body, so
    // currentClass must be cleared right after it - otherwise every subsequent
    // top-level class/member is mis-parented under the record forever.
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('does not leave a brace-less positional record "stuck" underneath a later class when the declaration line carries a trailing // comment (regression: stripped was computed from a line that never had its trailing line comment removed, so stripped.endsWith(\';\') was false and the pop check never fired -- the record frame stayed on classStack beneath Foo\'s frame, surviving Foo\'s own close and mis-parenting Baz\'s members under Point instead of Baz once Foo popped)', () => {
    const content = `public record Point(int X, int Y); // immutable value type

public class Foo {
    public void Bar() {
    }
}

public class Baz {
    public void Qux() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Point.cs')
    // Foo is top-level (not nested inside the record), so it must not inherit Point as its
    // enclosing class -- the stuck record frame previously caused exactly this misparent.
    const foo = symbols.find((s) => s.name === 'Foo')
    expect(foo?.kind).toBe('class')
    expect(foo?.docstring).toBe('')
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
    // Baz is declared after Foo's closing brace pops Foo off the stack, which previously
    // exposed the still-stuck Point frame underneath it.
    const baz = symbols.find((s) => s.name === 'Baz')
    expect(baz?.kind).toBe('class')
    expect(baz?.docstring).toBe('')
    const qux = symbols.find((s) => s.name === 'Qux')
    expect(qux?.kind).toBe('method')
    expect(qux?.docstring).toBe('Baz')
  })

  it('does not leave a fully single-line class "stuck" as the current class for later declarations', () => {
    const content = `public class Empty { }

public class Foo {
    public void Bar() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Empty.cs')
    // Regression: a class opened and closed on its own declaration line never rises above
    // classStartDepth, so currentClass must be cleared right after it too.
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('does not let braces inside a // line comment desync scope depth', () => {
    const content = `public class Foo {
    public void Before() {
        // TODO: handle { edge case
    }
    public void After() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: an unbalanced brace inside a // line comment must not be counted
    // toward braceDepth - otherwise depthInClass drifts and After is never detected.
    const after = symbols.find((s) => s.name === 'After')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('Foo')
  })

  it('detects .cs language via parseFile', async () => {
    const file = tmp('Foo.cs', 'public class Foo {}')
    const result = await parseFile(file)
    expect(result.language).toBe('csharp')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('does not let an unbalanced brace inside a string literal desync scope depth', () => {
    const content = `class Foo {
  private string bracket = "{";
  public void Bar() {}
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: the string literal "{" contains a literal brace character. If it is counted
    // toward braceDepth, Bar is never detected (wrong depth) and currentClass never pops after
    // Foo's real closing brace, mis-parenting everything declared afterward.
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('captures a nested class and parents its member to the nested class, not the outer class', () => {
    const content = `public class Outer {
    public class Inner {
        public void InnerMethod() {
        }
    }
    public void OuterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Outer.cs')
    // Regression: nested class headers were already recorded as symbols, but currentClass was a
    // single scalar that only ever latched onto the FIRST class seen - a nested class's own
    // members were measured against the OUTER class's start depth (depthInClass 2, never
    // matching the depthInClass === 1 gate), so they were silently dropped from the index.
    const inner = symbols.find((s) => s.name === 'Inner')
    expect(inner?.kind).toBe('class')
    expect(inner?.docstring).toBe('Outer')
    const innerMethod = symbols.find((s) => s.name === 'InnerMethod')
    expect(innerMethod?.kind).toBe('method')
    expect(innerMethod?.docstring).toBe('Inner')
    const outerMethod = symbols.find((s) => s.name === 'OuterMethod')
    expect(outerMethod?.kind).toBe('method')
    expect(outerMethod?.docstring).toBe('Outer')
  })

  it('extracts constructors with no explicit access modifier', () => {
    const content = `public class Box {
    Box(int x) { }
    public Box(string name) { }
}
`
    const { symbols } = extractCsharp(content, 'Box.cs')
    const constructors = symbols.filter((s) => s.kind === 'method' && s.docstring === 'Box')
    // Both constructors should be indexed: the no-modifier one and the public one
    expect(constructors).toHaveLength(2)
    expect(constructors.map((c) => c.name)).toEqual(['Box', 'Box'])
  })

  it('does not let a brace inside a trailing // comment desync scope depth', () => {
    const content = `class Foo {
    void Bar() {  // TODO: close the } here
    }
    void After() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: stripStringLiterals does not strip a trailing // comment, so the } inside
    // it cancelled out the real { that opened Bar's body, desyncing braceDepth and popping
    // Foo's scope one method early - After was mis-parented as top-level, not Foo's member.
    const after = symbols.find((s) => s.name === 'After')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('Foo')
  })

  it('does not let a nested quote inside an interpolation hole desync scope depth', () => {
    // Regression: stripStringLiterals did not track interpolation-hole brace depth, so the
    // nested `"` in `Replace("}", "")` was read as closing the outer `$"..."` string early,
    // exposing the hole's own `"}"` as bare unstripped code and leaking an unmatched `}` into
    // braceDepth - popping Formatter's scope one method early and mis-parenting after/after2.
    const content = `class Formatter {
    void clean() {
        var x = $"{raw.Replace("}", "")}";
    }
    void after() {
    }
    void after2() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Formatter.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['Formatter', 'clean', 'after', 'after2'])
    expect(symbols.find((s) => s.name === 'after')?.docstring).toBe('Formatter')
    expect(symbols.find((s) => s.name === 'after2')?.docstring).toBe('Formatter')
  })

  it('does not let a nested quote inside a verbatim interpolated string ($@"...") hole desync scope depth', () => {
    // Regression: findMultilineOpener/findMultilineCloser's 'verbatim' case (used for C#
    // $@"..."/@$"..." strings, which stripMultilineStringSpan handles before stripStringLiterals
    // ever sees the line) had no interpolation-hole awareness, unlike stripStringLiterals's own
    // bareBraceHole handling for the non-verbatim $"..." case above. The nested `"` in
    // `Map("}")` was read as closing the outer $@"..." string early, exposing the hole's own
    // `"}"` as bare unstripped code and leaking an unmatched `}` into braceDepth - popping Foo's
    // scope one method early and dropping Baz.
    const content = `class Foo {
    public void Bar() {
        var s = $@"{Map("}")}";
    }
    public void Baz() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['Foo', 'Bar', 'Baz'])
    expect(symbols.find((s) => s.name === 'Baz')?.docstring).toBe('Foo')
  })

  it('does not let a C# `{{` escaped literal brace inside an interpolated string open a hole', () => {
    // Regression: stripStringLiterals's bareBraceHole branch treated any `{` as opening an
    // interpolation hole unconditionally, with no check for C#'s `{{` literal-brace escape. A
    // `{{` inside a `$"..."` string opened a hole that never closed on this line, so the rest of
    // the line (and the real code after it) was read as hole content instead of blanked string
    // content, desyncing braceDepth and dropping every symbol after the offending method.
    const content = `public class Alpha {
    public void First() {
        var s = $"{{";
    }
    public void Second() {
    }
    public void Third() {
    }
}
`
    const { symbols } = extractCsharp(content, 'Alpha.cs')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['Alpha', 'First', 'Second', 'Third'])
    expect(symbols.find((s) => s.name === 'Second')?.docstring).toBe('Alpha')
    expect(symbols.find((s) => s.name === 'Third')?.docstring).toBe('Alpha')
  })

  it('detects an Allman-style auto-property with get/set on their own line', () => {
    const content = `public class Foo
{
    public int Bar
    {
        get; set;
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: PROPERTY_RE requires the '{'/get/set tokens on the same line as the property
    // declaration. Standard Allman brace style puts the brace (and get/set) on their own
    // following lines, so the property was silently omitted from the index entirely - not
    // mis-parented, just absent.
    const bar = symbols.find((s) => s.name === 'Bar' && s.kind === 'var')
    expect(bar).toBeDefined()
    expect(bar?.docstring).toBe('Foo')
  })

  it('detects an Allman-style property with an explicit (non-shorthand) accessor body', () => {
    const content = `public class Foo
{
    public int Count => count;
    public int Bar
    {
        get { return 1; }
    }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    // Regression: ALLMAN_ACCESSOR_RE only matched the auto-property shorthand ('get;'/'set;'),
    // so an Allman-style property with a real accessor body ('get { return 1; }') matched none
    // of PROPERTY_RE (needs a same-line '{'), the Allman header check (accessor line must be
    // exactly 'get;'/'set;'), PROPERTY_ARROW_RE (needs '=>'), or METHOD_RE (needs '(' after the
    // name) - the property was silently dropped from the index entirely.
    const bar = symbols.find((s) => s.name === 'Bar' && s.kind === 'var')
    expect(bar).toBeDefined()
    expect(bar?.docstring).toBe('Foo')
  })

  it('does not phantom-capture a nested generic type argument as the method name', () => {
    // Regression: METHOD_RE's name-suffix pattern was `[<(]` (matches any `<` or `(`), so a
    // generic return type followed by another generic type argument let the lazy name-capture
    // group stop at the FIRST `<` it saw - inside the return type itself - phantom-capturing
    // the inner type name ("List") instead of the real method name ("GetMap"). A `readonly`
    // field also got miscaptured as a method because `readonly` was absent from the modifier
    // alternation, so the field's type name ("Dictionary") was phantom-captured as a method too.
    const content = `public class Foo {
    public Dictionary<string, List<int>> GetMap() { return null; }
    private static readonly Dictionary<string, Func<int>> Handlers = new();
    public T Parse<T>(string s) { return default; }
}
`
    const { symbols } = extractCsharp(content, 'Foo.cs')
    const methods = symbols.filter((s) => s.kind === 'method').map((s) => s.name)
    expect(methods).toContain('GetMap')
    expect(methods).not.toContain('List')
    expect(methods).not.toContain('Dictionary')
    expect(methods).not.toContain('Handlers')
    expect(methods).toContain('Parse')
  })

  it('assigns distinct symbol kinds for struct/interface/enum instead of collapsing all to class', () => {
    // Regression: CLASS_HEADER_RE only captured the type name, never the class/struct/interface/
    // enum/record keyword itself, so the usage site hardcoded kind to the literal string 'class'
    // for every one of these constructs.
    const content = `public struct Point {
    public int X;
}

public interface IWidget {
    void Render();
}

public enum Color {
    Red,
    Green,
}

public record Vector(int X, int Y);
`
    const { symbols } = extractCsharp(content, 'Shapes.cs')
    expect(symbols.find((s) => s.name === 'Point')?.kind).toBe('struct')
    expect(symbols.find((s) => s.name === 'IWidget')?.kind).toBe('interface')
    expect(symbols.find((s) => s.name === 'Color')?.kind).toBe('enum')
    // record is class-like, so it still maps to 'class'.
    expect(symbols.find((s) => s.name === 'Vector')?.kind).toBe('class')
  })

  it('does not open a phantom verbatim string on an ordinary literal ending in "@"', () => {
    // Regression: findMultilineOpener's verbatim-string branch (`/\$?@\$?"/`) had no
    // isInsideStringLiteral guard, unlike the sibling triple-quote branch a few lines above it.
    // An ordinary string like `"@"` textually matches `@"`, so it was misread as opening a
    // verbatim string that never closes on this line, masking every subsequent line until a
    // stray `"` happened to appear anywhere later in the file - swallowing both methods below.
    const content = `public class ConfigHolder
{
    private const string At = "@";

    public void MethodOne()
    {
        System.Console.WriteLine("one");
    }

    public void MethodTwo()
    {
        System.Console.WriteLine("two");
    }
}
`
    const { symbols } = extractCsharp(content, 'Test.cs')
    const methods = symbols.filter((s) => s.kind === 'method').map((s) => s.name)
    expect(methods).toContain('MethodOne')
    expect(methods).toContain('MethodTwo')
  })

  it('does not leak a positional record scope whose signature spans multiple lines', () => {
    // Regression: the self-contained-one-liner pop was gated on openedFrameThisLine, so it only
    // fired on the exact line that pushed the frame. A brace-less positional record's signature
    // can wrap onto later lines (`record Person(\n  string First,\n  string Last);`), and since
    // it never opens a real `{` body, bodyEntered never flips true either - so neither pop path
    // ever fired and the frame stayed stranded, mis-parenting every following top-level class.
    const content = `public record Person(
    string First,
    string Last);

public class Account
{
    public void Deposit() { }
}
`
    const { symbols } = extractCsharp(content, 'Test.cs')
    expect(symbols.find((s) => s.name === 'Account')?.docstring).toBe('')
    expect(symbols.find((s) => s.name === 'Deposit')?.docstring).toBe('Account')
  })
})

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe('php adapter', () => {
  it('extracts class, method, function, and use import', () => {
    const content = `<?php
use App\\Models\\User;
namespace App\\Services;

class UserService {
  public function getUser(int $id): User {
    return new User();
  }
}

function helperFn() {}
`
    const { symbols, imports } = extractPhp(content, 'UserService.php')
    expect(symbols.length).toBeGreaterThan(0)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('UserService')
    expect(names).toContain('getUser')
    expect(imports.some((i) => i.target.includes('User'))).toBe(true)
  })

  it('indexes a legacy var-declared property (regression: PROP_RE\'s modifier alternation only recognized public/protected/private/static/readonly, so `var $foo;` -- still valid PHP syntax, a full synonym for public -- silently dropped the property from the index entirely)', () => {
    const content = `<?php
class Legacy {
    var $foo;
    var $bar = 1;
    public $baz;
}
`
    const { symbols } = extractPhp(content, 'Legacy.php')
    const props = symbols.filter((s) => s.kind === 'var').map((s) => s.name)
    expect(props).toContain('foo')
    expect(props).toContain('bar')
    expect(props).toContain('baz')
  })

  it('indexes a readonly class, alone or stacked with final/abstract (regression: CLASS_RE\'s modifier group only recognized abstract/final and was capped at a single optional modifier, so a PHP 8.2 readonly class -- alone or combined with final/abstract -- never matched at all, silently dropping the class and misattributing every member inside it as top-level)', () => {
    const content = `<?php
namespace App;

readonly class Point {
    public function __construct(public int $x, public int $y) {}
}

final readonly class Point2 {
    public int $x;
}
`
    const { symbols } = extractPhp(content, 'Point.php')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Point')
    expect(names).toContain('Point2')
    expect(symbols.find((s) => s.name === '__construct')?.kind).toBe('method')
    expect(symbols.find((s) => s.name === '__construct')?.docstring).toBe('Point')
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractPhp('', 'empty.php')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  // Regression: `use Trait;` inside a class body is a trait-use declaration (mixing a
  // trait's methods into the class), not a namespace import -- USE_RE had no brace-depth
  // gate, unlike every other classifier in this file, so a trait use was misrecorded as
  // an `imports` entry even though it has no relation to any real namespace dependency.
  it('does not record a trait-use declaration inside a class body as a namespace import', () => {
    const content = `<?php
namespace App;

class Foo
{
    use LoggableTrait;

    public function bar(): void
    {
    }
}
`
    const { symbols, imports } = extractPhp(content, 'Foo.php')
    expect(symbols.map((s) => s.name)).toContain('Foo')
    expect(imports.some((i) => i.target === 'LoggableTrait')).toBe(false)
  })

  it('indexes a final class constant, including a final combined with a visibility modifier', () => {
    // PHP 8.1+ allows `final const`. Regression: the modifier group allowed at most one modifier
    // and did not include `final` at all, so `final const FOO = 1;` and
    // `final public const BAR = 2;` silently dropped the constant from the index.
    const content = `<?php
class Foo {
    final const FOO = 1;
    final public const BAR = 2;
    public const BAZ = 3;
}
`
    const { symbols } = extractPhp(content, 'Foo.php')
    const consts = symbols.filter((s) => s.kind === 'const').map((s) => s.name)
    expect(consts).toContain('FOO')
    expect(consts).toContain('BAR')
    expect(consts).toContain('BAZ')
  })

  it('pops class scope at the closing brace so later top-level decls are not mis-parented', () => {
    const content = `<?php
class Foo {
    public function a() {}
}
function baz() {}
class Bar {
    public function b() {}
}
`
    const { symbols } = extractPhp(content, 'scope.php')
    const baz = symbols.find((s) => s.name === 'baz')
    expect(baz).toBeDefined()
    // baz is declared after Foo's closing brace, so it is a top-level function with no parent class.
    expect(baz?.kind).toBe('function')
    expect(baz?.docstring).toBe('')
    // Bar is a second top-level class declared after Foo closed; its parent must be empty, not Foo.
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('class')
    expect(bar?.docstring).toBe('')
    // Method b genuinely belongs to Bar.
    const b = symbols.find((s) => s.name === 'b')
    expect(b?.kind).toBe('method')
    expect(b?.docstring).toBe('Bar')
    // Sanity: method a still belongs to Foo.
    const a = symbols.find((s) => s.name === 'a')
    expect(a?.kind).toBe('method')
    expect(a?.docstring).toBe('Foo')
  })

  it('does not misclassify a function nested inside a method body as a class method', () => {
    const content = `<?php
class Foo {
    public function bar() {
        function baz() { return 1; }
    }
}
`
    const { symbols } = extractPhp(content, 'nested.php')
    const baz = symbols.find((s) => s.name === 'baz')
    expect(baz).toBeDefined()
    // baz is nested two brace-levels inside Foo (inside bar's body), not directly in Foo's
    // own body, so it must not be classified as a method of Foo.
    expect(baz?.kind).toBe('function')
    expect(baz?.docstring).toBe('')
    // bar is directly in Foo's body (one brace level in) and must still be a real method.
    const bar = symbols.find((s) => s.name === 'bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('parses declarations and braces that share a line with a block comment', () => {

    const content = `<?php
class Foo {
  public function methodA() {}
} /* closes Foo */
function afterFoo() {}
/* standalone
   block with a } brace that must not be counted
*/
class Bar { /* inline */ }
function tail() {}
`
    const { symbols } = extractPhp(content, 'x.php')
    const foo = symbols.find((s) => s.name === 'Foo')
    expect(foo?.kind).toBe('class')
    const methodA = symbols.find((s) => s.name === 'methodA')
    expect(methodA?.kind).toBe('method')
    expect(methodA?.docstring).toBe('Foo')
    // Core regression: afterFoo shares a line with */ that closes Foo; the closing brace must pop Foo's scope so afterFoo is top-level, not a method.
    const afterFoo = symbols.find((s) => s.name === 'afterFoo')
    expect(afterFoo?.kind).toBe('function')
    expect(afterFoo?.docstring).toBe('')
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('class')
    const tail = symbols.find((s) => s.name === 'tail')
    expect(tail?.kind).toBe('function')
    expect(tail?.docstring).toBe('')
  })

  it('does not treat a /* that appears inside a string literal as a block-comment opener', () => {
    const content = `<?php
class Scanner {
    public function scan() {
        $files = glob('src/*.php');
        return $files;
    }
}
function afterGlob() {}
`
    const { symbols } = extractPhp(content, 'scanner.php')
    const scan = symbols.find((s) => s.name === 'scan')
    expect(scan?.kind).toBe('method')
    expect(scan?.docstring).toBe('Scanner')
    // Regression: 'src/*.php' inside the glob() string call must not be mistaken for a
    // comment opener - otherwise everything after it (including this declaration) is
    // silently swallowed as "inside a never-closed comment".
    const afterGlob = symbols.find((s) => s.name === 'afterGlob')
    expect(afterGlob?.kind).toBe('function')
    expect(afterGlob?.docstring).toBe('')
  })

  it('does not index a function-local `static $var` declaration as a phantom class property (regression: the property branch had no brace-depth gate, unlike the method branch, so PROP_RE\'s `static` modifier alternation matched an ordinary function-local static variable and attributed it to whatever class was still on top of the context stack)', () => {
    const content = `<?php
class Counter {
    public static $shared = 0;

    public function next(): int {
        static $counter = 0;
        return ++$counter;
    }
}
`
    const { symbols } = extractPhp(content, 'Counter.php')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('shared')
    expect(names).toContain('next')
    expect(names).not.toContain('counter')
    expect(symbols.find((s) => s.name === 'shared')?.docstring).toBe('Counter')
  })

  it('does not attribute a constant declared inside an untracked anonymous class body to the enclosing named class (regression: the const branch had no brace-depth gate, unlike the method and property branches, so a const nested inside an anonymous class - which never gets pushed onto the context stack - was mistaken for a constant of whatever named class was still on top of it)', () => {
    const content = `<?php
class Outer {
    public function make() {
        return new class {
            const INNER = 1;
            public function inner() {}
        };
    }
    const REAL = 2;
}
`
    const { symbols } = extractPhp(content, 'Outer.php')
    expect(symbols.find((s) => s.name === 'INNER')?.docstring).toBe('')
    expect(symbols.find((s) => s.name === 'REAL')?.docstring).toBe('Outer')
  })

  it('detects .php language via parseFile', async () => {
    const file = tmp('foo.php', '<?php function foo() {}')
    const result = await parseFile(file)
    expect(result.language).toBe('php')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('does not let an unbalanced brace inside a string literal desync scope depth', () => {
    const content = `<?php
class Foo {
    public $bracket = "{";
    public function a() {}
}
function afterFoo() {}
`
    const { symbols } = extractPhp(content, 'Foo.php')
    // Regression: the string literal "{" contains a literal brace character. If it is counted
    // toward braceDepth, Foo's real closing brace never brings braceDepth back down to its
    // start depth, so Foo's context is never popped and afterFoo is silently mis-parented as
    // one of Foo's own methods instead of being a top-level function.
    const a = symbols.find((s) => s.name === 'a')
    expect(a?.kind).toBe('method')
    expect(a?.docstring).toBe('Foo')
    const afterFoo = symbols.find((s) => s.name === 'afterFoo')
    expect(afterFoo?.kind).toBe('function')
    expect(afterFoo?.docstring).toBe('')
  })

  it('does not let a brace inside a trailing // or # comment desync scope depth', () => {
    const content = `<?php
class A {
    const X = 1; // resets the } counter
    public function method1() {}
}
`
    const { symbols } = extractPhp(content, 'A.php')
    // Regression: stripStringLiterals does not strip trailing // or # comments, so the }
    // inside the comment on the const line was counted as real code, popping A's scope one
    // declaration early and mis-parenting method1 as a top-level function instead of A's method.
    const method1 = symbols.find((s) => s.name === 'method1')
    expect(method1?.kind).toBe('method')
    expect(method1?.docstring).toBe('A')
  })

  it('does not pop a class context on a multi-line header before its body brace is reached', () => {
    const content = `<?php
class Foo
implements Bar, Baz
{
    public function method1() {}
}
`
    const { symbols } = extractPhp(content, 'Foo.php')
    // Regression: the 'implements Bar, Baz' line has zero net braces, so braceDepth still
    // equals the just-pushed Foo frame's start depth. Without a bodyEntered gate, the class
    // context popped immediately on that line - before the '{' on the next line was even
    // seen - and method1 was mis-parented as a top-level function instead of Foo's method.
    const method1 = symbols.find((s) => s.name === 'method1')
    expect(method1?.kind).toBe('method')
    expect(method1?.docstring).toBe('Foo')
  })

  it('classifies kind correctly when the declared name is itself a substring of the keyword', () => {
    // Regression: kind was derived from `stripped.split(name)[0]` then checking
    // includes('interface'|'trait'|'enum'). When the name is a case-sensitive substring of the
    // keyword itself (e.g. an interface literally named "face", so the source reads
    // "interface face"), split(name) lands its split point INSIDE the keyword text, corrupting
    // the substring check and misclassifying the symbol as kind 'class'.
    const content = `<?php
interface face {
    public function look();
}
enum num {
}
`
    const { symbols } = extractPhp(content, 'weird.php')
    const face = symbols.find((s) => s.name === 'face')
    expect(face?.kind).toBe('interface')
    const num = symbols.find((s) => s.name === 'num')
    expect(num?.kind).toBe('enum')
  })
})

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

describe('html adapter', () => {
  it('extracts id symbols, class symbols, and link imports', () => {
    const content = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/styles/main.css">
  <script src="/js/app.js"></script>
</head>
<body>
  <h1>Main Title</h1>
  <div id="hero-banner" class="product-card featured">Hello</div>
  <h2>Subtitle</h2>
</body>
</html>`
    const { symbols, imports, sections } = extractHtml(content, 'index.html')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('hero-banner')
    expect(names).toContain('product-card')
    expect(imports.some((i) => i.kind === 'html_link')).toBe(true)
    expect(imports.some((i) => i.kind === 'html_script')).toBe(true)
    expect(sections.some((s) => s.heading === 'Main Title')).toBe(true)
  })

  it('suppresses noisy ids and class names', () => {
    const content = `<div id="container" class="wrapper row">content</div>`
    const { symbols } = extractHtml(content, 'test.html')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('container')
    expect(names).not.toContain('wrapper')
    expect(names).not.toContain('row')
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports, sections } = extractHtml('', 'empty.html')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
    expect(sections).toHaveLength(0)
  })

  it('detects .html language via parseFile', async () => {
    const file = tmp('page.html', '<h1>Hello</h1>')
    const result = await parseFile(file)
    expect(result.language).toBe('html')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('extracts a heading whose text spans multiple lines', () => {
    // Regression: HEADING_RE lacked the `s` (dotall) flag, so `.` in `(.*?)` couldn't match
    // the newlines a formatter/pretty-printer commonly inserts between the tag and its text,
    // and the heading/section was silently dropped rather than falling back to anything.
    const content = `<h1>\n  Multi-line Title\n</h1>\n<p>body</p>`
    const { sections } = extractHtml(content, 'multiline.html')
    expect(sections.some((s) => s.heading === 'Multi-line Title')).toBe(true)
  })

  it('headings are included in symbols via parseFile', async () => {
    // Regression: extractHtml computed headings into .sections, but extractSymbolsNoTreeSitter
    // only consumed .symbols, so headings never entered the index and were unreachable via
    // symbol/skeleton/outline or the live `section` command.
    const file = tmp('page.html', '<h2 id="setup">Setup Guide</h2>\n<p>content</p>\n<h3>Next Steps</h3>')
    const result = await parseFile(file)
    const heading = result.symbols.find((s) => s.name === 'Setup Guide')
    expect(heading?.kind).toBe('heading')
    expect(heading?.lineStart).toBe(1)
    const nextHeading = result.symbols.find((s) => s.name === 'Next Steps')
    expect(nextHeading?.kind).toBe('heading')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('does not match id=/class= inside a longer attribute name lacking a left boundary', () => {
    // Regression: ID_RE/CLASS_RE had no left boundary, so they matched inside longer attribute
    // names like data-id=, data-testid=, gid=, uuid=, valid=, data-class= etc, falsely feeding
    // html_id/html_class symbols. The same unboundaried pattern was inlined a third time in the
    // heading-anchor extraction, so a heading like `<h2 data-id="x">` registered a false anchor.
    const content = `<div data-id="phantom-id" data-testid="phantom-testid" gid="phantom-gid" data-class="phantom-class">real</div>
<div id="real-id" class="real-class">content</div>
<h2 data-id="not-an-anchor">Real Heading</h2>`
    const { symbols, sections } = extractHtml(content, 'boundary.html')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('phantom-id')
    expect(names).not.toContain('phantom-testid')
    expect(names).not.toContain('phantom-gid')
    expect(names).not.toContain('phantom-class')
    expect(names).toContain('real-id')
    expect(names).toContain('real-class')
    expect(sections.some((s) => s.heading === 'not-an-anchor')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Heading')).toBe(true)
  })

  it('dedupes and caps id/class symbols instead of emitting one row per occurrence unbounded', () => {
    // Regression: extractHtml pushed one symbol per id= occurrence and per class token with no
    // MAX_SYMBOLS cap and no dedup, unlike every other language adapter in this codebase.
    // Minified/framework-generated HTML can emit thousands of duplicate symbol rows.
    const lines: string[] = []
    for (let i = 0; i < 600; i++) {
      lines.push(`<div id="dup-widget" class="dup-token">item ${i}</div>`)
    }
    const content = lines.join('\n')
    const { symbols } = extractHtml(content, 'huge.html')
    // Each id/class occurrence is on its own line, so (name, line) dedup does not collapse them
    // - without a cap this would emit 1200 symbol rows (600 ids + 600 classes). The cap must
    // stop emission at exactly MAX_SYMBOLS.
    expect(symbols.length).toBe(500)
    // Duplicate id/class values within the SAME line must be deduped, not just capped.
    const sameLineContent = '<div id="only-once" class="only-once-cls only-once-cls">x</div>'
    const { symbols: sameLineSymbols } = extractHtml(sameLineContent, 'sameline.html')
    const onlyOnceCount = sameLineSymbols.filter((s) => s.name === 'only-once-cls').length
    expect(onlyOnceCount).toBe(1)
  })

  it('does not let a class token suppress an id of the same name on the same line (regression: html_id and html_class shared one dedup set keyed only on (name, line) with no kind component, so the id loop running first silently swallowed a class token equal to that id value as a false duplicate)', () => {
    const content = '<section id="pricing" class="pricing"></section>'
    const { symbols } = extractHtml(content, 'test.html')
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('html_id:pricing')
    expect(kinds).toContain('html_class:pricing')
  })

  it('does not truncate an attribute value containing the other quote character (regression: ID_RE/CLASS_RE/LINK_RE/SCRIPT_RE closed a quoted value on a bare ["\'] charclass with no backreference to the actual opener, and the body charclass [^"\']+ excluded BOTH quote characters unconditionally, so a literal apostrophe inside a double-quoted value -- e.g. id="user\'s-name" -- truncated the match at the apostrophe instead of the real closing quote)', () => {
    const content = `<div id="user's-name">hi</div><link href="a's-link.css"><script src='b"s.js'></script>`
    const { symbols, imports } = extractHtml(content, 'quotes.html')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === "user's-name")).toBe(true)
    expect(imports.some((i) => i.kind === 'html_link' && i.target === "a's-link.css")).toBe(true)
    expect(imports.some((i) => i.kind === 'html_script' && i.target === 'b"s.js')).toBe(true)
  })

  it('matches an attribute value that spans a literal newline (regression: ID_RE/CLASS_RE/LINK_RE/SCRIPT_RE used a bare `.` instead of `[\\s\\S]` in the quoted-value capture group, unlike liquid.ts\'s structurally identical INCLUDE_RE/SECTION_RE/RENDER_RE -- a `.` never matches a newline, so an id/class/href/src value wrapped across lines by an auto-formatter silently failed to match and the symbol/ref was dropped)', () => {
    const content = `<div id="pricing\ncard" class="foo\nbar"></div><link href="styles\nsheet.css"><script src="app\nbundle.js"></script>`
    const { symbols, imports } = extractHtml(content, 'multiline-attr.html')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'pricing\ncard')).toBe(true)
    // class="foo\nbar" -- whitespace (including the embedded newline) is the token separator, so this correctly yields two class symbols, not one symbol literally named "foo\nbar".
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'foo')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'bar')).toBe(true)
    expect(imports.some((i) => i.kind === 'html_link' && i.target === 'styles\nsheet.css')).toBe(true)
    expect(imports.some((i) => i.kind === 'html_script' && i.target === 'app\nbundle.js')).toBe(true)
  })

  it('registers a heading anchor-id section when the id value spans a literal newline (regression: the inline id-anchor regex in extractHtml used a bare `.` instead of `[\\s\\S]`, unlike the module-level ID_RE it sits right next to -- missed by the fix above since it is a separate inline .exec() call, not one of the four _RE constants)', () => {
    const content = `<h2 id="pricing\ncard">Pricing</h2>`
    const { sections } = extractHtml(content, 'multiline-anchor.html')
    expect(sections.some((s) => s.heading === 'pricing\ncard')).toBe(true)
  })

  it('does not index commented-out markup and preserves the real section line range', () => {
    // Regression: <!-- ... --> comments were never stripped before the heading/id/class/link/
    // script regexes ran, so dead/commented-out markup was indexed identically to live markup -
    // including corrupting the real subsequent section's start/end-line bookkeeping.
    const content = `<!--
<h1>Deprecated Title</h1>
<div id="dead-panel" class="dead-widget"></div>
<link href="legacy.css">
<script src="old-analytics.js"></script>
-->
<h1>Real Title</h1>
<p>content</p>`
    const { symbols, imports, sections } = extractHtml(content, 'commented.html')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('dead-panel')
    expect(names).not.toContain('dead-widget')
    expect(sections.some((s) => s.heading === 'Deprecated Title')).toBe(false)
    expect(imports.some((i) => i.target === 'legacy.css')).toBe(false)
    expect(imports.some((i) => i.target === 'old-analytics.js')).toBe(false)

    const realSection = sections.find((s) => s.heading === 'Real Title')
    expect(realSection).toBeDefined()
    expect(realSection?.line).toBe(7)
    expect(realSection?.endLine).toBe(8)
  })

  it('does not treat a heading-shaped string inside a <script> template literal as a real heading', () => {
    const content = `<script>
const tpl = \`<h1>Fake Title</h1>\`
</script>
<h1>Real Title</h1>`
    const { sections } = extractHtml(content, 'script-tpl.html')
    expect(sections.some((s) => s.heading === 'Fake Title')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })

  it('does not index id=/class= attributes written literally inside a <script> body', () => {
    const content = `<script>
const html = '<div id="phantom-script-id" class="phantom-script-class"></div>'
</script>
<div id="real-script-id" class="real-script-class">content</div>`
    const { symbols } = extractHtml(content, 'script-idclass.html')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('phantom-script-id')
    expect(names).not.toContain('phantom-script-class')
    expect(names).toContain('real-script-id')
    expect(names).toContain('real-script-class')
  })

  it('finds a real heading after a <script> body containing an unmatched literal <!-- marker', () => {
    // A literal `<!--` inside a <script> string with no closing `-->` in that same tag would,
    // if HTML_COMMENT_RE ran before script-body masking, greedily consume everything up to the
    // NEXT `-->` anywhere later in the document, silently eating real headings in between.
    const content = `<script>
const marker = '<!-- not a real comment opener'
</script>
<h1>Real Title</h1>`
    const { sections } = extractHtml(content, 'script-unmatched.html')
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })

  it('does not index a heading inside a CDATA section', () => {
    const content = `<![CDATA[<h1>Fake CDATA Title</h1>]]>
<h1>Real Title</h1>`
    const { sections } = extractHtml(content, 'cdata-heading.html')
    expect(sections.some((s) => s.heading === 'Fake CDATA Title')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })

  it('does not index id=/class= attributes written literally inside a CDATA section', () => {
    const content = `<![CDATA[<div id="phantom-cdata-id" class="phantom-cdata-class"></div>]]>
<div id="real-cdata-id" class="real-cdata-class">content</div>`
    const { symbols } = extractHtml(content, 'cdata-idclass.html')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('phantom-cdata-id')
    expect(names).not.toContain('phantom-cdata-class')
    expect(names).toContain('real-cdata-id')
    expect(names).toContain('real-cdata-class')
  })
})

// ---------------------------------------------------------------------------
// Liquid
// ---------------------------------------------------------------------------

describe('liquid adapter', () => {
  it('extracts include/render imports and schema symbol', () => {
    const content = `{% include 'header' %}
{% render 'product-card' %}
{% schema %}
{ "name": "Featured Section" }
{% endschema %}
<h1>Welcome</h1>`
    const { symbols, imports, sections } = extractLiquid(content, 'test.liquid', 'test.liquid')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Featured Section')
    expect(imports.some((i) => i.kind === 'liquid_include' && i.target === 'header')).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_render' && i.target === 'product-card')).toBe(true)
    expect(sections.some((s) => s.heading === 'Welcome')).toBe(true)
  })

  it('emits liquid_section_file symbol for files in sections/ directory', () => {
    const content = `<h1>Header</h1>`
    const { symbols } = extractLiquid(content, 'sections/header.liquid', 'sections/header.liquid')
    expect(symbols.some((s) => s.kind === 'liquid_section_file' && s.name === 'header')).toBe(true)
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports, sections } = extractLiquid('', 'empty.liquid')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
    expect(sections).toHaveLength(0)
  })

  it('detects whitespace-control tags ({%- ... -%})', () => {
    // Regression: INCLUDE_RE/SECTION_RE/RENDER_RE/SCHEMA_RE all required a plain `{%`
    // opener, so Shopify's dominant whitespace-control form `{%- render 'x' -%}` never
    // matched and was silently dropped.
    const content = `{%- render 'wsc-render' -%}
{%- include 'wsc-include' -%}
{%- section 'wsc-section' -%}
{%- schema -%}
{ "name": "WSC Schema" }
{%- endschema -%}
{% render 'plain-render' %}`
    const { symbols, imports } = extractLiquid(content, 'wsc.liquid', 'wsc.liquid')
    expect(imports.some((i) => i.kind === 'liquid_render' && i.target === 'wsc-render')).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_include' && i.target === 'wsc-include')).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_section' && i.target === 'wsc-section')).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_render' && i.target === 'plain-render')).toBe(true)
    expect(symbols.some((s) => s.kind === 'liquid_schema' && s.name === 'WSC Schema')).toBe(true)
  })

  it('does not truncate a quoted target containing the other quote character (regression: INCLUDE_RE/SECTION_RE/RENDER_RE closed on a bare [\'"] charclass with no backreference to the actual opener, and the body charclass [^\'"]+ excluded BOTH quote characters unconditionally, so a literal apostrophe inside a double-quoted target -- e.g. "translator\'s-notes" -- truncated the match at the apostrophe instead of the real closing quote)', () => {
    const content = `{% include "translator's-notes" %}
{% section 'product-card' %}
{% render "product-card", product: product %}
`
    const { imports } = extractLiquid(content, 'quotes.liquid', 'quotes.liquid')
    expect(imports.some((i) => i.kind === 'liquid_include' && i.target === "translator's-notes")).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_section' && i.target === 'product-card')).toBe(true)
    expect(imports.some((i) => i.kind === 'liquid_render' && i.target === 'product-card')).toBe(true)
  })

  it('detects .liquid language via parseFile', async () => {
    const file = tmp('test.liquid', '{% include "foo" %}')
    const result = await parseFile(file)
    expect(result.language).toBe('liquid')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('extracts a heading whose text spans multiple lines', () => {
    // Regression: HEADING_RE lacked the `s` (dotall) flag, so `.` in `(.*?)` couldn't match
    // the newlines a formatter/pretty-printer commonly inserts between the tag and its text,
    // and the heading/section was silently dropped rather than falling back to anything.
    const content = `<h1>\n  Multi-line Title\n</h1>`
    const { sections } = extractLiquid(content, 'multiline.liquid', 'multiline.liquid')
    expect(sections.some((s) => s.heading === 'Multi-line Title')).toBe(true)
  })

  it('headings are included in symbols via parseFile', async () => {
    // Regression: extractLiquid computed headings into .sections, but extractSymbolsNoTreeSitter
    // only consumed .symbols, so headings never entered the index.
    const file = tmp('test.liquid', '<h2>Setup Guide</h2>\n<p>content</p>')
    const result = await parseFile(file)
    const heading = result.symbols.find((s) => s.name === 'Setup Guide')
    expect(heading?.kind).toBe('heading')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('does not index a heading commented out with <!-- -->', () => {
    const content = `<!-- <h1>Old Title</h1> -->
<h1>Real Title</h1>`
    const { sections } = extractLiquid(content, 'html-comment.liquid', 'html-comment.liquid')
    expect(sections.some((s) => s.heading === 'Old Title')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })

  it('does not index a heading inside a {% comment %} block', () => {
    const content = `{% comment %}
<h1>Old Title</h1>
{% endcomment %}
<h1>Real Title</h1>`
    const { sections } = extractLiquid(content, 'liquid-comment.liquid', 'liquid-comment.liquid')
    expect(sections.some((s) => s.heading === 'Old Title')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })

  it('does not index a heading inside a CDATA section', () => {
    const content = `<![CDATA[<h1>Fake CDATA Title</h1>]]>
<h1>Real Title</h1>`
    const { sections } = extractLiquid(content, 'cdata.liquid', 'cdata.liquid')
    expect(sections.some((s) => s.heading === 'Fake CDATA Title')).toBe(false)
    expect(sections.some((s) => s.heading === 'Real Title')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

describe('kotlin adapter', () => {
  it('extracts class, method, top-level function, and import', () => {
    const content = `import kotlin.collections.List

class UserService {
  fun getUser(id: Int): String {
    return ""
  }
}

fun topLevel() {}
`
    const { symbols, imports } = extractKotlin(content, 'UserService.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('UserService')
    expect(names).toContain('getUser')
    expect(names).toContain('topLevel')
    expect(imports.some((i) => i.target.includes('List'))).toBe(true)
  })

  it('extracts a class, method, and top-level function that carry a same-line annotation (regression: FUN_RE/CLASS_HEADER_RE/TOP_FUN_RE are all ^-anchored against the modifier alternation or declaration keyword directly, with no room for a leading @Annotation token, so @Composable fun Foo() / @Test fun bar() / @Serializable data class Foo(...) - all extremely common real-world Kotlin - silently dropped the whole declaration and, for a class, every member inside it)', () => {
    const content = `@Serializable data class Foo(val x: Int)

class Bar {
    @Test fun testFoo() {
        println("hi")
    }
}

@Composable fun MyComposable() {
    println("hi")
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('testFoo')
    expect(names).toContain('MyComposable')
    expect(symbols.find((s) => s.name === 'testFoo')?.docstring).toBe('Bar')
  })

  it('indexes top-level SCREAMING_SNAKE const/val declarations', () => {

    const content = `const val MAX_SIZE = 100
val GREETING = "hi"
private const val SECRET = "x"
val lowercase = 5

class Config {
  const val INNER = 1
}
`
    const { symbols } = extractKotlin(content, 'Config.kt')
    const consts = symbols.filter((s) => s.kind === 'const').map((s) => s.name)
    // Top-level SCREAMING_SNAKE const/val are now indexed.
    expect(consts).toContain('MAX_SIZE')
    expect(consts).toContain('GREETING')
    expect(consts).toContain('SECRET')
    // In-class const still indexed; non-SCREAMING_SNAKE val still excluded.
    expect(consts).toContain('INNER')
    expect(consts).not.toContain('lowercase')
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractKotlin('', 'empty.kt')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('does not let a nested quote inside an interpolation hole desync scope depth', () => {
    // Regression: stripStringLiterals did not track interpolation-hole brace depth, so the
    // nested `"` in `replace("}", "")` was read as closing the outer `"..."` string early,
    // exposing the hole's own `"}"` as bare unstripped code and leaking an unmatched `}` into
    // braceDepth - popping Formatter's scope one method early and mis-parenting after/after2.
    const content = `class Formatter {
    fun clean() {
        val x = "\${raw.replace("}", "")}"
    }
    fun after() {
    }
    fun after2() {
    }
}
`
    const { symbols } = extractKotlin(content, 'Formatter.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['Formatter', 'clean', 'after', 'after2'])
    expect(symbols.find((s) => s.name === 'after')?.docstring).toBe('Formatter')
    expect(symbols.find((s) => s.name === 'after2')?.docstring).toBe('Formatter')
  })

  it('indexes members of a modifier-prefixed companion object instead of dropping them', () => {
    // Regression: CLASS_HEADER_RE's modifier list never included `companion`, so
    // `companion object { ... }` (with or without a leading visibility modifier) never got a
    // frame pushed for it at all -- yet its brace still incremented braceDepth, silently dropping
    // every member declared inside from the index.
    const content = `class Foo {
  private companion object {
    fun x() {}
  }
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    const x = symbols.find((s) => s.name === 'x')
    expect(x).toBeDefined()
    expect(x?.kind).toBe('method')
    expect(x?.docstring).toBe('Companion')
  })

  it('indexes members of an unmodified and a named companion object', () => {
    const content = `class Foo {
  companion object {
    fun y() {}
  }
}
class Bar {
  companion object Named {
    fun z() {}
  }
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    const y = symbols.find((s) => s.name === 'y')
    expect(y?.docstring).toBe('Companion')
    const z = symbols.find((s) => s.name === 'z')
    expect(z?.docstring).toBe('Named')
  })

  it('does not index a function-local class as a member of the enclosing class', () => {
    // Regression: the class/companion detection branch had no depthInClass gate, unlike the
    // method/const branch just below it -- so a class declared inside a method body (a
    // function-local class, legal Kotlin) got emitted as a real nested class member of the
    // enclosing class instead of being skipped as function-local.
    const content = `class Outer {
    fun makeThing(): Foo {
        class LocalHelper {
            fun help() {}
        }
        return LocalHelper()
    }
}
`
    const { symbols } = extractKotlin(content, 'Outer.kt')
    const localHelper = symbols.find((s) => s.name === 'LocalHelper')
    expect(localHelper).toBeUndefined()
    const help = symbols.find((s) => s.name === 'help')
    expect(help).toBeUndefined()
    const makeThing = symbols.find((s) => s.name === 'makeThing')
    expect(makeThing?.kind).toBe('method')
    expect(makeThing?.docstring).toBe('Outer')
  })

  it('does not index a function-local companion object as a member of the enclosing class', () => {
    const content = `class Outer {
    fun makeThing() {
        companion object {
            fun help() {}
        }
    }
}
`
    const { symbols } = extractKotlin(content, 'Outer.kt')
    expect(symbols.find((s) => s.name === 'Companion')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'help')).toBeUndefined()
  })

  it('detects .kt language via parseFile', async () => {
    const file = tmp('Foo.kt', 'fun main() {}')
    const result = await parseFile(file)
    expect(result.language).toBe('kotlin')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('captures methods from a class whose primary-constructor header spans multiple lines', () => {
    const content = `class Foo(
  val x: Int,
  val y: Int
) {
  fun bar(): Int {
    return x
  }
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    // Regression: currentClass must not clear until the real body-opening brace is seen -
    // otherwise a ktlint-formatted multi-line constructor header drops every member of the class.
    const bar = symbols.find((s) => s.name === 'bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('ignores an unmatched brace inside a /* */ block comment when tracking scope depth', () => {
    const content = `class Foo {
  fun first(): Int {
    return 1
  }
  /*
  }
  */
  fun second(): Int {
    return 2
  }
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    // Regression: a stray `}` inside a block comment must not be counted toward braceDepth -
    // otherwise the class closes early and every member declared after the comment is dropped.
    const second = symbols.find((s) => s.name === 'second')
    expect(second?.kind).toBe('method')
    expect(second?.docstring).toBe('Foo')
  })

  it('ignores braces inside a full-line // comment when tracking scope depth', () => {
    const content = `class Foo {
  fun first(): Int {
    return 1
  }
  // TODO: handle { edge case
  fun second(): Int {
    return 2
  }
}

fun afterFoo(): Int {
  return 3
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    // Regression: a `{` inside a // comment must not be counted toward braceDepth - otherwise
    // the class never closes and every top-level declaration after it is misattributed as a member.
    const afterFoo = symbols.find((s) => s.name === 'afterFoo')
    expect(afterFoo?.kind).toBe('function')
    expect(afterFoo?.docstring).toBe('')
  })

  it('does not let an unbalanced brace inside a string literal desync scope depth', () => {
    const content = `class Foo {
  val bracket = "{"
  fun bar(): Int {
    return 1
  }
}

fun afterFoo(): Int {
  return 3
}
`
    const { symbols } = extractKotlin(content, 'Foo.kt')
    // Regression: the string literal "{" contains a literal brace character. If it is counted
    // toward braceDepth, Foo's real closing brace never brings braceDepth back down to its
    // start depth, so currentClass is never cleared and afterFoo is silently mis-parented as
    // one of Foo's own methods instead of being a top-level function.
    const bar = symbols.find((s) => s.name === 'bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
    const afterFoo = symbols.find((s) => s.name === 'afterFoo')
    expect(afterFoo?.kind).toBe('function')
    expect(afterFoo?.docstring).toBe('')
  })

  it('captures a nested class inside another class, parented correctly, along with its own member', () => {
    const content = `class Outer {
  class Inner {
    fun innerMethod(): Int {
      return 1
    }
  }
  fun outerMethod(): Int {
    return 2
  }
}
`
    const { symbols } = extractKotlin(content, 'Outer.kt')
    // Regression: a nested class header was previously gated to column 0 only, so an indented
    // nested/inner class (companion object member, sealed subclass, nested data class - all
    // idiomatic Kotlin) was never emitted as a symbol, and none of its members were attributed
    // to it either.
    const inner = symbols.find((s) => s.name === 'Inner')
    expect(inner?.kind).toBe('class')
    expect(inner?.docstring).toBe('Outer')
    const innerMethod = symbols.find((s) => s.name === 'innerMethod')
    expect(innerMethod?.kind).toBe('method')
    expect(innerMethod?.docstring).toBe('Inner')
    const outerMethod = symbols.find((s) => s.name === 'outerMethod')
    expect(outerMethod?.kind).toBe('method')
    expect(outerMethod?.docstring).toBe('Outer')
  })

  it('does not drop top-level declarations after a class whose body opens and closes on the same line', () => {
    const content = `class Empty {}

fun afterEmpty(): Int {
  return 1
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    // Regression: an empty class body (`class Empty {}`) has a net brace delta of zero for its
    // line, so bodyEntered never flipped true and the class frame was never popped - every
    // declaration after it, including afterEmpty, was silently dropped instead of being
    // recognized as a top-level function.
    const empty = symbols.find((s) => s.name === 'Empty')
    expect(empty?.kind).toBe('class')
    const afterEmpty = symbols.find((s) => s.name === 'afterEmpty')
    expect(afterEmpty?.kind).toBe('function')
    expect(afterEmpty?.docstring).toBe('')
  })

  it('does not drop declarations after a body-less data class (no trailing brace at all)', () => {
    const content = `data class Point(val x: Int, val y: Int)

fun foo(): Int {
  return 1
}

fun bar(): Int {
  return 2
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    // Regression: a class/data class declared with only a primary constructor and no body block
    // at all (idiomatic Kotlin, e.g. DTOs) never opens a `{`, so bodyEntered never flipped true
    // and the phantom class frame lingered forever - every declaration after it, including foo
    // and bar, was silently dropped instead of being recognized as top-level functions.
    const point = symbols.find((s) => s.name === 'Point')
    expect(point?.kind).toBe('class')
    const foo = symbols.find((s) => s.name === 'foo')
    expect(foo?.kind).toBe('function')
    expect(foo?.docstring).toBe('')
    const bar = symbols.find((s) => s.name === 'bar')
    expect(bar?.kind).toBe('function')
    expect(bar?.docstring).toBe('')
  })

  it('does not drop declarations after several consecutive body-less data classes', () => {
    const content = `data class A(val x: Int)
data class B(val y: Int)
data class C(val z: Int)

fun afterAll(): Int {
  return 1
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    expect(symbols.find((s) => s.name === 'A')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'B')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'C')?.kind).toBe('class')
    const afterAll = symbols.find((s) => s.name === 'afterAll')
    expect(afterAll?.kind).toBe('function')
    expect(afterAll?.docstring).toBe('')
  })

  it('still recognizes a multi-line constructor header whose body opens on the closing-paren line', () => {
    const content = `class Foo(
  val x: Int
) {
  fun method(): Int {
    return 1
  }
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    // Guards against a naive fix that pops on any paren-balanced, brace-less line - a genuinely
    // multi-line constructor header must stay on the stack until its body actually opens.
    const method = symbols.find((s) => s.name === 'method')
    expect(method?.kind).toBe('method')
    expect(method?.docstring).toBe('Foo')
  })

  it('does not index local functions/vals inside method bodies as class members', () => {
    const content = `class Service {
  fun handle() {
    fun inner() = 42
    val LOCAL_THING = 5
    inner()
  }
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    // Regression: depthInClass was gated with >= 1 instead of === 1, so a bare statement or
    // local declaration nested inside a method body (depthInClass 2+) was ALSO matched as if
    // it were a direct member of the enclosing class.
    const handle = symbols.find((s) => s.name === 'handle')
    expect(handle?.kind).toBe('method')
    expect(handle?.docstring).toBe('Service')
    expect(symbols.find((s) => s.name === 'inner')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'LOCAL_THING')).toBeUndefined()
  })

  it('does not drop members of a class whose supertype colon starts the next line', () => {
    // Regression: the immediate-pop check popped the class frame as soon as its constructor
    // parens balanced back to 0 with no body brace on that same line - but a header can
    // legitimately continue onto the next line via a leading `:` (Allman/next-line-brace style),
    // which this same-line-only check could never see coming.
    const content = `class Foo(val x: Int)
    : Bar(x) {
    fun doWork() {}
    val CONST_A = 1
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('doWork')
    expect(names).toContain('CONST_A')
    expect(symbols.find((s) => s.name === 'doWork')?.docstring).toBe('Foo')
    expect(symbols.find((s) => s.name === 'CONST_A')?.docstring).toBe('Foo')
  })

  it('does not drop members of a class with a wrapped, comma-separated supertype list', () => {
    // Regression: same root cause as the leading-colon case above, but here the continuation
    // signal is a trailing `,`/`:` on each wrapped line rather than a leading one - the official
    // Kotlin coding-convention example for this exact style.
    const content = `class MyFavouriteVeryLongClassHolder :
    MyLongHolder<MyFavouriteVeryLongClass>(),
    SomeOtherInterface,
    AndAnotherOne {
    fun doWork() {}
    val CONST_X = 42
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('MyFavouriteVeryLongClassHolder')
    expect(names).toContain('doWork')
    expect(names).toContain('CONST_X')
    expect(symbols.find((s) => s.name === 'doWork')?.docstring).toBe('MyFavouriteVeryLongClassHolder')
  })

  it('still pops a genuinely body-less class header before the next top-level declaration (guard)', () => {
    const content = `data class Point(val x: Int, val y: Int)
fun main() {}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const main = symbols.find((s) => s.name === 'main')
    expect(main?.kind).toBe('function')
    expect(main?.docstring).toBe('')
  })

  it('does not drop members of a class whose Allman-style body brace is on its own line', () => {
    // Regression: the pendingPop resolution only whitelisted a leading `:`/`,` continuation
    // (the wrapped-supertype-list case) and ran before this line's own brace-counting, so a
    // standalone `{` on its own line was treated as "not a continuation" and popped the frame
    // before the brace-counting below ever got a chance to flip bodyEntered.
    const content = `class Foo
{
    fun bar() {}
    fun baz() {}
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('bar')
    expect(names).toContain('baz')
    expect(symbols.find((s) => s.name === 'bar')?.docstring).toBe('Foo')
    expect(symbols.find((s) => s.name === 'baz')?.docstring).toBe('Foo')
  })

  it('does not drop members of a class with a multi-line where type-constraint clause', () => {
    const content = `class Container<T>
    where T : Comparable<T> {
    fun add(item: T) {}
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Container')
    expect(names).toContain('add')
    expect(symbols.find((s) => s.name === 'add')?.docstring).toBe('Container')
  })

  it('indexes a fun interface (SAM/functional interface) and its members (regression: CLASS_HEADER_RE\'s modifier alternation did not include "fun", so a fun interface header never matched at all -- no frame was pushed for it, and every member declared inside was silently dropped rather than misattributed)', () => {
    const content = `fun interface Calculator {
    fun apply(x: Int): Int
}

class Ordinary {
    fun ok(): Int = 1
}
`
    const { symbols } = extractKotlin(content, 'Repro.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Calculator')
    expect(names).toContain('apply')
    expect(symbols.find((s) => s.name === 'apply')?.docstring).toBe('Calculator')
  })

  it('indexes a tailrec function at top level and as a class member (regression: FUN_RE/TOP_FUN_RE\'s modifier alternations did not include the real, still-valid Kotlin function modifier "tailrec", so a tailrec fun header never matched at all and the whole function was silently dropped from the index)', () => {
    const content = `tailrec fun factorial(n: Int, acc: Int = 1): Int {
    return if (n <= 1) acc else factorial(n - 1, n * acc)
}

class Calc {
    private tailrec fun gcd(a: Int, b: Int): Int {
        return if (b == 0) a else gcd(b, a % b)
    }
}
`
    const { symbols } = extractKotlin(content, 'Tailrec.kt')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('factorial')
    expect(names).toContain('gcd')
    expect(symbols.find((s) => s.name === 'gcd')?.docstring).toBe('Calc')
  })
})

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

describe('graphql adapter', () => {
  it('extracts type, query, mutation, enum, and fragment', () => {
    const content = `
type User {
  id: ID!
  name: String
}

enum Role { ADMIN USER }

query GetUser($id: ID!) {
  user(id: $id) { id name }
}

mutation CreateUser($name: String!) {
  createUser(name: $name) { id }
}

fragment UserFields on User {
  id name
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('User')
    expect(names).toContain('Role')
    expect(names).toContain('GetUser')
    expect(names).toContain('CreateUser')
    expect(names).toContain('UserFields')
    expect(symbols.find((s) => s.name === 'User')?.kind).toBe('graphql_type')
    expect(symbols.find((s) => s.name === 'Role')?.kind).toBe('graphql_enum')
  })

  it('extracts a schema block annotated with a directive (regression: SCHEMA_RE required schema to be immediately followed by {, so a legal `schema @auth { ... }` directive list silently dropped the whole schema block from the index)', () => {
    const content = `schema @auth {
  query: Query
}

type Query {
  hello: String
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    expect(symbols.find((s) => s.name === 'schema')?.kind).toBe('graphql_schema')
    expect(symbols.find((s) => s.name === 'Query')?.kind).toBe('graphql_type')
  })

  it('does not misread schemaVersion as a phantom schema block (regression guard for the directive-list fix above)', () => {
    const content = `input Config {
  schemaVersion: Int
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    expect(symbols.find((s) => s.kind === 'graphql_schema')).toBeUndefined()
  })

  it('does not misread an enum value that collides with a type-system keyword as a phantom top-level symbol (regression: \\s+ separator crossed a newline)', () => {
    const content = `
enum NodeType {
  scalar
  active
}

type RealType {
  id: ID
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('NodeType')
    expect(names).toContain('RealType')
    expect(names).not.toContain('active')
    expect(symbols.find((s) => s.name === 'NodeType')?.kind).toBe('graphql_enum')
  })

  it('extracts #import pragmas as imports', () => {
    const content = `# import UserFields from "user.graphql"
type Query { users: [User] }
`
    const { imports } = extractGraphql(content, 'query.graphql')
    expect(imports.some((i) => i.target === 'user.graphql')).toBe(true)
  })

  // Regression: the import extraction pass used to scan the raw, unmasked content, while every
  // other pass (types, directives, fragments, operations, schema) ran against content with
  // """..."""` block descriptions already blanked. A description whose prose merely mentions or
  // gives an example of the #import pragma syntax got matched as a real import, writing a
  // phantom, non-existent dependency edge into the index.
  it('does not extract a phantom import from #import-pragma-shaped prose inside a """..."""` block description', () => {
    const content = `"""
desc mentions:
# import Fake from "fake.graphql"
"""
type User {
  id: ID!
}
`
    const { imports } = extractGraphql(content, 'schema.graphql')
    expect(imports.some((i) => i.target === 'fake.graphql')).toBe(false)
  })

  it('stripHashComments preserves a `#` inside a quoted string (used before parsing GraphQL SDL)', () => {
    // A description string containing a literal `#` must not have its content past the `#`
    // treated as a comment and truncated - `type Foo {` on the same line must survive intact.
    const content = '"A weird desc # not a comment" type Foo {\n  id: ID!\n}\n'
    const stripped = stripHashComments(content)
    expect(stripped).toContain('type Foo {')
  })

  it('blank-fills real `#` comments instead of deleting them, preserving line length', () => {
    const content = 'type Foo { id: ID! } # a real comment\n'
    const stripped = stripHashComments(content)
    expect(stripped.length).toBe(content.length)
    expect(stripped).toMatch(/^type Foo \{ id: ID! \} +\n$/)
  })

  it('does not register a phantom symbol from a declaration-like line inside a """..."""` block description', () => {
    const content = `"""
type Foo represents a user
"""
type Foo {
  id: ID
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const fooSymbols = symbols.filter((s) => s.name === 'Foo')
    expect(fooSymbols).toHaveLength(1)
    expect(fooSymbols[0]?.kind).toBe('graphql_type')
    expect(fooSymbols[0]?.lineStart).toBe(4)
  })

  it('does not drop every symbol after a literal `#` inside an open """..."""` block description', () => {
    // Regression: extractGraphql used to strip `#` comments BEFORE masking """..."""` block
    // descriptions. stripHashComments's own quote-awareness only tracks quote parity within a
    // single line, so a `#` inside a still-open description (whose opening """` is on an
    // earlier line) looked "not inside a string" and got treated as a real comment - including
    // when it appeared right before the description's own closing """` on the same line, which
    // deleted that closer too. With the closer gone, the description-masking pass never found a
    // matching end for the rest of the file, silently dropping every symbol after it.
    const content = `"""
Some text with a # comment marker here """
type Foo {
  id: ID!
}

type Bar {
  id: ID!
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
  })

  it('does not treat a `"""`-looking sequence inside a real `#` comment as a description opener', () => {
    // Regression guard for the fix above: masking descriptions before stripping `#` comments
    // must not itself misread a `"""`-looking sequence that merely appears inside an ordinary
    // `#` comment (e.g. documentation prose referencing the syntax) as a real opener - that
    // would wrongly swallow every declaration after it as "still inside a description".
    const content = `# see """ for details on descriptions
type Foo {
  id: ID!
}

type Bar {
  id: ID!
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
  })

  it('blanks a single-line "..." description containing declaration-like text before matching (defense-in-depth alongside the block-string fix)', () => {
    // A single-line description's own line always starts with the opening quote, so the
    // line-anchored declaration regexes below can't match its content directly today - this
    // asserts the description is still blanked (not just "happens not to match yet") so the
    // behavior doesn't silently depend on that anchoring detail.
    const content = `"query GetFoo on a Foo returns nothing real"
type Foo {
  id: ID
}
`
    const { symbols } = extractGraphql(content, 'schema.graphql')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('GetFoo')
    expect(names).toContain('Foo')
    expect(symbols.find((s) => s.name === 'Foo')?.lineStart).toBe(2)
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractGraphql('', 'empty.graphql')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('reports correct line numbers for many scattered type declarations', () => {
    // Regression guard for a quadratic slice+split line-number bug: with many matches spread
    // across a large file, each declaration's reported lineStart must match its real 1-based
    // line, not drift or degrade under a stale/incremental offset calculation.
    const blockCount = 60
    const lines: string[] = []
    const expectedLines = new Map<string, number>()
    for (let i = 0; i < blockCount; i++) {
      lines.push('', `type Type${i} {`, `  field${i}: String`, `}`)
      // "type Type{i} {" lands 2 lines after the blank separator we just pushed.
      expectedLines.set(`Type${i}`, lines.length - 2)
    }
    const content = lines.join('\n')
    const { symbols } = extractGraphql(content, 'many.graphql')
    for (const [name, expectedLine] of expectedLines) {
      const sym = symbols.find((s) => s.name === name)
      expect(sym?.lineStart).toBe(expectedLine)
    }
  })

  it('detects .graphql language via parseFile', async () => {
    const file = tmp('schema.graphql', 'type Query { hello: String }')
    const result = await parseFile(file)
    expect(result.language).toBe('graphql')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

describe('sql adapter', () => {
  it('extracts CREATE TABLE, VIEW, FUNCTION, INDEX', () => {
    const content = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255)
);

CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;

CREATE OR REPLACE FUNCTION get_user(p_id INT) RETURNS users AS $$ BEGIN END; $$ LANGUAGE plpgsql;

CREATE UNIQUE INDEX idx_users_name ON users(name);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('users')
    expect(names).toContain('active_users')
    expect(names).toContain('get_user')
    expect(names).toContain('idx_users_name')
    expect(symbols.find((s) => s.name === 'users')?.kind).toBe('sql_table')
    expect(symbols.find((s) => s.name === 'active_users')?.kind).toBe('sql_view')
  })

  it('does not let a same-line, same-name symbol of a different kind suppress an earlier one (regression: the shared makeSymbolEmitter deduped by (name, line) with no kind component, so a table and a function sharing a name on one line had the second silently dropped as a false duplicate)', () => {
    const content = 'CREATE TABLE foo (id int); CREATE FUNCTION foo() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;'
    const symbols = extractSql(content, 'schema.sql')
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('sql_table:foo')
    expect(kinds).toContain('sql_function:foo')
  })

  it('does not truncate a multi-line CREATE statement to lineEnd 1 when a quoted identifier contains a literal semicolon (regression: the single-line-terminator pin scanned noStrings with a bare indexOf(\';\', ...), and stripSqlStringLiterals deliberately leaves "..."/`...`/[...] delimited-identifier contents unblanked for NAME_PAT to read, so a `;` embedded in a quoted name -- e.g. CREATE TABLE "a;b" -- was mistaken for the real statement terminator and wrongly pinned the whole multi-line definition to just its first line)', () => {
    const content = `CREATE TABLE "a;b" (
  id INT,
  name TEXT
);
`
    const symbols = extractSql(content, 'schema.sql')
    const sym = symbols.find((s) => s.name === 'a;b')
    expect(sym).toBeDefined()
    expect(sym?.lineEnd).toBeGreaterThan(1)
  })

  it('does not let a /*/ opener close its own comment against its trailing asterisk (comment overlap off-by-one)', () => {
    const content = `/*/ CREATE TABLE ghost (id int); */ CREATE TABLE real_table (id int);`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('ghost')
    expect(names).toContain('real_table')
  })

  it('extracts CREATE INDEX with CONCURRENTLY keyword', () => {
    const content = `
CREATE INDEX CONCURRENTLY idx_name ON users (id);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('idx_name')
    expect(names).not.toContain('CONCURRENTLY')
    expect(symbols.find((s) => s.name === 'idx_name')?.kind).toBe('sql_index')
  })

  it('extracts CREATE MATERIALIZED VIEW', () => {
    const content = `
CREATE MATERIALIZED VIEW mat_view AS SELECT * FROM users;
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('mat_view')
    expect(symbols.find((s) => s.name === 'mat_view')?.kind).toBe('sql_view')
  })

  it('does not register a DDL keyword appearing inside a string literal (dynamic SQL) as a phantom object', () => {
    const content = `
EXECUTE 'CREATE TABLE audit_log (id int)';

CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('audit_log')
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('does not let an escaped quote (\'\') inside a dynamic-SQL string literal prematurely end the blanked span', () => {
    const content = `
EXECUTE 'CREATE TABLE it''s_a_ghost (id int)';

CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('a_ghost')
    expect(names).not.toContain('it')
    expect(names).toContain('real_table')
  })

  it('registers a symbol for a double-quoted (delimited) identifier name, e.g. a reserved-word table name (regression: string-literal blanking must not also destroy identifier-quoting content)', () => {
    const content = `
CREATE TABLE "user" (id int);
CREATE TABLE "order" (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('user')
    expect(names).toContain('order')
  })

  it('does not drop symbols after a double-quoted identifier containing an apostrophe', () => {
    // Regression: standard SQL permits any character, including `'`, inside a delimited
    // identifier (e.g. a possessive/label-style column name). The scanner used to leave
    // double-quoted spans' contents unconsumed as opaque, so a `'` inside one opened a phantom
    // single-quoted string on the next iteration that never found a real closing `'`, blanking
    // every DDL statement after it through EOF.
    const content = `
CREATE TABLE t ("user's_data" TEXT);
CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('t')
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('does not let `--` or `/*` inside a double-quoted identifier be misread as a comment opener', () => {
    const content = `
CREATE TABLE t ("my--tbl" TEXT, "a/*b" INT);
CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('t')
    expect(names).toContain('real_table')
  })

  it('honors `""` as the doubled-quote escape for a literal `"` inside a delimited identifier', () => {
    const content = `
CREATE TABLE "weird""name" (id int);
CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('real_table')
  })

  it('does not drop symbols after a backtick-delimited (MySQL) identifier containing an apostrophe', () => {
    // Same phantom-string failure mode as the double-quoted case above, for the sibling
    // backtick-quoting form the adapter's own NAME_PAT also matches.
    const content = `
CREATE TABLE \`user's_data\` (id int);
CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('does not create a phantom table from a CREATE TABLE sitting inside a `#` (MySQL/MariaDB) line comment', () => {
    // Regression: stripSqlStringLiterals only recognized `--` and `/* */` comment forms, so a
    // `#`-commented CREATE TABLE (MySQL's third comment syntax) survived masking and matched the
    // live DDL patterns below, producing a phantom symbol - whether the comment leads a line or
    // trails real, uncommented DDL on the same line.
    const content = `
# CREATE TABLE fake_from_hash (id int);
CREATE TABLE real_table (id int);
CREATE TABLE t2 (id int); # CREATE TABLE also_fake (x int)
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('real_table')
    expect(names).toContain('t2')
    expect(names).not.toContain('fake_from_hash')
    expect(names).not.toContain('also_fake')
  })

  it('does not treat a PostgreSQL "#>" jsonb path-extraction operator as a MySQL "#" comment opener (regression: the # comment branch was dialect-agnostic and blanked the rest of the line, dropping a same-line CREATE TABLE that followed a bare "#" used as a postgres operator)', () => {
    const content = "CREATE VIEW v1 AS SELECT data #> '{a,b}' AS x FROM t; CREATE TABLE t2 (id int);\nCREATE TABLE t3 (id int);\n"
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('v1')
    expect(names).toContain('t2')
    expect(names).toContain('t3')
  })

  it('does not drop symbols after a bracket-delimited (SQL Server) identifier containing an apostrophe', () => {
    const content = `
CREATE TABLE [user's_data] (id int);
CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('unquotes each segment of a schema-qualified quoted identifier separately (regression: unquote() only stripped the outermost quote pair off the whole schema-qualified token, so "public"."users" was corrupted into the literal public"."users instead of public.users)', () => {
    const content = `
CREATE TABLE "public"."users" (id int);
CREATE TABLE public.orders (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('public.users')
    expect(names).toContain('public.orders')
    expect(names).not.toContain('public"."users')
  })

  it('does not drop symbols after a multi-line string literal containing a literal `--`', () => {
    // Regression: a `--` inside a multi-line string literal used to be blanked out by a
    // line-scoped comment pre-pass that ran before string-literal stripping and had no
    // awareness the line started mid-string, taking the closing quote with it and flipping
    // string-parity tracking for the rest of the file.
    const content = `
EXECUTE 'CREATE TABLE ghost (id int)
-- text');

CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('ghost')
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('does not drop symbols after a multi-line string containing a `/*`-looking sequence', () => {
    // Regression: block-comment stripping used to run as a separate pre-pass
    // (`stripCstyleComments`) before string-literal stripping, and had no awareness that a line
    // could start mid-way through an already-open multi-line string literal from a prior line.
    // A `/*` that merely appears inside such a string (e.g. stored as part of a default text
    // value) was misread as a real comment opener; since no real `*/` ever follows it, the
    // "comment" never closes and every real statement after it - to EOF - was silently dropped.
    const content = `CREATE TABLE t (
  note TEXT DEFAULT 'line one
/* looks like a comment
still string' -- trailing
);

CREATE TABLE real_table (id int);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('t')
    expect(names).toContain('real_table')
    expect(symbols.find((s) => s.name === 'real_table')?.kind).toBe('sql_table')
  })

  it('reports correct line numbers for many scattered CREATE TABLE statements', () => {
    // Regression guard for a quadratic slice+split line-number bug in the sql adapter.
    const tableCount = 60
    const lines: string[] = []
    const expectedLines = new Map<string, number>()
    for (let i = 0; i < tableCount; i++) {
      lines.push('', `CREATE TABLE table${i} (id int);`)
      expectedLines.set(`table${i}`, lines.length)
    }
    const content = lines.join('\n')
    const symbols = extractSql(content, 'many.sql')
    for (const [name, expectedLine] of expectedLines) {
      const sym = symbols.find((s) => s.name === name)
      expect(sym?.lineStart).toBe(expectedLine)
    }
  })

  it('returns empty array for empty input', () => {
    expect(extractSql('', 'empty.sql')).toHaveLength(0)
  })

  it('detects .sql language via parseFile', async () => {
    const file = tmp('schema.sql', 'CREATE TABLE foo (id INT);')
    const result = await parseFile(file)
    expect(result.language).toBe('sql')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// INI
// ---------------------------------------------------------------------------

describe('ini adapter', () => {
  it('extracts [section] headers as ini_section symbols', () => {
    const content = `[database]
host = localhost
port = 5432

[tool.black]
line-length = 100

[server]
debug = true
`
    const symbols = extractIni(content, 'config.ini')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('database')
    expect(names).toContain('tool.black')
    expect(names).toContain('server')
    expect(symbols[0]?.kind).toBe('ini_section')
  })

  it('extracts a quoted git-config-style subsection header', () => {
    // Regression: HEADER_RE's name charset didn't allow spaces or quotes, so a real,
    // common git-config-style header like [branch "master"] never matched and the whole
    // line was silently skipped rather than producing an ini_section symbol.
    const content = `[branch "master"]
remote = origin
merge = refs/heads/master
`
    const symbols = extractIni(content, '.git/config')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('branch "master"')
    expect(symbols.find((s) => s.name === 'branch "master"')?.kind).toBe('ini_section')
  })

  it('extracts CREATE INDEX with CONCURRENTLY keyword', () => {
    const content = `
CREATE INDEX CONCURRENTLY idx_name ON users (id);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('idx_name')
    expect(names).not.toContain('CONCURRENTLY')
    expect(symbols.find((s) => s.name === 'idx_name')?.kind).toBe('sql_index')
  })

  it('extracts CREATE MATERIALIZED VIEW', () => {
    const content = `
CREATE MATERIALIZED VIEW mat_view AS SELECT * FROM users;
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('mat_view')
    expect(symbols.find((s) => s.name === 'mat_view')?.kind).toBe('sql_view')
  })

  it('returns empty array for empty input', () => {
    expect(extractIni('', 'empty.ini')).toHaveLength(0)
  })

  it('detects .ini language via parseFile', async () => {
    const file = tmp('config.ini', '[section]\nkey=value\n')
    const result = await parseFile(file)
    expect(result.language).toBe('ini')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// .env (extractEnv)
// ---------------------------------------------------------------------------

describe('env adapter', () => {
  it('extracts KEY=value assignments as env_key symbols', () => {
    const content = `# Database config
DATABASE_URL=postgres://localhost/mydb
SECRET_KEY=supersecret
DEBUG=false
PORT=3000
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('DATABASE_URL')
    expect(names).toContain('SECRET_KEY')
    expect(names).toContain('DEBUG')
    expect(names).toContain('PORT')
    expect(symbols[0]?.kind).toBe('env_key')
  })

  it('captures keys written with a leading export prefix', () => {
    const content = `export API_KEY=abc123
PLAIN=1
export DB_URL=postgres://localhost/db
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    // The export-prefixed keys are captured as the variable name, not "export".
    expect(names).toContain('API_KEY')
    expect(names).toContain('DB_URL')
    expect(names).not.toContain('export')
    // A plain assignment with no prefix still works.
    expect(names).toContain('PLAIN')
  })

  it('skips comment lines', () => {
    const content = `# This is a comment
KEY=value
`
    const symbols = extractEnv(content, '.env')
    expect(symbols.map((s) => s.name)).not.toContain('This')
  })

  it('extracts keys containing dots and hyphens (regression: ENV_KEY_RE lacked `.`/`-` in its identifier character class, so keys like NODE-ENV or DB.HOST were silently dropped by the indexer even though the live section reader already found them)', () => {
    const content = `NODE-ENV=production
DB.HOST=localhost
PLAIN_KEY=ok
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['NODE-ENV', 'DB.HOST', 'PLAIN_KEY'])
  })

  it('does not read a bare URL on its own line as a phantom `https` key (regression: ENV_KEY_RE matched `:` unconditionally, so the scheme separator in a bare `https://example.com` value line was mistaken for a key/value split)', () => {
    const content = `DATABASE_URL=postgres://localhost/db
https://docs.example.com/setup
API_KEY=secret
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['DATABASE_URL', 'API_KEY'])
    expect(names).not.toContain('https')
  })

  // Regression: extractEnv scanned every line independently for a column-0 `KEY=value`
  // assignment, with no notion of an open quote carried over from a previous line. A
  // multi-line double-quoted value whose embedded content happened to look like an
  // assignment (e.g. `PHANTOM_KEY=phantom`) was misread as a real, separate key.
  it('does not emit a phantom key from a line embedded inside a multi-line quoted value', () => {
    const content = `MULTILINE="first line
PHANTOM_KEY=phantom
last line"
REAL_KEY=value
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('MULTILINE')
    expect(names).toContain('REAL_KEY')
    expect(names).not.toContain('PHANTOM_KEY')
    expect(names).toHaveLength(2)
  })

  it('resumes normal key scanning once the multi-line quoted value closes', () => {
    const content = `MULTILINE="line one
line two"
AFTER=value
`
    const symbols = extractEnv(content, '.env')
    const names = symbols.map((s) => s.name)
    expect(names).toEqual(['MULTILINE', 'AFTER'])
  })

  it('still treats a single-line quoted value normally (no false multi-line carryover)', () => {
    const content = `A="one"
B="two"
`
    const symbols = extractEnv(content, '.env')
    expect(symbols.map((s) => s.name)).toEqual(['A', 'B'])
  })

  // Regression: _lineClosesQuote/_detectOpenQuote treated any char immediately preceding a
  // quote as escaping it if it was a backslash, with no notion of odd/even backslash runs, and
  // applied that escape logic to single-quoted values too (which have no escape semantics in
  // dotenv/POSIX). A single-quoted value ending in a backslash (`DIR='C:\Users\me\'`) was
  // misread as an escaped, still-open quote, silently swallowing every subsequent key as a
  // phantom multi-line continuation. A double-quoted value ending in an even run of backslashes
  // (`WIN="C:\path\\"`, i.e. one literal trailing backslash) closes correctly either way, but is
  // included here to pin down the odd/even-run distinction for double quotes too.
  it('closes a single-quoted value on any quote regardless of a trailing backslash, and correctly parses a double-quoted value with an even trailing backslash run', () => {
    const content = String.raw`DIR='C:\Users\me\'
API_KEY=abc123
PORT=8080
WIN="C:\path\\"
NEXT=1
`
    const symbols = extractEnv(content, '.env')
    expect(symbols.map((s) => s.name)).toEqual(['DIR', 'API_KEY', 'PORT', 'WIN', 'NEXT'])
  })

  it('extracts CREATE INDEX with CONCURRENTLY keyword', () => {
    const content = `
CREATE INDEX CONCURRENTLY idx_name ON users (id);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('idx_name')
    expect(names).not.toContain('CONCURRENTLY')
    expect(symbols.find((s) => s.name === 'idx_name')?.kind).toBe('sql_index')
  })

  it('extracts CREATE MATERIALIZED VIEW', () => {
    const content = `
CREATE MATERIALIZED VIEW mat_view AS SELECT * FROM users;
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('mat_view')
    expect(symbols.find((s) => s.name === 'mat_view')?.kind).toBe('sql_view')
  })

  it('returns empty array for empty input', () => {
    expect(extractEnv('', '.env')).toHaveLength(0)
  })

  it('detects .env filename via parseFile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-env-test-'))
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, 'KEY=value\n')
    const result = await parseFile(file)
    expect(result.language).toBe('env_file')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

describe('makefile adapter', () => {
  it('extracts targets and define blocks', () => {
    const content = `all: build test

build:
\tgo build ./...

test:
\tgo test ./...

clean:
\trm -rf dist/

define GREETING
Hello World
endef
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('all')
    expect(names).toContain('build')
    expect(names).toContain('test')
    expect(names).toContain('clean')
    expect(names).toContain('GREETING')
    expect(symbols.find((s) => s.name === 'build')?.kind).toBe('makefile_target')
    expect(symbols.find((s) => s.name === 'GREETING')?.kind).toBe('makefile_define')
  })

  it('indexes a target whose name contains a legally-escaped hash, without misreading it as a comment start (regression: COMMENT_RE blanked from any # to end-of-line with no escape awareness, and TARGET_RE unconditionally excluded # from the name class even when not stripped, so a target like `foo\\#bar:` -- a legal GNU Make escaped-hash target name -- was silently dropped entirely, while a genuine trailing `#` comment on the same line as a target must still be stripped)', () => {
    const escaped = extractMakefile('foo\\#bar: baz\n\techo hi\n', 'Makefile')
    expect(escaped.map((s) => s.name)).toContain('foo\\#bar')

    const withComment = extractMakefile('foo: baz # this is a comment\n\techo hi\n', 'Makefile')
    expect(withComment.map((s) => s.name)).toEqual(['foo'])
  })

  it('excludes ::= and :::= assignments but keeps real targets including double-colon rules', () => {
    const content = `build:
\tgo build ./...

IMMEDIATE ::= now

POSIX_IMM :::= later

SIMPLE := x

archive:: build

clean::
\trm -rf dist/
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('build')
    expect(names).toContain('archive')
    expect(names).toContain('clean')
    expect(names).not.toContain('IMMEDIATE')
    expect(names).not.toContain('POSIX_IMM')
    expect(names).not.toContain('SIMPLE')
    expect(symbols.find((s) => s.name === 'build')?.kind).toBe('makefile_target')
    expect(symbols.find((s) => s.name === 'archive')?.kind).toBe('makefile_target')
  })

  it('skips .PHONY and other special targets', () => {
    const content = `.PHONY: all build\n\nall:\n\techo done\n`
    const symbols = extractMakefile(content, 'Makefile')
    expect(symbols.map((s) => s.name)).not.toContain('.PHONY')
  })

  it('does not mis-split a Windows drive-letter path target at its drive colon (regression: TARGET_RE stopped its non-greedy name capture at the FIRST colon, so \'C:/foo/bar.o: C:/foo/bar.c\' emitted a bogus target named \'C\' instead of the real \'C:/foo/bar.o\')', () => {
    const content = 'C:/foo/bar.o: C:/foo/bar.c\n\techo hi\n'
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('C:/foo/bar.o')
    expect(names).not.toContain('C')
    expect(symbols.find((s) => s.name === 'C:/foo/bar.o')?.kind).toBe('makefile_target')
  })

  it('splits a multi-target rule into separate symbols instead of fusing the names', () => {
    // Regression: `all clean:` used to capture the whole "all clean" run as a single symbol
    // name, so `token-goat symbol clean` returned nothing for a target visibly in the source.
    const content = `all clean:\n\techo done\n`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('all')
    expect(names).toContain('clean')
    expect(names).not.toContain('all clean')
    expect(symbols.find((s) => s.name === 'all')?.kind).toBe('makefile_target')
    expect(symbols.find((s) => s.name === 'clean')?.kind).toBe('makefile_target')
  })

  it('does not emit a spurious target for a colon-bearing line inside a define...endef block', () => {
    const content = `define PRINT_HELP_PYSCRIPT
import re, sys
for line in sys.stdin:
	match = re.match(r'^([a-zA-Z_-]+):.*?## (.*)$', line)
endef

test:
	go test ./...
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(symbols.filter((s) => s.kind === 'makefile_target')).toHaveLength(1)
    expect(names).toContain('test')
    expect(symbols.find((s) => s.name === 'test')?.kind).toBe('makefile_target')
    expect(names).toContain('PRINT_HELP_PYSCRIPT')
    expect(symbols.find((s) => s.name === 'PRINT_HELP_PYSCRIPT')?.kind).toBe('makefile_define')
  })

  it('masks the entire outer define body of a legally nested define...endef block, not just up to the first inner endef', () => {
    // Regression: DEFINE_BLOCK_RE was non-greedy, so with a nested `define`/`endef` pair the
    // mask stopped at the FIRST (inner) endef, leaving the rest of the outer define's body
    // unmasked and scanned as real rule text -- a fake target line left over in that
    // unmasked tail was wrongly emitted as a real makefile_target symbol.
    const content = `define outer
define inner
endef
fake-target-inside-outer:
	echo should not be indexed
endef

test:
	go test ./...
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('fake-target-inside-outer')
    expect(names).toContain('test')
    expect(names).toContain('outer')
    expect(symbols.find((s) => s.name === 'outer')?.kind).toBe('makefile_define')
  })

  it('does not mistake a tab-indented recipe line starting with "define" for a define block opener', () => {
    // Regression: DEFINE_LINE_RE/ENDEF_LINE_RE used `^\s*`, which matches a leading tab too -
    // but a tab-indented line in a Makefile is always a shell recipe line (arbitrary text
    // handed to the shell), never a make directive. A recipe command that happened to start
    // with the word "define" (e.g. `\tdefine X = 1`) was misread as opening a define...endef
    // block; since a real column-0 endef never appears inside a recipe, no closer was found
    // and everything from that line to EOF was masked, silently dropping every later target.
    const content = `first:
\tdefine X = 1
second:
\techo hi
third:
\techo bye
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('first')
    expect(names).toContain('second')
    expect(names).toContain('third')
  })

  it('emits a makefile_define symbol for a legally space-indented define block, not just column-0', () => {
    // Regression: DEFINE_LINE_RE (used by maskDefineBlocks to detect and mask the block body)
    // tolerates GNU make's legal leading spaces before `define`, but DEFINE_RE (the separate
    // regex that actually emits the makefile_define symbol) was hard-anchored at column 0 with
    // no such tolerance - so a legally space-indented `  define VAR` block was correctly masked
    // (its body didn't corrupt target scanning) but VAR itself was never surfaced as a symbol,
    // silently vanishing from the index despite valid Makefile syntax.
    const content = `  define GREETING
  echo hi
  endef

build:
\techo building
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('GREETING')
    expect(names).toContain('build')
    expect(symbols.find((s) => s.name === 'GREETING')?.kind).toBe('makefile_define')
  })

  it('recognizes a modifier-prefixed define block (override/export) instead of scanning its body for phantom targets', () => {
    // Regression: DEFINE_LINE_RE/DEFINE_RE only recognized a bare `define`, not GNU make's legal
    // `override define`/`export define`/`private define` modifier prefixes. maskDefineBlocks
    // never entered the block for a modifier-prefixed opener, so its body (often help/usage text
    // with colons) was left unmasked and scanned by TARGET_RE for phantom makefile_target
    // symbols, while the real variable name was dropped entirely since DEFINE_RE never matched.
    const content = `override define HELP_TEXT
usage: make foo
run this: to build
endef

export define SCRIPT
step one: do it
endef

real:
\techo hi
`
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('HELP_TEXT')
    expect(names).toContain('SCRIPT')
    expect(names).toContain('real')
    expect(symbols.find((s) => s.name === 'HELP_TEXT')?.kind).toBe('makefile_define')
    expect(symbols.find((s) => s.name === 'SCRIPT')?.kind).toBe('makefile_define')
    expect(names).not.toContain('usage')
    expect(names).not.toContain('run')
    expect(names).not.toContain('this')
    expect(names).not.toContain('step')
    expect(names).not.toContain('one')
  })

  it('does not create a phantom target from a colon inside a backslash-continued variable assignment', () => {
    // Regression: TARGET_RE scanned every physical line independently, never accounting for
    // GNU make's backslash-newline line continuation. A variable assignment wrapped across
    // multiple physical lines (a search path, a sed substitution) legitimately has a colon in
    // its continuation line, which TARGET_RE misread as a new rule header - even though that
    // line is logically still part of the preceding assignment, not an independent statement.
    const content = [
      'PATHS = /usr/bin:/usr/local/bin \\',
      '        /opt/bin:/sbin',
      '',
      'all:',
      '\techo hi',
    ].join('\n')
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('all')
    expect(names).not.toContain('/opt/bin')
    expect(names).toHaveLength(1)
  })

  it('does not create a phantom target from a colon inside a backslash-continued sed-substitution value', () => {
    const content = [
      'SUBST = s/old/new/ \\',
      '        first:second',
      '',
      'build:',
      '\tgcc -o app app.c',
    ].join('\n')
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('build')
    expect(names).not.toContain('first')
    expect(names).toHaveLength(1)
  })

  it('does not misread a backslash-continued value line starting with the word "define" as a real define opener', () => {
    // Regression: maskContinuationLines ran AFTER maskDefineBlocks, so a wrapped variable
    // assignment whose continuation line happens to start with the ordinary word "define" (e.g.
    // a list of make directive names) was still visible to DEFINE_LINE_RE when maskDefineBlocks
    // scanned. That opened a phantom define block with no matching endef, masking every line
    // through EOF (dropping every real target after it), and DEFINE_RE (which read the
    // continuation-unaware `stripped` copy) separately emitted a phantom makefile_define symbol.
    const content = [
      'DIRECTIVES = include ifdef \\',
      '    define undef pragma \\',
      '    endif',
      '',
      'all:',
      '\techo building',
      '',
      'clean:',
      '\techo cleaning',
    ].join('\n')
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('all')
    expect(names).toContain('clean')
    expect(symbols.some((s) => s.kind === 'makefile_define')).toBe(false)
    expect(names).toHaveLength(2)
  })

  it('does not let a backslash-terminated define-body line swallow the endef and drop every target after it', () => {
    // Regression: continuation-masking and define-block-masking ran as two independent line
    // scans. maskContinuationLines had no awareness of define/endef boundaries, so a define
    // body's last line ending in `\` caused the following `endef` line to be blanked as a
    // "continuation" even though GNU make does not join continuations across an endef
    // terminator - endef is a literal directive line regardless of what the previous body line
    // ended with. Blanking it meant maskDefineBlocks's depth counter never saw the endef and
    // masked every line through EOF, dropping every real target declared after the block.
    const content = [
      'define BUILD',
      'gcc -o foo \\',
      'endef',
      '',
      'all:',
      '\techo hi',
      '',
      'clean:',
      '\techo bye',
    ].join('\n')
    const symbols = extractMakefile(content, 'Makefile')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('all')
    expect(names).toContain('clean')
    expect(names).toContain('BUILD')
    expect(symbols.filter((s) => s.kind === 'makefile_target')).toHaveLength(2)
  })

  it('extracts CREATE INDEX with CONCURRENTLY keyword', () => {

    const content = `
CREATE INDEX CONCURRENTLY idx_name ON users (id);
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('idx_name')
    expect(names).not.toContain('CONCURRENTLY')
    expect(symbols.find((s) => s.name === 'idx_name')?.kind).toBe('sql_index')
  })

  it('extracts CREATE MATERIALIZED VIEW', () => {
    const content = `
CREATE MATERIALIZED VIEW mat_view AS SELECT * FROM users;
`
    const symbols = extractSql(content, 'schema.sql')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('mat_view')
    expect(symbols.find((s) => s.name === 'mat_view')?.kind).toBe('sql_view')
  })

  it('reports correct line numbers for many scattered targets', () => {
    // Regression guard for a quadratic slice+split line-number bug in the makefile adapter.
    const targetCount = 60
    const lines: string[] = []
    const expectedLines = new Map<string, number>()
    for (let i = 0; i < targetCount; i++) {
      lines.push('', `target${i}:`, `\techo ${i}`)
      expectedLines.set(`target${i}`, lines.length - 1)
    }
    const content = lines.join('\n')
    const symbols = extractMakefile(content, 'Makefile')
    for (const [name, expectedLine] of expectedLines) {
      const sym = symbols.find((s) => s.name === name)
      expect(sym?.lineStart).toBe(expectedLine)
    }
  })

  it('returns empty array for empty input', () => {
    expect(extractMakefile('', 'Makefile')).toHaveLength(0)
  })

  it('detects Makefile by name via parseFile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-make-test-'))
    const file = path.join(dir, 'Makefile')
    fs.writeFileSync(file, 'all:\n\techo hi\n')
    const result = await parseFile(file)
    expect(result.language).toBe('makefile')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------

describe('proto adapter', () => {
  it('extracts message, service, rpc, enum, and import', () => {
    const content = `syntax = "proto3";

import "google/protobuf/timestamp.proto";

message User {
  string id = 1;
  string name = 2;
}

enum Role {
  ADMIN = 0;
  USER = 1;
}

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc CreateUser(CreateUserRequest) returns (User);
}
`
    const { symbols, imports } = extractProto(content, 'user.proto')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('User')
    expect(names).toContain('Role')
    expect(names).toContain('UserService')
    expect(names).toContain('GetUser')
    expect(names).toContain('CreateUser')
    expect(symbols.find((s) => s.name === 'User')?.kind).toBe('proto_message')
    expect(symbols.find((s) => s.name === 'UserService')?.kind).toBe('proto_service')
    expect(symbols.find((s) => s.name === 'GetUser')?.kind).toBe('proto_rpc')
    expect(imports.some((i) => i.target === 'google/protobuf/timestamp.proto')).toBe(true)
  })

  it('reports correct line numbers for many scattered message declarations', () => {
    // Regression guard for a quadratic slice+split line-number bug in the proto adapter.
    const blockCount = 60
    const lines: string[] = []
    const expectedLines = new Map<string, number>()
    for (let i = 0; i < blockCount; i++) {
      lines.push('', `message Msg${i} {`, `  string field${i} = 1;`, `}`)
      expectedLines.set(`Msg${i}`, lines.length - 2)
    }
    const content = lines.join('\n')
    const { symbols } = extractProto(content, 'many.proto')
    for (const [name, expectedLine] of expectedLines) {
      const sym = symbols.find((s) => s.name === name)
      expect(sym?.lineStart).toBe(expectedLine)
    }
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractProto('', 'empty.proto')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('detects .proto language via parseFile', async () => {
    const file = tmp('user.proto', 'message Foo {}')
    const result = await parseFile(file)
    expect(result.language).toBe('proto')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('captures nested message/enum with correct end lines, not just column-0 top-level ones', () => {
    const content = `message Outer {
  message Inner {
    string x = 1;
  }
  enum Status {
    ACTIVE = 0;
  }
  int32 y = 1;
}
`
    const { symbols } = extractProto(content, 'nested.proto')
    const names = symbols.map((s) => s.name)
    // Regression: TOP_LEVEL_RE was anchored to column 0 with no leading-whitespace
    // allowance, so an indented nested message/enum never matched at all.
    expect(names).toContain('Inner')
    expect(names).toContain('Status')

    const outer = symbols.find((s) => s.name === 'Outer')
    const inner = symbols.find((s) => s.name === 'Inner')
    const status = symbols.find((s) => s.name === 'Status')
    expect(inner?.kind).toBe('proto_message')
    expect(status?.kind).toBe('proto_enum')

    // Regression: the shared flat end-line propagation assumes siblings, not nesting, so
    // without brace-matching Outer's range gets truncated to right before Inner starts, and
    // Inner (the last section in file order) over-extends all the way to EOF.
    expect(inner?.lineStart).toBe(2)
    expect(inner?.lineEnd).toBe(4)
    expect(status?.lineStart).toBe(5)
    expect(status?.lineEnd).toBe(7)
    expect(outer?.lineStart).toBe(1)
    expect(outer?.lineEnd).toBe(9)
  })

  it('does not treat a stray /* inside a string literal as a real block comment', () => {
    const content = `message Foo {
  string desc = 1 [default = "text /* not a real comment"];
}

message Bar {
  /* a real comment */
  string x = 1;
}
`
    const { symbols } = extractProto(content, 'quotes.proto')
    const foo = symbols.find((s) => s.name === 'Foo')
    const bar = symbols.find((s) => s.name === 'Bar')
    // Regression: the naive /\*[\s\S]*?\*\/ regex has no string-literal awareness, so the
    // "/*" inside Foo's string literal gets treated as opening a real block comment that
    // doesn't close until Bar's actual "*/", blanking out Foo's closing brace and merging
    // it into Bar's range.
    expect(foo?.lineEnd).toBe(3)
    expect(bar).toBeDefined()
    expect(bar?.lineStart).toBe(5)
    expect(bar?.lineEnd).toBe(8)
  })

  it('gives the last rpc in a service its own lineEnd, not the rest of the file', () => {
    // Regression: rpc symbols never got a blockEndLines entry, unlike message/enum/service/
    // extend/oneof, so the last rpc in a service fell back to the flat "next section start -
    // 1 / totalLines" model -- swallowing the service's closing brace and any unrelated
    // trailing content (comments, a sibling top-level declaration) into the rpc's own range.
    const content = `message Foo {
  string bar = 1;
}

service MyService {
  rpc DoThing(Request) returns (Response);
  rpc StreamThing(stream Request) returns (stream Response);
}

// trailing comment after the service closes
// more trailing lines
// even more trailing lines
`
    const { symbols } = extractProto(content, 'rpc_end.proto')
    const streamThing = symbols.find((s) => s.name === 'StreamThing')
    expect(streamThing?.lineStart).toBe(7)
    expect(streamThing?.lineEnd).toBe(7)
  })

  it('bounds a trailing-options-block rpc by its own closing brace, not the service\'s', () => {
    const content = `service Greeter {
rpc SayHello(HelloRequest) returns (HelloResponse) {}
rpc SayBye(ByeRequest) returns (ByeResponse) {
  option (foo) = true;
}
}
`
    const { symbols } = extractProto(content, 'rpc_option_block.proto')
    const sayBye = symbols.find((s) => s.name === 'SayBye')
    expect(sayBye?.lineStart).toBe(3)
    expect(sayBye?.lineEnd).toBe(5)
  })

  it('reports the rpc/oneof keyword line, not a preceding blank line', () => {
    const content = `service S {

  rpc Foo(A) returns (B);
}

message M {

  oneof choice {
    string a = 1;
  }
}
`
    const { symbols } = extractProto(content, 'blank_before.proto')
    const foo = symbols.find((s) => s.name === 'Foo')
    const choice = symbols.find((s) => s.name === 'choice')
    // Regression: RPC_RE/ONEOF_RE started with `^\s+`, and \s matches newlines, so a blank
    // line right before the keyword let `^` anchor at the blank line and \s+ bridge across
    // the newline down to the keyword -- reporting the blank line's number instead of the
    // actual rpc/oneof keyword line.
    expect(foo?.lineStart).toBe(3)
    expect(choice?.lineStart).toBe(8)
  })

  it('extracts rpc methods declared at column 0 inside an unindented service body', () => {
    // Regression: RPC_RE required at least one leading space/tab (`^[ 	]+rpc`), so a
    // column-0 rpc line inside a column-0 service block was never matched - only the
    // service itself got indexed.
    const content = `service Greeter {
rpc SayHello(HelloRequest) returns (HelloResponse) {}
rpc SayBye(ByeRequest) returns (ByeResponse) {}
}
`
    const { symbols } = extractProto(content, 'unindented.proto')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('SayHello')
    expect(names).toContain('SayBye')
    expect(symbols.find((s) => s.name === 'SayHello')?.kind).toBe('proto_rpc')
    expect(symbols.find((s) => s.name === 'SayBye')?.kind).toBe('proto_rpc')
  })

  it('extracts a message after a string literal containing // without corrupting its range', () => {
    const content = `message Foo {
  option (my.url) = "https://example.com";
}

message Bar {
  string x = 1;
}
`
    const { symbols } = extractProto(content, 'url_string.proto')
    const foo = symbols.find((s) => s.name === 'Foo')
    const bar = symbols.find((s) => s.name === 'Bar')
    // Regression: stripComments' line-comment pass had no string-literal awareness, so the
    // "//" inside the URL got treated as a real comment start and blanked the rest of the
    // line -- deleting the string's closing quote, desyncing quote-tracking, and corrupting
    // Foo's brace range / Bar's extraction.
    expect(foo?.lineStart).toBe(1)
    expect(foo?.lineEnd).toBe(3)
    expect(bar).toBeDefined()
    expect(bar?.lineStart).toBe(5)
    expect(bar?.lineEnd).toBe(7)
  })

describe('PowerShell adapter', () => {
  it('extracts function, filter, class, enum, and method symbols', () => {
    const content = `# PowerShell script
function Get-Foo {
  Write-Host "Outer function"
  
  function Helper {
    Write-Host "Nested helper"
  }
}

filter Select-Bar {
  $_ | Where-Object { $_.Active -eq $true }
}

class Widget {
  Widget() {
    # Constructor
  }

  [void] Render() {
    Write-Host "Rendering"
  }
}

enum Color {
  Red = 1
  Green = 2
  Blue = 3
}
`
    const { symbols } = extractPowershell(content, 'script.ps1')
    expect(symbols.length).toBeGreaterThan(0)
    const names = symbols.map((s) => s.name)
    
    // Should contain top-level definitions
    expect(names).toContain('Get-Foo')
    expect(names).toContain('Select-Bar')
    expect(names).toContain('Widget')
    expect(names).toContain('Color')
    expect(names).toContain('Render')
    
    // Should NOT contain nested function
    expect(names).not.toContain('Helper')
    
    // Check kinds
    expect(symbols.find((s) => s.name === 'Get-Foo')?.kind).toBe('function')
    expect(symbols.find((s) => s.name === 'Select-Bar')?.kind).toBe('function')
    expect(symbols.find((s) => s.name === 'Widget')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'Color')?.kind).toBe('enum')
    expect(symbols.find((s) => s.name === 'Render')?.kind).toBe('method')
  })

  it('handles block comments correctly', () => {
    const content = `<# 
      Block comment spanning
      multiple lines
    #>
    
function MyFunction {
  # Single line comment
  Write-Host "test"
}
`
    const { symbols } = extractPowershell(content, 'comment_test.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('MyFunction')
  })

  it('indexes a scope-qualified function under its real name, not the scope prefix', () => {
    // `function global:prompt { }` is the canonical PowerShell profile-customization pattern.
    // Regression: the name regex excluded `:` from the name character class, so `global` (the
    // scope qualifier) was captured as the function name instead of `prompt`.
    const content = `function global:prompt {
  "PS> "
}
`
    const { symbols } = extractPowershell(content, 'profile.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('prompt')
    expect(names).not.toContain('global')
    expect(symbols.find((s) => s.name === 'prompt')?.kind).toBe('function')
  })

  it('indexes local:/script:/private:-scoped function names, not the scope prefix', () => {
    const content = `function script:Get-Widget {
  "widget"
}
`
    const { symbols } = extractPowershell(content, 'scoped.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Widget')
    expect(names).not.toContain('script')
  })

  it('does not emit control-flow keywords inside a method body as methods', () => {
    const content = `class Calc {
  [int] Compute([int] $n) {
    if ($n -gt 0) {
      Write-Host "positive"
    }
    foreach ($i in 1..$n) {
      $this.Helper($i)
    }
    return $n
  }
}
`
    const { symbols } = extractPowershell(content, 'calc.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Compute')
    expect(symbols.find((s) => s.name === 'Compute')?.kind).toBe('method')
    expect(names).not.toContain('if')
    expect(names).not.toContain('foreach')
    expect(names).not.toContain('Write-Host')
    expect(names).not.toContain('Helper')
  })

  it('attaches methods to an Allman-style class (opening brace on its own line)', () => {
    const content = `class Widget
{
  [void] Render()
  {
    Write-Host "Rendering"
  }
}
`
    const { symbols } = extractPowershell(content, 'widget.ps1')
    const render = symbols.find((s) => s.name === 'Render')
    expect(render?.kind).toBe('method')
    expect(render?.docstring).toBe('Widget')
  })

  it('indexes a method whose return type is a nested generic (regression: the return-type bracket group only matched a single, non-nested `[...]` pair, so `[List[string]]` consumed only up to the inner `]`, left the outer `]` dangling, and silently dropped the whole method)', () => {
    const content = `class Repository {
    [System.Collections.Generic.List[string]] GetItems() {
        return $this.Items
    }

    [void] AddItem([string]$item) {
        $this.Items.Add($item)
    }
}
`
    const { symbols } = extractPowershell(content, 'repository.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('GetItems')
    expect(symbols.find((s) => s.name === 'GetItems')?.kind).toBe('method')
    expect(names).toContain('AddItem')
  })

  it('detects .ps1 and .psm1 languages via parseFile', async () => {
    const ps1File = tmp('script.ps1', 'function Get-Test { }')
    const result1 = await parseFile(ps1File)
    expect(result1.language).toBe('powershell')
    fs.rmSync(path.dirname(ps1File), { recursive: true, force: true })
    
    const psm1File = tmp('module.psm1', 'function Get-Test { }')
    const result2 = await parseFile(psm1File)
    expect(result2.language).toBe('powershell')
    fs.rmSync(path.dirname(psm1File), { recursive: true, force: true })
  })

  it('indexes a function whose declaration line also carries a same-line inline block comment', () => {
    const content = `function Setup { <# init #> }\n`
    const { symbols } = extractPowershell(content, 'inline_comment.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Setup')
  })

  it('preserves code before a mid-line block-comment opener that does not close on the same line', () => {
    const content = `function Foo {
    <# doc
       more doc
    #>
    return 1
}

function Bar {
    return 2
}
`
    const { symbols } = extractPowershell(content, 'mid_line_comment.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
  })

  // Regression: findUnquoted (used by the # and <# comment-marker search) toggled its
  // double-quote state on every literal `"`, with no backtick-escape awareness -- unlike
  // stripPowershellStringLiterals, which correctly treats a backtick immediately before a `"`
  // inside a double-quoted string as PowerShell's real escape sequence. A backtick-escaped quote
  // was misread as the string's real closing quote, so a `#` appearing later on the same (still
  // logically-open) string got treated as a real comment marker and truncated the rest of the
  // line -- including a closing brace -- desyncing braceDepth and silently dropping every
  // top-level declaration for the rest of the file.
  it('does not lose a closing brace after a backtick-escaped quote followed by a literal # on the same string', () => {
    const content = `function Foo {
    $x = "abc\`"def#ghi" }

function Bar {
    return 2
}
`
    const { symbols } = extractPowershell(content, 'backtick_escaped_quote.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
  })

  it('does not treat <# inside a string literal as a real block comment opener', () => {
    const content = `$x = "the <# marker"
function AfterString {
  Write-Host "hi"
}
`
    const { symbols } = extractPowershell(content, 'string_marker.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('AfterString')
  })

  it('clears currentClass after a one-liner class body so a following top-level function is still indexed', () => {
    const content = `class Empty { }

function AfterClass {
  Write-Host "after"
}
`
    const { symbols } = extractPowershell(content, 'oneliner_class.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Empty')
    expect(names).toContain('AfterClass')
  })

  it('clears currentClass after a one-liner class whose string literal contains an unbalanced brace', () => {
    // Regression: the one-liner check counted braces on the raw line, not the string-stripped
    // copy the real braceDepth tracker uses. A default value like "}" nets the real braces to
    // zero but adds a phantom close-brace to the raw count, so openCount !== closeCount, the
    // class is wrongly treated as multi-line, and currentClass is never cleared - stranding it
    // and dropping every top-level declaration that follows.
    const content = `class Foo { [string]$X = "}" }
function Bar { "hi" }
function Baz { "yo" }
`
    const { symbols } = extractPowershell(content, 'oneliner_string_brace_class.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
    expect(names).toContain('Baz')
  })

  it('classifies a class whose name contains the substring "enum" as class, not enum', () => {
    const content = `class EnumHelper {
    [void] DoWork() {}
}
`
    const { symbols } = extractPowershell(content, 'enum_substring_class.ps1')
    const sym = symbols.find((s) => s.name === 'EnumHelper')
    expect(sym?.kind).toBe('class')
  })

  it('still classifies a real enum declaration as enum', () => {
    const content = `enum Color {
    Red
    Blue
}
`
    const { symbols } = extractPowershell(content, 'real_enum.ps1')
    const sym = symbols.find((s) => s.name === 'Color')
    expect(sym?.kind).toBe('enum')
  })

  it('does not let braces inside a # comment desync the brace-depth counter', () => {

    const content = `function Outer {
  # TODO: handle { edge case
  Write-Host "x"
}

function AfterComment {
  Write-Host "y"
}
`
    const { symbols } = extractPowershell(content, 'hash_brace.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Outer')
    expect(names).toContain('AfterComment')
  })

  it('does not let an unbalanced brace inside a string literal desync scope depth', () => {
    const content = `class Foo {
  [string] $bracket = "{"

  [void] Bar() {
    Write-Host "in Bar"
  }
}
`
    const { symbols } = extractPowershell(content, 'string_brace.ps1')
    // Regression: the string literal "{" contains a literal brace character. If it is counted
    // toward braceDepth, depthInClass drifts and Bar is either missed or mis-parented, and
    // currentClass may never pop after Foo's real closing brace.
    const bar = symbols.find((s) => s.name === 'Bar')
    expect(bar?.kind).toBe('method')
    expect(bar?.docstring).toBe('Foo')
  })

  it('does not let an unbalanced brace in block-comment prose desync the brace-depth counter', () => {
    const content = `<#
 example { here
#>
function Get-Foo {
  return 1
}
`
    const { symbols } = extractPowershell(content, 'comment_brace.ps1')
    const foo = symbols.find((s) => s.name === 'Get-Foo')
    expect(foo).toBeDefined()
    expect(foo?.kind).toBe('function')
  })

  it('does not treat a literal <# inside a # line comment as a real block-comment opener', () => {
    const content = `# See <# for syntax details
function Get-Foo { $x = 1 }
function Get-Bar { $y = 2 }
`
    const { symbols } = extractPowershell(content, 'hash_then_marker.ps1')
    // Regression: the `#` line comment starts before the `<#` sequence, so `<#` here is just
    // text inside ordinary comment prose, not a real block-comment opener. Mistaking it for one
    // leaves inBlockComment stuck true (no #> ever follows), silently dropping every symbol
    // from this point to EOF.
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Foo')
    expect(names).toContain('Get-Bar')
  })

  it('still opens a real multi-line block comment when <# appears before any # marker', () => {
    const content = `<#
  Real block comment
  spanning multiple lines
#>
function Get-Foo {
  return 1
}
`
    const { symbols } = extractPowershell(content, 'real_block_comment.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Foo')
  })

  it('still handles a real single-line <# ... #> block comment', () => {
    const content = `<# single line block comment #>
function Get-Foo {
  return 1
}
`
    const { symbols } = extractPowershell(content, 'real_singleline_block_comment.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Foo')
  })

  it('does not open a phantom here-string on an ordinary literal ending in "@" or \'@\'', () => {
    // Regression: findMultilineOpener's PowerShell branch (`/@("|')\s*$/`) had no
    // isInsideStringLiteral guard. A line like `$email = "admin@"` ends with the two characters
    // `@"`, so it was misread as opening a here-string. PowerShell here-strings never close on
    // their opening line, and the real closer requires a line that STARTS with `"@` - which
    // never occurs in ordinary code - so once falsely triggered, the rest of the file was
    // silently swallowed from the index.
    const content = `function Get-Email {
    $email = "admin@"
    return $email
}

function Get-Other {
    return "ok"
}
`
    const { symbols } = extractPowershell(content, 'ordinary_at_string.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Email')
    expect(names).toContain('Get-Other')
  })

  it('still recognizes a real here-string opener and masks its multi-line content', () => {
    const content = `function Get-Template {
    $template = @"
Hello $Name
This is a multiline string.
"@
    return $template
}

function Get-Other {
    return "ok"
}
`
    const { symbols } = extractPowershell(content, 'real_here_string.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Get-Template')
    expect(names).toContain('Get-Other')
  })

  it('does not let a trailing backslash before a string literal\'s closing quote desync brace-depth tracking', () => {
    // Regression: PowerShell strings do not use backslash as an escape character - a backslash
    // right before the closing quote (e.g. a Windows path literal like "C:\Temp\") is just a
    // literal character, not an escaped quote. The brace-depth scanner used to reuse common.ts's
    // C-like `stripStringLiterals`, which treats backslash as an escape and so misread that
    // trailing backslash as escaping the real closing quote, leaving the string "open" past its
    // true end and swallowing the rest of the line - including the `}` that follows - as phantom
    // string content. That desynced braceDepth for every line afterward, dropping AfterSetup.
    const content = `function Setup {
  if ($true) { $Path = "C:\\Temp\\" }
}

function AfterSetup {
  Write-Host "after"
}
`
    const { symbols } = extractPowershell(content, 'trailing_backslash_string.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Setup')
    expect(names).toContain('AfterSetup')
  })
})
})

// ---------------------------------------------------------------------------
// Terraform / HCL
// ---------------------------------------------------------------------------

describe('terraform adapter', () => {
  it('extracts resource, data, variable, output, module, provider, and locals with Terraform addressing names', () => {
    const content = `resource "aws_instance" "web" {
  ami = "ami-123"
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

variable "region" {
  default = "us-east-1"
}

output "instance_id" {
  value = aws_instance.web.id
}

module "vpc" {
  source = "./modules/vpc"
}

provider "aws" {
  region = "us-east-1"
}

locals {
  common_tags = {
    Team = "infra"
  }
}
`
    const symbols = extractTerraform(content, 'main.tf')
    const byName = (name: string) => symbols.find((s) => s.name === name)

    expect(byName('aws_instance.web')?.kind).toBe('tf_resource')
    expect(byName('aws_instance.web')).toMatchObject({ lineStart: 1, lineEnd: 3 })

    expect(byName('data.aws_ami.ubuntu')?.kind).toBe('tf_data')
    expect(byName('data.aws_ami.ubuntu')).toMatchObject({ lineStart: 5, lineEnd: 7 })

    expect(byName('var.region')?.kind).toBe('tf_variable')
    expect(byName('var.region')).toMatchObject({ lineStart: 9, lineEnd: 11 })

    expect(byName('output.instance_id')?.kind).toBe('tf_output')
    expect(byName('output.instance_id')).toMatchObject({ lineStart: 13, lineEnd: 15 })

    expect(byName('module.vpc')?.kind).toBe('tf_module')
    expect(byName('module.vpc')).toMatchObject({ lineStart: 17, lineEnd: 19 })

    expect(byName('provider.aws')?.kind).toBe('tf_provider')
    expect(byName('provider.aws')).toMatchObject({ lineStart: 21, lineEnd: 23 })

    // locals contains its own nested `{ }` (the common_tags map literal) -- proves the block's
    // own end line is found via true brace matching, not truncated at the first nested `{`.
    expect(byName('locals')?.kind).toBe('tf_locals')
    expect(byName('locals')).toMatchObject({ lineStart: 25, lineEnd: 29 })
  })

  it('returns an empty array for empty input', () => {
    expect(extractTerraform('', 'empty.tf')).toHaveLength(0)
  })

  it('detects .tf, .tfvars, and .hcl language via parseFile', async () => {
    const tfFile = tmp('main.tf', 'resource "aws_instance" "web" {}')
    const tfvarsFile = tmp('terraform.tfvars', 'region = "us-east-1"')
    const hclFile = tmp('config.hcl', 'block "x" {}')
    try {
      expect((await parseFile(tfFile)).language).toBe('terraform')
      expect((await parseFile(tfvarsFile)).language).toBe('terraform')
      expect((await parseFile(hclFile)).language).toBe('terraform')
    } finally {
      fs.rmSync(path.dirname(tfFile), { recursive: true, force: true })
      fs.rmSync(path.dirname(tfvarsFile), { recursive: true, force: true })
      fs.rmSync(path.dirname(hclFile), { recursive: true, force: true })
    }
  })

  it('gives an outer resource its own end line past a nested lifecycle/dynamic sub-block, and does not mis-parent the next sibling', () => {
    const content = `resource "aws_instance" "web" {
  ami = "ami-123"

  lifecycle {
    create_before_destroy = true
  }

  dynamic "ebs_block_device" {
    for_each = var.extra_disks
    content {
      device_name = ebs_block_device.value
    }
  }
}

resource "aws_instance" "db" {
  ami = "ami-456"
}
`
    const symbols = extractTerraform(content, 'nested.tf')
    const names = symbols.map((s) => s.name)
    // Regression guard: nested lifecycle/dynamic sub-blocks are not themselves resource/data/
    // variable/output/module/provider/locals blocks and must never be emitted as symbols.
    expect(names).not.toContain('ebs_block_device')
    expect(names).not.toContain('lifecycle')

    const web = symbols.find((s) => s.name === 'aws_instance.web')
    const db = symbols.find((s) => s.name === 'aws_instance.db')
    // Without true brace matching, the flat "ends where the next section starts" model would
    // truncate web's range or let it swallow db entirely.
    expect(web).toMatchObject({ lineStart: 1, lineEnd: 14 })
    expect(db).toMatchObject({ lineStart: 16, lineEnd: 18 })
  })

  it('does not let a # / // / block comment containing a brace corrupt brace counting or fabricate a symbol from commented-out HCL', () => {
    const content = `# resource "fake" "not_real" { this is a comment with a brace }
resource "aws_instance" "web" {
  // ami = "old-ami" { legacy }
  ami = "ami-123" /* block comment with { brace */
}
`
    const symbols = extractTerraform(content, 'comments.tf')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('fake.not_real')
    expect(names).toContain('aws_instance.web')
    const web = symbols.find((s) => s.name === 'aws_instance.web')
    expect(web).toMatchObject({ lineStart: 2, lineEnd: 5 })
  })

  it('does not let a brace character inside a string literal default value corrupt brace counting', () => {
    const content = `variable "config" {
  default = "{}"
}

variable "next" {
  default = "ok"
}
`
    const symbols = extractTerraform(content, 'string_brace.tf')
    const configVar = symbols.find((s) => s.name === 'var.config')
    const nextVar = symbols.find((s) => s.name === 'var.next')
    // Regression: an unbalanced-looking "{" / "}" inside a quoted default value must not be
    // counted as real block nesting -- if it were, var.config would swallow var.next's range.
    expect(configVar).toMatchObject({ lineStart: 1, lineEnd: 3 })
    expect(nextVar).toMatchObject({ lineStart: 5, lineEnd: 7 })
  })

  it('does not let braces/quotes inside a heredoc body corrupt brace counting for the block or the next sibling', () => {
    const content = `resource "aws_iam_policy" "example" {
  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow"}]
}
EOF
}

resource "aws_instance" "after" {
  ami = "ami-789"
}
`
    const symbols = extractTerraform(content, 'heredoc.tf')
    const policy = symbols.find((s) => s.name === 'aws_iam_policy.example')
    const after = symbols.find((s) => s.name === 'aws_instance.after')
    // Regression: an unmasked heredoc body has unbalanced braces and stray quote characters
    // that would desync brace/quote tracking for the rest of the file if not masked out first.
    expect(policy).toMatchObject({ lineStart: 1, lineEnd: 8 })
    expect(after).toMatchObject({ lineStart: 10, lineEnd: 12 })
  })

  it('supports hyphens and underscores in resource/variable names', () => {
    const content = `resource "aws_instance" "web-server_1" {
  ami = "ami-1"
}

variable "db_password-v2" {
  default = "x"
}
`
    const symbols = extractTerraform(content, 'names.tf')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('aws_instance.web-server_1')
    expect(names).toContain('var.db_password-v2')
  })
})

describe('bash adapter', () => {
  it('extracts function and top-level var declarations across function-header styles', () => {
    const content = `#!/usr/bin/env bash
export APP_NAME=myapp
readonly VERSION=1.2.3
declare -r CONFIG_PATH=/etc/myapp.conf
PLAIN_VAR=hello

log() {
  echo "[$APP_NAME] $1"
}

function deploy {
  echo "deploying"
}

function build() {
  echo "building"
}

one_liner() { echo hi; }
`
    const symbols = extractBash(content, 'deploy.sh')
    const byName = (name: string) => symbols.find((s) => s.name === name)

    expect(byName('APP_NAME')).toMatchObject({ kind: 'variable', lineStart: 2 })
    expect(byName('VERSION')).toMatchObject({ kind: 'variable', lineStart: 3 })
    expect(byName('CONFIG_PATH')).toMatchObject({ kind: 'variable', lineStart: 4 })
    expect(byName('PLAIN_VAR')).toMatchObject({ kind: 'variable', lineStart: 5 })

    expect(byName('log')).toMatchObject({ kind: 'function', lineStart: 7 })
    expect(byName('deploy')).toMatchObject({ kind: 'function', lineStart: 11 })
    expect(byName('build')).toMatchObject({ kind: 'function', lineStart: 15 })
    expect(byName('one_liner')).toMatchObject({ kind: 'function', lineStart: 19 })
  })

  it('does not treat a local/nested assignment inside a function body as a top-level var', () => {
    const content = `deploy() {
  local target=prod
  RESULT=ok
}
`
    const symbols = extractBash(content, 'deploy.sh')
    expect(symbols.find((s) => s.name === 'target')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'RESULT')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'deploy')?.kind).toBe('function')
  })

  it('does not treat a var/function inside a bare { ...; } grouping block as top-level', () => {
    // Regression: a bash `{ ...; }` compound-command grouping block (not a function) bumps
    // braceDepth but never sets inFunction, so a naive inFunction-only gate wrongly treats
    // anything nested inside it as top-level.
    const content = `{
  echo hello
  INNER_VAR=set
}
NEXT_VAR=ok
`
    const symbols = extractBash(content, 'deploy.sh')
    expect(symbols.find((s) => s.name === 'INNER_VAR')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'NEXT_VAR')).toMatchObject({ kind: 'variable', lineStart: 5 })
  })

  it('does not mistake a word-glued # in ${VAR#pattern} parameter expansion for a comment', () => {
    // Regression: a generic C-style line-comment stripper treats any unquoted `#` as an opener,
    // which would truncate this line at the `#` inside ${APP_NAME#my} and never see NEXT_VAR.
    const content = 'PREFIX=${APP_NAME#my}\nNEXT_VAR=ok\n'
    const symbols = extractBash(content, 'expand.sh')
    expect(symbols.find((s) => s.name === 'PREFIX')).toBeDefined()
    expect(symbols.find((s) => s.name === 'NEXT_VAR')).toBeDefined()
  })

  it('masks heredoc bodies so embedded #/=/{} content never desyncs parsing', () => {
    const content = `deploy() {
  cat <<EOF
NOT_A_VAR=should not be indexed
# not a real comment either
{ unbalanced brace
EOF
  echo done
}

AFTER_HEREDOC=ok
`
    const symbols = extractBash(content, 'deploy.sh')
    expect(symbols.find((s) => s.name === 'NOT_A_VAR')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'AFTER_HEREDOC')).toMatchObject({ kind: 'variable', lineStart: 10 })
  })

  it('respects a quoted heredoc terminator (<<\'EOF\') the same as an unquoted one', () => {
    const content = "cat <<'EOF'\nFAKE_VAR=nope\nEOF\nREAL_VAR=yes\n"
    const symbols = extractBash(content, 'deploy.sh')
    expect(symbols.find((s) => s.name === 'FAKE_VAR')).toBeUndefined()
    expect(symbols.find((s) => s.name === 'REAL_VAR')).toBeDefined()
  })

  it('returns an empty array for empty input', () => {
    expect(extractBash('', 'empty.sh')).toHaveLength(0)
  })

  it('detects .sh and .bash language via parseFile', async () => {
    const shFile = tmp('deploy.sh', 'log() {\n  echo hi\n}\n')
    const bashFile = tmp('deploy.bash', 'log() {\n  echo hi\n}\n')
    try {
      const shResult = await parseFile(shFile)
      expect(shResult.language).toBe('bash')
      expect(shResult.symbols.find((s) => s.name === 'log')?.kind).toBe('function')

      const bashResult = await parseFile(bashFile)
      expect(bashResult.language).toBe('bash')
      expect(bashResult.symbols.find((s) => s.name === 'log')?.kind).toBe('function')
    } finally {
      fs.rmSync(path.dirname(shFile), { recursive: true, force: true })
      fs.rmSync(path.dirname(bashFile), { recursive: true, force: true })
    }
  })
})
