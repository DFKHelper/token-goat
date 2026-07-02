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
import { extractSql } from '../src/languages/sql_idx.js'
import { extractIni, extractEnv } from '../src/languages/ini_idx.js'
import { extractMakefile } from '../src/languages/makefile_idx.js'
import { extractProto } from '../src/languages/proto_idx.js'
import { extractPowershell } from '../src/languages/powershell_idx.js'

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
    fs.rmSync(path.dirname(file), { recursive: true })
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

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractPhp('', 'empty.php')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
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

  it('detects .php language via parseFile', async () => {
    const file = tmp('foo.php', '<?php function foo() {}')
    const result = await parseFile(file)
    expect(result.language).toBe('php')
    fs.rmSync(path.dirname(file), { recursive: true })
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
    fs.rmSync(path.dirname(file), { recursive: true })
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

  it('detects .liquid language via parseFile', async () => {
    const file = tmp('test.liquid', '{% include "foo" %}')
    const result = await parseFile(file)
    expect(result.language).toBe('liquid')
    fs.rmSync(path.dirname(file), { recursive: true })
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

  it('detects .kt language via parseFile', async () => {
    const file = tmp('Foo.kt', 'fun main() {}')
    const result = await parseFile(file)
    expect(result.language).toBe('kotlin')
    fs.rmSync(path.dirname(file), { recursive: true })
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

  it('extracts #import pragmas as imports', () => {
    const content = `# import UserFields from "user.graphql"
type Query { users: [User] }
`
    const { imports } = extractGraphql(content, 'query.graphql')
    expect(imports.some((i) => i.target === 'user.graphql')).toBe(true)
  })

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractGraphql('', 'empty.graphql')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('detects .graphql language via parseFile', async () => {
    const file = tmp('schema.graphql', 'type Query { hello: String }')
    const result = await parseFile(file)
    expect(result.language).toBe('graphql')
    fs.rmSync(path.dirname(file), { recursive: true })
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
    expect(extractSql('', 'empty.sql')).toHaveLength(0)
  })

  it('detects .sql language via parseFile', async () => {
    const file = tmp('schema.sql', 'CREATE TABLE foo (id INT);')
    const result = await parseFile(file)
    expect(result.language).toBe('sql')
    fs.rmSync(path.dirname(file), { recursive: true })
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
    fs.rmSync(path.dirname(file), { recursive: true })
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
    fs.rmSync(dir, { recursive: true })
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
    expect(extractMakefile('', 'Makefile')).toHaveLength(0)
  })

  it('detects Makefile by name via parseFile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-make-test-'))
    const file = path.join(dir, 'Makefile')
    fs.writeFileSync(file, 'all:\n\techo hi\n')
    const result = await parseFile(file)
    expect(result.language).toBe('makefile')
    fs.rmSync(dir, { recursive: true })
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

  it('returns empty arrays for empty input', () => {
    const { symbols, imports } = extractProto('', 'empty.proto')
    expect(symbols).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  it('detects .proto language via parseFile', async () => {
    const file = tmp('user.proto', 'message Foo {}')
    const result = await parseFile(file)
    expect(result.language).toBe('proto')
    fs.rmSync(path.dirname(file), { recursive: true })
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

  it('detects .ps1 and .psm1 languages via parseFile', async () => {
    const ps1File = tmp('script.ps1', 'function Get-Test { }')
    const result1 = await parseFile(ps1File)
    expect(result1.language).toBe('powershell')
    fs.rmSync(path.dirname(ps1File), { recursive: true })
    
    const psm1File = tmp('module.psm1', 'function Get-Test { }')
    const result2 = await parseFile(psm1File)
    expect(result2.language).toBe('powershell')
    fs.rmSync(path.dirname(psm1File), { recursive: true })
  })

  it('indexes a function whose declaration line also carries a same-line inline block comment', () => {
    const content = `function Setup { <# init #> }\n`
    const { symbols } = extractPowershell(content, 'inline_comment.ps1')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Setup')
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
})
})
