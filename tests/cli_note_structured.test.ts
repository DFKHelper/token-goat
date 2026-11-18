/** `note set` with --cue, --evidence and --verdict against the built bundle: what it stores, what `note get` and `note list --json` print, and the refusal of a bad verdict or a flag on another action. Fixtures are HAND-DERIVED: each expected line is written out from the command's documented behaviour, not read off the implementation. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

let data: string
let env: NodeJS.ProcessEnv

function note(...args: string[]): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, 'note', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-note-structured-'))
  env = { ...process.env, LOCALAPPDATA: data, XDG_DATA_HOME: data, TOKEN_GOAT_HOME: data }
})

afterAll(() => {
  fs.rmSync(data, { recursive: true, force: true })
})

describe('note set with evidence', () => {
  it('stores the fields, keeps get printing the lesson, and list --json carries them', () => {
    const set = note('set', 'full', 'reorder the steps', '--cue', 'deploy failed', '--evidence', 'run 4412 passed', '--verdict', 'helped')
    expect(set.status, set.stderr).toBe(0)
    expect(set.stdout).toBe('Set: full = reorder the steps\nCue: deploy failed\nEvidence: run 4412 passed\nVerdict: helped\n')
    expect(note('get', 'full').stdout).toBe('reorder the steps\n')
    expect(note('set', 'bare', 'a guess').stdout).toBe('Set: bare = a guess\n')
    const parsed = JSON.parse(note('list', '--json').stdout) as Record<string, unknown>
    expect(parsed['full']).toEqual({ value: 'reorder the steps', cue: 'deploy failed', evidence: 'run 4412 passed', verdict: 'helped' })
    expect(parsed['bare']).toBe('a guess')
  })

  it('shows the session-start marker in note list, and on stderr for note get so stdout stays the value', () => {
    // HAND-DERIVED: the marker text is the one buildInjection prints for the same note (see project_memory_structured.test.ts): evidence present gives the verdict and cue, none gives [unverified].
    note('set', 'marked', 'reorder the steps', '--cue', 'deploy failed', '--evidence', 'run 4412 passed', '--verdict', 'helped')
    note('set', 'guessed', 'a guess')
    const list = note('list').stdout.split('\n')
    expect(list.find((l) => l.startsWith('marked'))).toMatch(/^marked.* \[helped; cue: deploy failed\] = reorder the steps$/)
    expect(list.find((l) => l.startsWith('guessed'))).toMatch(/^guessed.* \[unverified\] = a guess$/)
    const marked = note('get', 'marked')
    expect(marked.stdout).toBe('reorder the steps\n')
    expect(marked.stderr).toBe('Note [helped; cue: deploy failed]\n')
    const guessed = note('get', 'guessed')
    expect(guessed.stdout).toBe('a guess\n')
    expect(guessed.stderr).toBe('Note [unverified]\n')
  })

  it('refuses a verdict outside the four allowed values, naming them, and stores nothing', () => {
    const r = note('set', 'bad-verdict', 'v', '--verdict', 'worked')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('helped, hurt, no effect, confounded')
    expect(note('get', 'bad-verdict').status).not.toBe(0)
  })

  it('refuses a field on any action but set', () => {
    for (const flag of ['--cue', '--evidence', '--verdict']) {
      const r = note('get', 'full', flag, 'helped')
      expect(r.status, flag).not.toBe(0)
      expect(r.stderr, flag).toContain('applies to note set only')
    }
  })

  it('folds a line break in evidence into one comment line the older reader still accepts', () => {
    const r = note('set', 'multi', 'v', '--evidence', 'line one\nline two')
    expect(r.status, r.stderr).toBe(0)
    const file = fs.readdirSync(data, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith('_memory.toml'))
    const text = fs.readFileSync(path.join(data, file ?? ''), 'utf8')
    expect(text).toContain('# evidence: line one\\nline two\n')
    expect(note('set', 'after', 'still updates').status).toBe(0)
  })
})
