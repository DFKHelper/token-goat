import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractSection, listSections, listAllSections, normalizeHeading, readSection } from '../src/section_reader.js'

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
    // The whole Install section must be returned, not truncated at the fenced
    // `# install dependencies` comment line.
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

describe('listSections', () => {
  it('returns all top-level headings from a real file', () => {
    const file = tmpFile('doc.md', MD)
    const sections = listSections(file)
    // Top level here is the shallowest present (## sections under one # title).
    // The single # Title is the shallowest, so only it is top-level.
    expect(sections).toEqual(['Title'])
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
})
