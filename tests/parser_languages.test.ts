import { describe, it, expect } from 'vitest'
import { parseFile } from '../src/parser.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('parser language support', () => {
  describe('markdown symbols', () => {
    it('extracts headings from markdown', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const mdFile = path.join(tmpDir, 'test.md')

      const content = `# Main Title
## Section One
### Subsection
## Section Two
Some content here
`

      fs.writeFileSync(mdFile, content)
      const result = await parseFile(mdFile)

      expect(result.language).toBe('markdown')
      expect(result.symbols).toHaveLength(4)
      expect(result.symbols.map((s) => s.name)).toEqual([
        'Main Title',
        'Section One',
        'Subsection',
        'Section Two',
      ])
      expect(result.symbols[0]?.kind).toBe('heading')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('json symbols', () => {
    it('extracts top-level keys from json', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const jsonFile = path.join(tmpDir, 'test.json')

      const content = `{
  "name": "test",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.0.0"
  }
}
`

      fs.writeFileSync(jsonFile, content)
      const result = await parseFile(jsonFile)

      expect(result.language).toBe('json')
      expect(result.symbols.length).toBeGreaterThan(0)
      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('name')
      expect(names).toContain('version')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts keys from single-line and brace-sharing json, top-level only', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const minified = path.join(tmpDir, 'min.json')
      fs.writeFileSync(minified, '{"name":"foo","version":"1.0","deps":{"lodash":"^4"}}')
      const minResult = await parseFile(minified)
      const minNames = minResult.symbols.map((s) => s.name)
      expect(minNames).toContain('name')
      expect(minNames).toContain('version')
      expect(minNames).toContain('deps')
      expect(minNames).not.toContain('lodash')

      const nested = path.join(tmpDir, 'nested.json')
      fs.writeFileSync(nested, '{ "a": { "b": 1 }, "c": 2 }')
      const nestedResult = await parseFile(nested)
      const nestedNames = nestedResult.symbols.map((s) => s.name)
      expect(nestedNames).toContain('a')
      expect(nestedNames).toContain('c')
      expect(nestedNames).not.toContain('b')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('computes lineEnd/body spanning the full value when a string value contains an embedded literal newline', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const jsonFile = path.join(tmpDir, 'multiline_value.json')

      const content = [
        '{',
        '  "key1": "line one',
        'line two",',
        '  "key2": "value2"',
        '}',
        '',
      ].join('\n')
      fs.writeFileSync(jsonFile, content)
      const result = await parseFile(jsonFile)

      const key1 = result.symbols.find((s) => s.name === 'key1')
      const key2 = result.symbols.find((s) => s.name === 'key2')

      expect(key1).toBeDefined()
      expect(key1?.lineStart).toBe(2)
      expect(key1?.lineEnd).toBe(3)
      expect(key1?.body).toContain('line two')

      expect(key2).toBeDefined()
      expect(key2?.lineStart).toBe(4)
      expect(key2?.lineEnd).toBe(4)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('counts newlines skipped between the colon and the value opening quote when computing lineEnd', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const jsonFile = path.join(tmpDir, 'colon_gap.json')

      const content = [
        '{',
        '  "key1":',
        '    "value on the next line",',
        '  "key2": "value2"',
        '}',
        '',
      ].join('\n')
      fs.writeFileSync(jsonFile, content)
      const result = await parseFile(jsonFile)

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

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('yaml symbols', () => {
    it('extracts top-level keys from yaml', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'test.yaml')

      const content = `name: my-app
version: 1.0.0
author: Test Author
config:
  debug: false
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      expect(result.language).toBe('yaml')
      expect(result.symbols.length).toBeGreaterThan(0)
      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('name')
      expect(names).toContain('version')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts kebab-case keys and ignores list-item lines', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'ci.yaml')

      const content = `name: build
runs-on: ubuntu-latest
on-failure: retry
steps:
- uses: actions/checkout
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('runs-on')
      expect(names).toContain('on-failure')
      // A sequence item ("- uses: ...") must not be captured as a key named "uses" or "-".
      expect(names).not.toContain('uses')
      expect(names).not.toContain('-')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not treat a line inside a wrapped multi-line quoted value as a real key (regression: extractYamlSymbols had no state tracking for a double/single-quoted flow scalar wrapping across lines, so wrapped prose that happened to contain its own "word:" -shaped text -- e.g. mentioning "ratio: 16:9" -- was misread as a brand new top-level key)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'wrapped.yaml')

      const content = `description: "This spans multiple lines and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not drop every key after a plain scalar containing an apostrophe (regression: yamlOpenQuoteAfter scanned the whole value for any unbalanced quote, so an apostrophe in ordinary text like "It\'s working" was misread as opening a multi-line quoted string, silently swallowing every subsequent key)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'apostrophe.yaml')

      const content = `title: It's working
name: World
port: 8080
host: localhost
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('title')
      expect(names).toContain('name')
      expect(names).toContain('port')
      expect(names).toContain('host')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not drop every key after a plain scalar whose trailing comment has an odd quote count', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'comment-quote.yaml')

      const content = `port: 8080  # TODO: fix "this
name: World
debug: true
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('port')
      expect(names).toContain('name')
      expect(names).toContain('debug')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('still tracks a genuine multi-line quoted value that opens with a leading quote (guard: leading-char gating must not break the real wrapped-value case)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const yamlFile = path.join(tmpDir, 'leading-quote.yaml')

      const content = `description: "This spans multiple lines and
fake_key: this looks like a key but is really string content
still wrapping"
real_key: value
`

      fs.writeFileSync(yamlFile, content)
      const result = await parseFile(yamlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('description')
      expect(names).toContain('real_key')
      expect(names).not.toContain('fake_key')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('toml symbols', () => {
    it('extracts sections and keys from toml', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'test.toml')

      const content = `[project]
name = "myapp"
version = "1.0.0"

[tool.pytest]
testpaths = ["tests"]
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      expect(result.language).toBe('toml')
      expect(result.symbols.length).toBeGreaterThan(0)
      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('project')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts kebab-case bare keys', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'config.toml')

      const content = `[hints]
serve-diff-on-reread = true
max-bytes = 1024
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('serve-diff-on-reread')
      expect(names).toContain('max-bytes')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts array-of-tables section names without the leading bracket', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'Cargo.toml')

      const content = `[package]
name = "myapp"

[[bin]]
name = "cli"

[[tool.metadata.x]]
value = 1
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('bin')
      expect(names).toContain('tool.metadata.x')
      expect(names).not.toContain('[bin')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('skips spurious keys inside multi-line literal strings', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'literal.toml')

      const content = `[project]
name = "myapp"
example = '''
fake_key = "not a real key"
'''
version = "1.0.0"
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('fake_key')
      expect(names).toContain('name')
      expect(names).toContain('version')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('handles complex multi-line strings correctly', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'complex.toml')

      const content = `[project]
description = """
fake_key = "still not real"
another_key = 5
"""
real_key = "yes"

[project.example]
name = "single-line triple quote: """not multiline""" still fine"
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('fake_key')
      expect(names).not.toContain('another_key')
      expect(names).toContain('real_key')
      expect(names).toContain('name')
      expect(names).toContain('project.example')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not desync from a single-line """ value whose body contains an odd count of nested \'\'\' (regression: basic/literal triple-quote run counts were tallied independently per line via separate regex matches, so an inert \'\'\' sequence sitting inside an already-closed """..." span was misread as its own real open/close toggle, leaving a phantom multi-line literal-string state open that silently swallowed every key/section until an unrelated \'\'\' happened to appear later in the file)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const tomlFile = path.join(tmpDir, 'nested.toml')

      const content = `[project]
note = """it's a test, delimiter looks like ''' here"""
real_key = "yes"
`

      fs.writeFileSync(tomlFile, content)
      const result = await parseFile(tomlFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('note')
      expect(names).toContain('real_key')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('css symbols', () => {
    it('extracts selectors from css', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'test.css')

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

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      expect(result.language).toBe('css')
      expect(result.symbols.length).toBeGreaterThan(0)
      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.button')
      expect(names).toContain('#header')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not extract selectors from inside block comments', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'test.css')

      const content = `/*
.legacy-btn {
  color: red;
}
*/
.active {
  color: blue;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      // Regression: extractCssSymbols scanned raw lines without stripping /* */ comments
      // first, so a commented-out selector at column 0 was indexed as a live one.
      const names = result.symbols.map((s) => s.name)
      expect(names).not.toContain('.legacy-btn')
      expect(names).toContain('.active')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts compound, pseudo-class, tag, and attribute selectors (regression: the original regex only matched a bare class/id selector immediately followed by a comma/space/brace, silently skipping compound selectors, pseudo-classes, plain tag/attribute selectors, and anything else it did not directly cover)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'compound.css')

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

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.foo.bar')
      expect(names).toContain('.foo:hover')
      expect(names).toContain('div')
      expect(names).toContain('input[type="text"]')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts a selector nested under @media/@supports without treating the at-rule header itself as a selector', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'media.css')

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

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.nested')
      expect(names).toContain('.grid-item')
      expect(names.some((n) => n.startsWith('@media'))).toBe(false)
      expect(names.some((n) => n.startsWith('@supports'))).toBe(false)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('splits a same-line comma-separated selector list into one symbol per selector', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'commalist.css')

      const content = `.a, .b {
  padding: 0;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('indexes every selector in a multi-line comma-separated selector list, not just the brace-bearing line', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'multiline-commalist.css')

      const content = `.btn,
.btn-primary,
.btn-secondary {
  padding: 0;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.btn')
      expect(names).toContain('.btn-primary')
      expect(names).toContain('.btn-secondary')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('indexes every selector in a multi-line comma-separated selector list when the opening brace is on its own line (regression: a bare selector-fragment continuation line and a brace-only line both fell through to the discard branch, silently dropping every accumulated fragment)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'brace-own-line.css')

      const content = `.a,
.b
{
  color: red;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('indexes every selector in a multi-line comma-separated selector list interrupted by an own-line block comment (regression: stripCstyleComments blanks a comment to an all-spaces line, which failed the continuation guard and fell into the discard branch, silently dropping every fragment accumulated before the comment)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'comment-interrupted.css')

      const content = `.a,
/* primary button */
.b {
  padding: 0;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.a')
      expect(names).toContain('.b')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not create a phantom selector from a `{` inside a quoted declaration value (regression: extractCssSymbols scanned raw lines for a rule-opening brace without stripping string literals first, so a pseudo-element content value like `content: "{";` was mistaken for a selector line)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'brace-in-string.css')

      const content = `.icon::before {
  content: "{";
  color: red;
}

.box {
  width: 10px;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('.icon::before')
      expect(names).toContain('.box')
      expect(names).not.toContain('content: "')
      expect(names).toHaveLength(2)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('still captures a real selector whose attribute value legitimately contains a quoted string (guard: string-stripping the match must not blank a genuine selector)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'attr-selector.css')

      const content = `input[type="text"] {
  color: blue;
}
`

      fs.writeFileSync(cssFile, content)
      const result = await parseFile(cssFile)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('input[type="text"]')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('dockerfile symbols', () => {
    it('extracts directives from dockerfile', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const dockerFile = path.join(tmpDir, 'Dockerfile')

      const content = `FROM node:18-alpine
RUN npm install
COPY . /app
WORKDIR /app
EXPOSE 3000
CMD ["node", "server.js"]
`

      fs.writeFileSync(dockerFile, content)
      const result = await parseFile(dockerFile)

      expect(result.language).toBe('dockerfile')
      expect(result.symbols.length).toBeGreaterThan(0)
      const kinds = result.symbols.map((s) => s.kind)
      expect(kinds.every((k) => k === 'directive')).toBe(true)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('extracts ARG/LABEL/VOLUME/USER/HEALTHCHECK/ONBUILD/SHELL/STOPSIGNAL/MAINTAINER directives (regression: extractDockerfileSymbols only recognized FROM/RUN/COPY/ADD/EXPOSE/ENV/WORKDIR/CMD/ENTRYPOINT, silently dropping every other real Dockerfile instruction)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const dockerFile = path.join(tmpDir, 'Dockerfile')

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

      fs.writeFileSync(dockerFile, content)
      const result = await parseFile(dockerFile)

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

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does not misread a backslash-continued shell line as a new directive (regression: env VAR=val cmd inside a RUN continuation was misread as a standalone ENV directive)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const dockerFile = path.join(tmpDir, 'Dockerfile')

      const content = `FROM node:22
RUN apt-get update && \\
    env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 && \\
    npm ci
COPY . /app
`

      fs.writeFileSync(dockerFile, content)
      const result = await parseFile(dockerFile)

      const names = result.symbols.map((s) => s.name)
      expect(names.some((n) => n.startsWith('FROM '))).toBe(true)
      expect(names.some((n) => n.startsWith('RUN '))).toBe(true)
      expect(names.some((n) => n.startsWith('COPY '))).toBe(true)
      expect(names.some((n) => n.startsWith('ENV '))).toBe(false)
      expect(result.symbols).toHaveLength(3)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('language detection', () => {
    it('detects ruby files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const rbFile = path.join(tmpDir, 'test.rb')

      fs.writeFileSync(rbFile, 'def hello\n  puts "world"\nend\n')
      const result = await parseFile(rbFile)

      expect(result.language).toBe('ruby')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('detects java files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const javaFile = path.join(tmpDir, 'Test.java')

      fs.writeFileSync(javaFile, 'public class Test {}\n')
      const result = await parseFile(javaFile)

      expect(result.language).toBe('java')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('detects css files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'test.css')

      fs.writeFileSync(cssFile, '.test { }\n')
      const result = await parseFile(cssFile)

      expect(result.language).toBe('css')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('detects Dockerfile by name', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const dockerFile = path.join(tmpDir, 'Dockerfile')

      fs.writeFileSync(dockerFile, 'FROM ubuntu\n')
      const result = await parseFile(dockerFile)

      expect(result.language).toBe('dockerfile')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('detects scss as css', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const scssFile = path.join(tmpDir, 'test.scss')

      fs.writeFileSync(scssFile, '$color: blue;\n')
      const result = await parseFile(scssFile)

      expect(result.language).toBe('css')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('edge cases', () => {
    it('handles empty files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const mdFile = path.join(tmpDir, 'empty.md')

      fs.writeFileSync(mdFile, '')
      const result = await parseFile(mdFile)

      expect(result.language).toBe('markdown')
      expect(result.symbols).toHaveLength(0)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('handles malformed json', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const jsonFile = path.join(tmpDir, 'test.json')

      fs.writeFileSync(jsonFile, '{ invalid json content }')
      const result = await parseFile(jsonFile)

      expect(result.language).toBe('json')
      expect(result.symbols).toHaveLength(0)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('handles markdown with mixed heading styles', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const mdFile = path.join(tmpDir, 'test.md')

      const content = `# Title
## Subtitle
Text content
`

      fs.writeFileSync(mdFile, content)
      const result = await parseFile(mdFile)

      expect(result.symbols.length).toBe(2)
      expect(result.symbols[0]?.kind).toBe('heading')
      expect(result.symbols[1]?.kind).toBe('heading')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })
})
