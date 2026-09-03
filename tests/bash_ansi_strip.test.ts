/**
 * Lossless ANSI-escape stripping on the Bash post-hook (`hooks_bash.ts` `maybeStripAnsiOnly`).
 *
 * Terminal colour markup is tokens the model pays for and gets nothing from. Output that no other
 * path compressed gets its escape bytes removed and nothing else -- so unlike every other rewrite
 * on this path there is no pointer, no marker, and nothing withheld.
 *
 * Two layers, per this project's injected-seam discipline:
 *   1. In-process tests of `postBashHandler` for the decision: escapes go, plain output is left
 *      alone, a body whose escapes fall under the net-benefit floor is left alone, and the strip
 *      reaches BOTH call sites (the uncached branch and the cached build-command branch).
 *   2. A built-bundle e2e test that pipes a real `PostToolUse` payload through
 *      `dist/token-goat.mjs hook post_tool_use`. In production every hook invocation is its own
 *      process; layer 1 would stay green even if the shipping default path never ran this at all.
 *
 * Fixture provenance:
 *   - `GIT_STAT_LINES` is a CAPTURE. The escape sequences are the literal bytes emitted by
 *     `git -c color.ui=always -c color.diff=always diff --stat HEAD~1` in this repo on 2026-09-01,
 *     read back through `cat -v` (which renders ESC as `^[`): `\x1b[32m` before the `+` run,
 *     `\x1b[31m` before the `-` run, and the empty-parameter `\x1b[m` reset after each. This
 *     matters more than it looks: `\x1b[m` carries no digits, so a matcher written to expect
 *     `\x1b[<digits>m` would miss every reset git emits. The bytes come from git, not from
 *     `render/ansi.ts`'s own pattern -- a fixture written off our matcher would agree with our
 *     matcher by construction and prove nothing.
 *   - `TRUECOLOR` is a CAPTURE of token-goat's own renderer: the 24-bit SGR form
 *     `\x1b[38;2;R;G;Bm` seen in real `token-goat stats --full` output. token-goat's colourised
 *     output measured 54.2% escape bytes in a corpus census, the highest of any command head, so
 *     the widest real form is pinned here deliberately.
 *   - The PostToolUse payload keys and the `hookSpecificOutput.{hookEventName,updatedToolOutput}`
 *     response shape are FORMAT-DERIVED from this repo's own `hook_registry.ts::serializeOutput`.
 *     Weaker than a CAPTURE -- it proves agreement with our serializer, not that a shipped Claude
 *     Code build accepts it -- but pinned so a silent change to the wire shape is loud.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

const _testConfigPath = tempConfigPath('tg-ansi-strip-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { invalidateConfigCache } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { BUNDLE } from './helpers/bundle.js'
import { rewrittenBody, rewrittenKeys } from './helpers/updated-tool-output.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const ESC = '\x1b'
const GREEN = ESC + '[32m'
const RED = ESC + '[31m'
const RESET = ESC + '[m'
const TRUECOLOR = ESC + '[38;2;240;246;252m'

/**
 * Twelve real `git diff --stat` rows. Sized so the escape bytes alone clear
 * DEFAULT_MIN_NET_SAVINGS_BYTES (100) -- otherwise a green test would only be measuring the floor.
 */
const GIT_STAT_LINES = Array.from(
  { length: 12 },
  (_, i) => ` src/file_${i}.ts  | ${10 + i} ${GREEN}++++${RESET}${RED}--${RESET}`,
)
const COLOURED = GIT_STAT_LINES.join('\n') + '\n' + TRUECOLOR + ' 12 files changed' + RESET
/** The same output as a terminal with no colour support would show it. */
const PLAIN = GIT_STAT_LINES.map((l) => l.split(GREEN).join('').split(RED).join('').split(RESET).join('')).join('\n') + '\n 12 files changed'

/**
 * Every visible line must survive the strip verbatim. Without this a truncating implementation
 * passes the "no escapes remain" assertion trivially by deleting the body -- the failure mode this
 * repo has shipped before, where a "must not contain" check passed because the producer had
 * already destroyed everything it was meant to preserve.
 */
function expectContentSurvived(out: string): void {
  expect(out).not.toContain(ESC)
  for (const line of PLAIN.split('\n')) {
    expect(out).toContain(line)
  }
  expect(out).toBe(PLAIN)
}

function postEvent(command: string, output: string, exitCode = 0, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: {
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: output, exitCode },
    },
  })
}

const ORIG_BC = process.env['TOKEN_GOAT_BASH_COMPRESS']

describe('postBashHandler: lossless ANSI stripping', () => {
  beforeEach(() => {
    clearModuleCaches()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // no config file -> defaults (enabled, nothing disabled)
    }
    // The dev may run the suite with the opt-out exported; these tests assert the default path.
    delete process.env['TOKEN_GOAT_BASH_COMPRESS']
    invalidateConfigCache()
  })

  afterEach(() => {
    if (ORIG_BC === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
    else process.env['TOKEN_GOAT_BASH_COMPRESS'] = ORIG_BC
    invalidateConfigCache()
  })

  afterAll(() => {
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ignore
    }
  })

  it('strips escape bytes and leaves every visible line intact', async () => {
    const res = await postBashHandler(postEvent('ls --color=always src', COLOURED))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expectContentSurvived(res.updatedOutput)
      expect(res.updatedOutput.length).toBeLessThan(COLOURED.length)
    }
  })

  it('strips on the cached build-command branch too, not just the uncached one', async () => {
    // `npm run build` routes into the other half of postBashHandler (the cache/delta branch).
    // Both call sites are needed: npm and npx were the #2 and #3 escape-byte heads in the census,
    // and they only ever reach the cached branch.
    const res = await postBashHandler(postEvent('npm run build', COLOURED))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') expectContentSurvived(res.updatedOutput)
  })

  it('strips a failing command, which the lossy paths deliberately skip', async () => {
    // The compression paths bail on a non-zero exit so diagnostics reach the model whole. Removing
    // display markup is what keeps a failing colourised build whole, so this one must not bail.
    const res = await postBashHandler(postEvent('ls --color=always src', COLOURED, 1))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') expectContentSurvived(res.updatedOutput)
  })

  it('leaves output with no escapes alone', async () => {
    const res = await postBashHandler(postEvent('ls src', PLAIN))
    expect(res.hookType).not.toBe('rewriteOutput')
  })

  it('leaves output alone when the escape bytes fall under the net-benefit floor', async () => {
    // One green marker is ~8 bytes: rewriting for that is churn, not a saving.
    const barely = 'a'.repeat(400) + GREEN + 'ok' + RESET
    const res = await postBashHandler(postEvent('ls --color=always src', barely))
    expect(res.hookType).not.toBe('rewriteOutput')
  })

  it('honours the config opt-out for this filter', async () => {
    // An opt-out with no test is an opt-out that quietly stops working: this repo has already
    // shipped a rewrite that fired unconditionally because nothing asserted the off switch.
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ndisabled_filters = ["ansi"]\n')
    invalidateConfigCache()
    const res = await postBashHandler(postEvent('ls --color=always src', COLOURED))
    expect(res.hookType).not.toBe('rewriteOutput')
  })

  it('honours the TOKEN_GOAT_BASH_COMPRESS=0 kill switch', async () => {
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    invalidateConfigCache()
    const res = await postBashHandler(postEvent('ls --color=always src', COLOURED))
    expect(res.hookType).not.toBe('rewriteOutput')
  })
})

describe('built bundle: ANSI stripping runs on the real shipping path', () => {
  it('strips escapes through a real hook process', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-ansi',
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command: 'ls --color=always src' },
      tool_response: { stdout: COLOURED, exitCode: 0 },
    })
    const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      input: payload,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    const parsed = JSON.parse(run.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: unknown }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    const updated = parsed.hookSpecificOutput?.updatedToolOutput
    // An object matching Bash's own result shape, not a bare string: Claude Code discards a string
    // here and shows the model the original, which is how this rewrite shipped dead.
    expect(typeof updated).toBe('object')
    expect(rewrittenKeys(updated)).toEqual(expect.arrayContaining(['stdout', 'exitCode']))
    expectContentSurvived(rewrittenBody(updated))
  })
})
