/**
 * Guard: an unknown command name that reflects a *conceptual* miss rather than a typo must get a
 * pointer to the commands that actually serve the intent.
 *
 * Commander's built-in "(Did you mean X?)" is edit distance over the registered names. That works
 * for `symbl` -> `symbol`, but `search` -- probably the most natural name to reach for -- resolves to
 * `arch`, the import-graph analyser, which has nothing to do with searching. An agent that follows
 * that suggestion burns a call and builds the wrong model of the CLI.
 *
 * The bundle-level cases below drive the real built binary, because the hint is emitted from run()'s
 * commander error branch -- wiring no unit test on the pure functions can pin.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { attemptedCommandName, suggestForUnknownCommand } from '../src/command_intent.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('suggestForUnknownCommand', () => {
  it('points a search-shaped guess at the three commands that actually search', () => {
    const hint = suggestForUnknownCommand('search')
    expect(hint).not.toBeNull()
    expect(hint).toContain('grep')
    expect(hint).toContain('semantic')
    expect(hint).toContain('symbol')
  })

  it('covers the other intent groups', () => {
    expect(suggestForUnknownCommand('cat')).toContain('read')
    expect(suggestForUnknownCommand('definition')).toContain('symbol')
    expect(suggestForUnknownCommand('usages')).toContain('refs')
    expect(suggestForUnknownCommand('tree')).toContain('map')
    expect(suggestForUnknownCommand('summarize')).toContain('brief')
  })

  it('matches case-insensitively — the same conceptual miss either way', () => {
    expect(suggestForUnknownCommand('Search')).toBe(suggestForUnknownCommand('search'))
  })

  // A hint for a name that isn't a recognised intent would be a guess, and a wrong hint is worse
  // than commander's own. Silence is the correct answer outside the curated set.
  it('stays silent for a plain typo and for an empty name', () => {
    expect(suggestForUnknownCommand('symbl')).toBeNull()
    expect(suggestForUnknownCommand('zzzqqq')).toBeNull()
    expect(suggestForUnknownCommand('   ')).toBeNull()
  })
})

describe('attemptedCommandName', () => {
  it('returns the first bare token after the node binary and script', () => {
    expect(attemptedCommandName(['node', 'token-goat', 'search', 'foo'])).toBe('search')
  })

  it('skips leading flags so the hint keys on the token commander rejected', () => {
    expect(attemptedCommandName(['node', 'token-goat', '--json', 'search'])).toBe('search')
  })

  it('returns null when argv carries no command at all', () => {
    expect(attemptedCommandName(['node', 'token-goat'])).toBeNull()
    expect(attemptedCommandName(['node', 'token-goat', '--help'])).toBeNull()
  })
})

describe('unknown-command hint through the built bundle', () => {
  it('appends the intent hint without replacing commander’s own diagnostic', () => {
    const r = runBundle(['search', 'foo'])
    expect(r.status).toBe(1)
    // Commander's line must survive: this is additive, not a takeover of the error path.
    expect(r.stderr).toContain("unknown command 'search'")
    expect(r.stderr).toContain('Looking for that?')
    expect(r.stderr).toContain('semantic')
  })

  it('leaves a plain typo to commander alone', () => {
    const r = runBundle(['symbl', 'foo'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown command 'symbl'")
    expect(r.stderr).toContain('Did you mean symbol?')
    expect(r.stderr).not.toContain('Looking for that?')
  })

  // Guard: the hint must not leak onto commands that exist. A regression that emitted it for every
  // failure -- or every invocation -- would still pass the two cases above.
  it('never fires for a registered command', () => {
    const r = runBundle(['commands', '--grep', 'semantic'])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).not.toContain('Looking for that?')
  })
})
