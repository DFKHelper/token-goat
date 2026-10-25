/** Failure-recovery pairs: the signature, the directory scope, what counts as the fix having run, and scoring. Split from recovery_pairs.test.ts by describe group; shared helpers are in helpers/recovery_pairs_fixtures.ts. */
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRetired, loadRecoveryPairs } from '../src/recovery_pairs.js'
import { MODULE_ERROR, INSTALL, freshProject, gitProject, session, failed, succeeded, contextOf, teach, teachTwice, pairState, installKeyPath, storeText } from './helpers/recovery_pairs_fixtures.js'

describe('the signature', () => {
  it('gives an assertion failure no hint after an install-fixed missing-module failure', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    expect(contextOf(await failed(session(), cwd, 'pytest', MODULE_ERROR))).toContain(INSTALL)
    expect(contextOf(await failed(session(), cwd, 'pytest', 'Exit code 1\nAssertionError: expected 1 to equal 2'))).toBe('')
  })

  it('skips a generic script header and keys on the first error-looking line', async () => {
    const { cwd } = freshProject()
    const noisy = (headline: string): string => `Exit code 1\n> pkg@1.0.0 test\n> vitest run\n\n=== test session starts ===\n${headline}`
    await teachTwice(cwd, 'npm test', [INSTALL], noisy('Error: Cannot find module foo'), 'npm test')
    expect(storeText(cwd)).not.toContain('pkg@')
    expect(storeText(cwd)).not.toContain('session starts')
    expect(contextOf(await failed(session(), cwd, 'npm test', noisy('Error: Cannot find module foo')))).toContain(INSTALL)
    expect(contextOf(await failed(session(), cwd, 'npm test', noisy('AssertionError: expected 1')))).toBe('')
  })

  it('keys on the first error-looking line even when informative lines come before it', async () => {
    const { cwd } = freshProject()
    const body = (headline: string): string => `Exit code 1\nrunning suite alpha\nloading config beta\nsetup finished gamma\n${headline}`
    await teachTwice(cwd, 'tool', [INSTALL], body('Error: Cannot find module foo'))
    expect(contextOf(await failed(session(), cwd, 'tool', body('Error: Cannot find module foo')))).toContain(INSTALL)
    expect(contextOf(await failed(session(), cwd, 'tool', body('Error: something else entirely')))).toBe('')
  })

  it('opens no pair for an error made only of banners', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'npm test', [INSTALL], 'Exit code 1\n> pkg@1.0.0 test\n=== banner ===\n\n----\n', 'npm test')
    expect(storeText(cwd)).toBe('')
  })

  it('falls back to the first three informative lines when no line reads as an error', async () => {
    const { cwd } = freshProject()
    const body = (second: string, fourth: string): string => `Exit code 1\nalpha one\n${second}\ngamma three\n${fourth}`
    await teachTwice(cwd, 'tool', [INSTALL], body('beta two', 'delta four'))
    expect(contextOf(await failed(session(), cwd, 'tool', body('beta two', 'omega other')))).toContain(INSTALL)
    expect(contextOf(await failed(session(), cwd, 'tool', body('beta changed', 'delta four')))).toBe('')
  })
})

describe('the directory scope', () => {
  it('does not share a pair between two subdirectories of one project', async () => {
    const { root } = gitProject()
    const svc1 = join(root, 'svc1')
    const svc2 = join(root, 'svc2')
    mkdirSync(svc1)
    mkdirSync(svc2)
    await teachTwice(svc1, 'pytest', [INSTALL])
    expect(contextOf(await failed(session(), svc1, 'pytest'))).toContain(INSTALL)
    expect(contextOf(await failed(session(), svc2, 'pytest'))).toBe('')
    expect(contextOf(await failed(session(), root, 'pytest'))).toBe('')
  })

  it('folds a leading cd into the scope', async () => {
    const { root } = gitProject()
    await teachTwice(root, 'cd svc1 && pytest', ['npm ci'])
    expect(contextOf(await failed(session(), root, 'cd svc1 && pytest'))).toContain('`npm ci`')
    expect(contextOf(await failed(session(), root, 'cd svc2 && pytest'))).toBe('')
    expect(contextOf(await failed(session(), root, 'pytest'))).toBe('')
  })
})

describe('what counts as the fix having run', () => {
  async function seeded(fixParts: string[]): Promise<string> {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', fixParts)
    return cwd
  }

  it('scores a hurt when a two-part fix ran as two separate whole commands and the failure came back', async () => {
    const cwd = await seeded(['npm ci', 'make setup'])
    const s = session()
    expect(contextOf(await failed(s, cwd, 'pytest'))).toContain('`npm ci && make setup`')
    await succeeded(s, cwd, 'npm ci')
    await succeeded(s, cwd, 'make setup')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 1]])
  })

  it('retires a two-part fix that keeps failing after both parts ran', async () => {
    const cwd = await seeded(['npm ci', 'make setup'])
    for (let i = 0; i < 2; i++) {
      const s = session()
      expect(contextOf(await failed(s, cwd, 'pytest'))).toContain('npm ci && make setup')
      await succeeded(s, cwd, 'npm ci')
      await succeeded(s, cwd, 'make setup')
      await failed(s, cwd, 'pytest')
    }
    expect(pairState(cwd)).toEqual([[0, 2]])
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('scores nothing when only one part of a two-part fix ran', async () => {
    const cwd = await seeded(['npm ci', 'make setup'])
    const s = session()
    await failed(s, cwd, 'pytest')
    await succeeded(s, cwd, 'npm ci')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 0]])
  })

  it('scores nothing when the parts ran out of order', async () => {
    const cwd = await seeded(['npm ci', 'make setup'])
    const s = session()
    await failed(s, cwd, 'pytest')
    await succeeded(s, cwd, 'make setup')
    await succeeded(s, cwd, 'npm ci')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 0]])
  })

  it('counts a single call that is the whole fix', async () => {
    const cwd = await seeded(['npm ci', 'make setup'])
    const s = session()
    await failed(s, cwd, 'pytest')
    await succeeded(s, cwd, 'npm ci && make setup')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 1]])
  })

  it('does not take cmake for make', async () => {
    const cwd = await seeded(['make'])
    const s = session()
    await failed(s, cwd, 'pytest')
    await succeeded(s, cwd, 'cmake ..')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 0]])
    const t = session()
    await failed(t, cwd, 'pytest')
    await succeeded(t, cwd, 'make')
    await failed(t, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 1]])
  })

  it('does not take a command that merely contains the fix for the fix', async () => {
    const cwd = await seeded(['make'])
    const s = session()
    await failed(s, cwd, 'pytest')
    await succeeded(s, cwd, 'echo make')
    await failed(s, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[0, 0]])
  })
})

describe('scoring', () => {
  it('retires a pair only when it hurt at least twice and hurt more than it helped', () => {
    // HAND-DERIVED: the three boundaries of hurt >= 2 && hurt > helped.
    const pair = { signature: 's', commandShape: 'c', fix: 'f', count: 1, lastSeen: 0, sessions: [] }
    expect(isRetired({ ...pair, helped: 1, hurt: 2 })).toBe(true)
    expect(isRetired({ ...pair, helped: 2, hurt: 2 })).toBe(false)
    expect(isRetired({ ...pair, helped: 0, hurt: 1 })).toBe(false)
  })

  it('scores an offered fix, retires one that keeps failing, and stops offering it', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    const helped = session()
    expect(contextOf(await failed(helped, cwd, 'pytest'))).toContain(INSTALL)
    await succeeded(helped, cwd, INSTALL)
    await succeeded(helped, cwd, 'pytest')
    expect(pairState(cwd)).toEqual([[1, 0]])
    for (let i = 0; i < 2; i++) {
      const s = session()
      expect(contextOf(await failed(s, cwd, 'pytest'))).toContain(INSTALL)
      await succeeded(s, cwd, INSTALL)
      await failed(s, cwd, 'pytest')
    }
    expect(pairState(cwd)).toEqual([[1, 2]])
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('scores only the pair of the failure the fix was offered for', async () => {
    const { cwd } = freshProject()
    const first = 'Exit code 1\nModuleNotFoundError: No module named foo'
    const second = 'Exit code 1\nImportError: cannot import name bar'
    await teachTwice(cwd, 'pytest', [INSTALL], first)
    await teachTwice(cwd, 'pytest', [INSTALL], second)
    const s = session()
    expect(contextOf(await failed(s, cwd, 'pytest', first))).toContain(INSTALL)
    await succeeded(s, cwd, INSTALL)
    await failed(s, cwd, 'pytest', second)
    const firstSignature = createHmac('sha256', readFileSync(installKeyPath(), 'utf8').trim()).update('exit 1: ModuleNotFoundError: No module named foo').digest('hex')
    const hurt = loadRecoveryPairs(cwd).map((p) => [p.signature === firstSignature, p.hurt] as const)
    expect(hurt.slice().sort()).toEqual([
      [false, 0],
      [true, 1],
    ])
  })

  it('never lets a newly learned pair overwrite one that has helped', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    const helped = session()
    await failed(helped, cwd, 'pytest')
    await succeeded(helped, cwd, INSTALL)
    await succeeded(helped, cwd, 'pytest')
    await teach(cwd, 'pytest', ['uv sync'])
    await teach(cwd, 'pytest', ['uv sync'])
    expect(loadRecoveryPairs(cwd).map((p) => p.fix)).toEqual([INSTALL])
  })

  it('replaces a pair that never helped with a newly learned fix', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    await teach(cwd, 'pytest', ['uv sync'])
    expect(loadRecoveryPairs(cwd).map((p) => p.fix)).toEqual(['uv sync'])
  })
})

