import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { stripComments, scanSecrets, formatMarkdown, formatXml, formatPlain } from '../src/pack.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pack-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('stripComments', () => {
  it('strips Python line comments', () => {
    const code = 'x = 1  # comment\ny = 2  # another\n'
    const result = stripComments(code, 'file.py')
    expect(result).toContain('x = 1')
    expect(result).toContain('y = 2')
    expect(result).not.toContain('comment')
  })

  it('strips TypeScript block comments', () => {
    const code = 'const x = 1; /* comment */ const y = 2;'
    const result = stripComments(code, 'file.ts')
    expect(result).toContain('const x')
    expect(result).toContain('const y')
    expect(result).not.toContain('comment')
  })

  it('preserves shebangs', () => {
    const code = '#!/bin/bash\n# regular comment\necho test\n'
    const result = stripComments(code, 'script.sh')
    expect(result).toContain('#!/bin/bash')
  })

  it('returns unchanged for unknown extensions', () => {
    const code = 'some code # comment'
    const result = stripComments(code, 'file.unknown')
    expect(result).toBe(code)
  })
})

describe('scanSecrets', () => {
  it('detects AWS access keys', () => {
    const files = [
      {
        path: 'config.py',
        rel_path: 'config.py',
        content: 'aws_key = AKIAIOSFODNN7EXAMPLE',
        lines: 1,
        tokens: 10,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].kind).toBe('AWS access key')
  })

  it('skips safe file extensions', () => {
    const files = [
      {
        path: 'image.png',
        rel_path: 'image.png',
        content: 'fake aws secret AKIAIOSFODNN7EXAMPLE',
        lines: 1,
        tokens: 10,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBe(0)
  })
})

describe('formatMarkdown', () => {
  it('includes file count and token estimate', () => {
    const result = {
      files: [
        { path: 'f.ts', rel_path: 'f.ts', content: 'code', lines: 1, tokens: 1 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 1,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('1 file')
    expect(md).toContain('tokens')
  })

  it('formats file sections correctly', () => {
    const result = {
      files: [
        { path: 'test.js', rel_path: 'test.js', content: 'const x = 1', lines: 1, tokens: 5 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 5,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('## `test.js`')
    expect(md).toContain('```javascript')
  })
})

describe('formatXml', () => {
  it('wraps files in document elements', () => {
    const result = {
      files: [
        { path: 'f.py', rel_path: 'f.py', content: 'x = 1', lines: 1, tokens: 2 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 2,
    }
    const xml = formatXml(result)
    expect(xml).toContain('<documents>')
    expect(xml).toContain('<document')
    expect(xml).toContain('<source>f.py</source>')
    expect(xml).toContain('</documents>')
  })
})

describe('formatPlain', () => {
  it('includes separator and file headers', () => {
    const result = {
      files: [
        { path: 'f.ts', rel_path: 'f.ts', content: 'code', lines: 1, tokens: 1 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 1,
    }
    const text = formatPlain(result)
    expect(text).toContain('File: f.ts')
    expect(text).toContain('=====')
  })
})
