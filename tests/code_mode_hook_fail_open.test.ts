/** `hook` exits 0 with `{}` on every escape. Fixtures FORMAT-DERIVED (PROVENANCE.tsv); inline HAND-DERIVED. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import type * as Parser from '../src/parser.js'
import { makeBundleProject, runBundle, type BundleProject } from './helpers/bundle.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const FIXTURES = path.join(__dirname, 'fixtures', 'code_mode')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

// Pass-through wrapper: the real loader runs unless a row asks it to throw; no src seam.
const loadFault = vi.hoisted(() => ({ fail: false }))
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Parser>()
  return {
    ...actual,
    loadRegexExtractors: async (): Promise<void> => {
      if (loadFault.fail) throw new Error('simulated regex adapter load failure')
      return actual.loadRegexExtractors()
    },
  }
})

let proj: BundleProject
let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  proj = makeBundleProject('tg-cm-failopen-')
  stdout = []
  stderr = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.chdir(originalCwd)
  closeAllDbs()
  fs.rmSync(proj.root, { recursive: true, force: true })
})

async function runInProcess(argv: string[]): Promise<number | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('token-goat hook fails open in process', () => {
  it('a failure before the relay runs (bad --cwd) ends as exit 0 and {}', async () => {
    const missing = path.join(proj.root, 'no-such-dir')
    const code = await runInProcess(['--cwd', missing, 'hook', 'pre_tool_use'])
    expect(code, 'exit code of a hook that failed before the relay').toBe(0)
    expect(stdout.join('')).toBe('{}')
    expect(stderr.join('')).toContain('hook failed open')
  })

  it('a rejected option on the hook command ends as exit 0 and {}', async () => {
    const code = await runInProcess(['hook', 'pre_tool_use', '--no-such-option'])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toBe('{}')
  })

  it('still prints {} for a failing hook after this process already wrote to stdout', async () => {
    // The spy replaces write, so bytes must go through the real stream for its byte counter to move.
    stdoutSpy.mockRestore()
    process.stdout.write('earlier reply in this process\n')
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    const code = await runInProcess(['hook', 'pre_tool_use', '--no-such-option'])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toBe('{}')
  })

  it('does not touch the exit code of a command that is not a hook', async () => {
    const missing = path.join(proj.root, 'no-such-dir')
    const code = await runInProcess(['--cwd', missing, 'scope', 'foo.ts:1'])
    expect(code, 'a non-hook command keeps its failure exit').toBe(1)
    expect(stdout.join('')).not.toBe('{}')
  })
})

describe('run catches a failure while the regex adapters load', () => {
  afterEach(() => {
    loadFault.fail = false
  })

  it('a hook ends as exit 0 and {} when the load throws, and names the cause on stderr', async () => {
    loadFault.fail = true
    const code = await runInProcess(['hook', 'pre_tool_use'])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toBe('{}')
    expect(stderr.join('')).toContain('simulated regex adapter load failure')
    expect(stderr.join('')).toContain('hook failed open')
  })

  it('a non-hook command rethrows the same failure', async () => {
    loadFault.fail = true
    await expect(run(['node', 'token-goat', 'scope', 'foo.ts:1'])).rejects.toThrow('simulated regex adapter load failure')
    expect(stdout.join('')).toBe('')
  })
})

describe('token-goat hook fails open from the built bundle', () => {
  const hook = (event: string, input: string, extra?: string[]) =>
    runBundle([...(extra ?? []), 'hook', event], { cwd: proj.project, env: proj.env, input, timeout: 60000 })

  it('answers {} for a REPL call carrying tool_input.code', () => {
    const r = hook('pre_tool_use', fixture('repl_pre_tool_use.json'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
  })

  it('answers {} for an inner Bash call', () => {
    const r = hook('pre_tool_use', fixture('inner_bash_pre_tool_use.json'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
  })

  it('answers {} for malformed stdin', () => {
    const r = hook('pre_tool_use', '{"tool_name": "REPL", "tool_inp')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
  })

  it('answers {} for an unknown tool_name', () => {
    const r = hook('pre_tool_use', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'NoSuchTool', tool_input: {} }))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
  })

  it('answers {} for a REPL result and a REPL failure on the post events', () => {
    const post = hook('post_tool_use', fixture('repl_post_tool_use.json'))
    expect(post.status, post.stderr).toBe(0)
    expect(post.stdout.trim()).toBe('{}')
    const failure = hook('post_tool_use_failure', fixture('repl_post_tool_use_failure.json'))
    expect(failure.status, failure.stderr).toBe(0)
    expect(failure.stdout.trim()).toBe('{}')
  })

  it('a forced pre-relay failure (bad --cwd) still ends as exit 0 and {}', () => {
    const r = hook('pre_tool_use', fixture('repl_pre_tool_use.json'), ['--cwd', path.join(proj.root, 'no-such-dir')])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
    expect(r.stderr).toContain('hook failed open')
  })
})
