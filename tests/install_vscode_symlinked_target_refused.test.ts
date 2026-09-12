/**
 * A project-scope VS Code install must not read, copy, or write through a symlink a repository
 * checked in.
 *
 * `install --vscode` defaults to project scope, so the installer now opens files that came out of a
 * clone the developer did not write. Three of those paths are attacker-choosable: a repository can
 * commit `.github/copilot-instructions.md` as a symlink to `~/.ssh/id_ed25519`, `.vscode/mcp.json`
 * as a symlink to a JSON credential file such as `~/.docker/config.json` (which parses cleanly, so
 * every shape check the MCP reader applies still passes), or `.github` itself as a directory link
 * whose leaf is then an ordinary file resolving outside the clone. The installer read through the
 * link, and `backupFile` copied the secret's bytes into `<repo>/<name>.bak.<ISO>` -- untracked,
 * matched by no `.gitignore`, swept up by `git add -A`.
 *
 * The assertion is therefore on BYTES IN THE WORKING TREE, not just on the throw: a refusal that
 * still managed to copy the file first would satisfy an `expect(...).toThrow()` and leak anyway.
 *
 * PROVENANCE: HAND-DERIVED. The secret payloads are arbitrary strings written by this test; the
 * attack path names are the ones `vscodeInstructionsPath`, `vscodeMcpPath` and `vscodeHooksDir`
 * compute in src/bridges/vscode_install.ts for project scope, and are pinned as such by
 * tests/install_vscode_project_default_e2e.test.ts's PROJECT_FILES list.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installVscode, uninstallVscode } from '../src/bridges/vscode_install.js'
import { backupFile } from '../src/util.js'

import { CAN_JUNCTION, CAN_SYMLINK } from './helpers/can-symlink.js'

const SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-tg-test-secret\n-----END OPENSSH PRIVATE KEY-----\n'
const SECRET_JSON = '{"auths":{"registry.example":{"auth":"dGctdGVzdC1zZWNyZXQtY3JlZA=="}}}\n'

let root: string
let project: string
let outside: string
let prevHome: string | undefined
let prevUserProfile: string | undefined
let prevAppData: string | undefined

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-symlink-')))
  project = path.join(root, 'project')
  outside = path.join(root, 'outside')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  // The installer must never reach the real home directory even if a fix is incomplete.
  prevHome = process.env['HOME']
  prevUserProfile = process.env['USERPROFILE']
  prevAppData = process.env['APPDATA']
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['APPDATA'] = path.join(home, 'AppData', 'Roaming')
})

afterEach(() => {
  vi.useRealTimers()
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('HOME', prevHome)
  restore('USERPROFILE', prevUserProfile)
  restore('APPDATA', prevAppData)
  fs.rmSync(root, { recursive: true, force: true })
})

/** Every regular file under `dir`, absolute, following nothing. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (cur: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** Names of files in the working tree whose bytes contain `needle`. */
function leakedInto(dir: string, needle: string): string[] {
  return filesUnder(dir).filter((f) => {
    try {
      return fs.readFileSync(f, 'utf8').includes(needle)
    } catch {
      return false
    }
  })
}

/**
 * Run `fn`, returning the error it threw or undefined.
 *
 * The throw is asserted LAST at every call site below, after the byte assertions. Asserting it
 * first would make the throw the only discriminating check under mutation, and a refusal that
 * copied the file before giving up would then read as a pass.
 */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}

/** A file outside the project holding `content`, plus a repo path symlinked to it. */
function plantSymlink(relInProject: string, content: string, secretName: string): string {
  const secret = path.join(outside, secretName)
  fs.writeFileSync(secret, content)
  const link = path.join(project, relInProject)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(secret, link, 'file')
  return secret
}

describe('a repository-planted symlink at a project-scope install target', () => {
  it.skipIf(!CAN_SYMLINK)('is refused at .github/copilot-instructions.md, and no secret byte reaches the tree', () => {
    const secret = plantSymlink(path.join('.github', 'copilot-instructions.md'), SECRET, 'id_ed25519')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))

    expect(leakedInto(project, 'tg-test-secret')).toEqual([])
    // The link's target is untouched too: an "install" that rewrote the user's private key would be
    // a second, worse defect than the disclosure.
    expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET)
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_SYMLINK)('is refused at .vscode/mcp.json even though the target is valid JSON', () => {
    const secret = plantSymlink(path.join('.vscode', 'mcp.json'), SECRET_JSON, 'docker-config.json')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))

    expect(leakedInto(project, 'tg-test-secret-cred')).toEqual([])
    expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET_JSON)
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_SYMLINK)('is refused at .github/hooks/token-goat.json', () => {
    plantSymlink(path.join('.github', 'hooks', 'token-goat.json'), SECRET, 'hook-secret')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))
    expect(leakedInto(project, 'tg-test-secret')).toEqual([])
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_JUNCTION)('is refused when .github itself is the link and the leaf is an ordinary file', () => {
    // The leaf is a REAL file here: an lstat of the leaf alone reports "not a symlink" and would
    // wave this through. Only resolving the whole path catches it.
    const stash = path.join(outside, 'stash')
    fs.mkdirSync(stash, { recursive: true })
    fs.writeFileSync(path.join(stash, 'copilot-instructions.md'), SECRET)
    fs.symlinkSync(stash, path.join(project, '.github'), 'junction')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))
    expect(leakedInto(project, 'tg-test-secret')).toEqual([])
    expect(fs.readFileSync(path.join(stash, 'copilot-instructions.md'), 'utf8')).toBe(SECRET)
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_JUNCTION)('is refused when .github is the link and the leaf does not exist yet', () => {
    // The other half of the directory-link case, and the half that shipped broken: with NO leaf
    // file behind the link, realpathSync throws ENOENT on the full path, and isInsideRoot used to
    // answer from the lexical form -- which says `<project>/.github/...` is inside `<project>`.
    // The install then exited 0 and created four files in `outside/stash`. The absence of a leaf
    // is the installer's NORMAL case, so this was the reachable shape, not the exotic one.
    const stash = path.join(outside, 'stash')
    fs.mkdirSync(stash, { recursive: true })
    fs.symlinkSync(stash, path.join(project, '.github'), 'junction')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))

    // The observable an attacker cares about: nothing token-goat writes may land outside the
    // project root. Asserted before the throw, so a refusal that wrote first still fails.
    expect(filesUnder(outside)).toEqual([])
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_SYMLINK)('is refused when the file link itself dangles, so the leaf cannot be realpath\'d', () => {
    // Same ENOENT trigger through the other door: the leaf IS a symlink but its target does not
    // exist, so realpathSync throws on the full path exactly as it does for a missing leaf.
    const absent = path.join(outside, 'not-created-yet.md')
    const link = path.join(project, '.github', 'copilot-instructions.md')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(absent, link, 'file')

    const err = thrownBy(() => installVscode({ project: true, projectRoot: project }))

    expect(filesUnder(outside)).toEqual([])
    expect(fs.existsSync(absent)).toBe(false)
    expect(String(err)).toMatch(/resolves outside the project/)
  })

  it.skipIf(!CAN_SYMLINK)('is refused on the uninstall path too, which reads and backs up the same files', () => {
    plantSymlink(path.join('.github', 'copilot-instructions.md'), SECRET, 'id_ed25519')

    const err = thrownBy(() => uninstallVscode({ project: true, projectRoot: project }))
    expect(leakedInto(project, 'tg-test-secret')).toEqual([])
    expect(String(err)).toMatch(/resolves outside the project/)
  })
})

describe('the population this guard runs against is not empty', () => {
  it('installs normally into a project with no links, writing every project file', () => {
    const result = installVscode({ project: true, projectRoot: project })
    expect(result.scope).toBe('project')
    const written = filesUnder(project).map((f) => path.relative(project, f).replace(/\\/g, '/')).sort()
    expect(written.filter((f) => !/\.bak\.\d{4}-/.test(f))).toEqual([
      '.github/copilot-instructions.md',
      '.github/hooks/token-goat-shim.js',
      '.github/hooks/token-goat.json',
      '.github/hooks/token-goat.owners',
      '.vscode/mcp.json',
    ])
  })

  it.skipIf(!CAN_SYMLINK)('leaves a user-scope symlinked target alone: a dotfiles link is the user\'s own', () => {
    // ~/.copilot/instructions/token-goat.instructions.md pointing into a dotfiles checkout is a
    // legitimate, common setup. The guard is scoped to project targets precisely so this keeps
    // working; refusing here would break it for no gain, since the user owns both ends.
    const dotfiles = path.join(outside, 'dotfiles')
    fs.mkdirSync(dotfiles, { recursive: true })
    const real = path.join(dotfiles, 'token-goat.instructions.md')
    fs.writeFileSync(real, '# my own file\n')
    const linkDir = path.join(root, 'home', '.copilot', 'instructions')
    fs.mkdirSync(linkDir, { recursive: true })
    fs.symlinkSync(real, path.join(linkDir, 'token-goat.instructions.md'), 'file')

    expect(() => installVscode({})).not.toThrow()
    const written = path.join(linkDir, 'token-goat.instructions.md')
    expect(fs.readFileSync(written, 'utf8')).toContain('# my own file')
    expect(fs.readFileSync(written, 'utf8')).toContain('token-goat-vscode-begin')
    // Unchanged pre-existing behaviour, pinned here so a later reader is not surprised: the write
    // goes through atomicWriteText, which renames a regular file over the link rather than writing
    // through it, so the user's dotfile keeps its old content and the link is replaced. That is a
    // separate (user-scope, non-disclosing) wart, not something this fix touches.
    expect(fs.lstatSync(written).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(real, 'utf8')).toBe('# my own file\n')
  })
})

describe('backupFile does not write through a destination symlink', () => {
  it.skipIf(!CAN_SYMLINK)('never copies into a link planted at the .bak path, and steps past it', () => {
    // The backup name is `<p>.bak.<ISO-with-dashes>`, so with the clock frozen the attacker's link
    // can be planted at exactly the path backupFile is about to create. This is the destination
    // half of the same read/write-through-a-link class; COPYFILE_EXCL is what closes it.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const target = path.join(project, 'settings.json')
    fs.writeFileSync(target, '{"a":1}\n')
    const victim = path.join(outside, 'victim.txt')
    fs.writeFileSync(victim, 'do not overwrite me\n')
    fs.symlinkSync(victim, `${target}.bak.2026-09-12T00-00-00-000Z`, 'file')

    backupFile(target)

    // The load-bearing assertion: the link's target is untouched. COPYFILE_EXCL is what does that,
    // and it is set on every attempt. The backup itself lands beside the planted link under a
    // disambiguated name rather than aborting the install -- see the same-millisecond test below
    // for why a bare throw here was the wrong shape.
    expect(fs.readFileSync(victim, 'utf8')).toBe('do not overwrite me\n')
    expect(fs.lstatSync(`${target}.bak.2026-09-12T00-00-00-000Z`).isSymbolicLink()).toBe(true)
    const written = fs.readdirSync(project).filter((f) => f.startsWith('settings.json.bak.') && !fs.lstatSync(path.join(project, f)).isSymbolicLink())
    expect(written).toEqual(['settings.json.bak.2026-09-12T00-00-00-000Z-1'])
    expect(fs.readFileSync(path.join(project, written[0] as string), 'utf8')).toBe('{"a":1}\n')
  })

  it('gives a second backup in the same millisecond its own name instead of aborting', () => {
    // Not raced: the clock is pinned, so both calls compute the identical `.bak.<ISO>` stamp with
    // certainty. Racing would only bound the failure rate (20 fresh installs measured a 4-6 ms gap
    // between installVscode's two backups of this same file -- 0/20 collisions, which bounds the
    // rate at ~15% and proves nothing), and the second call must succeed on every box, not most.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const target = path.join(project, 'copilot-instructions.md')

    fs.writeFileSync(target, 'first\n')
    backupFile(target)
    fs.writeFileSync(target, 'second\n')
    backupFile(target)

    const backups = fs.readdirSync(project).filter((f) => f.startsWith('copilot-instructions.md.bak.')).sort()
    expect(backups).toEqual([
      'copilot-instructions.md.bak.2026-09-12T00-00-00-000Z',
      'copilot-instructions.md.bak.2026-09-12T00-00-00-000Z-1',
    ])
    // Distinct names are only half of it: the second backup must hold the second content, not be a
    // duplicate of the first under a new name.
    expect(fs.readFileSync(path.join(project, backups[0] as string), 'utf8')).toBe('first\n')
    expect(fs.readFileSync(path.join(project, backups[1] as string), 'utf8')).toBe('second\n')
  })

  it('still makes an ordinary backup when nothing is planted', () => {
    const target = path.join(project, 'settings.json')
    fs.writeFileSync(target, '{"a":1}\n')
    backupFile(target)
    const backups = fs.readdirSync(project).filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(project, backups[0] as string), 'utf8')).toBe('{"a":1}\n')
  })
})
