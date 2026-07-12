import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { runConfigGet } from '../src/read_commands.js'

describe('configGet section scoping bug', () => {
  const tmpDirs: string[] = []

  function tmpFile(name: string, content: string): string {
    const dir = mkdtempSync(path.join('tests', 'tmp'))
    tmpDirs.push(dir)
    const file = path.join(dir, name)
    writeFileSync(file, content, 'utf-8')
    return file
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir !== undefined) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
  })

  it('should return the key from the correct section, not the first match', () => {
    const content = [
      '[tool.ruff]',
      'version = "0.1"',
      '',
      '[project]',
      'version = "2.0.0"',
    ].join('\n')

    const f = tmpFile('pyproject.toml', content)

    let stdout = ''
    const oldWrite = process.stdout.write
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write

    runConfigGet({ file: f, key: 'project.version' })

    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('2.0.0')
  })

  it('should recognize section headers with trailing comments', () => {
    const content = [
      '[tool.ruff] # comment',
      'version = "0.1"',
      '',
      '[project] ; another comment',
      'version = "2.0.0"',
      '',
      '[tool.other]  ; comment after spaces',
      'value = "3.0"',
    ].join('\n')

    const f = tmpFile('pyproject.toml', content)
    const oldWrite = process.stdout.write

    // Test 1: [tool.ruff] with # comment
    let stdout = ''
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'tool.ruff.version' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('0.1')

    // Test 2: [project] with ; comment
    stdout = ''
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'project.version' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('2.0.0')

    // Test 3: [tool.other] with trailing comment after spaces
    stdout = ''
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'tool.other.value' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('3.0')
  })

  it('should strip inline comments from values, not just section headers', () => {
    const content = ['[project]', 'name = "goat" # this is a comment'].join('\n')
    const f = tmpFile('pyproject.toml', content)

    let stdout = ''
    const oldWrite = process.stdout.write
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'project.name' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('goat')
  })

  it('should not corrupt a value with an inline ; comment', () => {
    const content = ['[project]', 'name = "goat" ; ini-style comment'].join('\n')
    const f = tmpFile('setup.cfg', content)

    let stdout = ''
    const oldWrite = process.stdout.write
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'project.name' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe('goat')
  })

  it('should only strip a quote pair when both ends actually match', () => {
    const content = [
      '[project]',
      "plural = dogs'",
      "mismatched = \"foo'",
    ].join('\n')
    const f = tmpFile('pyproject.toml', content)
    const oldWrite = process.stdout.write

    // A legitimate trailing apostrophe with no matching leading quote must survive intact --
    // the old independent-single-end regex stripped the trailing "'" even though the leading
    // character isn't a quote at all.
    let stdout = ''
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'project.plural' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe("dogs'")

    // Mismatched quote characters at each end must not be independently stripped.
    stdout = ''
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    runConfigGet({ file: f, key: 'project.mismatched' })
    process.stdout.write = oldWrite
    expect(stdout.trim()).toBe("\"foo'")
  })
})
