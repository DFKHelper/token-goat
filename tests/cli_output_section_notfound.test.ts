// Regression guard: `bash-output`/`web-output --section <heading>` share
// _applyFiltersAndPrint(), which called extractSection() and, when it returned null (the
// requested heading wasn't found), left `content` unchanged instead of erroring -- silently
// printing the full unfiltered output. This is an outlier: the sibling `skill-section` and
// `gdrive-sections --heading` commands both report a clear error when their requested
// section/heading isn't found. Drive the real run() entry against a real web-output cache
// entry so this exercises the actual command wiring, not the filter helper in isolation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { clearModuleCaches } from '../src/reset.js'
import { storeWebOutput } from '../src/web_cache.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  clearModuleCaches()
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
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

// Regression: postFetchHandler's compress_bodies path cached only the cleaned text, so a raw
// fetch body was permanently unrecoverable once cleaned -- a lossy store with no recovery path.
// web-output --raw (new) recovers it via storeWebOutput's optional rawContent param; the default
// (no --raw) path must stay byte-identical to before this change.
describe('web-output --raw', () => {
  it('returns the raw pre-clean body when a raw copy was stored, and the default (no --raw) stays the cleaned body', async () => {
    const id = storeWebOutput('https://example.com/raw-cli', 'cleaned body', undefined, '<html><body data-secret="x">cleaned body</body></html>')

    const rawCode = await runCli(['web-output', id, '--raw'])
    expect(rawCode).toBe(0)
    expect(stdout.join('')).toContain('data-secret="x"')

    stdout.length = 0
    const defaultCode = await runCli(['web-output', id])
    expect(defaultCode).toBe(0)
    expect(stdout.join('')).toBe('cleaned body\n')
    expect(stdout.join('')).not.toContain('data-secret')
  })

  it('falls back to the cleaned content when no raw copy was ever stored', async () => {
    const id = storeWebOutput('https://example.com/no-raw-cli', 'plain body')

    const code = await runCli(['web-output', id, '--raw'])

    expect(code).toBe(0)
    expect(stdout.join('')).toBe('plain body\n')
  })
})
