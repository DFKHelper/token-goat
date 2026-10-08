import { describe, expect, it } from 'vitest'
import { checkLockConsistency, formatProblem, satisfies } from '../scripts/lock-consistency.mjs'

/** PROVENANCE: HAND-DERIVED. Every lock below is a minimal package-lock.json written from the lockfileVersion 3 shape (a `packages` map keyed by install path), and every semver verdict in the table is computed from the node-semver range rules by hand, independently of the module under test. The b479903b shape is the one that commit produced: the parent's optionalDependencies map names 2.1.14 while the sibling platform package resolves to 2.1.15. */

type Entry = Record<string, unknown>
const lock = (packages: Record<string, Entry>) => ({ lockfileVersion: 3, packages: { '': { name: 'root', version: '1.0.0' }, ...packages } })

describe('satisfies', () => {
  const table: readonly [string, string, boolean][] = [
    ['2.1.15', '2.1.15', true],
    ['2.1.15', '2.1.14', false],
    ['2.1.15', '=2.1.15', true],
    ['3.25.8', '^3.25', true],
    ['4.0.0', '^3.25 || ^4.0', true],
    ['3.24.9', '^3.25', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['4.9.9', '^4', true],
    ['5.0.0', '^4', false],
    ['2.3.9', '~2.3.0', true],
    ['2.4.0', '~2.3.0', false],
    ['4.2.0', '2', false],
    ['2.9.9', '2', true],
    ['2.5.0', '>= 2.1.2 < 3.0.0', true],
    ['3.0.0', '>= 2.1.2 < 3.0.0', false],
    ['4.12.0', '>= 4.11', true],
    ['11.1.6', '11.1.5 || >11.1.6 <12', false],
    ['11.2.0', '11.1.5 || >11.1.6 <12', true],
    ['9.9.9', '*', true],
    ['5.0.0', '^5.0.0-beta.5 || >=5.0.0', true],
    ['5.0.0-beta.6', '^5.0.0-beta.5 || >=5.0.0', true],
    ['5.0.0-beta.4', '^5.0.0-beta.5 || >=5.0.0', false],
    ['5.1.0-beta.1', '^5.0.0-beta.5', false],
  ]
  it.each(table)('%s against %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  it('returns null for syntax outside the supported subset instead of guessing', () => {
    expect(satisfies('1.0.0', 'latest')).toBeNull()
    expect(satisfies('1.0.0', 'npm:other@^1')).toBeNull()
    expect(satisfies('1.0.0', 'file:../x')).toBeNull()
  })
})

describe('checkLockConsistency', () => {
  it('accepts a lock whose specs are all met', () => {
    const problems = checkLockConsistency(
      lock({
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^2.0.0' }, optionalDependencies: { c: '1.0.0' } },
        'node_modules/b': { version: '2.3.0' },
        'node_modules/c': { version: '1.0.0' },
      }),
    )
    expect(problems).toEqual([])
  })

  it('rejects the b479903b shape: a parent naming 2.1.14 beside a top-level 2.1.15', () => {
    const problems = checkLockConsistency(
      lock({
        'node_modules/lefthook': { version: '2.1.15', optionalDependencies: { 'lefthook-linux-x64': '2.1.14' } },
        'node_modules/lefthook-linux-x64': { version: '2.1.15' },
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ dependent: 'node_modules/lefthook', field: 'optionalDependencies', name: 'lefthook-linux-x64', spec: '2.1.14', kind: 'mismatch', resolvedPath: 'node_modules/lefthook-linux-x64', resolvedVersion: '2.1.15' })
    expect(formatProblem(problems[0])).toBe('node_modules/lefthook declares optionalDependencies lefthook-linux-x64@2.1.14, but node resolves node_modules/lefthook-linux-x64@2.1.15, which does not satisfy it')
  })

  it('accepts a nested copy that is the one node resolves for its dependent', () => {
    const problems = checkLockConsistency(
      lock({
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
        'node_modules/a/node_modules/b': { version: '1.4.0' },
        'node_modules/b': { version: '2.0.0' },
        'node_modules/d': { version: '1.0.0', dependencies: { b: '^2.0.0' } },
      }),
    )
    expect(problems).toEqual([])
  })

  it('rejects a dependent whose nested copy is the wrong one', () => {
    const problems = checkLockConsistency(
      lock({
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^2.0.0' } },
        'node_modules/a/node_modules/b': { version: '1.4.0' },
        'node_modules/b': { version: '2.0.0' },
      }),
    )
    expect(problems.map((p: { resolvedPath?: string }) => p.resolvedPath)).toEqual(['node_modules/a/node_modules/b'])
  })

  it('walks up through a scoped package path to the right node_modules', () => {
    const problems = checkLockConsistency(
      lock({
        'node_modules/x': { version: '1.0.0' },
        'node_modules/x/node_modules/@s/a': { version: '1.0.0', dependencies: { y: '1.0.0' } },
        'node_modules/y': { version: '1.0.0' },
      }),
    )
    expect(problems).toEqual([])
  })

  it('rejects a required dependency that resolves to nothing', () => {
    const problems = checkLockConsistency(lock({ 'node_modules/a': { version: '1.0.0', dependencies: { gone: '^1.0.0' } } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'missing', name: 'gone' })
    expect(formatProblem(problems[0])).toContain('nothing in the lock resolves it')
  })

  it('allows an optional dependency that resolves to nothing', () => {
    expect(checkLockConsistency(lock({ 'node_modules/a': { version: '1.0.0', optionalDependencies: { gone: '^1.0.0' } } }))).toEqual([])
  })

  it('checks a present peer but ignores an absent one and an optional one', () => {
    const base = {
      'node_modules/a': { version: '1.0.0', peerDependencies: { p: '^1.0.0', q: '^1.0.0', r: '^1.0.0' }, peerDependenciesMeta: { r: { optional: true } } },
      'node_modules/p': { version: '2.0.0' },
      'node_modules/r': { version: '9.0.0' },
    }
    const problems = checkLockConsistency(lock(base))
    expect(problems.map((p: { name: string }) => p.name)).toEqual(['p'])
  })

  it('reads the root package dependencies too', () => {
    const packages = { '': { name: 'root', dependencies: { a: '^2.0.0' } }, 'node_modules/a': { version: '1.0.0' } }
    expect(checkLockConsistency({ packages })).toHaveLength(1)
  })

  it('lets an override explain a mismatch but still holds the resolved copy to the override', () => {
    const packages = {
      'node_modules/a': { version: '1.0.0', dependencies: { sharp: '^0.32.0', z: '^1.0.0' } },
      'node_modules/sharp': { version: '0.35.5' },
      'node_modules/z': { version: '1.2.0' },
    }
    expect(checkLockConsistency(lock(packages), { overrides: { sharp: '^0.35.0' } })).toEqual([])
    const stale = checkLockConsistency(lock(packages), { overrides: { sharp: '^0.36.0' } })
    expect(stale).toHaveLength(1)
    expect(formatProblem(stale[0])).toContain('(forced by overrides, replacing ^0.32.0)')
  })

  it('follows a $name override to the root declaration', () => {
    const packages = {
      '': { name: 'root', optionalDependencies: { sharp: '^0.35.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { sharp: '^0.32.0' } },
      'node_modules/sharp': { version: '0.35.5' },
    }
    expect(checkLockConsistency({ packages }, { overrides: { sharp: '$sharp' } })).toEqual([])
  })

  it('reports a spec it cannot check rather than passing it', () => {
    const problems = checkLockConsistency(lock({ 'node_modules/a': { version: '1.0.0', dependencies: { b: 'latest' } }, 'node_modules/b': { version: '1.0.0' } }))
    expect(problems).toHaveLength(1)
    expect(problems[0].kind).toBe('unsupported')
  })

  it('skips link entries, which carry no version of their own', () => {
    const problems = checkLockConsistency(lock({ 'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } }, 'node_modules/b': { resolved: 'packages/b', link: true } }))
    expect(problems).toEqual([])
  })
})
