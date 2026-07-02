// Regression guard: `bash-output`/`web-output --section <heading>` share
// _applyFiltersAndPrint(), which called extractSection() and, when it returned null (the
// requested heading wasn't found), left `content` unchanged instead of erroring -- silently
// printing the full unfiltered output. This is an outlier: the sibling `skill-section` and
// `gdrive-sections --heading` commands both report a clear error when their requested
// section/heading isn't found. Drive the real run() entry against a real web-output cache
// entry so this exercises the actual command wiring, not the filter helper in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { clearModuleCaches } from '../src/reset.js'
import { storeWebOutput } from '../src/web_cache.js'

let stdout: string[]
let stderr: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  clearModuleCaches()
  stdout = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  stderr = []
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  clearModuleCaches()
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('web-output --section on a missing heading', () => {
  it('errors instead of silently printing the full unfiltered content', async () => {
    const id = storeWebOutput('https://example.com/doc', '## Real Heading\nreal body text\n')

    const code = await runCli(['web-output', id, '--section', 'NoSuchHeading'])

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('NoSuchHeading')
    expect(stdout.join('')).not.toContain('real body text')
  })
})
