import { describe, expect, it } from 'vitest'

import { detectLanguage } from '../src/parser_types.js'
import type { Language } from '../src/parser_types.js'

describe('detectLanguage', () => {
  it('returns typescript for .ts files', () => {
    expect(detectLanguage('src/foo.ts')).toBe('typescript')
    expect(detectLanguage('C:/proj/app.tsx')).toBe('typescript')
  })

  it('returns python for .py files', () => {
    expect(detectLanguage('module.py')).toBe('python')
    expect(detectLanguage('/abs/path/stub.pyi')).toBe('python')
  })

  it('returns javascript for .js / .mjs / .cjs', () => {
    expect(detectLanguage('a.js')).toBe('javascript')
    expect(detectLanguage('b.mjs')).toBe('javascript')
    expect(detectLanguage('c.cjs')).toBe('javascript')
  })

  it('returns unknown for an unrecognised extension', () => {
    expect(detectLanguage('data.xyz')).toBe('unknown')
    expect(detectLanguage('noextension')).toBe('unknown')
  })

  it('classifies named files (Dockerfile, pyproject.toml) by basename', () => {
    expect(detectLanguage('Dockerfile')).toBe('bash')
    expect(detectLanguage('repo/pyproject.toml')).toBe('toml')
    expect(detectLanguage('package.json')).toBe('json')
  })

  it('is case-insensitive on the extension', () => {
    expect(detectLanguage('FOO.PY')).toBe('python')
    expect(detectLanguage('Bar.TS')).toBe('typescript')
  })

  it('covers every Language value via some input', () => {
    // One representative input per non-unknown Language; unknown covered above.
    const cases: Record<Exclude<Language, 'unknown'>, string> = {
      python: 'a.py',
      typescript: 'a.ts',
      javascript: 'a.js',
      rust: 'a.rs',
      go: 'a.go',
      c: 'a.c',
      cpp: 'a.cpp',
      bash: 'a.sh',
      markdown: 'a.md',
      toml: 'a.toml',
      json: 'a.json',
      yaml: 'a.yaml',
    }
    for (const [lang, file] of Object.entries(cases)) {
      expect(detectLanguage(file)).toBe(lang)
    }
  })
})
