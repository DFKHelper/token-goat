/** Failure-recovery pairs: digests keyed per install, credential patterns, the store file, the install key, line breaks, wrappers. Split from recovery_pairs.test.ts by describe group. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepCacheRoots } from '../src/disk_cache.js'
import { purgeRoots } from '../src/purge.js'
import { clearModuleCaches } from '../src/reset.js'
import { carriesCredential, fixIsAllowed } from '../src/recovery_fix_policy.js'
import { installKey, learnableFix, loadRecoveryPairs, recoveryProjectKey, recoveryStorePath, WRAPPER } from '../src/recovery_pairs.js'
import { MODULE_ERROR, INSTALL, freshProject, session, failed, succeeded, contextOf, teach, teachTwice, sidecarPathOf, sidecarText, installKeyPath, storeText, canSymlink } from './helpers/recovery_pairs_fixtures.js'

describe('the digests are keyed per install', () => {
  // HAND-DERIVED: the error line the lesson is keyed on is `exit 1: ModuleNotFoundError: No module named foo` (the captured failure's first error line, as the scoring test above spells it); an unsalted SHA-256 of it is what a leaked store would let a guesser confirm.
  it('keeps no bare SHA-256 of a guessable error line in the store', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    const bare = createHash('sha256').update('exit 1: ModuleNotFoundError: No module named foo').digest('hex')
    expect(storeText(cwd)).not.toContain(bare)
    expect(storeText(cwd)).toContain('"signature"')
  })

  it('still lets two sessions on one install learn a pair and replay it', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toContain(INSTALL)
  })

  it('creates a random 256-bit key once, owner-only where the platform has modes, and prints it nowhere', async () => {
    const { cwd } = freshProject()
    const s = session()
    const shown = [contextOf(await failed(s, cwd, 'pytest'))]
    await succeeded(s, cwd, INSTALL)
    await succeeded(s, cwd, 'pytest')
    await teachTwice(cwd, 'pytest', [INSTALL])
    shown.push(contextOf(await failed(session(), cwd, 'pytest')))
    const key = readFileSync(installKeyPath(), 'utf8')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') expect(statSync(installKeyPath()).mode & 0o777).toBe(0o600)
    for (const text of [...shown, storeText(cwd), sidecarText(s)]) expect(text).not.toContain(key)
    await teachTwice(cwd, 'pytest', [INSTALL])
    expect(readFileSync(installKeyPath(), 'utf8')).toBe(key)
  })

  // HAND-DERIVED: a key file is valid only as 64 lowercase hex characters in a regular file; each row is a way the file on disk can be something else.
  it.each<[string, (path: string) => void]>([
    ['garbage', (path: string) => writeFileSync(path, 'not a key')],
    ['empty', (path: string) => writeFileSync(path, '')],
    ...(canSymlink() ? [['symlink', (path: string) => symlinkSync(join(dirname(path), 'elsewhere.txt'), path, 'file')] as [string, (path: string) => void]] : []),
    ['directory', (path: string) => mkdirSync(path)],
  ])('replaces a %s key file with a fresh regular key and still learns and replays', async (_name, damage) => {
    const path = installKeyPath()
    rmSync(path, { recursive: true, force: true })
    const target = join(dirname(path), 'elsewhere.txt')
    writeFileSync(target, 'untouched')
    damage(path)
    clearModuleCaches()
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    expect(lstatSync(path).isFile()).toBe(true)
    const key = readFileSync(path, 'utf8')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toContain(INSTALL)
    expect(storeText(cwd)).not.toContain(key)
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  // HAND-DERIVED: a store marked with the previous version number is what an older build left; it holds bare digests this build can not reproduce, so it is dropped unread rather than mixed in.
  it('drops a store written by the unkeyed version instead of replaying it', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toContain(INSTALL)
    const target = recoveryStorePath(recoveryProjectKey(cwd) ?? '')
    const store = JSON.parse(readFileSync(target, 'utf8')) as { version: number }
    store.version = 3
    writeFileSync(target, JSON.stringify(store))
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
    expect(existsSync(target)).toBe(false)
  })

  it('ignores a pending file of the unkeyed version', async () => {
    const { cwd } = freshProject()
    const s = session()
    await failed(s, cwd, 'pytest')
    const target = sidecarPathOf(s, '.recovery-pending')
    const pending = JSON.parse(readFileSync(target, 'utf8')) as { version: number; open: unknown[] }
    expect(pending.version).toBe(4)
    expect(pending.open.length).toBe(1)
    pending.version = 3
    writeFileSync(target, JSON.stringify(pending))
    await succeeded(s, cwd, 'pytest')
    expect(loadRecoveryPairs(cwd)).toEqual([])
  })
})

describe('credential patterns added with the digests', () => {
  it.each([
    'GITHUB_PAT=hunter2 make setup',
    'curl -H "X-Auth-Token: hunter2" https://example.invalid',
    'curl --header "Cookie: sid=hunter2" https://example.invalid',
    'deploy --passphrase hunter2',
    'sshpass -p hunter2 ssh h',
    'make deploy DB_PWD=hunter2',
    'psql -W hunter2',
    'openssl enc -k hunter2',
    'gpg --passphrase=hunter2',
  ])('flags %s', (command) => {
    expect(carriesCredential(command)).toBe(true)
  })

  it.each(['curl -H "Accept: application/json" https://example.invalid', 'psql -W', 'make PWD_DIR=build', 'ssh h', 'openssl enc -aes256 -in a -out b'])('lets %s through', (command) => {
    expect(carriesCredential(command)).toBe(false)
  })
})

describe('the store file', () => {
  const stale =(fix: string): string => JSON.stringify({ version: 1, pairs: [{ signature: 's', commandShape: 'pytest', fix, count: 1, lastSeen: 1, helped: 0, hurt: 0, sessions: [] }] })

  it('is deleted once every pair in it has expired', () => {
    const { cwd } = freshProject()
    const target = recoveryStorePath(recoveryProjectKey(cwd) ?? '')
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, stale('npm ci'))
    expect(existsSync(target)).toBe(true)
    expect(loadRecoveryPairs(cwd)).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  it('is kept while a pair in it is alive', async () => {
    const { cwd } = freshProject()
    await teach(cwd, 'pytest', [INSTALL])
    expect(existsSync(recoveryStorePath(recoveryProjectKey(cwd) ?? ''))).toBe(true)
    expect(loadRecoveryPairs(cwd).length).toBe(1)
  })

  it('lives under a root that uninstall --purge deletes', () => {
    const target = resolve(recoveryStorePath('abc'))
    expect(purgeRoots().some((root) => target.startsWith(root))).toBe(true)
  })

  it('has its session sidecars age-pruned with the rest of the sessions directory', async () => {
    const { cwd } = freshProject()
    const s = session()
    await failed(s, cwd, 'pytest')
    const pending = sidecarPathOf(s, '.recovery-pending')
    const pathMiss = sidecarPathOf(s, '.path-miss')
    writeFileSync(pathMiss, '{}')
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    utimesSync(pending, old, old)
    utimesSync(pathMiss, old, old)
    sweepCacheRoots()
    expect(existsSync(pending)).toBe(false)
    expect(existsSync(pathMiss)).toBe(false)
  })
})

describe('the install key is written without following a planted link, and one key wins a race', () => {
  function keyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tg-installkey-'))
    return join(dir, 'recovery_pairs')
  }

  // HAND-DERIVED: the old temporary name was the key path plus the process id and `.tmp`; the other rows are the neighbours a planter would guess. The random suffix is why none of them is reached, so the rows prove the target stays untouched and the key ends up a regular file.
  it.skipIf(!canSymlink())('never writes through a symlink planted at a plausible temporary name', () => {
    const dir = keyDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'install.key')
    const target = join(dir, 'victim.txt')
    writeFileSync(target, 'untouched')
    for (const name of [`install.key.${process.pid}.tmp`, 'install.key.tmp', `install.key.${process.pid + 1}.tmp`, 'install.key.0.tmp']) symlinkSync(target, join(dir, name), 'file')
    const key = 'a'.repeat(64)
    expect(installKey(path, key)).toBe(key)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(lstatSync(path).isFile()).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(key)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp') && !lstatSync(join(dir, name)).isSymbolicLink())).toEqual([])
    rmSync(dirname(dir), { recursive: true, force: true })
  })

  it.skipIf(!canSymlink())('leaves a regular file at the key path when a symlink was planted there', () => {
    const dir = keyDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'install.key')
    const target = join(dir, 'victim.txt')
    writeFileSync(target, 'untouched')
    symlinkSync(target, path, 'file')
    const key = 'b'.repeat(64)
    expect(installKey(path, key)).toBe(key)
    expect(lstatSync(path).isFile()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    rmSync(dirname(dir), { recursive: true, force: true })
  })

  // HAND-DERIVED: process A and process B both found the key bad and each holds its own fresh key. A installs first; B, arriving after, must adopt what is on disk instead of renaming its own over it, or A's digests no longer match the key the next process reads.
  it('hands the second of two writers the first writer\'s key and leaves the file alone', () => {
    const dir = keyDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'install.key')
    writeFileSync(path, 'not a key')
    const first = 'c'.repeat(64)
    const second = 'd'.repeat(64)
    expect(installKey(path, first)).toBe(first)
    expect(installKey(path, second)).toBe(first)
    expect(readFileSync(path, 'utf8')).toBe(first)
    expect(readdirSync(dir)).toEqual(['install.key'])
    rmSync(dirname(dir), { recursive: true, force: true })
  })
})

describe('a fix with a line break is refused', () => {
  // HAND-DERIVED: each row is a command the allowlist accepts, a line break or other control character, then a second command. Whitespace squeezing turns the break into a space, so the second command rode in behind an allowed one before the check ran first.
  const breaks: Array<[string, string]> = [
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['U+2028', String.fromCharCode(0x2028)],
    ['U+2029', String.fromCharCode(0x2029)],
    ['U+0085', String.fromCharCode(0x85)],
    ['a tab', '\t'],
    ['a vertical tab', String.fromCharCode(11)],
  ]
  const pairs: Array<[string, string]> = [['go test ./...', './evil'], ['make test', 'build']]
  const rows = pairs.flatMap(([head, tail]) => breaks.map(([label, sep]) => [`${head}${sep}${tail}`, label] as const))

  it.each(rows)('refuses %j (%s) through fixIsAllowed', (fix) => {
    expect(fixIsAllowed(fix, WRAPPER)).toBe(false)
    expect(fixIsAllowed(`npm ci && ${fix}`, WRAPPER)).toBe(false)
  })

  it('still accepts the same words on one line, so the line break is what is refused', () => {
    expect(fixIsAllowed('go test ./... ./evil', WRAPPER)).toBe(true)
    expect(fixIsAllowed('go test ./...', WRAPPER)).toBe(true)
    expect(fixIsAllowed('make test build', WRAPPER)).toBe(true)
  })

  // HAND-DERIVED: a store is hand-editable, so isReplayable is the second line of defence; the control row proves the edit lands (the allowed fix is spoken), the others that the broken fix is not.
  it.each([['make test', true], ['make test\nbuild', false], ['go test ./...\n./evil', false], ['make test\rbuild', false], [`make test${String.fromCharCode(0x2028)}build`, false]] as const)('replays a store edited to %j: %s', async (fix, spoken) => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest', [INSTALL])
    const target = recoveryStorePath(recoveryProjectKey(cwd) ?? '')
    const store = JSON.parse(readFileSync(target, 'utf8')) as { pairs: Array<{ fix: string }> }
    for (const pair of store.pairs) pair.fix = fix
    writeFileSync(target, JSON.stringify(store))
    expect(contextOf(await failed(session(), cwd, 'pytest')).includes('followed by')).toBe(spoken)
  })
})

describe('a Python tool behind npx, bunx or pnpm exec is not learned', () => {
  // HAND-DERIVED: the npm packages named pytest, ruff, flake8, mypy and the like are unrelated third-party code, so a replayed `npx -y <tool>` would fetch and run it. Each row is a failed bare command whose success wraps it in a node runner.
  const python = ['pytest t.py', 'ruff check .', 'flake8 src', 'mypy src', 'python -m pytest', 'python3 -m mypy src', 'black .', 'isort .', 'pylint src', 'tox']
  const wrappers = ['npx -y', 'npx --yes', 'npx', 'bunx', 'pnpm exec', 'npx --no-install']
  const rows = python.flatMap((command) => wrappers.map((wrapper) => [command, wrapper] as const))

  it.each(rows)('learns nothing from %s run as `%s` of it', (command, wrapper) => {
    expect(learnableFix(command, `${wrapper} ${command}`, [])).toBeNull()
  })

  // HAND-DERIVED: the node test and lint runners of the rerun rule; these are the tools those wrappers exist for.
  it.each([['vitest run', 'npx -y vitest run', 'npx -y (the same command)'], ['jest', 'bunx jest', 'bunx (the same command)'], ['eslint .', 'pnpm exec eslint .', 'pnpm exec (the same command)'], ['tsc', 'npx --yes tsc', 'npx --yes (the same command)'], ['mocha', 'npx mocha', 'npx (the same command)']] as const)('still learns %s run as %s', (failedCommand, success, fix) => {
    expect(learnableFix(failedCommand, success, [])).toBe(fix)
  })

  it('still learns a Python tool behind a Python runner', () => {
    expect(learnableFix('pytest t.py', 'uv run pytest t.py', [])).toBe('uv run (the same command)')
    expect(learnableFix('pytest t.py', 'source .venv/bin/activate && pytest t.py', [])).toBe('source .venv/bin/activate && (the same command)')
  })

  // HAND-DERIVED: a store from before the rule, or edited by hand, holds `npx -y (the same command)` for a Python tool; the failing command in front of the replay is what says which tool it would wrap.
  it.each([['pytest', false], ['vitest run', true]] as const)('does not replay `npx -y (the same command)` for a failing %s: %s', async (command, spoken) => {
    const { cwd } = freshProject()
    await teachTwice(cwd, command, ['npm ci'])
    const target = recoveryStorePath(recoveryProjectKey(cwd) ?? '')
    const store = JSON.parse(readFileSync(target, 'utf8')) as { pairs: Array<{ fix: string }> }
    for (const pair of store.pairs) pair.fix = 'npx -y (the same command)'
    writeFileSync(target, JSON.stringify(store))
    expect(contextOf(await failed(session(), cwd, command)).includes('followed by')).toBe(spoken)
  })

  // HAND-DERIVED: the same learned-twice flow as the review probe, through the hooks: pytest taught twice as `npx -y pytest` leaves no pair and no suggestion.
  it('gives no suggestion after `npx -y pytest` is taught twice', async () => {
    const { cwd } = freshProject()
    await teachTwice(cwd, 'pytest t.py', [], MODULE_ERROR, 'npx -y pytest t.py')
    expect(loadRecoveryPairs(cwd)).toEqual([])
    expect(contextOf(await failed(session(), cwd, 'pytest t.py'))).toBe('')
  })
})

describe('env -i is refused as a wrapper', () => {
  // HAND-DERIVED: `-i` is a source flag and was already refused; the long spelling was accepted, so both are closed and the dead `-i` entry of the wrapper list is gone.
  it.each(['env -i npm ci', 'env --ignore-environment npm ci', 'env -i CI=1 npm ci', 'env --ignore-environment CI=1 npm ci'])('refuses %s', (fix) => {
    expect(fixIsAllowed(fix, WRAPPER)).toBe(false)
  })

  it('still accepts env with a safe variable', () => {
    expect(fixIsAllowed('env CI=1 npm ci', WRAPPER)).toBe(true)
  })
})

