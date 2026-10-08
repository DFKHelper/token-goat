/** The structural lock diff and the audit built on it (scripts/lock-audit.mjs). Every lock pair is HAND-DERIVED and the registry is a fake lookup, so nothing here reaches a network. */
import { describe, expect, it } from 'vitest'
import { auditLockChange, diffLocks, formatDiff, parseNpmView } from '../scripts/lock-audit.mjs'

const AT = new Date('2026-10-07T00:00:00.000Z')
const OLD_ENOUGH = '2026-09-01T00:00:00.000Z'

type Entry = Record<string, unknown>
const lock = (packages: Record<string, Entry>) => ({ lockfileVersion: 3, packages: { '': { name: 'root', version: '1.0.0' }, ...packages } })
const pkg = (version: string, integrity: string, extra: Entry = {}): Entry => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity, ...extra })

/** A registry that serves what the lock says for every name@version, published long enough ago. */
function registryOf(table: Record<string, { publishedAt?: string; integrity?: string }>) {
  return (name: string, version: string) => {
    const hit = table[`${name}@${version}`]
    if (!hit) throw new Error('404 not in the fake registry')
    return { publishedAt: hit.publishedAt ?? OLD_ENOUGH, integrity: hit.integrity ?? null }
  }
}

const audit = (oldLock: unknown, newLock: unknown, lookup: (n: string, v: string) => { publishedAt: string | null; integrity: string | null }, overrides?: Record<string, string>) => auditLockChange({ oldLock, newLock, overrides, cooldownDays: 7, at: AT, lookup })

describe('diffLocks', () => {
  it('reports added, removed and moved packages, and ignores the root entry', () => {
    // HAND-DERIVED: a is bumped, b is dropped, c arrives.
    const before = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a1'), 'node_modules/b': pkg('2.0.0', 'sha512-b') })
    const after = lock({ 'node_modules/a': pkg('1.1.0', 'sha512-a2'), 'node_modules/c': pkg('3.0.0', 'sha512-c') })
    const diff = diffLocks(before, after)
    expect(diff.added).toEqual([{ path: 'node_modules/c', name: 'c', version: '3.0.0' }])
    expect(diff.removed).toEqual([{ path: 'node_modules/b', name: 'b', version: '2.0.0' }])
    expect(diff.changed).toEqual([{ path: 'node_modules/a', name: 'a', from: '1.0.0', to: '1.1.0', integrityChanged: true }])
    expect(formatDiff(diff)).toEqual(['added    node_modules/c 3.0.0', 'removed  node_modules/b 2.0.0', 'changed  node_modules/a 1.0.0 -> 1.1.0 (integrity changed)'])
  })

  it('names a nested package by the segment after its last node_modules/, and an alias by its recorded name', () => {
    const diff = diffLocks(lock({}), lock({ 'node_modules/a/node_modules/@s/b': pkg('1.0.0', 'sha512-b'), 'node_modules/alias': pkg('1.0.0', 'sha512-r', { name: 'real' }) }))
    expect(diff.added.map((item: { name: string }) => item.name)).toEqual(['@s/b', 'real'])
  })

  it('reports a flag change and a package that newly carries an install script', () => {
    const before = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a', { optional: true }), 'node_modules/b': pkg('1.0.0', 'sha512-b') })
    const after = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a'), 'node_modules/b': pkg('1.0.0', 'sha512-b', { hasInstallScript: true }) })
    const diff = diffLocks(before, after)
    expect(diff.flagChanges).toEqual([{ path: 'node_modules/a', flag: 'optional', from: true, to: false }])
    expect(diff.newInstallScripts).toEqual(['node_modules/b'])
    expect(formatDiff(diff)).toContain('note     node_modules/b now has an install script')
  })

  it('reports a root optionalDependencies entry that moved to dependencies', () => {
    const before = { packages: { '': { optionalDependencies: { fsevents: '^2.0.0' } } } }
    const after = { packages: { '': { dependencies: { fsevents: '^2.0.0' } } } }
    expect(diffLocks(before, after).rootReclassified).toEqual([{ name: 'fsevents', from: 'optionalDependencies', to: 'dependencies' }])
  })

  it('shows a change to a dependency map even when no version moved', () => {
    const before = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a', { optionalDependencies: { b: '1.0.0' } }) })
    const after = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a', { optionalDependencies: { b: '1.0.1' } }) })
    const lines = formatDiff(diffLocks(before, after))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('node_modules/a')
    expect(lines[0]).toContain('optionalDependencies')
  })
})

describe('auditLockChange', () => {
  const before = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a1') })
  const after = lock({ 'node_modules/a': pkg('1.1.0', 'sha512-a2') })

  it('passes a bump whose version cooled down and whose integrity the registry confirms', async () => {
    const result = await audit(before, after, registryOf({ 'a@1.1.0': { integrity: 'sha512-a2' } }))
    expect(result.violations).toEqual([])
  })

  it('accepts a release published exactly cooldown days before the commit and refuses one a millisecond later', async () => {
    const edge = new Date(AT.getTime() - 7 * 24 * 60 * 60 * 1000)
    const exact = await audit(before, after, registryOf({ 'a@1.1.0': { integrity: 'sha512-a2', publishedAt: edge.toISOString() } }))
    expect(exact.violations).toEqual([])
    const inside = await audit(before, after, registryOf({ 'a@1.1.0': { integrity: 'sha512-a2', publishedAt: new Date(edge.getTime() + 1).toISOString() } }))
    expect(inside.violations.map((v: { kind: string }) => v.kind)).toEqual(['cooldown'])
  })

  it('refuses an integrity the registry does not serve for that version', async () => {
    const result = await audit(before, after, registryOf({ 'a@1.1.0': { integrity: 'sha512-other' } }))
    expect(result.violations.map((v: { kind: string }) => v.kind)).toEqual(['integrity'])
    expect(result.violations[0].message).toContain('sha512-a2')
    expect(result.violations[0].message).toContain('sha512-other')
  })

  it('treats a package the registry cannot answer for as a violation, not a pass', async () => {
    const result = await audit(before, after, registryOf({}))
    expect(result.violations.map((v: { kind: string }) => v.kind)).toEqual(['lookup'])
    expect(result.violations[0].message).toContain('a@1.1.0')
  })

  it('treats an answer with no publish time as a lookup violation', async () => {
    const result = await audit(before, after, () => ({ publishedAt: null, integrity: 'sha512-a2' }))
    expect(result.violations.map((v: { kind: string }) => v.kind)).toEqual(['lookup'])
  })

  it('refuses a changed integrity on an unchanged version', async () => {
    const result = await audit(lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a1') }), lock({ 'node_modules/a': pkg('1.0.0', 'sha512-evil') }), registryOf({}))
    expect(result.violations.map((v: { kind: string }) => v.kind)).toEqual(['integrity-same-version'])
  })

  it('refuses a package that gains an install script, whether it is new or an existing one that started running code, and not one that always had it', async () => {
    // HAND-DERIVED: hasInstallScript is the lock's own marker for a preinstall, install or postinstall script.
    const ok = registryOf({ 'a@1.1.0': { integrity: 'sha512-a2' }, 'n@1.0.0': { integrity: 'sha512-n' } })
    const gained = lock({ 'node_modules/a': pkg('1.1.0', 'sha512-a2', { hasInstallScript: true }) })
    const result = await audit(before, gained, ok)
    expect(result.violations.map((v: { kind: string }) => v.kind)).toEqual(['install-script'])
    expect(result.violations[0].path).toBe('node_modules/a')
    const arrived = await audit(lock({}), lock({ 'node_modules/n': pkg('1.0.0', 'sha512-n', { hasInstallScript: true }) }), ok)
    expect(arrived.violations.map((v: { kind: string }) => v.kind)).toEqual(['install-script'])
    const always = await audit(lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a1', { hasInstallScript: true }) }), gained, ok)
    expect(always.violations).toEqual([])
  })

  it('refuses a package that stopped being optional, and a root optionalDependencies entry that moved', async () => {
    const o = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a', { optional: true }) })
    const r = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a') })
    expect((await audit(o, r, registryOf({}))).violations.map((v: { kind: string }) => v.kind)).toEqual(['optional-lost'])
    const rootBefore = { packages: { '': { optionalDependencies: { a: '^1.0.0' } }, 'node_modules/a': pkg('1.0.0', 'sha512-a', { optional: true }) } }
    const rootAfter = { packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': pkg('1.0.0', 'sha512-a', { optional: true }) } }
    expect((await audit(rootBefore, rootAfter, registryOf({}))).violations.map((v: { kind: string }) => v.kind)).toEqual(['reclassified'])
  })

  it('refuses a lock that disagrees with itself (the b479903b shape)', async () => {
    // HAND-DERIVED from b479903b: the parent still names 2.1.14 of a child the tree resolves at 2.1.15.
    const stale = lock({ 'node_modules/p': pkg('2.1.15', 'sha512-p', { optionalDependencies: { c: '2.1.14' } }), 'node_modules/c': pkg('2.1.15', 'sha512-c') })
    const fresh = lock({ 'node_modules/p': pkg('2.1.15', 'sha512-p', { optionalDependencies: { c: '2.1.15' } }), 'node_modules/c': pkg('2.1.15', 'sha512-c') })
    const ok = registryOf({ 'p@2.1.15': { integrity: 'sha512-p' }, 'c@2.1.15': { integrity: 'sha512-c' } })
    const bad = await audit(lock({}), stale, ok)
    expect(bad.violations.map((v: { kind: string }) => v.kind)).toEqual(['inconsistent'])
    expect(bad.violations[0].message).toContain('c@2.1.14')
    expect((await audit(lock({}), fresh, ok)).violations).toEqual([])
  })

  it('looks each name@version up once, and skips an entry the registry does not serve (a link or file dependency)', async () => {
    const calls: string[] = []
    const twice = lock({ 'node_modules/a': pkg('1.0.0', 'sha512-a'), 'node_modules/x/node_modules/a': pkg('1.0.0', 'sha512-a'), 'node_modules/local': { version: '1.0.0', link: true, resolved: 'packages/local' } })
    const result = await audit(lock({}), twice, (name: string, version: string) => {
      calls.push(`${name}@${version}`)
      return { publishedAt: OLD_ENOUGH, integrity: 'sha512-a' }
    })
    expect(calls).toEqual(['a@1.0.0'])
    expect(result.violations).toEqual([])
  })
})

describe('parseNpmView', () => {
  // CAPTURE: `npm view lefthook@2.1.15 dist.integrity time --json` (npm 11.6.2), trimmed to the keys read.
  const captured = '{"dist.integrity":"sha512-l/BSlOZBou3zLDuSIV8V+kbNyC6UiFCACVHu8dVUCDxH5+8qZXmJr8iROruI/7hv6W7c3sVlVT+6+BpVhGZRmA==","time":{"created":"2020-01-01T00:00:00.000Z","2.1.14":"2026-09-20T10:00:00.000Z","2.1.15":"2026-09-29T19:51:53.849Z"}}'

  it('reads the integrity and the publish time of the version asked for', () => {
    expect(parseNpmView(captured, '2.1.15')).toEqual({ integrity: 'sha512-l/BSlOZBou3zLDuSIV8V+kbNyC6UiFCACVHu8dVUCDxH5+8qZXmJr8iROruI/7hv6W7c3sVlVT+6+BpVhGZRmA==', publishedAt: '2026-09-29T19:51:53.849Z' })
  })

  it('answers null for a version the time map lacks, and reads the last object of an array answer', () => {
    expect(parseNpmView(captured, '9.9.9').publishedAt).toBeNull()
    expect(parseNpmView(`[{"dist.integrity":"old"},${captured}]`, '2.1.15').publishedAt).toBe('2026-09-29T19:51:53.849Z')
  })
})
