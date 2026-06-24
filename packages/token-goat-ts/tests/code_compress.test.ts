import { describe, it, expect } from 'vitest'
import { compressToSkeleton, stripComments, deduplicateLines, compressCode } from '../src/code_compress.js'

describe('code_compress', () => {
  describe('compressToSkeleton', () => {
    it('returns null for unsupported extension', () => {
      const result = compressToSkeleton('code', '.rb')
      expect(result).toBeNull()
    })

    it('returns empty string for empty input', () => {
      const result = compressToSkeleton('', '.ts')
      expect(result).toBe('')
    })

    it('preserves Python imports', () => {
      const code = 'import os\nimport sys\ndef foo():\n    pass'
      const result = compressToSkeleton(code, '.py')
      expect(result).toContain('import os')
      expect(result).toContain('import sys')
    })

    it('preserves Python function signatures', () => {
      const code = 'def hello(name: str) -> str:\n    x = 1\n    y = 2\n    return name'
      const result = compressToSkeleton(code, '.py')
      expect(result).toContain('def hello')
      expect(result).toContain('# ... 3 lines')
    })

    it('preserves Python decorators', () => {
      const code = '@dataclass\nclass User:\n    name: str\n    age: int'
      const result = compressToSkeleton(code, '.py')
      expect(result).toContain('@dataclass')
      expect(result).toContain('class User')
    })

    it('preserves Python type aliases', () => {
      const code = 'Vector = list[float]\ndef dot():\n    pass'
      const result = compressToSkeleton(code, '.py')
      expect(result).toContain('Vector = list[float]')
    })

    it('preserves TypeScript imports', () => {
      const code = "import { foo } from './bar'\nfunction test() { return 1; }"
      const result = compressToSkeleton(code, '.ts')
      expect(result).toContain('import { foo }')
      expect(result).toContain('function test')
    })

    it('preserves TypeScript interface signatures', () => {
      const code = 'interface User {\n  name: string\n  age: number\n}'
      const result = compressToSkeleton(code, '.ts')
      expect(result).toContain('interface User')
    })

    it('handles brace-counting for single-line bodies', () => {
      const code = 'function add(a, b) { return a + b; }\nfunction mul(a, b) { return a * b; }'
      const result = compressToSkeleton(code, '.js')
      expect(result).toContain('function add')
      expect(result).toContain('function mul')
    })
  })

  describe('stripComments', () => {
    it('removes Python comments', () => {
      const code = 'x = 1  # assignment\ny = 2  # another'
      const result = stripComments(code, 'py')
      expect(result).toContain('x = 1')
      expect(result).not.toContain('# assignment')
    })

    it('removes TypeScript comments', () => {
      const code = 'const x = 1 // number\nconst y = 2 // another'
      const result = stripComments(code, 'ts')
      expect(result).toContain('const x = 1')
      expect(result).not.toContain('// number')
    })

    it('removes comments from end of lines', () => {
      const code = "x = 'hash'  # comment here"
      const result = stripComments(code, 'py')
      expect(result).not.toContain('comment')
      expect(result).toContain("x = 'hash'")
    })

    it('removes trailing whitespace after comment removal', () => {
      const code = 'x = 1   // comment with spaces'
      const result = stripComments(code, 'js')
      const lines = result.split('\n')
      expect(lines[0]).toBe('x = 1')
    })
  })

  describe('deduplicateLines', () => {
    it('removes consecutive duplicate lines', () => {
      const text = 'a\na\nb\nb\nb\nc'
      const result = deduplicateLines(text)
      expect(result).toBe('a\nb\nc')
    })

    it('preserves single occurrences', () => {
      const text = 'a\nb\nc'
      const result = deduplicateLines(text)
      expect(result).toBe('a\nb\nc')
    })

    it('preserves non-consecutive duplicates', () => {
      const text = 'a\nb\na'
      const result = deduplicateLines(text)
      expect(result).toBe('a\nb\na')
    })

    it('handles empty lines', () => {
      const text = 'a\n\n\nb'
      const result = deduplicateLines(text)
      expect(result).toBe('a\n\nb')
    })
  })

  describe('compressCode', () => {
    it('applies strip comments by default', () => {
      const code = 'x = 1  # comment\ny = 2'
      const result = compressCode(code, 'py')
      expect(result).not.toContain('# comment')
    })

    it('applies dedup by default', () => {
      const code = 'import os\nimport os\nimport sys'
      const result = compressCode(code, 'py')
      const lines = result.split('\n').filter((l) => l.includes('import os'))
      expect(lines).toHaveLength(1)
    })

    it('respects stripComments option false', () => {
      const code = 'x = 1  # comment'
      const result = compressCode(code, 'py', { stripComments: false })
      expect(result).toContain('# comment')
    })

    it('respects dedup option false', () => {
      const code = 'a\na'
      const result = compressCode(code, 'py', { dedup: false })
      expect(result).toBe('a\na')
    })
  })
})
