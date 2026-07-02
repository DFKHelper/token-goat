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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
    })
  })

  describe('language detection', () => {
    it('detects ruby files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const rbFile = path.join(tmpDir, 'test.rb')

      fs.writeFileSync(rbFile, 'def hello\n  puts "world"\nend\n')
      const result = await parseFile(rbFile)

      expect(result.language).toBe('ruby')

      fs.rmSync(tmpDir, { recursive: true })
    })

    it('detects java files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const javaFile = path.join(tmpDir, 'Test.java')

      fs.writeFileSync(javaFile, 'public class Test {}\n')
      const result = await parseFile(javaFile)

      expect(result.language).toBe('java')

      fs.rmSync(tmpDir, { recursive: true })
    })

    it('detects css files', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const cssFile = path.join(tmpDir, 'test.css')

      fs.writeFileSync(cssFile, '.test { }\n')
      const result = await parseFile(cssFile)

      expect(result.language).toBe('css')

      fs.rmSync(tmpDir, { recursive: true })
    })

    it('detects Dockerfile by name', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const dockerFile = path.join(tmpDir, 'Dockerfile')

      fs.writeFileSync(dockerFile, 'FROM ubuntu\n')
      const result = await parseFile(dockerFile)

      expect(result.language).toBe('dockerfile')

      fs.rmSync(tmpDir, { recursive: true })
    })

    it('detects scss as css', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const scssFile = path.join(tmpDir, 'test.scss')

      fs.writeFileSync(scssFile, '$color: blue;\n')
      const result = await parseFile(scssFile)

      expect(result.language).toBe('css')

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
    })

    it('handles malformed json', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
      const jsonFile = path.join(tmpDir, 'test.json')

      fs.writeFileSync(jsonFile, '{ invalid json content }')
      const result = await parseFile(jsonFile)

      expect(result.language).toBe('json')
      expect(result.symbols).toHaveLength(0)

      fs.rmSync(tmpDir, { recursive: true })
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

      fs.rmSync(tmpDir, { recursive: true })
    })
  })
})
