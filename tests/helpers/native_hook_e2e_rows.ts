/** The describe blocks of tests/native_hook_install_e2e.test.ts, registered by the shard files. A shard names the rows it runs; a row that relies on an earlier row's install or serve run does that step itself. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parse as parseToml } from 'smol-toml'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { computeCodexHookHash } from '../../src/bridges/codex_install.js'
import { SESSION_START_TEST_BUDGET_ENV, SESSION_START_TEST_BUDGET_MIN_MS } from '../../src/bridges/shim_common.js'
import { parseGuardedCommand } from '../../src/hook_guard.js'
import { parseNativeInvocation, splitHookCommand } from '../../src/native_hook.js'
import type { PayloadHarness } from '../fixtures/harness_hook_payloads.js'
import { ROOT } from './bundle.js'
import { isHookServerCommandLine, killAllIfCommandLine } from './kill_if_command_line.js'
import { buildNative } from './native_bin.js'
import {
  CONFIG_FILE,
  INSTALL_FLAG,
  NATIVE,
  SPLIT,
  WIN,
  caseFor,
  cli,
  detailCounts,
  driveHarness,
  driveNodeForm,
  doctorRows,
  endLaunched,
  eventOf,
  forms,
  install,
  launch,
  makeSandbox,
  pidAlive,
  sandboxes,
  sleep,
  specialFor,
  startServer,
  stopServer,
  tokenGoatEntries,
  waysFor,
  wiredFor,
  wordsOf,
  type DoctorRow,
  type Entry,
  type Env,
  type Sandbox,
} from './native_hook_e2e_support.js'

/** The rows of one harness: `serve` runs the install and every served, fallback and Node-form count; `switch` switches the forms and back (and the project scope for Claude Code and Copilot); `doctor` reads doctor. */
/** One kill bound for the switch row; the serve row keeps its own. */
const SWITCH_CAP_MS = 240_000

export type HarnessPart = 'serve' | 'switch' | 'doctor'

/** The rows of the stale-build describe: `copy` (stale copy), `broken` (failing binary), `node` (failing shipped binary), `absent` (no native binary). */
export type StaleRow = 'copy' | 'broken' | 'node' | 'absent'

const USER_SWITCH_TITLE =
  'switches every event to the Node form, which each way the harness runs it answers as the Node command does, and back on reinstall'

/** The beforeAll that builds the native client and the afterAll that ends every sandbox's server and removes its files; each shard file calls this once at top level. */
export function registerSandboxLifecycle(): void {
  beforeAll(() => {
    buildNative()
  })

  afterEach(() => {
    let failure: unknown
    for (const sb of sandboxes) {
      try {
        endLaunched(sb)
      } catch (err) {
        failure ??= err
      }
    }
    if (failure !== undefined) throw failure
  })

  afterAll(async () => {
    // A pid whose command line could not be read is reported after every sandbox has been cleaned up.
    let unreadable: unknown
    for (const sb of sandboxes) {
      try {
        stopServer(sb)
      } catch {
        // the pid wait below still runs
      }
      const deadline = Date.now() + 5000
      for (const pid of sb.pids) {
        while (pidAlive(pid) && Date.now() < deadline) await sleep(50)
      }
      try {
        killAllIfCommandLine(sb.pids, isHookServerCommandLine, { signal: 'SIGTERM' })
      } catch (err) {
        unreadable ??= err
      }
      // The link first, on its own: removing the tree through it would reach the repository.
      if (WIN) fs.rmdirSync(sb.link)
      else fs.unlinkSync(sb.link)
      fs.rmSync(sb.root, { recursive: true, force: true })
    }
    if (unreadable !== undefined) throw unreadable
    expect(fs.existsSync(path.join(ROOT, 'package.json'))).toBe(true)
  })
}

/** Registers the harness rows named in `parts` for `harness`, in the describe the e2e file always had. */
export function registerHarnessRows(harness: PayloadHarness, parts: readonly HarnessPart[]): void {
  const has = (part: HarnessPart): boolean => parts.includes(part)

  describe.runIf(NATIVE)(`${harness}: native hook commands as installed`, () => {
    let sb: Sandbox
    let expected = { native: 0, fallback: 0 }
    // Ruling 115: the copilot install runs with the SessionStart owner budget at its floor, so the wiring must not depend on the owner finishing inside it.
    const installBudget: Env = harness === 'copilot_cli' ? { [SESSION_START_TEST_BUDGET_ENV]: String(SESSION_START_TEST_BUDGET_MIN_MS) } : {}

    beforeAll(async () => {
      sb = makeSandbox(specialFor(harness))
      await startServer(sb)
    }, 120_000)

    /** The user-scope switch: every event to the Node form and back, and the Codex trust hashes. */
    async function switchUser(): Promise<void> {
      const file = CONFIG_FILE[harness](sb)
      const before = forms(file, SPLIT[harness])
      const env: Env = harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {}
      install(sb, INSTALL_FLAG[harness], { ...env, TOKEN_GOAT_NATIVE_HOOKS: '0' })
      expect(forms(file, SPLIT[harness])).toEqual({ native: 0, node: before.native + before.node })
      await driveNodeForm(sb, harness)
      install(sb, INSTALL_FLAG[harness], env)
      expect(forms(file, SPLIT[harness])).toEqual({ native: before.native + before.node, node: 0 })
      if (harness === 'codex') {
        // Codex refuses an entry whose trusted_hash does not match its command, so every native entry must carry its own.
        const cfg = parseToml(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> & { state: Record<string, { trusted_hash?: string }> } }
        let checked = 0
        for (const [event, groups] of Object.entries(cfg.hooks)) {
          if (event === 'state' || !Array.isArray(groups)) continue
          groups.forEach((g: { matcher?: string; hooks?: Entry[] }, gi: number) => {
            ;(g.hooks ?? []).forEach((h, hi) => {
              const hookCommand = h.command ?? ''
              const eventArg = eventOf(splitHookCommand(hookCommand, SPLIT.codex))
              const stateKey = Object.keys(cfg.hooks.state).find((k) => k.endsWith(`:${eventArg}:${gi}:${hi}`))
              expect(stateKey, `${event} ${gi}:${hi}`).toBeDefined()
              const trusted = cfg.hooks.state[stateKey!]!.trusted_hash
              expect(trusted).toBe(computeCodexHookHash(eventArg, hookCommand, g.matcher))
              checked++
            })
          })
        }
        expect(checked).toBe(before.native + before.node)
      }
    }

    /** The project-scope switch, and uninstall of the project's native entries. */
    function switchProject(): void {
      const env: Env = harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {}
      // The project scope switches the same way.
      const flags = harness === 'claudecode' ? ['--project'] : ['--copilot', '--local']
      const projFile = harness === 'claudecode' ? path.join(sb.proj, '.claude', 'settings.json') : path.join(sb.proj, '.github', 'hooks', 'token-goat.json')
      install(sb, flags, env, sb.proj)
      const n = forms(projFile, SPLIT[harness])
      expect(n.native).toBeGreaterThan(0)
      expect(n.node).toBe(0)
      install(sb, flags, { ...env, TOKEN_GOAT_NATIVE_HOOKS: '0' }, sb.proj)
      expect(forms(projFile, SPLIT[harness])).toEqual({ native: 0, node: n.native })
      install(sb, flags, env, sb.proj)
      expect(forms(projFile, SPLIT[harness])).toEqual(n)
      const un = cli(sb, ['uninstall', ...(harness === 'claudecode' ? ['--project'] : ['--copilot', '--local'])], {}, sb.proj)
      expect(un.status, un.stderr).toBe(0)
      expect(forms(projFile, SPLIT[harness]).native).toBe(0)
    }

    if (has('serve')) {
      it('writes the native form for every event and each way the harness runs it is served, matches the Node command, and falls back to it', async () => {
        const printed = install(sb, INSTALL_FLAG[harness], installBudget)
        const f = forms(CONFIG_FILE[harness](sb), SPLIT[harness])
        expect(f.native, `install printed: ${printed}`).toBeGreaterThan(0)
        expect(f.node).toBe(0)
        if (harness === 'claudecode')
          expect(
            tokenGoatEntries(CONFIG_FILE[harness](sb)).every((e) => e.args === undefined),
            'the native form is the guarded string form',
          ).toBe(true)
        const got = await driveHarness(sb, harness)
        expected = { native: expected.native + got.native, fallback: expected.fallback + got.fallback }
        // One row per call, each under the path it took: `native` from the server, `native-fallback:server-off` from the Node command tg-hook fell back to, and nothing from the reference run of that Node command alone.
        const counts = detailCounts(sb)
        expect(counts['native']).toBe(expected.native)
        expect(counts['native-fallback:server-off']).toBe(expected.fallback)
        expect(counts['node']).toBe(expected.native)
      }, 240_000)
    }

    if (has('switch')) {
      it(`${USER_SWITCH_TITLE}, and uninstall removes the native entries`, async () => {
        if (!has('serve')) install(sb, INSTALL_FLAG[harness], installBudget)
        await switchUser()
        if (harness === 'claudecode' || harness === 'copilot_cli') switchProject()
      }, SWITCH_CAP_MS)
    }

    if (has('doctor')) {
      it('doctor reports the wired form, its self-test and the counts; a missing binary is broken, the Node form outdated, and off is quiet', async () => {
        if (!has('serve')) {
          install(sb, INSTALL_FLAG[harness], installBudget)
          expected = await driveHarness(sb, harness)
        }
        const file = CONFIG_FILE[harness](sb)
        const label = { claudecode: 'Claude Code (user)', codex: 'Codex', grok: 'Grok CLI', kimi: 'Kimi Code', copilot_cli: 'Copilot CLI (user)' }[harness]
        const run = `token-goat install${INSTALL_FLAG[harness].length > 0 ? ` ${INSTALL_FLAG[harness].join(' ')}` : ''}`
        const rowIn = (list: DoctorRow[]): { status: string; message: string } => {
          const r = list.find((x) => x.name === `Native hooks (${label})`)
          expect(r, `no Native hooks (${label}) row`).toBeDefined()
          return r!
        }
        const row = (env: Env = {}): { status: string; message: string } => rowIn(doctorRows(sb, env))
        const execEnv: Env = harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {}

        const countsBeforeDoctor = detailCounts(sb)
        const live = row(execEnv)
        expect(detailCounts(sb), 'doctor recorded a hook call of its own').toEqual(countsBeforeDoctor)
        expect(live.status, live.message).toBe('ok')
        expect(live.message).toMatch(/^native, .*tg-hook(\.exe)?, self-test passed; last 7 days: \d+ served natively, \d+ fell back \(server-off \d+\), \d+ through Node$/)
        // Copilot's own doctor check (checkCopilotCli) runs the wired preToolUse command for real, and under this sandbox's TOKEN_GOAT_HOOK_SERVER=0 that call falls back to Node; it marks the call as its own (HOOK_PROBE_ENV), so the counts are the harness's calls alone.
        const fellBack = expected.fallback
        expect(live.message).toContain(`${expected.native} served natively, ${fellBack} fell back (server-off ${fellBack})`)

        install(sb, INSTALL_FLAG[harness], { ...execEnv, TOKEN_GOAT_NATIVE_HOOKS: '0' })
        const outdated = row(execEnv)
        expect(outdated.status, outdated.message).toBe('warn')
        expect(outdated.message).toContain(`Node form while the native hook client is available; run \`${run}\` to switch`)

        const off = row({ ...execEnv, TOKEN_GOAT_NATIVE_HOOKS: '0' })
        expect(off.status, off.message).toBe('ok')
        expect(off.message).toMatch(/^Node form; native hooks are off \(hooks\.native or TOKEN_GOAT_NATIVE_HOOKS\)/)

        install(sb, INSTALL_FLAG[harness], execEnv)
        // A binary that has gone: every entry now names one that does not exist.
        const text = fs.readFileSync(file, 'utf8')
        const bin = parseNativeInvocation(wordsOf(tokenGoatEntries(file)[0]!, SPLIT[harness]))!.bin
        const gone = path.join(path.dirname(bin), 'gone', path.basename(bin))
        // The path sits in the file as each shell's quoting wrote it (bare in an exec-form entry and cmd.exe's double quotes, `''` in PowerShell, `'\''` in sh), then string-escaped by JSON or TOML, both of which escape a backslash and a double quote the way JSON.stringify does.
        const encode = (s: string): string => JSON.stringify(s).slice(1, -1)
        const quotings = [(s: string): string => s, (s: string): string => s.replaceAll("'", "''"), (s: string): string => s.replaceAll("'", String.raw`'\''`)]
        let rewritten = text
        for (const q of quotings) rewritten = rewritten.split(encode(q(bin))).join(encode(q(gone)))
        fs.writeFileSync(file, rewritten)
        const bins = tokenGoatEntries(file).map((e) => parseNativeInvocation(wordsOf(e, SPLIT[harness]))?.bin)
        expect(bins.length).toBeGreaterThan(0)
        expect(bins.every((b) => b === gone), JSON.stringify(bins)).toBe(true)
        // Run the broken entries the way the harness does: a binary that cannot start must not read as a hook that exited 0 and allowed the call. Through PowerShell this is POWERSHELL_EXIT_SUFFIX's guard, since LASTEXITCODE is never set when the call operator finds nothing to run.
        const c = caseFor(harness)
        const brokenEntries = tokenGoatEntries(file)
        let guardedBroken = 0
        for (const way of waysFor(harness, brokenEntries)) {
          const { entry, cmd } = wiredFor(brokenEntries, c, way)
          const r = await launch(way.run(cmd, entry), c, sb, 'tg-native-broken', {
            TOKEN_GOAT_HOOK_SERVER: '0',
          }).catch((e: unknown) => ({ stdout: '', stderr: String(e), exit: -1 }))
          const guarded = parseGuardedCommand(cmd)
          if (guarded?.kind !== 'v1') {
            expect(r.exit, `${way.label}: ${r.stderr}`).not.toBe(0)
            continue
          }
          // A guarded command whose binary is gone runs the Node shim, answering what that shim answers.
          guardedBroken++
          const wrapped = guarded.native.slice(guarded.native.indexOf('--') + 1)
          const ref = await launch(
            { file: wrapped[0]!, args: wrapped.slice(1) },
            c,
            sb,
            'tg-native-broken-ref',
            { TOKEN_GOAT_HOOK_SERVER: '0' },
          )
          expect({ stdout: r.stdout, exit: r.exit }, `${way.label}: ${r.stderr}`).toEqual({
            stdout: ref.stdout,
            exit: ref.exit,
          })
        }
        // The rows below read this same list: nothing changed the sandbox since doctor was asked.
        const brokenRows = doctorRows(sb, execEnv)
        const broken = rowIn(brokenRows)
        if (guardedBroken > 0) {
          expect(broken.status, broken.message).toBe('warn')
          expect(broken.message).toContain('fall back to the Node shim meanwhile')
          expect(broken.message).toContain(`run \`${run}\` to restore the native client`)
        } else {
          expect(broken.status, broken.message).toBe('fail')
          expect(broken.message).toContain(
            'which no longer exists, so those events fail instead of falling back to Node',
          )
          expect(broken.message).toContain(`run \`${run}\` to rewrite them`)
        }
        if (harness === 'claudecode') {
          const events = brokenRows.find((x) => x.name === 'Claude Code hook events')!
          expect(events.status, events.message).toBe('fail')
          expect(events.message).toContain('to a native hook client binary that no longer exists; run: token-goat install')
          // Broken, not outdated: the entry is what this build writes apart from the binary being gone.
          expect(events.message).not.toContain('no longer writes')
        }
        if (harness === 'copilot_cli') {
          // Copilot's own row checks the binary before it runs the command, so it names the cause rather than a launch failure.
          const own = brokenRows.find((x) => x.name === 'Copilot CLI')!
          expect(own.status, own.message).toBe('fail')
          expect(own.message).toContain(`native hook client binary that no longer exists (${gone})`)
        }
        install(sb, INSTALL_FLAG[harness], execEnv)
        const reinstalled = row(execEnv)
        expect(reinstalled.status, reinstalled.message).toBe('ok')
        if (WIN) {
          // doctor only reads: with the data-dir copy gone it reports the entries broken and leaves the copy for install to write, rather than writing it while it computes what install would write. Moved rather than deleted: an unlink returns at once but leaves the name in place while anything (a scanner, just after the self-test ran it) still holds the file open, and a rename takes effect regardless.
          fs.renameSync(bin, `${bin}.moved`)
          expect(fs.existsSync(bin), 'moved away before doctor').toBe(false)
          const missing = row(execEnv)
          expect(missing.status, missing.message).toBe(guardedBroken > 0 ? 'warn' : 'fail')
          expect(fs.existsSync(bin)).toBe(false)
          install(sb, INSTALL_FLAG[harness], execEnv)
          expect(fs.existsSync(bin)).toBe(true)
          const rewritten = row(execEnv)
          expect(rewritten.status, rewritten.message).toBe('ok')
        }

        const un = cli(sb, ['uninstall', ...INSTALL_FLAG[harness]])
        expect(un.status, un.stderr).toBe(0)
        expect(forms(file, SPLIT[harness]).native).toBe(0)
      }, 300_000)
    }
  })
}

/** The stale-build describe, registered with the rows named in `parts`. */
export function registerStaleRows(parts: readonly StaleRow[]): void {
  const has = (part: StaleRow): boolean => parts.includes(part)

  describe.runIf(NATIVE)('doctor on a build whose native hook client is stale, broken or absent', () => {
    /** A binary that starts and exits 1 whatever it is asked, standing in for a native hook client that fails its self-test. CAPTURE: `C:\Windows\System32\where.exe --selftest` prints "INFO: Could not find files for the given pattern(s)." and exits 1 (Windows 11 26200); `/bin/false` exits 1 whatever its arguments (POSIX `false`). */
    const FAILING_BINARY = WIN ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe') : '/bin/false'
    const TARGET = `${process.platform}-${process.arch}`

    /** A sandbox whose package is a real copy of the built one (dist and package.json, with node_modules linked back to this repository), so its native binary can be changed without touching the repository's. */
    function copiedSandbox(dirName: string): Sandbox {
      const sb = makeSandbox(dirName)
      if (WIN) fs.rmdirSync(sb.link)
      else fs.unlinkSync(sb.link)
      const pkg = path.join(sb.home, 'pkg')
      fs.mkdirSync(pkg)
      fs.cpSync(path.join(ROOT, 'dist'), path.join(pkg, 'dist'), { recursive: true })
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'))
      sb.link = path.join(pkg, 'node_modules')
      fs.symlinkSync(path.join(ROOT, 'node_modules'), sb.link, WIN ? 'junction' : 'dir')
      return sb
    }

    /** Puts `src`'s bytes at `file`, moving the old file aside first: a rename takes effect even while a scanner still holds the file open after the last self-test ran it. */
    function replace(file: string, src: string): void {
      fs.renameSync(file, `${file}.${String(Date.now())}.old`)
      fs.copyFileSync(src, file)
    }

    // One sandbox per scenario, each installed and checked on its own: a single test chaining all four ran about ten installs and doctors under one 300 s budget, which a starved Windows machine overran with nothing wrong in the product.
    function wiredSandbox(): {
      sb: Sandbox
      packaged: string
      good: string
      run: string
      row: () => { status: string; message: string }
      expectOk: () => void
      wiredBin: () => string | undefined
      bin: string
    } {
      const sb = copiedSandbox('tg native build')
      const packaged = path.join(sb.home, 'pkg', 'dist', 'native', TARGET, WIN ? 'tg-hook.exe' : 'tg-hook')
      const good = path.join(sb.root, 'tg-hook.good')
      fs.copyFileSync(packaged, good)
      const run = 'token-goat install --codex'
      const row = (): { status: string; message: string } => {
        const r = doctorRows(sb).find((x) => x.name === 'Native hooks (Codex)')
        expect(r, 'no Native hooks (Codex) row').toBeDefined()
        return r!
      }
      const expectOk = (): void => {
        const r = row()
        expect(r.status, r.message).toBe('ok')
      }
      const wiredBin = (): string | undefined => parseNativeInvocation(wordsOf(tokenGoatEntries(CONFIG_FILE.codex(sb))[0]!, SPLIT.codex))?.bin

      install(sb, ['--codex'])
      const bin = wiredBin()
      expect(bin, `the native form was not written; doctor says: ${row().message}`).toBeDefined()
      expectOk()
      return { sb, packaged, good, run, row, expectOk, wiredBin, bin: bin! }
    }

    // An upgrade ships different bytes, and the entries still run the data-directory copy of the old ones.
    if (has('copy')) {
      it.runIf(WIN)('reports a stale copy and install refreshes it', () => {
        const { sb, packaged, good, run, row, expectOk, bin } = wiredSandbox()
        fs.appendFileSync(packaged, Buffer.from('a later build'))
        const stale = row()
        expect(stale.status, stale.message).toBe('warn')
        expect(stale.message).toContain(`self-test passed, but the copy differs from this build's binary; run \`${run}\` to refresh it`)
        install(sb, ['--codex'])
        expect(fs.readFileSync(bin).equals(fs.readFileSync(packaged))).toBe(true)
        expectOk()
        replace(packaged, good)
        install(sb, ['--codex'])
        expectOk()
      }, 300_000)
    }

    if (has('broken')) {
      it('reports a binary the entries run that fails its self-test', () => {
        const { run, row, bin } = wiredSandbox()
        replace(bin, FAILING_BINARY)
        const broken = row()
        expect(broken.status, broken.message).toBe('fail')
        expect(broken.message).toContain(`the native hook client at ${bin} fails its self-test (exit code 1); run \`${run}\` to rewrite the entries as Node commands`)
      }, 300_000)
    }

    if (has('node')) {
      it('writes the Node form when the binary this build ships fails its self-test, and restores the native form when it passes again', () => {
        const { sb, packaged, good, row, expectOk, wiredBin, bin } = wiredSandbox()
        replace(packaged, FAILING_BINARY)
        // An install never replaces a stamped copy with an unstamped client, so the machine starts without a copy. On POSIX the wired binary is the packaged one replaced above, so there is no copy to remove.
        if (WIN) fs.rmSync(bin, { force: true })
        const printed = install(sb, ['--codex'])
        expect(wiredBin(), `install printed: ${printed}`).toBeUndefined()
        const failing = row()
        expect(failing.status, failing.message).toBe('warn')
        expect(failing.message).toMatch(/^Node form; this build's native hook client fails its self-test \(exit code 1\); last 7 days/)
        replace(packaged, good)
        install(sb, ['--codex'])
        expect(wiredBin(), `the native form was not restored; doctor says: ${row().message}`).toBe(bin)
        expectOk()
      }, 300_000)
    }

    if (has('absent')) {
      it('reports a build that ships no native binary for this machine, and install moves the entries to the Node form', () => {
        const { sb, packaged, run, row, wiredBin } = wiredSandbox()
        const nativeDir = path.dirname(path.dirname(packaged))
        fs.renameSync(nativeDir, `${nativeDir}.gone`)
        const absent = row()
        if (WIN) {
          // The entries run the data-directory copy, which still works.
          expect(absent.status, absent.message).toBe('warn')
          expect(absent.message).toContain(`, but this build ships no native hook client for ${TARGET}; run \`${run}\` to switch to the Node form`)
          expect(absent.message).not.toContain('self-test passed')
        } else {
          // The entries are the guarded form, so with the packaged binary gone they fall back to the Node shim and doctor warns rather than fails.
          expect(absent.status, absent.message).toBe('warn')
          expect(absent.message).toContain(`the native hook client at ${packaged} no longer exists; the guarded hook entries fall back to the Node shim meanwhile`)
        }
        install(sb, ['--codex'])
        expect(wiredBin()).toBeUndefined()
        const node = row()
        expect(node.status, node.message).toBe('ok')
        expect(node.message.startsWith(`Node form; this build ships no native hook client for ${TARGET}; last 7 days`), node.message).toBe(true)
      }, 300_000)
    }
  })
}
