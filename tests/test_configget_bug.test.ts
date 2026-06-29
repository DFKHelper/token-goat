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

    // When looking for `project.version`, we want the value from the [project]
    // section, not the value from [tool.ruff]. However, the naive line-based
    // search finds the FIRST line with "version =", which is in [tool.ruff],
    // returning "0.1" instead of "2.0.0".
    let stdout = ''
    let stderr = ''
    // Capture output
    const oldWrite = process.stdout.write
    const oldErrWrite = process.stderr.write
    process.stdout.write = ((s: string) => { stdout += s; return true }) as typeof process.stdout.write
    process.stderr.write = ((s: string) => { stderr += s; return true }) as typeof process.stderr.write

    runConfigGet({ file: f, key: 'project.version' })

    process.stdout.write = oldWrite
    process.stderr.write = oldErrWrite

    // This test will FAIL on the current (buggy) implementation because it
    // returns "0.1" from [tool.ruff], but we expect "2.0.0" from [project]
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
    expect(stdout.trim()).toBe('2.0.0')
  })
})
