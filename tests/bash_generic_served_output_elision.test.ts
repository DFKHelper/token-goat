import { tempConfigPath } from './helpers/temp-config.js'
import { unlinkSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnSync } from 'node:child_process'

/** Generic (non-file-read) elision of already-served shell output (hooks_bash.ts `maybeElideServedGenericOutput`). `elideServedShellLines`/`maybeCollapseIdenticalRead` only ever run when `pureFileReadPath(cmd)` resolves, so a `cat`/`head`/`tail`/`sed`/`awk`-shaped read is the only surface that ever got a repeated stretch withheld. Every other command -- `npm test`, `git log`, `rg`, and the rest -- shipped its already-served lines again in full. This exercises the generic path added to cover them, over a session-wide served-output list rather than a per-file one. */

// vi.mock is not needed here: these tests exercise the shipped default (bash_compress.elide_served_shell_output = true) without touching config at all, mirroring bash_served_line_elision.test.ts. The one test that forces the config off below still needs a real config file to write into, so it redirects configPath the same way tests/hooks_bash.test.ts does.
import { vi } from 'vitest'
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})
const _testConfigPath = tempConfigPath('tg-bash-generic-served-config-test.toml')

import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { BUNDLE } from './helpers/bundle.js'
import { rewrittenBody } from './helpers/updated-tool-output.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Output line N, one-indexed, distinguishable from every other and long enough that a modest slice clears the 512-byte floor. */
function outLine(n: number): string {
  return `record ${n}: ${'y'.repeat(60)}`
}

function block(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(outLine(n))
  return out.join('\n')
}

function postEvent(command: string, output: string, exitCode: number | null = 0, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode } },
  })
}

/** The body the model is handed: the rewrite when one was emitted, otherwise the untouched output. */
function delivered(out: Awaited<ReturnType<typeof postBashHandler>>, fallback: string): string {
  return out.hookType === 'rewriteOutput' ? out.updatedOutput : fallback
}

describe('postBashHandler: generic served-output elision (shipped default, config untouched)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('withholds an overlapping stretch of a later, different, non-file-read command against the shipped default', async () => {
    // Neither command is a file read (no pureFileReadPath match), and they are two different commands, not a rerun of the same one -- the delta-summary path this would otherwise hit only fires on an exact command rerun. Nothing in this test forces bash_compress.elide_served_shell_output; the default must already be on.
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const second = block(20, 60)
    const out = await postBashHandler(postEvent('some-report-tool --stage deploy', second))
    expect(out.hookType).toBe('rewriteOutput')
    const body = delivered(out, second)
    expect(body).toContain(outLine(41))
    expect(body).toContain(outLine(60))
    expect(body).not.toContain(outLine(20))
    expect(body).not.toContain(outLine(40))
    expect(body).toContain('token-goat bash-output ')
  })

  it('counts the withheld lines rather than naming them, since a generic command carries no file line numbers', async () => {
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const second = block(20, 60)
    const out = await postBashHandler(postEvent('some-report-tool --stage deploy', second))
    const body = delivered(out, second)
    expect(body).toMatch(/\d+ lines here were already served/)
    expect(body).not.toMatch(/lines \d+-\d+ were already served/)
  })

  it('never stores or matches against a failed command\'s output', async () => {
    // A non-zero exit's stdout is an error message, not real content: it must not become a baseline a later success is collapsed against, and a failure must never itself be elided.
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40), 1))
    const second = block(20, 60)
    const out = await postBashHandler(postEvent('some-report-tool --stage deploy', second, 0))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('caches what the model was shown, not what the command printed', async () => {
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const second = block(20, 60)
    const elided = await postBashHandler(postEvent('some-report-tool --stage deploy', second))
    expect(elided.hookType).toBe('rewriteOutput')

    // A third command whose only overlap is with the stretch the second call withheld behind a notice. It must still be withheld, and the id it points at must be the run that actually showed those lines, not the notice-bearing one.
    const third = block(25, 35)
    const out = await postBashHandler(postEvent('some-report-tool --stage report', third + '\n' + 'z'.repeat(600)))
    const body = delivered(out, third)
    expect(body).not.toContain(outLine(30))
  })

  it('leaves a command whose output is all new completely alone', async () => {
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const fresh = block(200, 240)
    const out = await postBashHandler(postEvent('some-report-tool --stage deploy', fresh))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('never composes a rewrite out of a live credential, even from a different command than the one it overlaps', async () => {
    // storeBashOutput always redacts before writing, so the stored copy of `build`'s output below never carries the key. A later, DIFFERENT command whose own live output still carries it must not have that row shipped inside a rewrite this function composed just because some other stretch of the same output happens to overlap `build`'s stored (redacted) body.
    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const withSecret = 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n' + block(20, 60)
    const out = await postBashHandler(postEvent('some-other-tool --stage deploy', withSecret))
    if (out.hookType === 'rewriteOutput') {
      expect(out.updatedOutput).not.toContain('AKIAABCDEFGHIJKLMNOP')
    }
  })

  // Command outputs are HAND-DERIVED synthetic rows; each recall body is CAPTURE, printed by the built bundle's `bash-output` for the id this hook's own notice named, the chain observed live when `token-goat bash-output 65eed6d63d26be06 --full` came back as a notice pointing at that same id. `tg` is FORMAT-DERIVED from package.json's `bin`, which maps it to the same dist/token-goat.mjs; the built bundle's hook answered `tg bash-output <id> --full` with a notice naming that id after the `token-goat` spelling was already exempt.
  async function recallServedId(session: string, flags: readonly string[], bin = 'token-goat'): Promise<{ recalled: string; body: string }> {
    await postBashHandler(postEvent('some-report-tool --stage recall-src', block(1, 40), 0, session))
    const elided = await postBashHandler(postEvent('some-report-tool --stage recall-overlap', block(20, 60), 0, session))
    const id = /Recall them with `token-goat bash-output ([0-9a-f]+) --full`/.exec(delivered(elided, ''))?.[1]
    if (id === undefined) throw new Error('the overlapping run was not withheld behind a recall pointer')
    const recall = spawnSync(process.execPath, [BUNDLE, 'bash-output', id, ...flags], { encoding: 'utf8' })
    expect(recall.status).toBe(0)
    const command = `${bin} bash-output ${id} ${flags.map((f) => (f.includes(' ') ? `'${f}'` : f)).join(' ')}`
    const out = await postBashHandler(postEvent(command, recall.stdout, 0, session))
    return { recalled: recall.stdout, body: delivered(out, recall.stdout) }
  }

  it.each([
    { bin: 'token-goat', flag: '--full', flags: ['--full'], lo: 1, hi: 40 },
    { bin: 'token-goat', flag: '--grep', flags: ['--grep', 'record 3'], lo: 30, hi: 39 },
    { bin: 'tg', flag: '--full', flags: ['--full'], lo: 1, hi: 40 },
  ])('delivers a $bin $flag recall of an id whose lines were already served, instead of withholding it behind a pointer to the same id', async ({ bin, flag, flags, lo, hi }) => {
    const { recalled, body } = await recallServedId(`recall-${bin}${flag}`, flags, bin)
    expect(recalled).toContain(outLine(lo))
    expect(body).toContain(outLine(lo))
    expect(body).toContain(outLine(hi))
    expect(body).not.toMatch(/already served verbatim/)
  })

  it("keeps a recall out of later matches, so rerunning the recalled command is not collapsed against the recall's copy of it", async () => {
    const session = 'recall-then-rerun'
    await recallServedId(session, ['--full'])
    const rerun = block(1, 40)
    const out = await postBashHandler(postEvent('some-report-tool --stage recall-src', rerun, 0, session))
    expect(out.hookType).not.toBe('rewriteOutput')
  })
})

describe('postBashHandler: generic served-output elision — config off', () => {
  afterEach(() => {
    invalidateConfigCache()
    try {
      unlinkSync(_testConfigPath)
    } catch {
      // ok — may not exist
    }
  })

  it('does nothing when bash_compress.elide_served_shell_output is set to false', async () => {
    clearModuleCaches()
    const cfg = defaultConfig()
    cfg.bash_compress.elide_served_shell_output = false
    saveConfig(cfg)

    await postBashHandler(postEvent('some-report-tool --stage build', block(1, 40)))
    const second = block(20, 60)
    const out = await postBashHandler(postEvent('some-report-tool --stage deploy', second))
    expect(out.hookType).not.toBe('rewriteOutput')
  })
})

function runHook(command: string, output: string, sessionId: string) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: REPO,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: output, exitCode: 0 },
  })
  return spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8' })
}

describe('built bundle: generic served-output elision survives across processes', () => {
  it('withholds an already-served stretch of a generic command in a separate hook process', () => {
    // In-process cases above prove the rule; this proves it is in the shipped artifact and reachable through the real hook entrypoint, not just source under test.
    const first = runHook('some-report-tool --stage build', block(1, 40), 'e2e-generic')
    expect(first.status).toBe(0)

    const second = block(20, 60)
    const out = runHook('some-report-tool --stage deploy', second, 'e2e-generic')
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeDefined()

    const body = rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput)
    expect(body).toContain(outLine(41))
    expect(body).toContain(outLine(60))
    expect(body).not.toContain(outLine(20))
    expect(body).not.toContain(outLine(40))
    expect(body).toMatch(/\d+ lines here were already served/)
  })
})
