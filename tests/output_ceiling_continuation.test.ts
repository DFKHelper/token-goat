/** Regression: token-goat's own answers ran past Claude Code's inline Bash limit (measured on 2.1.29x: 26,588 chars came back inline, a 29,926-char stdout was persisted with a 2 KB preview), so `section` (52.5 KB), `skill-body humanizer` (49 KB) and `bash-output --file --grep` (48 KB) were each persisted to a file the agent then spent more calls reading back. section, skill-body, skill-section, bash-output, web-output and mcp-output now hold their answer to HARNESS_INLINE_CEILING_CHARS at a line boundary, close any fence first, and name a continuation command. Each case runs the built bundle, then runs the continuation it printed and checks that it returns the next lines. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { storeMcpOutput } from '../src/mcp_cache.js'
import { HARNESS_INLINE_CEILING_CHARS } from '../src/overflow_guard.js'
import { shlexSplit } from '../src/tool_filters/helpers.js'
import { storeWebOutput } from '../src/web_cache.js'

// HAND-DERIVED: numbered lines of ~110 chars, so a few hundred of them clear the ceiling and every line names its own position.
const padded = (label: string, i: number): string => `${label} ${String(i).padStart(4, '0')} ${'filler '.repeat(14)}end`

let root: string
let env: NodeJS.ProcessEnv

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** The command a capped answer names for its next part, run through the bundle. */
function runContinuation(stdout: string): { status: number | null; stdout: string; stderr: string; command: string } {
  const command = /Next part: `(token-goat [^`\n]+)`/.exec(stdout)?.[1]
  expect(command, `no continuation named in: ${stdout.slice(-400)}`).toBeDefined()
  const [, ...args] = shlexSplit(command!)
  return { ...run(args), command: command! }
}

function expectCapped(stdout: string): void {
  expect(stdout.length).toBeLessThanOrEqual(HARNESS_INLINE_CEILING_CHARS)
  expect(stdout).toContain(`capped at ${HARNESS_INLINE_CEILING_CHARS} chars`)
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-output-ceiling-')))
  fs.writeFileSync(path.join(root, 'big.md'), `# Big\n\n## Long part\n\n${Array.from({ length: 500 }, (_, i) => padded('doc', i + 1)).join('\n')}\n\n## After\n\ntail\n`)
  const skillDir = path.join(root, 'home', '.claude', 'skills', 'tgbigskill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# Big Skill\n\n## Long part\n\n${Array.from({ length: 500 }, (_, i) => padded('skill', i + 1)).join('\n')}\n\n## After\n\ntail\n`)
  fs.writeFileSync(path.join(root, 'tool-output.txt'), `${Array.from({ length: 1000 }, (_, i) => padded('row', i + 1)).join('\n')}\n`)
  env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
  }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('section', () => {
  it('pages a section past the ceiling with a read of the next lines', () => {
    const r = run(['section', 'big.md::Long part'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const lastShown = Number(/^# Long part — big\.md:3-(\d+)$/m.exec(r.stdout)?.[1])
    expect(r.stdout).toContain(`doc ${String(lastShown - 4).padStart(4, '0')} `)

    const next = runContinuation(r.stdout)
    expect(next.command).toMatch(/^token-goat read "big\.md@/)
    expect(next.status, next.stderr).toBe(0)
    expect(next.stdout.length).toBeLessThanOrEqual(HARNESS_INLINE_CEILING_CHARS)
    expect(next.stdout.split('\n')[1]).toBe(padded('doc', lastShown - 3))
  })
})

describe('skill-body and skill-section', () => {
  it('skill-body pages a body past the ceiling with a read of the skill file', () => {
    const r = run(['skill-body', 'tgbigskill'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const shown = r.stdout.split('\n')
    const lastLine = shown[shown.indexOf(shown.find((l) => l.startsWith('[token-goat: skill body capped'))!) - 1]!

    const next = runContinuation(r.stdout)
    expect(next.status, next.stderr).toBe(0)
    expect(next.stdout.length).toBeLessThanOrEqual(HARNESS_INLINE_CEILING_CHARS)
    const lastIndex = Number(/^skill (\d+) /.exec(lastLine)?.[1])
    expect(next.stdout.split('\n')[1]).toBe(padded('skill', lastIndex + 1))
  })

  it('skill-section pages a section past the ceiling the same way', () => {
    const r = run(['skill-section', 'tgbigskill', 'Long part'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const lastIndex = Number(/^skill (\d+) .*\n\[token-goat: skill section capped/m.exec(r.stdout)?.[1])

    const next = runContinuation(r.stdout)
    expect(next.status, next.stderr).toBe(0)
    expect(next.stdout.split('\n')[1]).toBe(padded('skill', lastIndex + 1))
  })
})

describe('the cached-output recalls', () => {
  /** The last numbered row inside the fence and the first one of its continuation. */
  const rowNumbers = (stdout: string, label: string): number[] => [...stdout.matchAll(new RegExp(`^${label} (\\d+) `, 'gm'))].map((m) => Number(m[1]))

  it('bash-output --head past the ceiling closes the fence, then names --lines for the rest', () => {
    const r = run(['bash-output', '--file', path.join(root, 'tool-output.txt'), '--head', '400'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    expect(r.stdout.indexOf('</untrusted-tool-output>')).toBeLessThan(r.stdout.indexOf('[token-goat: output capped'))
    const shown = rowNumbers(r.stdout, 'row')

    const next = runContinuation(r.stdout)
    expect(next.command).toContain(`--lines ${shown.at(-1)! + 1}-400`)
    expect(next.status, next.stderr).toBe(0)
    expect(rowNumbers(next.stdout, 'row')[0]).toBe(shown.at(-1)! + 1)
  })

  it('bash-output --grep keeps the pattern in its continuation and resumes after the last match shown', () => {
    // Lines of ~370 chars: the 100 matches a bare --grep prints run past the ceiling, the shape of the 48 KB `--grep 'listing/[0-9]+'` recall.
    const file = path.join(root, 'long-matches.txt')
    fs.writeFileSync(file, `${Array.from({ length: 300 }, (_, i) => `hit ${String(i + 1).padStart(4, '0')} listing/${i} ${'filler '.repeat(50)}`).join('\n')}\n`)
    const r = run(['bash-output', '--file', file, '--grep', 'listing/[0-9]+'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const shown = rowNumbers(r.stdout, 'hit')
    expect(shown.length).toBeGreaterThan(0)

    const next = runContinuation(r.stdout)
    expect(next.command).toContain(`--grep "listing/[0-9]+" --lines ${shown.at(-1)! + 1}-300`)
    expect(next.status, next.stderr).toBe(0)
    expect(rowNumbers(next.stdout, 'hit')[0]).toBe(shown.at(-1)! + 1)
  })

  it('bash-output --grep with no --max-matches stops at 100 matches and names the rest', () => {
    const file = path.join(root, 'short-matches.txt')
    fs.writeFileSync(file, `${Array.from({ length: 250 }, (_, i) => `MATCH ${i + 1}`).join('\n')}\n`)
    const r = run(['bash-output', '--file', file, '--grep', 'MATCH'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('MATCH 100\n')
    expect(r.stdout).not.toContain('MATCH 101\n')
    expect(r.stdout).toContain('showing the first 100 of 250 matching lines')

    const next = runContinuation(r.stdout)
    expect(next.command).toContain('--lines 101-250')
    expect(next.stdout).toContain('MATCH 101\n')
    expect(next.stdout).toContain('MATCH 200\n')
  })

  it('bash-output --full still prints everything it was asked for', () => {
    const r = run(['bash-output', '--file', path.join(root, 'tool-output.txt'), '--full'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(padded('row', 1000))
    expect(r.stdout).not.toContain('capped at')
  })

  it('web-output pages a cached page past the ceiling by its id', () => {
    const id = storeWebOutput('https://example.com/output-ceiling', Array.from({ length: 400 }, (_, i) => padded('web', i + 1)).join('\n'))
    const r = run(['web-output', id, '--head', '400'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const shown = rowNumbers(r.stdout, 'web')

    const next = runContinuation(r.stdout)
    expect(next.command).toContain(`token-goat web-output ${id}`)
    expect(next.status, next.stderr).toBe(0)
    expect(rowNumbers(next.stdout, 'web')[0]).toBe(shown.at(-1)! + 1)
  })

  it('mcp-output pages a cached MCP result past the ceiling by its id', () => {
    const id = storeMcpOutput('output-ceiling-session', 'mcp__probe__list', { q: 'all' }, Array.from({ length: 400 }, (_, i) => padded('mcp', i + 1)).join('\n'))
    expect(id).not.toBeNull()
    const r = run(['mcp-output', id!, '--head', '400'])
    expect(r.status, r.stderr).toBe(0)
    expectCapped(r.stdout)
    const shown = rowNumbers(r.stdout, 'mcp')

    const next = runContinuation(r.stdout)
    expect(next.command).toContain(`token-goat mcp-output ${id!}`)
    expect(next.status, next.stderr).toBe(0)
    expect(rowNumbers(next.stdout, 'mcp')[0]).toBe(shown.at(-1)! + 1)
  })
})
