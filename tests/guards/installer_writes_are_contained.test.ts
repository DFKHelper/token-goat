/**
 * Every project-scoped install refuses a config path that resolves outside the project, and the
 * refusal is enforced by the write helpers rather than by each installer remembering to ask.
 *
 * THE FINDING. `assertProjectScopeTarget` existed, was correct, and was wired into ONE installer of
 * five. `install --visualstudio -p`, `install --copilot --local`, `install --cursor -p` and
 * `install --pi --local` each read, backed up and rewrote a repo-controlled config path through
 * whatever symlink a clone had checked in -- so a repository could ship `.mcp.json` as a link to
 * `~/.ssh/id_ed25519` or `.github/copilot-instructions.md` as a link to a private file, and the
 * install would `copyFileSync` those bytes into `<repo>/<name>.bak.<ISO>`, an untracked file no
 * `.gitignore` matches and `git add -A` sweeps up. Reproduced live against the built bundle at
 * 3cd0b044: eight escapes across four flags, with `--vscode -p` refusing in-band as the control.
 * `--copilot --local` and `--pi --local` shipped that way in v2.9.10.
 *
 * WHY THIS FILE IS NOT THREE MORE CALL SITES. Four of five installer authors already forgot the
 * call. A guard you must remember to invoke is not a trust boundary, and a per-installer patch
 * regrows the moment a sixth bridge is written. The unit of remembering is moved instead:
 * `withInstallScope` declares the scope once per entry point and `assertWriteInScope` -- called by
 * `backupFile`, `ensureDirSync`, `atomicWriteCore`, `upsertDelimitedBlock` and `removeFileInScope`
 * themselves -- refuses anything leaving it.
 *
 * AND THAT IS WHY THIS FILE IS LOAD-BEARING RATHER THAN SUPPLEMENTARY. An earlier version of this
 * paragraph said "omission now fails CLOSED", and it is not true: `assertWriteInScope` returns early
 * when no scope was declared, so an installer that never calls `withInstallScope` is not confined at
 * all. Measured, with in-band positive controls in one run -- scope-declared + outside REFUSED,
 * scope-declared + inside ALLOWED, NO scope declared + outside ALLOWED, nested-undefined + outside
 * ALLOWED, after nested restore REFUSED. The permissive default cannot simply be flipped, because
 * those helpers are the whole codebase's write path and not the installers' (see
 * `bridges/project_scope_guard.ts::assertWriteInScope` for the full argument). So what covers the
 * undeclared case is THIS TEST, and nothing else. Its two halves cover different failure modes:
 *
 *   1. STRUCTURAL. Enumerate every installer module that both writes through a helper and builds a
 *      path from `process.cwd()`/`projectRoot`, and require each to declare a scope. The population
 *      is asserted non-empty and by name, because a population that silently empties is the exact
 *      way the sibling guard next door went quiet after a rename.
 *   2. BEHAVIOURAL. Spawn the BUILT BUNDLE against a real poisoned clone, once per install flag,
 *      and require an actual refusal. Source-text checks cannot see a flag whose scope declaration
 *      is present but wrong, and they cannot see a helper that stopped calling
 *      `assertWriteInScope`. Every poisoned run is paired with the SAME flag against a CLEAN clone
 *      that must still install: without that in-band control, "refused" is indistinguishable from
 *      an installer broken into refusing everything, and a refusal you cannot first observe
 *      succeeding is not evidence.
 *
 * The user of this repo does not run VS Code, so there is no daily-use backstop for any of this.
 * The test IS the detection surface, not a supplement to one.
 *
 * PROVENANCE: CAPTURE. The structural population is read from `src/**\/*.ts` at run time; every
 * behavioural verdict is the real exit status and stderr of the real bundle against real symlinks,
 * with a canary counter that voids the run if the probe stopped being able to see a leak at all.
 *
 * I/O: spawns the built bundle under a fully redirected HOME/USERPROFILE/TOKEN_GOAT_HOME/
 * LOCALAPPDATA/APPDATA/XDG_DATA_HOME/XDG_CONFIG_HOME, inside a scratch directory removed
 * afterwards. It never touches the real `~/.claude`, which an audit probe did once and duplicated a
 * section in the user's global config. APPDATA and XDG_CONFIG_HOME were missing from that list
 * while this sentence still claimed "fully redirected" -- see `ensureBase` for what it cost.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { CAN_JUNCTION, CAN_SYMLINK } from '../helpers/can-symlink.js'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const SRC = path.join(REPO, 'src')
const CLI = path.join(REPO, 'dist', 'token-goat.mjs')

// ---------------------------------------------------------------------------------------------
// 1. Structural: which modules must declare an install scope, and do they.
// ---------------------------------------------------------------------------------------------

/**
 * Any of the helpers that now enforce containment, plus the wrappers that funnel into them.
 *
 * `installSingleFilePlugin`/`uninstallSingleFilePlugin` are in this list because leaving them out
 * put a HOLE IN THE POPULATION SHAPED EXACTLY LIKE THE NEXT REGRESSION. `bridges/pi_install.ts`
 * writes exclusively through them and so was classified a non-member (writes=false,
 * projectRelative=true, declaresScope=true) -- meaning `--pi --local`, one of the flags that
 * SHIPPED vulnerable, had no structural regression guard at all, and `mustInclude` listed five
 * installers with pi absent, baking the omission in. Since `installSingleFilePlugin` is the obvious
 * template for the next single-file-plugin harness, a sixth installer written on it and forgetting
 * `withInstallScope` was caught by NEITHER half: the structural regex could not see it, and the
 * behavioural SPECS list below is hand-maintained.
 *
 * `removeFileInScope` is here for the same reason one step later: the destructive half of
 * containment now funnels through it, and a module whose only project-relative touch is a delete is
 * still a module that has to declare a scope.
 */
const WRITES = /\b(?:backupFile|upsertDelimitedBlock|atomicWriteText|atomicWriteBytes|ensureDirSync|writeJsonSettings|writeIfDifferent|installSingleFilePlugin|uninstallSingleFilePlugin|removeFileInScope)\s*\(/
/** Builds a path out of the working directory or an explicit project root -- i.e. a repo-relative path. */
const PROJECT_RELATIVE = /project\?:\s*boolean|local\?:\s*boolean|process\.cwd\(\)|projectRoot/
/** Declares the scope of a run. */
const DECLARES_SCOPE = /\bwithInstallScope\s*\(/

/**
 * Modules that write a repo-relative path and are therefore required to declare a scope.
 *
 * Both halves over-approximate deliberately: a false member widens the population, which fails
 * loudly and gets an exemption with a reason written beside it, rather than quietly shrinking the
 * set the way a precise-but-brittle rule would.
 */
function projectScopeWriters(): string[] {
  const out: string[] = []
  for (const dir of [path.join(SRC, 'bridges'), SRC]) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.ts')) continue
      const full = path.join(dir, name)
      const rel = path.relative(SRC, full).replace(/\\/g, '/')
      if (out.includes(rel)) continue
      const code = fs.readFileSync(full, 'utf8')
      // Installer modules only. Everything under `src/bridges/` counts, and so does any module
      // anywhere in `src/` that exports an `install*`/`uninstall*` entry point -- so a new
      // installer written outside the bridges directory does not escape the population by
      // location. Modules that merely happen to write files and mention the working directory
      // (`cli.ts`, `worker.ts`, `util.ts`) are not installs and have no scope to declare.
      const isInstaller = rel.startsWith('bridges/') || /export\s+(?:async\s+)?function\s+(?:install|uninstall)[A-Z_]/.test(code)
      if (!isInstaller) continue
      if (!WRITES.test(code) || !PROJECT_RELATIVE.test(code)) continue
      out.push(rel)
    }
  }
  return out
}

function declaresScope(rel: string): boolean {
  return DECLARES_SCOPE.test(fs.readFileSync(path.join(SRC, rel), 'utf8'))
}

/**
 * Members that write a repo-relative-looking path but are not install-time writes into a clone.
 *
 * The bar is that declaring a scope would be WRONG, not merely unnecessary.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'util.ts',
    'IS the enforcement layer, not an install run. It is here only because it exports the generic ' +
      '`installSingleFilePlugin`/`uninstallSingleFilePlugin` helpers that the real installers call ' +
      'while already inside their own scope. Declaring a scope here would either override the ' +
      "caller's (silently widening it) or wrap `assertWriteInScope` in a call to itself. The four " +
      'helpers in this file are exactly what every scoped write is required to reach.',
  ],
])

// ---------------------------------------------------------------------------------------------
// 2. Behavioural: does each flag actually refuse a poisoned clone, and still install a clean one.
// ---------------------------------------------------------------------------------------------

const CANARY = 'TG-CONTAINMENT-CANARY-9f3a1c'
/** The leaf shape needs a file symlink; the dir shape needs a junction. Separate Windows privileges. */
const CAN_LEAF = CAN_SYMLINK
const CAN_DIR = process.platform === 'win32' ? CAN_JUNCTION : CAN_SYMLINK

interface Spec {
  readonly label: string
  /** The repo-relative config path the installer writes. */
  readonly rel: string
  readonly args: readonly string[]
}

/**
 * One entry per project-confined install flag. `--vscode -p` leads because it is the IN-BAND
 * CONTROL: it was already covered before the inversion, so a run where it does not refuse is a run
 * whose other refusals mean nothing.
 *
 * `--codex`, `--kimi`, `--zed` and `--openclaw` are absent on evidence, not oversight: none of them
 * constructs a project-relative path at all (no `projectRoot`, no `process.cwd()`, no local flag),
 * so they are user-scope only and have no project target to poison.
 */
const SPECS: readonly Spec[] = [
  { label: 'vscode-p (in-band control)', rel: '.vscode/mcp.json', args: ['install', '--vscode', '-p'] },
  { label: 'vscode-p github', rel: '.github/copilot-instructions.md', args: ['install', '--vscode', '-p'] },
  { label: 'visualstudio-p', rel: '.mcp.json', args: ['install', '--visualstudio', '-p'] },
  { label: 'visualstudio-p github', rel: '.github/copilot-instructions.md', args: ['install', '--visualstudio', '-p'] },
  { label: 'copilot-local', rel: '.github/copilot-instructions.md', args: ['install', '--copilot', '--local'] },
  { label: 'cursor-p', rel: '.cursor/mcp.json', args: ['install', '--cursor', '-p'] },
  { label: 'pi-local', rel: '.pi/extensions/token-goat.ts', args: ['install', '--pi', '--local'] },
  // Plain `install -p` writes project-scope Claude Code hooks. It is only safe to spawn here
  // because HOME and USERPROFILE are redirected below: its CLAUDE.md upsert and skill write are
  // USER scope and would otherwise land in the real `~/.claude`.
  { label: 'claude-p', rel: '.claude/settings.json', args: ['install', '-p'] },
]

let BASE: string | null = null
let PRIVATE = ''
let ENV: NodeJS.ProcessEnv = {}
let filesScanned = 0

function ensureBase(): string {
  if (BASE !== null) return BASE
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-contain-'))
  const outside = path.join(BASE, 'outside')
  const fakeHome = path.join(BASE, 'home')
  for (const d of [outside, fakeHome, path.join(BASE, 'tghome'), path.join(BASE, 'localapp')]) {
    fs.mkdirSync(d, { recursive: true })
  }
  PRIVATE = path.join(outside, 'private.json')
  fs.writeFileSync(PRIVATE, `{"${CANARY}": true}\n`)
  ENV = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    TOKEN_GOAT_HOME: path.join(BASE, 'tghome'),
    LOCALAPPDATA: path.join(BASE, 'localapp'),
    XDG_DATA_HOME: path.join(BASE, 'localapp'),
    // The CONFIG roots, not just the DATA roots. `vscode_install.ts`, `zed_install.ts` and
    // `opencode_install.ts` read `process.env['APPDATA']` directly on Windows, and this set did not
    // redirect it: a probe using this very allowlist wrote `%APPDATA%\Zed\settings.json` into the
    // real user profile during an audit. The read direction bites here too -- `install --vscode -p`'s
    // clean control below calls `otherScopeHasManagedServer`, which reads the real
    // `%APPDATA%\Code\User\mcp.json`, so on a machine where token-goat IS registered in VS Code user
    // scope this guard would fail environmentally. `tests/setup/isolate-home.ts` now redirects both
    // process-wide as well; this stays explicit because the spread above is the contract THIS file's
    // header claims, and a redirection set that names four of six keys is how the gap opened.
    APPDATA: path.join(BASE, 'localapp'),
    XDG_CONFIG_HOME: path.join(BASE, 'localapp'),
    COPILOT_HOME: path.join(fakeHome, '.copilot'),
  }
  return BASE
}

afterAll(() => {
  // No early return: this hook builds nothing the tests depend on, but a bare `return` here is
  // indistinguishable to a reader (and to tests/guards/test_bodies_assert_before_returning) from a
  // setup hook that bailed and left its file running on state nobody built.
  if (BASE !== null) {
    try {
      fs.rmSync(BASE, { recursive: true, force: true })
    } catch {
      // Best effort: a junction the OS still holds open is not worth failing a run over.
    }
  }
})

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    // The link itself reads through to the secret by definition, so following it would report a
    // leak that is not one. The write-through case is caught by the outside-stash diff instead.
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) walkFiles(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}

function run(args: readonly string[], cwd: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      env: ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

interface Escape {
  readonly verdict: 'ESCAPE' | 'REFUSED' | 'no-escape'
  readonly detail: string
}

/** Build a poisoned clone for `spec`, run the flag against it, and report what escaped. */
function probe(spec: Spec, shape: 'leaf' | 'dir'): Escape {
  const base = ensureBase()
  const clone = path.join(base, `clone-${spec.label.replace(/[^\w-]/g, '_')}-${shape}`)
  fs.rmSync(clone, { recursive: true, force: true })
  fs.mkdirSync(clone, { recursive: true })

  const relDir = path.dirname(spec.rel)
  const stash = path.join(base, 'outside', `stash-${path.basename(clone)}`)
  fs.mkdirSync(stash, { recursive: true })
  fs.copyFileSync(PRIVATE, path.join(stash, path.basename(spec.rel)))

  if (shape === 'leaf') {
    fs.mkdirSync(path.join(clone, relDir), { recursive: true })
    fs.symlinkSync(path.join(stash, path.basename(spec.rel)), path.join(clone, spec.rel), 'file')
  } else {
    fs.mkdirSync(path.join(clone, path.dirname(relDir)), { recursive: true })
    fs.symlinkSync(stash, path.join(clone, relDir), 'junction')
  }
  const stashBefore = new Set(fs.readdirSync(stash))

  const { code, output } = run(spec.args, clone)

  const inTree: string[] = []
  for (const f of walkFiles(clone)) {
    filesScanned++
    try {
      if (fs.readFileSync(f, 'latin1').includes(CANARY)) inTree.push(`in-tree:${path.relative(clone, f)}`)
    } catch {
      // Unreadable file: not a leak this probe can attribute.
    }
  }
  // The other half of the harm: the installer wrote THROUGH the link, so a `.bak` copy of the
  // private file appeared beside it, outside the tree entirely.
  const outside = fs.readdirSync(stash).filter((n) => !stashBefore.has(n)).map((n) => `outside:${n}`)
  const escaped = [...inTree, ...outside]

  if (escaped.length > 0) return { verdict: 'ESCAPE', detail: escaped.join(', ') }
  if (code !== 0 && /resolves outside the project|refusing to touch/i.test(output)) {
    return { verdict: 'REFUSED', detail: `exit=${code}` }
  }
  return { verdict: 'no-escape', detail: `exit=${code} :: ${output.split('\n')[0]?.slice(0, 200) ?? ''}` }
}

/** The same flag against a CLEAN clone: it must still install, or the refusal above proves nothing. */
function cleanControl(spec: Spec): { ok: boolean; detail: string } {
  const base = ensureBase()
  const clone = path.join(base, `clean-${spec.label.replace(/[^\w-]/g, '_')}`)
  fs.rmSync(clone, { recursive: true, force: true })
  fs.mkdirSync(clone, { recursive: true })
  const { code, output } = run(spec.args, clone)
  const wrote = walkFiles(clone).length
  return {
    ok: code === 0 && wrote > 0,
    detail: `exit=${code} filesWritten=${wrote} :: ${output.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`,
  }
}

describe('installer writes are contained by construction', () => {
  it('finds the modules that write repo-relative paths, so the check below is not vacuous', () => {
    // Named individually as well as counted: a rename that drops one silently is how the sibling
    // guard (installer_writes_are_always_backed_up) went quiet after `installHooks` became
    // `installHooksScoped`.
    //
    // RE-MEASURED at 7 members after `installSingleFilePlugin`/`uninstallSingleFilePlugin` and
    // `removeFileInScope` joined WRITES: the six installers below plus `util.ts`, which is EXEMPT.
    // It was 6 before, with `bridges/pi_install.ts` wrongly excluded -- see WRITES for why that
    // omission was the shape of the next regression. Floor at 6 (one below live, so a single
    // legitimate deletion does not fire an unrelated guard) and ceiling at 10 (one past the widest
    // this classifier has been measured at), re-pinned together as the helper requires.
    //
    // `bridges/opencode_install.ts` shares pi's `installSingleFilePlugin` template and is STILL
    // correctly absent, which is worth stating because it looks like a second omission: it has no
    // project-relative path at all -- no `process.cwd()`, no `projectRoot`, no local flag -- because
    // its target is `%APPDATA%`/XDG-rooted and therefore user scope only. It fails
    // PROJECT_RELATIVE, not WRITES. Give it a `--local` flag and it joins the population
    // automatically, which is the property this widening bought.
    //
    // The anchors are EXACT. As substrings, `install.ts` also matches `pi_install.ts`,
    // `vscode_install.ts` and every other member, so the anchor meant to pin `src/install.ts`
    // specifically would have survived that file's deletion outright.
    pinnedPopulation({
      what: 'modules under src/ that build a repo-relative path and write it through a write helper',
      items: projectScopeWriters(),
      floor: 6,
      ceiling: 10,
      mustIncludeExact: [
        'bridges/copilot_cli_install.ts',
        'bridges/cursor_install.ts',
        'bridges/pi_install.ts',
        'bridges/visualstudio_install.ts',
        'bridges/vscode_install.ts',
        'install.ts',
      ],
    })
  })

  it('requires every one of them to declare an install scope', () => {
    const undeclared = projectScopeWriters().filter((rel) => !declaresScope(rel) && !EXEMPT.has(rel))

    expect(
      undeclared,
      'This module writes a path built from process.cwd()/projectRoot through a write helper, but never ' +
        'calls withInstallScope. Its writes therefore run with NO project confinement, which is the ' +
        'defect four of five installers shipped: a clone can check the config path in as a symlink to a ' +
        'private file and the install copies that file into the working tree. Wrap the entry point in ' +
        'withInstallScope(projectScopeRoot(opts), () => ...), or add it to EXEMPT here with the reason a ' +
        'scope declaration would be wrong.',
    ).toEqual([])
  })

  it('routes every filesystem mutation in an installer through a helper that checks containment', () => {
    // The boundary is only where the primitives are. Two installers reached PAST it with a raw
    // `fs.mkdirSync(dir, { recursive: true })` -- and a recursive create is exactly the hazard
    // `ensureDirSync`'s own comment names as the reason containment moved into it, because it walks
    // THROUGH a directory symlink a clone checked in. The impact was bounded then, only because the
    // `backupFile`/`atomicWriteText` on the next line did refuse; the primitive was outside the
    // boundary by inspection, and the bound was luck about ordering rather than a property.
    //
    // Deletes are here for the reason they were missing: the inversion covered writes and left
    // `unlinkSync`/`rmSync` unguarded, so "the write helpers themselves refuse a write the declared
    // root does not contain" read as a completed boundary while the destructive half walked
    // straight through it.
    // Scoped to the project-relative population above, NOT to every bridge. A user-scope-only
    // bridge unlinking `~/.codex/hooks/token-goat.json` is outside the threat model on purpose:
    // this file's own header records that a user-scope config path is routinely a symlink into a
    // dotfiles repository the user owns both ends of, and refusing those buys nothing. What makes
    // the narrow scope sufficient is that the population is COMPUTED rather than listed -- give any
    // of those bridges a `--local` flag and it joins the population, and this rule starts applying
    // to it in the same commit that introduces the hazard.
    const RAW_FS_MUTATION = /(?:\bfs\.)?\b(?:mkdirSync|rmSync|unlinkSync|rmdirSync|writeFileSync|renameSync|copyFileSync|symlinkSync)\s*\(/g
    const offenders: string[] = []
    for (const rel of pinnedPopulation({
      what: 'project-relative installer modules scanned for raw filesystem mutations',
      items: projectScopeWriters(),
      floor: 6,
      ceiling: 10,
      mustIncludeExact: ['bridges/cursor_install.ts', 'bridges/visualstudio_install.ts', 'bridges/pi_install.ts', 'install.ts'],
    })) {
      if (EXEMPT.has(rel)) continue
      const code = fs.readFileSync(path.join(SRC, rel), 'utf8')
      // Comments and doc blocks name these primitives constantly -- that is how the hazard gets
      // explained -- so only real code counts. Block comments are blanked rather than deleted so
      // the reported line numbers stay true.
      const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      for (const m of codeOnly.matchAll(RAW_FS_MUTATION)) {
        // An explicit `assertWriteInScope` just above the call is the escape hatch, and the only
        // one: it is the same containment check the helpers make, written out where no helper fits
        // -- a recursive DIRECTORY removal, which the file-only `removeFileInScope` cannot express.
        // Same idiom as the sibling backup guard, which accepts a `backupFile` earlier in the body.
        const before = codeOnly.slice(0, m.index).split('\n').slice(-4).join('\n')
        if (/\bassertWriteInScope\s*\(/.test(before)) continue
        offenders.push(`${rel}:${codeOnly.slice(0, m.index).split('\n').length}: ${m[0]}`)
      }
    }

    expect(
      offenders,
      'These installer modules mutate the filesystem through a raw node:fs primitive instead of a ' +
        'containment-checking helper (ensureDirSync / atomicWriteText / backupFile / ' +
        'upsertDelimitedBlock / removeFileInScope). A raw call is outside the trust boundary by ' +
        'construction: a recursive mkdir walks through a checked-in directory symlink, and an unlink ' +
        'below one deletes the file at its target. Route it through the helper, which is the only ' +
        'place assertWriteInScope is called.',
    ).toEqual([])
  })

  it('names no exemption that has stopped being a writer', () => {
    const members = new Set(projectScopeWriters())
    expect([...EXEMPT.keys()].filter((k) => !members.has(k))).toEqual([])
  })

  describe.skipIf(!CAN_LEAF && !CAN_DIR)('against a real poisoned clone', () => {
    for (const spec of SPECS) {
      const shapes = (['leaf', 'dir'] as const).filter(
        (s) => (s === 'leaf' ? CAN_LEAF : CAN_DIR && path.dirname(spec.rel) !== '.'),
      )
      for (const shape of shapes) {
        it(`refuses ${spec.label} when ${spec.rel} is a ${shape} link out of the tree`, { timeout: 60_000 }, () => {
          const r = probe(spec, shape)

          expect(
            r.verdict,
            `${spec.label}/${shape}: ${r.detail}. ESCAPE means the private file's bytes reached the working ` +
              'tree or a backup of it appeared outside; no-escape means nothing leaked THIS TIME but the ' +
              'install did not refuse, which is a shape away from leaking.',
          ).toBe('REFUSED')
        })
      }

      it(`still installs ${spec.label} into a clean clone (in-band control)`, { timeout: 60_000 }, () => {
        const r = cleanControl(spec)

        expect(
          r.ok,
          `${spec.label}: the containment refusal above is only evidence if the same flag succeeds on a ` +
            `clean clone. It did not: ${r.detail}. A false refusal here is a real bug -- the shared ` +
            'Claude hook shim is a legitimate USER-scope write made during a PROJECT-scope run, and ' +
            'confining it broke `install -p` once already.',
        ).toBe(true)
      })
    }

    it('scanned something, so a clean sweep above is not a dead probe', () => {
      expect(filesScanned, 'the leak search opened no files at all, which voids every no-escape verdict').toBeGreaterThan(0)
      expect(fs.readFileSync(PRIVATE, 'latin1').includes(CANARY), 'the canary is no longer findable by this probe\'s own matcher, so it could not have detected a leak either').toBe(true)
    })
  })
})
