/** Restoring and checking the `libc` field npm 11.6.2 drops from a lock (scripts/lock-libc.mjs). Lock fragments are HAND-DERIVED from the real lock's shape (package-lock.json, node_modules/@img/sharp-libvips-linux-arm64: keys version, resolved, integrity, cpu, dev, libc, license, optional, os); the registry is a fake lookup, so nothing here reaches a network. */
import { describe, expect, it } from 'vitest'
import { bareLinuxPackages, findMissingLibc, restoreLibc } from '../scripts/lock-libc.mjs'

type Entry = Record<string, unknown>
const linux = (version: string, extra: Entry = {}): Entry => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: 'sha512-x', cpu: ['x64'], dev: true, license: 'MIT', optional: true, os: ['linux'], ...extra })
const lockOf = (packages: Record<string, Entry>): { lockfileVersion: number; packages: Record<string, Entry> } => ({ lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } })
const registry = (table: Record<string, string[] | null>) => (name: string, version: string) => {
  const key = `${name}@${version}`
  if (!(key in table)) throw new Error('404')
  return { libc: table[key] }
}

describe('bareLinuxPackages', () => {
  it('lists only registry Linux packages without libc', () => {
    const lock = lockOf({
      'node_modules/a-linux': linux('1.0.0'),
      'node_modules/b-linux-glibc': linux('1.0.0', { libc: ['glibc'] }),
      'node_modules/c-darwin': linux('1.0.0', { os: ['darwin'] }),
      'node_modules/d-any': { version: '1.0.0', resolved: 'https://registry.npmjs.org/d/-/d-1.0.0.tgz' },
      'node_modules/e-link': linux('1.0.0', { link: true }),
      'node_modules/f-file': linux('1.0.0', { resolved: 'file:../f' }),
    })
    expect(bareLinuxPackages(lock)).toEqual(['node_modules/a-linux'])
  })
})

describe('restoreLibc', () => {
  it('takes libc from the previous lock for an unchanged entry, without asking the registry', async () => {
    const oldLock = lockOf({ 'node_modules/a': linux('1.0.0', { libc: ['musl'] }) })
    const newLock = lockOf({ 'node_modules/a': linux('1.0.0') })
    const result = await restoreLibc({ oldLock, newLock, lookup: () => { throw new Error('must not be asked') } })
    expect(result.unresolved).toEqual([])
    expect(result.restored).toEqual([{ path: 'node_modules/a', libc: ['musl'], source: 'previous lock' }])
    expect((newLock.packages['node_modules/a'] as Entry).libc).toEqual(['musl'])
  })

  it('takes libc from the registry for a moved or new entry, and puts it where npm writes it', async () => {
    const oldLock = lockOf({ 'node_modules/a': linux('1.0.0', { libc: ['glibc'] }) })
    const newLock = lockOf({ 'node_modules/a': linux('1.1.0'), 'node_modules/n': linux('2.0.0') })
    const result = await restoreLibc({ oldLock, newLock, lookup: registry({ 'a@1.1.0': ['glibc'], 'n@2.0.0': ['musl'] }) })
    expect(result.restored.map((r: { path: string; source: string }) => `${r.path}:${r.source}`)).toEqual(['node_modules/a:registry', 'node_modules/n:registry'])
    expect(Object.keys(newLock.packages['node_modules/a'])).toEqual(['version', 'resolved', 'integrity', 'cpu', 'dev', 'libc', 'license', 'optional', 'os'])
    expect((newLock.packages['node_modules/n'] as Entry).libc).toEqual(['musl'])
  })

  it('leaves alone an entry the registry declares no libc for, and an unchanged entry that was always bare', async () => {
    const oldLock = lockOf({ 'node_modules/bare': linux('1.0.0') })
    const newLock = lockOf({ 'node_modules/bare': linux('1.0.0'), 'node_modules/free': linux('1.0.0') })
    const result = await restoreLibc({ oldLock, newLock, lookup: registry({ 'free@1.0.0': null }) })
    expect(result).toEqual({ restored: [], unresolved: [] })
    expect('libc' in (newLock.packages['node_modules/bare'] as Entry)).toBe(false)
  })

  it('reports an entry the registry could not answer for, rather than leaving it bare silently', async () => {
    const newLock = lockOf({ 'node_modules/gone': linux('9.9.9') })
    const result = await restoreLibc({ oldLock: lockOf({}), newLock, lookup: registry({}) })
    expect(result.restored).toEqual([])
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0].message).toContain('gone')
  })

  it('names a scoped or nested package by its registry name, and asks once per name@version', async () => {
    const asked: string[] = []
    const newLock = lockOf({ 'node_modules/@s/p-linux': linux('1.0.0'), 'node_modules/x/node_modules/@s/p-linux': linux('1.0.0') })
    await restoreLibc({ oldLock: lockOf({}), newLock, lookup: (name: string, version: string) => { asked.push(`${name}@${version}`); return { libc: ['glibc'] } } })
    expect(asked).toEqual(['@s/p-linux@1.0.0'])
  })
})

describe('findMissingLibc', () => {
  it('flags a Linux package whose registry manifest declares libc and whose lock entry lacks it', async () => {
    const lock = lockOf({ 'node_modules/a': linux('1.0.0'), 'node_modules/b': linux('1.0.0'), 'node_modules/c': linux('1.0.0', { libc: ['glibc'] }) })
    const problems = await findMissingLibc({ lock, lookup: registry({ 'a@1.0.0': ['glibc'], 'b@1.0.0': null }) })
    expect(problems.map((p: { path: string }) => p.path)).toEqual(['node_modules/a'])
    expect(problems[0].message).toContain('"glibc"')
  })

  it('treats a package the registry cannot answer for as a problem, not a pass', async () => {
    const problems = await findMissingLibc({ lock: lockOf({ 'node_modules/a': linux('1.0.0') }), lookup: registry({}) })
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain('could not be checked')
  })

  it('asks nothing for a lock with no bare Linux package', async () => {
    const problems = await findMissingLibc({ lock: lockOf({ 'node_modules/a': linux('1.0.0', { libc: ['musl'] }) }), lookup: () => { throw new Error('must not be asked') } })
    expect(problems).toEqual([])
  })
})
