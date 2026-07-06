import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  extractSection,
  listSections,
  listAllSections,
  normalizeHeading,
  readSection,
  findContainingSection,
} from '../src/section_reader.js'

const tmpDirs: string[] = []

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-sec-'))
  tmpDirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

const MD = [
  '# Title',
  'intro line',
  '',
  '## Install',
  'run the installer',
  'second install line',
  '',
  '## Usage',
  'how to use it',
  '',
  '## Install',
  'second install section body',
  '',
].join('\n')

describe('extractSection', () => {
  it('finds a markdown ## heading and returns its content', () => {
    const result = extractSection(MD, 'Usage')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Usage')
    expect(result?.content).toBe('## Usage\nhow to use it')
  })

  it('returns null for a missing section', () => {
    expect(extractSection(MD, 'Nonexistent')).toBeNull()
  })

  it('matches case-insensitively', () => {
    const result = extractSection(MD, 'usage')
    expect(result?.heading).toBe('Usage')
  })

  it('returns the first occurrence by default for duplicate headings', () => {
    const result = extractSection(MD, 'Install')
    expect(result?.content).toContain('run the installer')
    expect(result?.content).not.toContain('second install section body')
  })

  it('disambiguates duplicate headings with a #N suffix', () => {
    const result = extractSection(MD, 'Install#2')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('second install section body')
    expect(result?.content).not.toContain('run the installer')
  })

  it('returns null when the ordinal exceeds the match count', () => {
    expect(extractSection(MD, 'Install#5')).toBeNull()
  })

  it('reaches a heading whose literal text ends in #<digits> (e.g. "Issue #42")', () => {
    const md = ['# Title', '## Issue #42', 'bug details here', '## Other', 'x'].join('\n')
    const result = extractSection(md, 'Issue #42')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Issue #42')
    expect(result?.content).toBe('## Issue #42\nbug details here')
  })

  it('preserves a trailing # in heading text (C#) instead of stripping it as a closing sequence', () => {
    const md = ['# Lang notes', '## C#', 'dotnet content', '## Other', 'x'].join('\n')
    const result = extractSection(md, 'C#')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('C#')
    expect(result?.content).toBe('## C#\ndotnet content')
  })

  it('does not treat a #-comment inside a fenced code block as a header', () => {
    const md = [
      '# Title',
      '',
      '## Install',
      '',
      'Run the installer:',
      '',
      '```bash',
      '# install dependencies',
      'npm install -g token-goat',
      '```',
      '',
      'More install notes here.',
      '',
      '## Usage',
      '',
      'Usage text.',
    ].join('\n')

    const result = extractSection(md, 'Install')
    expect(result).not.toBeNull()
    // The whole Install section must be returned, not truncated at the fenced `# install dependencies` comment line.
    expect(result?.content).toContain('npm install -g token-goat')
    expect(result?.content).toContain('More install notes here.')
    // The fenced comment must not become a selectable section of its own.
    expect(extractSection(md, 'install dependencies')).toBeNull()
  })

  it('extracts a TOML [section] table', () => {
    const toml = [
      '[project]',
      'name = "demo"',
      'version = "1.0"',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
    ].join('\n')
    const result = extractSection(toml, 'project')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('name = "demo"')
    expect(result?.content).not.toContain('line-length')
  })

  it('includes nested TOML subtables but stops at a sibling table', () => {
    const toml = [
      '[tool.ruff]',
      'line-length = 100',
      '',
      '[tool.ruff.lint]',
      'select = ["E"]',
      '',
      '[tool.mypy]',
      'strict = true',
      '',
    ].join('\n')
    const result = extractSection(toml, 'tool.ruff')
    expect(result).not.toBeNull()
    // The nested [tool.ruff.lint] subtable is part of the tool.ruff section...
    expect(result?.content).toContain('[tool.ruff.lint]')
    expect(result?.content).toContain('select = ["E"]')
    // ...but the sibling [tool.mypy] table is not.
    expect(result?.content).not.toContain('[tool.mypy]')
    expect(result?.content).not.toContain('strict = true')
  })
})

describe('extractSection — CRLF line endings', () => {
  const CRLF = '## A\r\n\r\ncontent A\r\n\r\n## B\r\n\r\ncontent B\r\n'
  const LF = '## A\n\ncontent A\n\n## B\n\ncontent B\n'

  it('trims the trailing blank line on a CRLF file the same as on the LF-equivalent', () => {
    const crlfResult = extractSection(CRLF, 'A')
    const lfResult = extractSection(LF, 'A')

    expect(crlfResult).not.toBeNull()
    expect(lfResult).not.toBeNull()

    // The last line of the returned content must not be a blank/`\r`-only separator line.
    const lastCrlfLine = crlfResult?.content.split('\n').at(-1)
    expect(lastCrlfLine).not.toBe('')
    expect(lastCrlfLine).not.toBe('\r')

    // lineEnd must match what the LF-only equivalent produces, not one line larger.
    expect(crlfResult?.lineEnd).toBe(lfResult?.lineEnd)
  })
})

describe('listSections', () => {
  it('returns all headings at all nesting levels from a file', () => {
    const file = tmpFile('doc.md', MD)
    const sections = listSections(file)
    // listSections now returns all headings at every level, not just top-level
    expect(sections).toEqual(['Title', 'Install', 'Usage', 'Install'])
  })

  it('lists ## sections when there is no # heading', () => {
    const noTitle = ['## Alpha', 'a', '', '## Beta', 'b'].join('\n')
    const file = tmpFile('flat.md', noTitle)
    expect(listSections(file)).toEqual(['Alpha', 'Beta'])
  })

  it('returns an empty array for an unreadable file', () => {
    expect(listSections('/no/such/path/nope.md')).toEqual([])
  })
})

describe('normalizeHeading', () => {
  it('replaces em-dash with hyphen (replacement mode)', () => {
    expect(normalizeHeading('Section Index — load on demand')).toBe('Section Index - load on demand')
  })

  it('replaces en-dash with hyphen (replacement mode)', () => {
    expect(normalizeHeading('Section Index – load on demand')).toBe('Section Index - load on demand')
  })

  it('strips trailing parenthetical', () => {
    expect(normalizeHeading('Priority Matrix (June 2026)')).toBe('Priority Matrix')
  })

  it('strips leading numeric prefix', () => {
    expect(normalizeHeading('5. Chain Recipes')).toBe('Chain Recipes')
  })

  it('collapses multiple spaces', () => {
    expect(normalizeHeading('  Foo   Bar  ')).toBe('Foo Bar')
  })

  it('leaves normal headings unchanged', () => {
    expect(normalizeHeading('Installation')).toBe('Installation')
  })
})

describe('extractSection — normalized heading matching', () => {
  const MD_DASHES = [
    '# Doc',
    '',
    '## Section Index — load on demand',
    'content here',
    '',
    '## Priority Matrix (June 2026)',
    'matrix content',
    '',
    '## 5. Chain Recipes',
    'recipe content',
    '',
  ].join('\n')

  it('matches heading with em-dash when queried without it', () => {
    const result = extractSection(MD_DASHES, 'Section Index')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('content here')
  })

  it('matches heading with em-dash when queried with a hyphen', () => {
    const result = extractSection(MD_DASHES, 'Section Index - load on demand')
    expect(result).not.toBeNull()
  })

  it('matches heading with trailing parenthetical when queried without it', () => {
    const result = extractSection(MD_DASHES, 'Priority Matrix')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('matrix content')
  })

  it('matches heading with numeric prefix when queried without it', () => {
    const result = extractSection(MD_DASHES, 'Chain Recipes')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('recipe content')
  })
})

describe('extractSection — unambiguous prefix redirect (#92)', () => {
  const MD_PREFIX = [
    '# Business / logic',
    'body a',
    '',
    '# postMessage abuse & Service Worker persistence',
    'body b',
    '',
    '# Setup',
    'body c',
    '',
  ].join('\n')

  it('redirects a unique normalized-prefix query to the lone matching heading', () => {
    const result = extractSection(MD_PREFIX, 'Business')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Business / logic')
    expect(result?.redirectedFrom).toBe('Business')
    expect(result?.content).toContain('body a')
  })

  it('redirects across an ampersand subtitle the strip-normalizer does not cover', () => {
    const result = extractSection(MD_PREFIX, 'postMessage')
    expect(result?.heading).toBe('postMessage abuse & Service Worker persistence')
    expect(result?.redirectedFrom).toBe('postMessage')
  })

  it('does not set redirectedFrom on an exact match', () => {
    const result = extractSection(MD_PREFIX, 'Setup')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Setup')
    expect(result?.redirectedFrom).toBeUndefined()
  })

  it('does NOT redirect when a prefix is ambiguous across distinct headings', () => {
    const md = ['# Business / logic', 'a', '', '# Business rules engine', 'b', ''].join('\n')
    expect(extractSection(md, 'Business')).toBeNull()
  })

  it('does NOT use the prefix fallback when an ordinal is given', () => {
    // An ordinal implies the caller knows the exact heading text, so a prefix-only query with `#N` must miss rather than silently redirect.
    expect(extractSection(MD_PREFIX, 'Business#1')).toBeNull()
  })
})

describe('listAllSections', () => {
  it('returns all headings at all nesting levels', () => {
    const content = ['# Title', '## Sub A', '### Deep A1', '## Sub B'].join('\n')
    const file = tmpFile('nested.md', content)
    const sections = listAllSections(file)
    expect(sections).toEqual(['Title', 'Sub A', 'Deep A1', 'Sub B'])
  })

  it('returns an empty array for an unreadable file', () => {
    expect(listAllSections('/no/such/path/nope.md')).toEqual([])
  })
})

describe('readSection', () => {
  it('reads a section from a real temp file', () => {
    const file = tmpFile('readme.md', MD)
    const result = readSection(file, 'Usage')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Usage')
    expect(result?.content).toContain('how to use it')
  })

  it('reads a Python function body by name', () => {
    const py = [
      'import os',
      '',
      'def alpha():',
      '    return 1',
      '',
      'def beta():',
      '    return 2',
      '',
    ].join('\n')
    const file = tmpFile('mod.py', py)
    const result = readSection(file, 'alpha')
    expect(result).not.toBeNull()
    expect(result?.content).toContain('def alpha():')
    expect(result?.content).toContain('return 1')
    expect(result?.content).not.toContain('def beta')
  })

  it('returns null for an unreadable file', () => {
    expect(readSection('/no/such/path/nope.md', 'X')).toBeNull()
  })

  it('finds a real YAML key when comment lines precede it (comments are not headers)', () => {
    const yaml = [
      '# Application configuration',
      '# do not edit by hand',
      'database:',
      '  host: localhost',
      '  port: 5432',
      'logging:',
      '  level: info',
      '',
    ].join('\n')
    const file = tmpFile('config.yaml', yaml)
    const result = readSection(file, 'database')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('database')
    expect(result?.content).toContain('host: localhost')
    // A comment line must never be exposed as a section.
    expect(readSection(file, 'do not edit by hand')).toBeNull()
  })

  it('finds an INI [section] when a # comment precedes it', () => {
    const ini = ['# global config', '[database]', 'host=localhost', '[logging]', 'level=info', ''].join('\n')
    const file = tmpFile('settings.ini', ini)
    const result = readSection(file, 'database')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('database')
  })
})

describe('listSections regression: nested headings visibility', () => {
  it('lists all heading levels when section --list is called on a nested document', () => {
    const content = ['# Main Title', '## Section A', '### Subsection A1', '## Section B', '### Subsection B1'].join('\n')
    const file = tmpFile('nested.md', content)
    // This test verifies that when using section --list on a document with nested headings,
    // the user sees the complete hierarchy, not just the top-level headings.
    // Before the fix, listSections would only return ['Main Title'] (the shallowest level).
    // After the fix (using listAllSections), it should return all levels.
    const sections = listSections(file)
    expect(sections).toContain('Section A')
    expect(sections).toContain('Subsection A1')
    expect(sections).toContain('Section B')
    expect(sections).toContain('Subsection B1')
  })
})

describe('BOM stripping regression', () => {
  it('finds markdown heading in file with UTF-8 BOM', () => {
    const BOM = '﻿'
    const md = BOM + '# Section Title\nContent here'
    const file = tmpFile('bom.md', md)
    const result = readSection(file, 'Section Title')
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Section Title')
  })

  it('lists all sections in file with UTF-8 BOM', () => {
    const BOM = '﻿'
    const md = BOM + '# First\n## Second\n### Third'
    const file = tmpFile('nested-bom.md', md)
    const sections = listAllSections(file)
    expect(sections).toEqual(['First', 'Second', 'Third'])
  })
})

describe('findContainingSection', () => {
  it('finds the enclosing markdown heading for a symbol inside it', () => {
    const md = ['# Title', '', '## Install', 'line one', 'line two', 'line three', '', '## Usage', 'usage line'].join(
      '\n',
    )
    const file = tmpFile('containing.md', md)
    // "line two" is line 5 (1-based) -- inside the "## Install" section (lines 4-6).
    const result = findContainingSection(file, 5, 5)
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Install')
  })

  it('returns the innermost heading when sections nest', () => {
    const md = ['# Outer', 'outer body', '', '## Inner', 'inner body line'].join('\n')
    const file = tmpFile('nested-containing.md', md)
    // "inner body line" is line 5, inside both "# Outer" (1-5) and "## Inner" (4-5) -- the
    // innermost (deepest/last) enclosing heading, "Inner", must win.
    const result = findContainingSection(file, 5, 5)
    expect(result).not.toBeNull()
    expect(result?.heading).toBe('Inner')
  })

  it('returns null when the file has no heading structure enclosing the symbol', () => {
    const text = ['line one', 'line two', 'line three'].join('\n')
    const file = tmpFile('plain.txt', text)
    expect(findContainingSection(file, 2, 2)).toBeNull()
  })

  it('returns null for an unreadable file', () => {
    expect(findContainingSection('/no/such/path/nope.md', 1, 1)).toBeNull()
  })
})
