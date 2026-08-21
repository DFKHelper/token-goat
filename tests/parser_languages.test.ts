import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

describe('parser language support', () => {
  describe('markdown symbols', () => {
    it('extracts headings from markdown', async () => {
      const content = `# Main Title
## Section One
### Subsection
## Section Two
Some content here
`

      const result = await parseFixture('test.md', content)

      expect(result.language).toBe('markdown')
      expect(result.symbols).toHaveLength(4)
      expect(result.symbols.map((s) => s.name)).toEqual([
        'Main Title',
        'Section One',
        'Subsection',
        'Section Two',
      ])
      expect(result.symbols[0]?.kind).toBe('heading')
    })
  })

  describe('json symbols', () => {
    it('extracts top-level keys from json', async () => {
      const content = `{
  "name": "test",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.0.0"
  }
}
`

      const result = await parseFixture('test.json', content)

      expect(result.language).toBe('json')
      // Top-level keys only -- the nested "lodash" key under dependencies must not appear.
      expect(result.symbols.map((s) => s.name)).toEqual(['name', 'version', 'dependencies'])
    })

    it('extracts keys from single-line and brace-sharing json, top-level only', async () => {
      const minResult = await parseFixture('min.json', '{"name":"foo","version":"1.0","deps":{"lodash":"^4"}}')
      const minNames = minResult.symbols.map((s) => s.name)
      expect(minNames).toContain('name')
      expect(minNames).toContain('version')
      expect(minNames).toContain('deps')
      expect(minNames).not.toContain('lodash')

      const nestedResult = await parseFixture('nested.json', '{ "a": { "b": 1 }, "c": 2 }')
      const nestedNames = nestedResult.symbols.map((s) => s.name)
      expect(nestedNames).toContain('a')
      expect(nestedNames).toContain('c')
      expect(nestedNames).not.toContain('b')
    })

    it('computes lineEnd/body spanning the full value when a string value contains an embedded literal newline', async () => {
      const content = [
        '{',
        '  "key1": "line one',
        'line two",',
        '  "key2": "value2"',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('multiline_value.json', content)

      const key1 = result.symbols.find((s) => s.name === 'key1')
      const key2 = result.symbols.find((s) => s.name === 'key2')

      expect(key1).toBeDefined()
      expect(key1?.lineStart).toBe(2)
      expect(key1?.lineEnd).toBe(3)
      expect(key1?.body).toContain('line two')

      expect(key2).toBeDefined()
      expect(key2?.lineStart).toBe(4)
      expect(key2?.lineEnd).toBe(4)
    })

    it('counts newlines skipped between the colon and the value opening quote when computing lineEnd', async () => {
      const content = [
        '{',
        '  "key1":',
        '    "value on the next line",',
        '  "key2": "value2"',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('colon_gap.json', content)

      const key1 = result.symbols.find((s) => s.name === 'key1')
      const key2 = result.symbols.find((s) => s.name === 'key2')

      expect(key1).toBeDefined()
      expect(key1?.lineStart).toBe(2)
      // The value's opening quote is on line 3, not line 2 where the key/colon are -- the
      // newline in the colon-to-quote gap must be counted, not just newlines inside the string.
      expect(key1?.lineEnd).toBe(3)
      expect(key1?.body).toContain('value on the next line')

      expect(key2).toBeDefined()
      expect(key2?.lineStart).toBe(4)
      expect(key2?.lineEnd).toBe(4)
    })

    it('bounds each key body by its own value, not the whole line, on minified json', async () => {
      // A single-line document with many top-level keys, each holding a sizeable object. The
      // regression this pins: body used to default to the key's whole source LINE, which on
      // minified JSON is the entire file -- so every key stored a full copy of the document and
      // total stored bytes grew as keys x filesize. A 1.5 MB, 1142-key real-world file inflated
      // global.db by 1.6 GB that way, which stretched reindex transactions past db.ts's 15s
      // busy_timeout and surfaced to users as "database is locked".
      const keyCount = 60
      const filler = 'x'.repeat(400)
      const entries = Array.from(
        { length: keyCount },
        (_, i) => `"key${i}":{"filler":"${filler}","n":${i}}`,
      )
      const content = `{${entries.join(',')}}`
      const result = await parseFixture('minified_wide.json', content)

      expect(result.symbols).toHaveLength(keyCount)

      // The invariant, stated as the property that actually failed: total stored body bytes
      // must scale with the document, not with keys x document. Asserting a per-key size cap
      // alone would not catch a regression that merely lowered the multiplier.
      const totalBody = result.symbols.reduce((n, s) => n + s.body.length, 0)
      expect(totalBody).toBeLessThan(content.length * 2)

      // Each body is the key plus its own value -- neither the whole file nor a bare fragment.
      const first = result.symbols.find((s) => s.name === 'key0')
      expect(first).toBeDefined()
      expect(first?.body).toContain('"key0"')
      expect(first?.body).toContain('"n":0')
      expect(first?.body).not.toContain('"key1"')
      expect(first?.body.length).toBeLessThan(content.length)
    })

    it('gives an object value a body and lineEnd covering the value, not just the key line', async () => {
      const content = ['{', '  "deps": {', '    "a": 1,', '    "b": 2', '  }', '}', ''].join('\n')
      const result = await parseFixture('object_value.json', content)

      const deps = result.symbols.find((s) => s.name === 'deps')
      expect(deps).toBeDefined()
      expect(deps?.lineStart).toBe(2)
      // Previously lineEnd was the key's own line (2) and body was just `"deps": {`, so
      // `read file::deps` returned an opening brace instead of the value.
      expect(deps?.lineEnd).toBe(5)
      expect(deps?.body).toContain('"b": 2')
      expect(deps?.body.trimEnd().endsWith('}')).toBe(true)
    })

    it('handles adversarial json without over-consuming or dropping top-level keys', async () => {
      const parse = parseFixture

      // Escaped quotes and escaped backslashes inside both key and value. An off-by-one in the
      // escape handling would either swallow the following key or split this one. Names come
      // back unescaped (`\"` -> `"`), which is the correct JSON reading of the key.
      const esc = await parse('escapes.json', '{"a\\"b":"v\\"x","tail\\\\":"end","z":1}')
      expect(esc.symbols.map((s) => s.name)).toEqual(['a"b', 'tail\\', 'z'])

      // A key whose value ends in an EVEN run of backslashes: the final quote is real, not
      // escaped, so the next key must still be seen.
      const evenSlash = await parse('even.json', '{"k":"ends\\\\\\\\","next":2}')
      expect(evenSlash.symbols.map((s) => s.name)).toContain('next')

      // CRLF line endings: lineEnd is derived by counting '\n', which CRLF still contains.
      const crlf = await parse('crlf.json', '{\r\n  "obj": {\r\n    "n": 1\r\n  }\r\n}\r\n')
      const obj = crlf.symbols.find((s) => s.name === 'obj')
      expect(obj?.lineStart).toBe(2)
      expect(obj?.lineEnd).toBe(4)

      // Mismatched closer: `[` must not be closed by `}`. The value body has to stop at the
      // offending character instead of running to EOF and swallowing the rest of the document.
      const mismatch = await parse('mismatch.json', '{"bad":[1,2}, "after":3}')
      const bad = mismatch.symbols.find((s) => s.name === 'bad')
      expect(bad).toBeDefined()
      expect(bad?.body).not.toContain('"after"')

      // Truncated container and truncated string: bounded, no throw, no hang.
      const truncObj = await parse('trunc_obj.json', '{"open": {"a": 1')
      expect(truncObj.symbols.map((s) => s.name)).toContain('open')
      const truncStr = await parse('trunc_str.json', '{"s": "never closed')
      expect(truncStr.symbols.map((s) => s.name)).toContain('s')

      // Deep nesting must not recurse -- the scanner is iterative, so this must not overflow.
      const depth = 5000
      const deep = await parse('deep.json', `{"d":${'['.repeat(depth)}${']'.repeat(depth)}}`)
      expect(deep.symbols.map((s) => s.name)).toEqual(['d'])
    })
  })

  describe('yaml symbols', () => {
    it('extracts top-level keys from yaml', async () => {
      const content = `name: my-app
version: 1.0.0
author: Test Author
config:
  debug: false
`

      const result = await parseFixture('test.yaml', content)

      expect(result.language).toBe('yaml')
      // Top-level keys only -- the nested "debug" key under config must not appear.
      expect(result.symbols.map((s) => s.name)).toEqual(['name', 'version', 'author', 'config'])
    })

    it('extracts kebab-case keys and ignores list-item lines', async () => {
      const content = `name: build
runs-on: ubuntu-latest
on-failure: retry
steps:
- uses: actions/checkout
`

      const result = await parseFixture('ci.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('runs-on')
      expect(names).toContain('on-failure')
      // A sequence item ("- uses: ...") must not be captured as a key named "uses" or "-".
      expect(names).not.toContain('uses')
      expect(names).not.toContain('-')
    })

    it('extracts a dotted flat-config key (regression: the yaml key regex character class omitted `.`, so a Spring-Boot/flat-config-style key like `server.host:` was silently skipped by the indexer even though the live section reader already found it)', async () => {
      const content = `server.host: localhost
server.port: 8080
plain_key: value
`

      const result = await parseFixture('flat.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toEqual(['server.host', 'server.port', 'plain_key'])
    })

    it('does not read a bare URL on its own line as a phantom `https` key (regression: the yaml key regex matched `:` unconditionally, so the scheme separator in a bare `https://example.com` value line was mistaken for a key/value split)', async () => {
      const content = `homepage:
https://example.com/docs
name: myproject
`

      const result = await parseFixture('url.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toEqual(['homepage', 'name'])
      expect(names).not.toContain('https')
    })

    it('does not treat a line inside a wrapped multi-line quoted value as a real key (regression: extractYamlSymbols had no state tracking for a double/single-quoted flow scalar wrapping across lines, so wrapped prose that happened to contain its own "word:" -shaped text -- e.g. mentioning "ratio: 16:9" -- was misread as a brand new top-level key)', async () => {
      const content = `description: "This spans multiple lines and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      const result = await parseFixture('wrapped.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')
    })

    it('does not drop every key after a plain scalar containing an apostrophe (regression: yamlOpenQuoteAfter scanned the whole value for any unbalanced quote, so an apostrophe in ordinary text like "It\'s working" was misread as opening a multi-line quoted string, silently swallowing every subsequent key)', async () => {
      const content = `title: It's working
name: World
port: 8080
host: localhost
`

      const result = await parseFixture('apostrophe.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('title')
      expect(names).toContain('name')
      expect(names).toContain('port')
      expect(names).toContain('host')
    })

    it('does not drop every key after a plain scalar whose trailing comment has an odd quote count', async () => {
      const content = `port: 8080  # TODO: fix "this
name: World
debug: true
`

      const result = await parseFixture('comment-quote.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('port')
      expect(names).toContain('name')
      expect(names).toContain('debug')
    })

    it('still tracks a genuine multi-line quoted value that opens with a leading quote (guard: leading-char gating must not break the real wrapped-value case)', async () => {
      const content = `description: "This spans multiple lines and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      const result = await parseFixture('leading-quote.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')
    })

    it('does not prematurely close a multi-line double-quoted value on an escaped quote (mutation-testing gap: yamlLineClosesQuote/yamlOpenQuoteAfter must skip past a backslash-escaped quote as two chars, not one, or a `\\"` inside a wrapped value is mistaken for the real closing quote and the next line is misread as a new top-level key)', async () => {
      const content = `description: "This has an escaped \\" quote and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      const result = await parseFixture('escaped-quote.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')
    })

    it('does not prematurely close a multi-line double-quoted value on an escaped quote on a continuation line (mutation-testing gap: yamlLineClosesQuote must skip past a backslash-escaped quote as two chars, not one)', async () => {
      const content = `description: "This spans multiple lines and
has an escaped \\" quote here and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      const result = await parseFixture('escaped-quote-continuation.yaml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')
    })
  })

  describe('toml symbols', () => {
    it('extracts sections and keys from toml', async () => {
      const content = `[project]
name = "myapp"
version = "1.0.0"

[tool.pytest]
testpaths = ["tests"]
`

      const result = await parseFixture('test.toml', content)

      expect(result.language).toBe('toml')
      expect(result.symbols.map((s) => s.name)).toEqual(['project', 'name', 'version', 'tool.pytest', 'testpaths'])
    })

    it('extracts kebab-case bare keys', async () => {
      const content = `[hints]
serve-diff-on-reread = true
max-bytes = 1024
`

      const result = await parseFixture('config.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('serve-diff-on-reread')
      expect(names).toContain('max-bytes')
    })

    it('extracts array-of-tables section names without the leading bracket', async () => {
      const content = `[package]
name = "myapp"

[[bin]]
name = "cli"

[[tool.metadata.x]]
value = 1
`

      const result = await parseFixture('Cargo.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('bin')
      expect(names).toContain('tool.metadata.x')
      expect(names).not.toContain('[bin')
    })

    it('skips spurious keys inside multi-line literal strings', async () => {
      const content = `[project]
name = "myapp"
example = '''
fake_key = "not a real key"
'''
version = "1.0.0"
`

      const result = await parseFixture('literal.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('fake_key')
      expect(names).toContain('name')
      expect(names).toContain('version')
    })

    it('handles complex multi-line strings correctly', async () => {
      const content = `[project]
description = """
fake_key = "still not real"
another_key = 5
"""
real_key = "yes"

[project.example]
name = "single-line triple quote: """not multiline""" still fine"
`

      const result = await parseFixture('complex.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('fake_key')
      expect(names).not.toContain('another_key')
      expect(names).toContain('real_key')
      expect(names).toContain('name')
      expect(names).toContain('project.example')
    })

    it('does not desync from a single-line """ value whose body contains an odd count of nested \'\'\' (regression: basic/literal triple-quote run counts were tallied independently per line via separate regex matches, so an inert \'\'\' sequence sitting inside an already-closed """..." span was misread as its own real open/close toggle, leaving a phantom multi-line literal-string state open that silently swallowed every key/section until an unrelated \'\'\' happened to appear later in the file)', async () => {
      const content = `[project]
note = """it's a test, delimiter looks like ''' here"""
real_key = "yes"
`

      const result = await parseFixture('nested.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('note')
      expect(names).toContain('real_key')
    })

    it('does not misread a multi-line array-of-arrays row as a phantom section (regression: no continuation tracking for multi-line arrays meant a nested-array row like `[1, 0, 0],` was matched by the section regex as a new table header)', async () => {
      const content = `[package]
name = "myapp"

matrix = [
  [1, 0, 0],
  [0, 1, 0],
]

[deps]
value = 1
`

      const result = await parseFixture('matrix.toml', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('matrix')
      expect(names).toContain('deps')
      expect(names).not.toContain('1, 0, 0')
      expect(names).not.toContain('0, 1, 0')
      expect(result.symbols.filter((s) => s.kind === 'section')).toHaveLength(2)
    })
  })

  describe('css symbols', () => {
    it('extracts selectors from css', async () => {
      const content = `.button {
  color: blue;
}
#header {
  background: white;
}
.active-item {
  font-weight: bold;
}
`

      const result = await parseFixture('test.css', content)

      expect(result.language).toBe('css')
      expect(result.symbols.map((s) => s.name)).toEqual(['.button', '#header', '.active-item'])
    })

    it('does not extract selectors from inside block comments', async () => {
      const content = `/*
.legacy-btn {
  color: red;
}
*/
.active {
  color: blue;
}
`

      const result = await parseFixture('test.css', content)

      // Regression: extractCssSymbols scanned raw lines without stripping /* */ comments
      // first, so a commented-out selector at column 0 was indexed as a live one.
      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('.legacy-btn')
      expect(names).toContain('.active')
    })

    it('extracts compound, pseudo-class, tag, and attribute selectors (regression: the original regex only matched a bare class/id selector immediately followed by a comma/space/brace, silently skipping compound selectors, pseudo-classes, plain tag/attribute selectors, and anything else it did not directly cover)', async () => {
      const content = `.foo.bar {
  color: red;
}
.foo:hover {
  color: blue;
}
div {
  margin: 0;
}
input[type="text"] {
  border: 1px solid;
}
`

      const result = await parseFixture('compound.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.foo.bar')
      expect(names).toContain('.foo:hover')
      expect(names).toContain('div')
      expect(names).toContain('input[type="text"]')
    })

    it('extracts a selector nested under @media/@supports without treating the at-rule header itself as a selector', async () => {
      const content = `@media (min-width: 600px) {
  .nested {
    color: green;
  }
}
@supports (display: grid) {
  .grid-item {
    display: grid;
  }
}
`

      const result = await parseFixture('media.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.nested')
      expect(names).toContain('.grid-item')
      expect(names.some((n) => n.startsWith('@media'))).toBe(false)
      expect(names.some((n) => n.startsWith('@supports'))).toBe(false)
    })

    it('splits a same-line comma-separated selector list into one symbol per selector', async () => {
      const content = `.a, .b {
  padding: 0;
}
`

      const result = await parseFixture('commalist.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')
    })

    it('indexes every selector in a multi-line comma-separated selector list, not just the brace-bearing line', async () => {
      const content = `.btn,
.btn-primary,
.btn-secondary {
  padding: 0;
}
`

      const result = await parseFixture('multiline-commalist.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.btn')
      expect(names).toContain('.btn-primary')
      expect(names).toContain('.btn-secondary')
    })

    it('indexes every selector in a multi-line comma-separated selector list when the opening brace is on its own line (regression: a bare selector-fragment continuation line and a brace-only line both fell through to the discard branch, silently dropping every accumulated fragment)', async () => {
      const content = `.a,
.b
{
  color: red;
}
`

      const result = await parseFixture('brace-own-line.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')
    })

    it('indexes every selector in a multi-line comma-separated selector list interrupted by an own-line block comment (regression: stripCstyleComments blanks a comment to an all-spaces line, which failed the continuation guard and fell into the discard branch, silently dropping every fragment accumulated before the comment)', async () => {
      const content = `.a,
/* primary button */
.b {
  padding: 0;
}
`

      const result = await parseFixture('comment-interrupted.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')
    })

    it('does not create a phantom selector from a `{` inside a quoted declaration value (regression: extractCssSymbols scanned raw lines for a rule-opening brace without stripping string literals first, so a pseudo-element content value like `content: "{";` was mistaken for a selector line)', async () => {
      const content = `.icon::before {
  content: "{";
  color: red;
}

.box {
  width: 10px;
}
`

      const result = await parseFixture('brace-in-string.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.icon::before')
      expect(names).toContain('.box')
      expect(names).not.toContain('content: "')
      expect(names).toHaveLength(2)
    })

    it('still captures a real selector whose attribute value legitimately contains a quoted string (guard: string-stripping the match must not blank a genuine selector)', async () => {
      const content = `input[type="text"] {
  color: blue;
}
`

      const result = await parseFixture('attr-selector.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('input[type="text"]')
    })

    it('does not split a selector-list on a comma nested inside a quoted attribute value or a functional pseudo-class (regression: the comma-separated selector-list splitter ran a plain split(\',\') over the raw selector text, so a comma inside `[data-x="a,b"]` or `:is(.foo, .bar)` was mistaken for a top-level selector-list separator and shredded the selector into bogus fragments)', async () => {
      const content = `input[data-x="a,b"] {
  color: red;
}
:is(.foo, .bar) {
  color: blue;
}
.one, .two {
  color: green;
}
`

      const result = await parseFixture('nested-comma.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('input[data-x="a,b"]')
      expect(names).toContain(':is(.foo, .bar)')
      expect(names).toContain('.one')
      expect(names).toContain('.two')
      expect(names).not.toContain('input[data-x="a')
      expect(names).not.toContain(':is(.foo')
    })

    it('does not drop a single selector written in Allman brace style, where the `{` sits alone on the line after the selector (regression: the continuation-candidate accumulator only started collecting a bare selector-fragment line when it ended in a trailing comma or a comma-list was already underway, so the FIRST and only fragment of an Allman-brace single selector - which has neither - fell through to the discard case and was silently dropped)', async () => {
      const content = `body
{
  margin: 0;
}

.button
{
  color: red;
}
`

      const result = await parseFixture('allman.css', content)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('body')
      expect(names).toContain('.button')
    })
  })

  describe('dockerfile symbols', () => {
    it('extracts directives from dockerfile', async () => {
      const content = `FROM node:18-alpine
RUN npm install
COPY . /app
WORKDIR /app
EXPOSE 3000
CMD ["node", "server.js"]
`

      const result = await parseFixture('Dockerfile', content)

      expect(result.language).toBe('dockerfile')
      // Pin the exact directive count and their names -- length > 0 plus a vacuously-true
      // Array.prototype.every check (which passes even on an empty array) would miss a
      // regression that dropped some directives or silently renamed them.
      expect(result.symbols).toHaveLength(6)
      const names = result.symbols.map((s) => s.name)
      expect(names).toEqual([
        'FROM node:18-alpine',
        'RUN npm install',
        'COPY . /app',
        'WORKDIR /app',
        'EXPOSE 3000',
        'CMD ["node", "server.js"]',
      ])
      const kinds = result.symbols.map((s) => s.kind)
      expect(kinds.every((k) => k === 'directive')).toBe(true)
    })

    it('extracts ARG/LABEL/VOLUME/USER/HEALTHCHECK/ONBUILD/SHELL/STOPSIGNAL/MAINTAINER directives (regression: extractDockerfileSymbols only recognized FROM/RUN/COPY/ADD/EXPOSE/ENV/WORKDIR/CMD/ENTRYPOINT, silently dropping every other real Dockerfile instruction)', async () => {
      const content = `FROM node:18-alpine
ARG BUILD_ENV=production
LABEL maintainer="team@example.com"
VOLUME /data
USER node
HEALTHCHECK CMD curl -f http://localhost/ || exit 1
ONBUILD RUN echo hi
SHELL ["/bin/bash", "-c"]
STOPSIGNAL SIGTERM
MAINTAINER Old Style <old@example.com>
`

      const result = await parseFixture('Dockerfile', content)

      const names = result.symbols.map((s) => s.name)
      expect(names.some((n) => n.startsWith('ARG '))).toBe(true)
      expect(names.some((n) => n.startsWith('LABEL '))).toBe(true)
      expect(names.some((n) => n.startsWith('VOLUME '))).toBe(true)
      expect(names.some((n) => n.startsWith('USER '))).toBe(true)
      expect(names.some((n) => n.startsWith('HEALTHCHECK '))).toBe(true)
      expect(names.some((n) => n.startsWith('ONBUILD '))).toBe(true)
      expect(names.some((n) => n.startsWith('SHELL '))).toBe(true)
      expect(names.some((n) => n.startsWith('STOPSIGNAL '))).toBe(true)
      expect(names.some((n) => n.startsWith('MAINTAINER '))).toBe(true)
    })

    it('does not misread a backslash-continued shell line as a new directive (regression: env VAR=val cmd inside a RUN continuation was misread as a standalone ENV directive)', async () => {
      const content = `FROM node:22
RUN apt-get update && \\
    env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 && \\
    npm ci
COPY . /app
`

      const result = await parseFixture('Dockerfile', content)

      const names = result.symbols.map((s) => s.name)
      expect(names.some((n) => n.startsWith('FROM '))).toBe(true)
      expect(names.some((n) => n.startsWith('RUN '))).toBe(true)
      expect(names.some((n) => n.startsWith('COPY '))).toBe(true)
      expect(names.some((n) => n.startsWith('ENV '))).toBe(false)
      expect(result.symbols).toHaveLength(3)
    })

    it('does not swallow a real directive following a comment line that ends in a backslash (regression: a whole-line # comment ending in \\ set the continuation flag from any trailing-backslash line with no comment special-case, so the next real directive was misread as leftover continuation text and silently dropped)', async () => {
      const content = `FROM node:20
# build steps below \\
RUN echo hello
COPY . .
`

      const result = await parseFixture('Dockerfile', content)

      const names = result.symbols.map((s) => s.name)
      expect(names.some((n) => n.startsWith('RUN '))).toBe(true)
      expect(names.some((n) => n.startsWith('COPY '))).toBe(true)
      expect(result.symbols).toHaveLength(3)
    })
  })

  // Line-based (non-tree-sitter) adapters used to give every symbol a one-line placeholder span
  // (lineEnd === lineStart, body === the signature line), so `read "file::symbol"` returned only
  // the declaration, not the body. These assert the real block span now reaches the closing
  // brace/`end`, WITHOUT over-running into the next sibling, and that a brace hidden inside a
  // string or heredoc never closes (C#) or opens (bash/elixir) a span. Each asserts
  // lineEnd > lineStart first: that structural half is what goes red on the pre-fix code, where
  // every span was a single line. Run through the real parseFile dispatch, so the C-style case
  // exercises the production assignBraceBlockSpans wrapper rather than a direct extractor call.
  describe('block spans for line-based languages', () => {
    it('gives a C# method a real block span via the dispatch wrapper, quote-aware', async () => {
      const content = [
        'public class Widget',
        '{',
        '    public int Add(int a, int b)',
        '    {',
        '        var s = "}";',
        '        return a + b;',
        '    }',
        '',
        '    public int Sub(int a, int b)',
        '    {',
        '        return a - b;',
        '    }',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('Widget.cs', content)
      const add = result.symbols.find((s) => s.name === 'Add')
      expect(add).toBeDefined()
      expect(add?.lineStart).toBe(3)
      expect(add?.lineEnd).toBe(7)
      expect(add?.lineEnd).toBeGreaterThan(add?.lineStart ?? 0)
      expect(add?.body).toContain('return a + b')
      // The `"}"` string literal on line 5 must not have closed the span early.
      expect(add?.body).toContain('var s = "}"')
      // The span must not have run on into the next method.
      expect(add?.body).not.toContain('Sub')
    })

    it('gives a bash function a real block span, masking a brace inside a heredoc', async () => {
      const content = [
        'emit() {',
        "  cat <<'INNER'",
        '  this heredoc has an unbalanced { brace',
        'INNER',
        '  echo done',
        '}',
        '',
        'second() {',
        '  echo hi',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('s.sh', content)
      const emit = result.symbols.find((s) => s.name === 'emit')
      expect(emit).toBeDefined()
      expect(emit?.lineStart).toBe(1)
      expect(emit?.lineEnd).toBe(6)
      expect(emit?.lineEnd).toBeGreaterThan(emit?.lineStart ?? 0)
      expect(emit?.body).toContain('echo done')
      // The `{` inside the heredoc must not have run the span to end-of-file and swallowed `second`.
      expect(emit?.body).not.toContain('second()')
      const second = result.symbols.find((s) => s.name === 'second')
      expect(second?.lineStart).toBe(8)
      expect(second?.lineEnd).toBe(10)
    })

    it('gives a lua function a real block span that ends at its own `end`', async () => {
      const content = [
        'local function outer(x)',
        '  local y = x + 1',
        '  return y',
        'end',
        '',
        'function M.method(a)',
        '  return a * 2',
        'end',
        '',
      ].join('\n')
      const result = await parseFixture('m.lua', content)
      const outer = result.symbols.find((s) => s.name === 'outer')
      expect(outer).toBeDefined()
      expect(outer?.lineStart).toBe(1)
      expect(outer?.lineEnd).toBe(4)
      expect(outer?.lineEnd).toBeGreaterThan(outer?.lineStart ?? 0)
      expect(outer?.body).toContain('return y')
      expect(outer?.body).not.toContain('M.method')
    })

    it('gives an elixir def a real block span, masking a fake def in a @moduledoc heredoc', async () => {
      const content = [
        'defmodule Calc do',
        '  @moduledoc """',
        '  def not_a_real_function(x) do',
        '    x',
        '  end',
        '  """',
        '',
        '  def add(a, b) do',
        '    sum = a + b',
        '    sum',
        '  end',
        '',
        '  defp helper(x) do',
        '    x * 2',
        '  end',
        'end',
        '',
      ].join('\n')
      const result = await parseFixture('calc.ex', content)
      // The `def not_a_real_function` inside the @moduledoc heredoc must not be indexed at all.
      expect(result.symbols.map((s) => s.name)).not.toContain('not_a_real_function')
      const add = result.symbols.find((s) => s.name === 'add')
      expect(add).toBeDefined()
      expect(add?.lineStart).toBe(8)
      expect(add?.lineEnd).toBe(11)
      expect(add?.lineEnd).toBeGreaterThan(add?.lineStart ?? 0)
      expect(add?.body).toContain('sum = a + b')
      // The span must end at its own `end`, not swallow the private helper below it.
      expect(add?.body).not.toContain('helper')
    })

    it('widens a C# method whose signature line carries a block comment holding stray braces', async () => {
      // A `/* { } */` comment on the signature line must not derail the brace search: without
      // block-comment skipping, findBlockOpenBrace grabs the comment's `{` and
      // findMatchingBraceEndLine closes on the comment's `}` at the same line, so the method never
      // widens (stays lineEnd === lineStart) and `read Cmt.cs::Compute` returns only its signature.
      const content = [
        'public class Widget',
        '{',
        '    public int Compute() /* returns { the } value */',
        '    {',
        '        return 42;',
        '    }',
        '    public int Other()',
        '    {',
        '        return 7;',
        '    }',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('Cmt.cs', content)
      const compute = result.symbols.find((s) => s.name === 'Compute')
      expect(compute).toBeDefined()
      expect(compute?.lineStart).toBe(3)
      expect(compute?.lineEnd).toBe(6)
      expect(compute?.lineEnd).toBeGreaterThan(compute?.lineStart ?? 0)
      expect(compute?.body).toContain('return 42')
      // Must not have run on into the next method.
      expect(compute?.body).not.toContain('Other')
    })

    it('does not let a semicolon-less declaration swallow a following control-flow block', async () => {
      // Scala has no `;` statement terminator, so a `val` above a bare `if (...) {}` used to have
      // its span widened to include the unrelated if-block. The keyword stop must keep `base` a
      // one-line symbol while the real method below still widens normally.
      const content = [
        'class Calc {',
        '  val base = 10',
        '  if (base > 5) {',
        '    println("big")',
        '  }',
        '  def add(x: Int): Int = {',
        '    x + base',
        '  }',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('Sc2.scala', content)
      const base = result.symbols.find((s) => s.name === 'base')
      expect(base).toBeDefined()
      expect(base?.lineStart).toBe(2)
      // The if-block on lines 3-5 must NOT have been attached to `base`.
      expect(base?.lineEnd).toBe(2)
      expect(base?.body).not.toContain('println')
      const add = result.symbols.find((s) => s.name === 'add')
      expect(add?.lineStart).toBe(6)
      expect(add?.lineEnd).toBe(8)
      expect(add?.body).toContain('x + base')
    })

    it('still widens an Allman-brace multi-line signature (keyword stop must not misfire)', async () => {
      // The brace opens on its own line after a `)` at depth 0. That line starts with `{`, not a
      // control keyword, so the finding-1 keyword stop must leave this legitimate widening intact.
      const content = [
        'public class Svc',
        '{',
        '    public int Sum(',
        '        int a,',
        '        int b)',
        '    {',
        '        return a + b;',
        '    }',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('Allman.cs', content)
      const sum = result.symbols.find((s) => s.name === 'Sum')
      expect(sum).toBeDefined()
      expect(sum?.lineStart).toBe(3)
      expect(sum?.lineEnd).toBe(8)
      expect(sum?.body).toContain('return a + b')
    })

    it('widens a PowerShell function despite a <# #> block comment with stray braces', async () => {
      const content = [
        'function Get-Thing <# opens { a brace #> {',
        '    return 1',
        '}',
        'function Get-Other {',
        '    return 2',
        '}',
        '',
      ].join('\n')
      const result = await parseFixture('Ps.ps1', content)
      const thing = result.symbols.find((s) => s.name === 'Get-Thing')
      expect(thing).toBeDefined()
      expect(thing?.lineStart).toBe(1)
      expect(thing?.lineEnd).toBe(3)
      expect(thing?.body).toContain('return 1')
      expect(thing?.body).not.toContain('Get-Other')
    })

    it('does not stretch a symbol to end-of-file when its brace never closes', async () => {
      // An unbalanced/unclosed brace (a file being edited) must yield no widening rather than a
      // span running to EOF: findMatchingBraceEndLine returns -1 (noMatchValue) and the symbol is
      // left at its signature line.
      const content = [
        'public class Broken',
        '{',
        '    public void Leak()',
        '    {',
        '        if (x)',
        '        {',
        '            // never closed',
        '            work();',
        '            more();',
        '            evenmore();',
        '',
      ].join('\n')
      const result = await parseFixture('Broken.cs', content)
      const leak = result.symbols.find((s) => s.name === 'Leak')
      expect(leak).toBeDefined()
      expect(leak?.lineStart).toBe(3)
      // No matching close brace, so the symbol must NOT span to the end of the file.
      expect(leak?.lineEnd).toBe(3)
    })
  })

  describe('language detection', () => {
    it('detects ruby files', async () => {
      const result = await parseFixture('test.rb', 'def hello\n  puts "world"\nend\n')

      expect(result.language).toBe('ruby')
    })

    it('detects java files', async () => {
      const result = await parseFixture('Test.java', 'public class Test {}\n')

      expect(result.language).toBe('java')
    })

    it('detects css files', async () => {
      const result = await parseFixture('test.css', '.test { }\n')

      expect(result.language).toBe('css')
    })

    it('detects Dockerfile by name', async () => {
      const result = await parseFixture('Dockerfile', 'FROM ubuntu\n')

      expect(result.language).toBe('dockerfile')
    })

    it('detects scss as css', async () => {
      const result = await parseFixture('test.scss', '$color: blue;\n')

      expect(result.language).toBe('css')
    })
  })

  describe('edge cases', () => {
    it('handles empty files', async () => {
      const result = await parseFixture('empty.md', '')

      expect(result.language).toBe('markdown')
      expect(result.symbols).toHaveLength(0)
    })

    it('handles malformed json', async () => {
      const result = await parseFixture('test.json', '{ invalid json content }')

      expect(result.language).toBe('json')
      expect(result.symbols).toHaveLength(0)
    })

    it('handles markdown with mixed heading styles', async () => {
      const content = `# Title
## Subtitle
Text content
`

      const result = await parseFixture('test.md', content)

      expect(result.symbols.length).toBe(2)
      expect(result.symbols[0]?.kind).toBe('heading')
      expect(result.symbols[1]?.kind).toBe('heading')
    })
  })
})
