/**
 * Duplicate-invocation suppression for VS Code agent hooks (`src/vscode_duplicate.ts`).
 *
 * FIXTURE PROVENANCE — CAPTURE. Every payload below is a verbatim `stdin_raw` recorded by a probe
 * hook script run by a real VS Code 1.137.0 (commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`) on
 * 2026-09-12, with `code --new-window --disable-workspace-trust` so Workspace Trust could not
 * silence the hooks. Capture log: `%TEMP%\tg-dblfire\armD_multiroot.jsonl` (two-copy multi-root
 * session) and `armF_denyclean.jsonl` (path-bearing pre_tool_use). They are pasted here unedited
 * apart from shortening the machine-specific workspace roots, because the two facts this module
 * rests on are wire facts and nothing derived from our own code could establish them:
 *
 *  - the two copies of one logical event carry a BYTE-IDENTICAL `timestamp` and `session_id`
 *    (`2026-09-12T18:01:09.648Z` / `ddd6fe11-...` in both the USER and ROOTB records), which is
 *    what makes `(session_id, event, timestamp)` a usable election key; and
 *  - they differ in `cwd` alone — VS Code hands each copy the workspace folder it resolved for
 *    that hook FILE — which is what makes a path-bearing event separable by the path gate and a
 *    pathless one not separable at all.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installCopilotHooksFile, releaseCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { _resetDataDirCacheForTesting, dataDir } from '../src/constants.js'
import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent, relayInProcess } from '../src/relay.js'
import { VSCODE_HOOKS_DIR_ENV, shouldSuppressDuplicateVscodeHook } from '../src/vscode_duplicate.js'

/** CAPTURE — armD_multiroot.jsonl, tag `USER-sessionStart`, workspace root substituted. */
function sessionStartPayload(cwd: string): Record<string, unknown> {
  return {
    timestamp: '2026-09-12T18:01:09.648Z',
    hook_event_name: 'SessionStart',
    session_id: 'ddd6fe11-9a9c-4b87-9802-dc480037808c',
    transcript_path:
      'c:\\Users\\zelys\\AppData\\Roaming\\Code\\User\\workspaceStorage\\e4dbeb13983c33fa15ddf37322d74ca4\\GitHub.copilot-chat\\transcripts\\ddd6fe11-9a9c-4b87-9802-dc480037808c.jsonl',
    source: 'new',
    model: 'auto',
    cwd,
  }
}

/**
 * CAPTURE — armF_denyclean.jsonl, tag `USER-preToolUse`. VS Code's own spelling: the tool is
 * `read_file` and its argument is camelCase `filePath`. Run through `normalizePayload(_, 'vscode')`
 * exactly as `relayInProcess` does before `buildEvent`, so the event under test is the one the
 * shipping path actually constructs rather than a hand-canonicalised stand-in.
 */
function readFilePayload(cwd: string, filePath: string): Record<string, unknown> {
  return {
    timestamp: '2026-09-12T18:04:52.311Z',
    hook_event_name: 'PreToolUse',
    session_id: 'ddd6fe11-9a9c-4b87-9802-dc480037808c',
    tool_name: 'read_file',
    tool_use_id: 'call_QeQm2t1a',
    tool_input: { filePath, startLine: 1, endLine: 200 },
    cwd,
  }
}

function pathlessEvent(cwd: string) {
  return buildEvent('session_start', sessionStartPayload(cwd))
}

function readEvent(cwd: string, filePath: string) {
  return buildEvent('pre_tool_use', normalizePayload(readFilePayload(cwd, filePath), 'vscode'))
}

let tmp: string
let home: string
let saved: Record<string, string | undefined>

const ENV_KEYS = [
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'HOME',
  'USERPROFILE',
  'TOKEN_GOAT_HARNESS_OVERRIDE',
  'CLAUDE_CODE_SESSION_ID',
  VSCODE_HOOKS_DIR_ENV,
]

/**
 * A workspace folder with (or without) its own project-scope token-goat install.
 *
 * The install is REAL -- `installCopilotHooksFile`, the function `installVscode` calls -- rather
 * than a hand-written `token-goat.json`. That matters now: a bare file at that path is exactly the
 * attack shape `a repository-committed hooks file` below covers, and standing down for it is the
 * defect. Only a file this machine's own installer wrote, with its ownership sidecar, counts.
 */
function makeWorkspace(name: string, withProjectHooks: boolean): string {
  const root = path.join(tmp, name)
  fs.mkdirSync(root, { recursive: true })
  if (withProjectHooks) installCopilotHooksFile(path.join(root, '.github', 'hooks'), 'vscode')
  return root
}

/** A workspace folder carrying a hooks file the repository committed: no sidecar, no ledger entry. */
function makeHostileWorkspace(name: string, opts: { forgeSidecar?: boolean } = {}): string {
  const root = path.join(tmp, name)
  const hooks = path.join(root, '.github', 'hooks')
  fs.mkdirSync(hooks, { recursive: true })
  fs.writeFileSync(path.join(hooks, 'token-goat.json'), '{}')
  if (opts.forgeSidecar === true) fs.writeFileSync(path.join(hooks, 'token-goat.owners'), 'vscode\n')
  return root
}

function userHooksDir(): string {
  const dir = path.join(home, '.copilot', 'hooks')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-dupe-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere; both are set so the
  // `~/.copilot/hooks` comparison resolves inside the fixture on every platform.
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  // dataDir() caches at module load, so the override needs the explicit cache reset.
  process.env['LOCALAPPDATA'] = path.join(tmp, 'data')
  process.env['XDG_DATA_HOME'] = path.join(tmp, 'data')
  _resetDataDirCacheForTesting()
  delete process.env[VSCODE_HOOKS_DIR_ENV]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDataDirCacheForTesting()
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // Best-effort: the relayInProcess case leaves a SQLite handle open on the isolated data dir,
    // which Windows refuses to unlink. The directory is under the OS temp root and each test makes
    // its own, so a survivor costs nothing and must not fail the run.
  }
})

describe('shouldSuppressDuplicateVscodeHook', () => {
  it('never suppresses on a harness that is not vscode', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    const event = pathlessEvent(ws)
    // The exact setup that suppresses under 'vscode' below.
    expect(shouldSuppressDuplicateVscodeHook(event, 'copilot_cli')).toBe(false)
    expect(shouldSuppressDuplicateVscodeHook(event, 'claude')).toBe(false)
  })

  it('stands the user-scope copy down when the workspace carries its own project hooks file', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(ws), 'vscode')).toBe(true)
    // Path-bearing too: the cross-scope case is settled before the path gate is consulted, because
    // the user copy's cwd is folders[0] and the gate would judge the target against the wrong root.
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(true)
  })

  it('keeps the user-scope copy when the workspace has no project install to defer to', () => {
    const ws = makeWorkspace('rootA', false)
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(false)
  })

  it('never stands a project-scope copy down for the cross-scope reason', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(false)
    // Two project copies, one per root, for the same path-bearing event: BOTH proceed, and the path
    // gate declines the one whose workspace does not contain the target. Electing here instead would
    // risk standing down the only copy that would have acted.
    const rootB = makeWorkspace('rootB', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(rootB, '.github', 'hooks')
    expect(shouldSuppressDuplicateVscodeHook(readEvent(rootB, path.join(ws, 'README.md')), 'vscode')).toBe(false)
  })

  it('elects exactly one copy of a pathless event, across differing cwds', () => {
    const rootA = makeWorkspace('rootA', true)
    const rootB = makeWorkspace('rootB', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(rootA, '.github', 'hooks')
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(rootA), 'vscode')).toBe(false)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(rootB, '.github', 'hooks')
    // Same session_id, same event, same captured timestamp — one logical event, already claimed.
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(rootB), 'vscode')).toBe(true)
    // A third root would stand down too.
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(rootA), 'vscode')).toBe(true)
  })

  it('does not confuse two genuinely distinct pathless events in one session', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    const first = buildEvent('session_start', sessionStartPayload(ws))
    const later = buildEvent('session_start', { ...sessionStartPayload(ws), timestamp: '2026-09-12T18:09:00.000Z' })
    expect(shouldSuppressDuplicateVscodeHook(first, 'vscode')).toBe(false)
    expect(shouldSuppressDuplicateVscodeHook(later, 'vscode')).toBe(false)
  })

  it('writes its markers under token-goat data dir only, never the workspace', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    shouldSuppressDuplicateVscodeHook(pathlessEvent(ws), 'vscode')
    const markers = path.join(dataDir(), 'vscode-dedupe')
    expect(fs.existsSync(markers)).toBe(true)
    expect(fs.readdirSync(markers).filter((e) => e !== '.pruned').length).toBe(1)
    // Nothing landed in the workspace beyond the fixture's own .github/hooks file.
    expect(fs.readdirSync(ws).sort()).toEqual(['.github'])
  })

  it('fails OPEN when the marker directory cannot be created', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    // Break the marker write: a regular FILE where the marker directory must be, so the mkdir
    // inside alreadyClaimed() fails on every platform. A suppression module that throws or that
    // guesses "already claimed" here would silence every pathless hook on the machine.
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(path.join(dataDir(), 'vscode-dedupe'), 'not a directory')
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(ws), 'vscode')).toBe(false)
    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(ws), 'vscode')).toBe(false)
  })

  it('fails OPEN when the payload carries no timestamp to key on', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    const payload = sessionStartPayload(ws)
    delete payload['timestamp']
    const event = buildEvent('session_start', payload)
    expect(shouldSuppressDuplicateVscodeHook(event, 'vscode')).toBe(false)
    expect(shouldSuppressDuplicateVscodeHook(event, 'vscode')).toBe(false)
  })

  it('is actually reached by relayInProcess, not just callable', async () => {
    // A unit test of an exported function proves nothing about whether the shipping path calls it.
    // relayInProcess is the single choke point both the in-process and the CLI hook paths run
    // through, so this drives it for real and looks for the election's own side effect.
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
    delete process.env['CLAUDE_CODE_SESSION_ID']
    const markers = path.join(dataDir(), 'vscode-dedupe')
    expect(fs.existsSync(markers)).toBe(false)
    await relayInProcess('session_start', sessionStartPayload(ws))
    expect(
      fs.existsSync(markers) && fs.readdirSync(markers).some((e) => e !== '.pruned'),
      'relayInProcess did not reach the duplicate election — no marker was claimed',
    ).toBe(true)
  })

  it('fails OPEN when the shim did not say which hooks directory it came from', () => {
    const ws = makeWorkspace('rootA', true)
    // No VSCODE_HOOKS_DIR_ENV: an older installed shim. The cross-scope rule cannot fire, so the
    // user-scope copy keeps working (duplicated) rather than going silent.
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(false)
  })
})

/**
 * A repository-committed `.github/hooks/token-goat.json` is not a project install.
 *
 * The attack the bare `existsSync` allowed: a repo commits that path containing `{}`, a developer
 * with a user-scope install opens the clone, and every VS Code hook stands down -- read dedup,
 * hints, image shrinking, edit-queue reindexing, and the pre-approval path gate all return `{}`
 * with no error. It is silent by construction and indistinguishable from working.
 *
 * PROVENANCE: HAND-DERIVED for the hostile fixture (a file this test writes; `{}` is the minimum
 * payload that makes VS Code treat a file as a hooks file, per the event-key table cited on
 * VSCODE_HOOK_FILE_EVENT_KEYS). The legitimate side is not a fixture at all: it is whatever
 * `installCopilotHooksFile` actually writes, so the two cannot agree by construction.
 */
describe('a repository-committed hooks file cannot stand the real hook down', () => {
  it('keeps working when the clone carries an unowned token-goat.json', () => {
    const hostile = makeHostileWorkspace('hostile')
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(fs.existsSync(path.join(hostile, '.github', 'hooks', 'token-goat.json'))).toBe(true)
    expect(shouldSuppressDuplicateVscodeHook(readEvent(hostile, path.join(hostile, 'README.md')), 'vscode')).toBe(false)
  })

  it('keeps working when the clone also forges the ownership sidecar', () => {
    // The sidecar is a plain text file in the clone, so it is forgeable and this check alone would
    // not close the class. The ledger is the one a clone cannot write.
    const hostile = makeHostileWorkspace('forged', { forgeSidecar: true })
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(fs.readFileSync(path.join(hostile, '.github', 'hooks', 'token-goat.owners'), 'utf8')).toContain('vscode')
    expect(shouldSuppressDuplicateVscodeHook(readEvent(hostile, path.join(hostile, 'README.md')), 'vscode')).toBe(false)
  })

  it('keeps working when a real install elsewhere left a ledger entry for a different path', () => {
    // Guards against a ledger check keyed on anything looser than the exact path.
    makeWorkspace('real', true)
    const hostile = makeHostileWorkspace('hostile2', { forgeSidecar: true })
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(readEvent(hostile, path.join(hostile, 'README.md')), 'vscode')).toBe(false)
  })

  it('keeps working when the only project install in the clone belongs to Copilot CLI, not VS Code', () => {
    // The honest counterpart to the forged-sidecar case, and what makes the sidecar check carry its
    // own weight: `install --copilot --project` writes the same token-goat.json at the same path and
    // records the same ledger entry, but registers `copilot` as the owner. There is no project-scope
    // VS Code copy to defer to, so the user-scope copy is still the only one that would answer.
    const ws = path.join(tmp, 'copilotOnly')
    fs.mkdirSync(ws, { recursive: true })
    installCopilotHooksFile(path.join(ws, '.github', 'hooks'), 'copilot')
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(false)
  })

  it('stops standing down once the machine uninstalls the project install it made', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(true)
    releaseCopilotHooksFile(path.join(ws, '.github', 'hooks'), 'vscode')
    // A repository could drop its own file back at that path afterwards; the ledger entry must not
    // still be sitting there vouching for it.
    fs.mkdirSync(path.join(ws, '.github', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.github', 'hooks', 'token-goat.json'), '{}')
    fs.writeFileSync(path.join(ws, '.github', 'hooks', 'token-goat.owners'), 'vscode\n')
    expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(false)
  })

  it('records the stand-down on stderr under TOKEN_GOAT_LOG, and says nothing without it', () => {
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    })
    try {
      delete process.env['TOKEN_GOAT_LOG']
      expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(true)
      expect(lines).toEqual([])
      process.env['TOKEN_GOAT_LOG'] = '1'
      expect(shouldSuppressDuplicateVscodeHook(readEvent(ws, path.join(ws, 'README.md')), 'vscode')).toBe(true)
      expect(lines.join('')).toContain('stood down')
      expect(lines.join('')).toContain('a project-scope install owns this workspace')
    } finally {
      spy.mockRestore()
      delete process.env['TOKEN_GOAT_LOG']
    }
  })
})

/**
 * A cwd VS Code hands the hook is model-adjacent input arriving BEFORE the user approves anything,
 * and on Windows a UNC cwd (`\\host\share\repo`) turns a bare `existsSync` into an outbound SMB
 * connection carrying an NTLM authentication attempt, with no timeout available on the in-process
 * path. The lookup therefore goes through `vscodePathAllowed`, the same gate every pre_tool_use
 * handler uses, which declines a two-separator root outright.
 *
 * PROVENANCE: HAND-DERIVED. The workspace is a real `installCopilotHooksFile` install -- performed
 * THROUGH the two-separator spelling, so the ownership sidecar and the created-configs ledger both
 * vouch for that exact path. Without the gate every other check passes and the hook stands down;
 * the gate is the only thing between those two outcomes, which is what makes the assertion
 * discriminating rather than an accident of an absent install.
 */
describe('a two-separator workspace root is declined before anything stats it', () => {
  /** The same real directory addressed the way the gate must refuse: `\\?\C:\...` / `//tmp/...`. */
  function twoSeparatorSpelling(root: string): string {
    return process.platform === 'win32' ? `\\\\?\\${root}` : `/${root}`
  }

  it('does not stand the user-scope copy down for a UNC or device cwd', () => {
    const root = path.join(tmp, 'uncRoot')
    const spelled = twoSeparatorSpelling(root)
    fs.mkdirSync(root, { recursive: true })
    installCopilotHooksFile(path.join(spelled, '.github', 'hooks'), 'vscode')
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()

    // Positive control on the arrangement itself: everything the redundancy check looks at is in
    // place under the two-separator spelling, so a `false` below cannot be a missing install.
    expect(fs.existsSync(path.join(spelled, '.github', 'hooks', 'token-goat.json')), 'the install did not land, so this proves nothing').toBe(true)
    expect(fs.readFileSync(path.join(spelled, '.github', 'hooks', 'token-goat.owners'), 'utf8')).toContain('vscode')

    expect(shouldSuppressDuplicateVscodeHook(readEvent(spelled, path.join(spelled, 'README.md')), 'vscode')).toBe(false)
  })

  it('still stands down for the same install addressed normally', () => {
    // The other half: without this, the test above would pass on a gate that refuses everything.
    const root = path.join(tmp, 'uncRoot2')
    fs.mkdirSync(root, { recursive: true })
    installCopilotHooksFile(path.join(twoSeparatorSpelling(root), '.github', 'hooks'), 'vscode')
    process.env[VSCODE_HOOKS_DIR_ENV] = userHooksDir()
    expect(shouldSuppressDuplicateVscodeHook(readEvent(root, path.join(root, 'README.md')), 'vscode')).toBe(true)
  })
})

/**
 * The dedupe marker directory is a first-write path into token-goat's data root, so it is one of
 * the places that can CREATE that root -- and it must create it owner-only.
 */
describe('marker writes harden the data root', () => {
  // POSIX only: Node ignores POSIX modes on Windows, where the directory inherits the parent ACL.
  // `it.skipIf` rather than an early `return` so a Windows run says SKIPPED instead of PASSED,
  // matching tests/helpers/can-symlink.ts's reasoning about silently-unrun fixtures.
  it.skipIf(process.platform === 'win32')('creates the data root owner-only when a hook is the first thing to write there', () => {
    // The fresh-install ordering this covers: the VS Code hook fires before any CLI command has
    // ever run, so THIS is the code that creates ~/.local/share/token-goat. Created with a bare
    // recursive mkdir it takes the process umask -- 0755 on a stock Linux box -- and every local
    // user can then list the cached bash output, fetched pages and per-project index that land in
    // it. ensureDirSync/atomicWriteText are the only helpers that harden the root first.
    const ws = makeWorkspace('rootA', true)
    process.env[VSCODE_HOOKS_DIR_ENV] = path.join(ws, '.github', 'hooks')
    const root = dataDir()
    fs.rmSync(root, { recursive: true, force: true })
    _resetDataDirCacheForTesting()

    expect(shouldSuppressDuplicateVscodeHook(pathlessEvent(ws), 'vscode')).toBe(false)

    expect(fs.existsSync(path.join(dataDir(), 'vscode-dedupe')), 'the marker directory was never created, so this proves nothing').toBe(true)
    expect(fs.statSync(dataDir()).mode & 0o077, 'data root is group/world accessible').toBe(0)
  })
})
