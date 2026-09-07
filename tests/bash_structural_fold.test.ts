/**
 * Structural folding on the shell read surface (hooks_bash.ts `foldShellReadStructure`).
 *
 * The Read hook already replaces a large untargeted whole-file delivery with a structural view of it: a heading tree for a document, a declaration skeleton for source. The identical bytes arriving as the stdout of `cat <file>` got none of that. These tests pin the two halves of closing that gap: the fold fires on the shapes whose stdout genuinely IS the file, and it declines on every shape where it is not.
 *
 * FIXTURE PROVENANCE
 *
 * The two payload files are CAPTURE: this repository's own `src/read_commands.ts` and `CLAUDE.arch.md`, copied byte-for-byte into a scratch project for the run. They are real files a reader really cats, not content shaped to the matcher.
 *
 * Every must-not-drop list is HAND-DERIVED: the surviving lines are computed from the payload by a rule written here (a line beginning `export function`, a line beginning `## `) that shares nothing with the tree-sitter extraction or the markdown heading scanner the implementation uses. A ratio assertion alone would pass on an over-collapse -- over-collapsing improves a ratio -- so each one is paired with the list.
 *
 * The scratch project is a temp directory reached through RELATIVE commands on purpose. `classifyCatPath` declines any path that spells out a temp location, so `cat /tmp/x/big.ts` would be rejected before any of this ran and every test here would pass by not reaching the code under test.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The marker both structural notices open with. The discriminator is this line and never the byte count: a piped or redirected command is separately eligible for the generic output filter, which shrinks it without this fold being involved at all. */
const PARTIAL_VIEW = 'Partial view: this '
/** A line separator as a value, so a template edit of this file cannot break the literal apart. */
const NEWLINE = String.fromCharCode(10)

let TMP = ''
let SRC = ''
let DOC = ''
const SRC_REL = 'big.ts'
const DOC_REL = 'big.md'
const OTHER_REL = 'other.ts'
const SECRET_REL = 'secret.ts'
/** A DIFFERENT document for the parity case. Not a second copy of the one above: the served-line store matches on line runs, so a second copy of already-folded content meets the elision rule first and returns its notice instead of a heading tree. */
const PARITY_REL = 'parity.md'
let PARITY_DOC = ''

beforeAll(() => {
  TMP = mkdtempSync(path.join(tmpdir(), 'tg-structural-'))
  mkdirSync(TMP, { recursive: true })
  SRC = readFileSync(path.join(REPO, 'src', 'read_commands.ts'), 'utf-8')
  DOC = readFileSync(path.join(REPO, 'CLAUDE.arch.md'), 'utf-8')
  writeFileSync(path.join(TMP, SRC_REL), SRC, 'utf-8')
  writeFileSync(path.join(TMP, DOC_REL), DOC, 'utf-8')
  writeFileSync(path.join(TMP, OTHER_REL), SRC, 'utf-8')
  PARITY_DOC = readFileSync(path.join(REPO, 'README.md'), 'utf-8')
  writeFileSync(path.join(TMP, PARITY_REL), PARITY_DOC, 'utf-8')
  // Assembled at run time from pieces so no credential-shaped literal is ever committed to this file, and written only for the length of the run.
  writeFileSync(path.join(TMP, SECRET_REL), 'const key = "' + 'AKIA' + 'IOSFODNN7EXAMPLE' + '"\n' + SRC, 'utf-8')
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  clearModuleCaches()
})

function postEvent(command: string, output: string, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: { cwd: TMP, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } },
  })
}

/** The body the model is handed: the rewrite when one was emitted, otherwise the untouched output. */
function delivered(out: Awaited<ReturnType<typeof postBashHandler>>, fallback: string): string {
  return out.hookType === 'rewriteOutput' ? out.updatedOutput : fallback
}

async function deliveredFor(command: string, output: string, sessionId = 's'): Promise<string> {
  return delivered(await postBashHandler(postEvent(command, output, sessionId)), output)
}

/** Every top-level exported function declaration line in the payload, by a rule of this file's own and not the extractor's. These are the lines a skeleton exists to keep. */
function exportedFunctionLines(source: string): string[] {
  return source.split('\n').filter((l) => /^export (?:async )?function \w+/.test(l))
}

/** Every second-level heading line in the document, by a rule of this file's own. */
function secondLevelHeadings(doc: string): string[] {
  return doc.split('\n').filter((l) => /^## \S/.test(l)).map((l) => l.slice(3).trim())
}

/** One `token-goat hook post_tool_use` run against the built bundle, on its own TOKEN_GOAT_HOME, returning the rewritten body or the empty string when nothing was rewritten. */
function hookViaBundle(session: string, event: Record<string, unknown>): string {
  const home = path.join(TMP, 'home-' + session)
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
    input: JSON.stringify({ session_id: session, hook_event_name: 'PostToolUse', cwd: TMP, ...event }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TOKEN_GOAT_HOME: home },
  })
  if (res.status !== 0) throw new Error(`bundle hook exited ${String(res.status)}: ${res.stderr.slice(0, 300)}`)
  const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { updatedToolOutput?: { stdout?: string; file?: { content?: string } } } }
  const updated = parsed.hookSpecificOutput?.updatedToolOutput
  return updated?.stdout ?? updated?.file?.content ?? ''
}

describe('postBashHandler: structural folding of a whole-file shell read', () => {
  it('replaces a whole-file `cat` of source with a skeleton that keeps every exported declaration', async () => {
    const body = await deliveredFor(`cat ${SRC_REL}`, SRC, 'src-cat')
    expect(body).toContain(PARTIAL_VIEW)

    // Must-not-drop, paired with the ratio below: an over-collapse that dropped declarations would improve the ratio and pass on it alone.
    const declarations = exportedFunctionLines(SRC)
    expect(declarations.length).toBeGreaterThan(20)
    for (const line of declarations) expect(body).toContain(line)

    // Every withheld run stands behind a notice naming how to get it back, never a silent drop.
    expect(body).toContain('token-goat read "')
    expect(body.length).toBeLessThan(SRC.length * 0.5)
  })

  it('replaces a whole-file `cat` of a document with a heading tree that keeps every section name', async () => {
    const body = await deliveredFor(`cat ${DOC_REL}`, DOC, 'doc-cat')
    expect(body).toContain(PARTIAL_VIEW)

    const headings = secondLevelHeadings(DOC)
    expect(headings.length).toBeGreaterThan(5)
    for (const heading of headings) expect(body).toContain(heading)

    expect(body).toContain('token-goat section "')
    expect(body.length).toBeLessThan(DOC.length * 0.25)
  })

  it('discloses the withheld line count and reports the declaration count as a floor, never as a total', async () => {
    const body = await deliveredFor(`cat ${SRC_REL}`, SRC, 'src-notice')
    // "at least", because tree-sitter surfaces declarations and not every name the file holds.
    expect(body).toMatch(/at least [\d,]+ declarations found/)
    expect(body).toMatch(/[\d,]+ lines of bodies withheld/)
  })

  it('folds `head -n <total>` of the same file, whose stdout is also the whole file', async () => {
    const total = SRC.split('\n').length
    const body = await deliveredFor(`head -n ${total} ${SRC_REL}`, SRC, 'src-head')
    expect(body).toContain(PARTIAL_VIEW)
  })

  it('folds a `2>/dev/null`-suffixed read, which the pre-hook admits as advisory rather than denying', async () => {
    const body = await deliveredFor(`cat ${SRC_REL} 2>/dev/null`, SRC, 'src-devnull')
    expect(body).toContain(PARTIAL_VIEW)
  })

  it('gives the shell surface the same answer the Read tool gives the identical bytes', () => {
    // Both arms run as fresh processes against the built bundle with their own TOKEN_GOAT_HOME. In-process they would share this run's session store, where the first arm's fold records its kept lines as served and the second arm meets the already-served elision instead of a heading tree -- a real rule, but not the one under test.
    const abs = path.join(TMP, PARITY_REL)
    const numLines = PARITY_DOC.split(NEWLINE).length
    const shell = hookViaBundle('parity-shell', { tool_name: 'Bash', tool_input: { command: `cat ${PARITY_REL}` }, tool_response: { stdout: PARITY_DOC, stderr: '', interrupted: false, isImage: false } })
    const read = hookViaBundle('parity-read', { tool_name: 'Read', tool_input: { file_path: abs }, tool_response: { file: { filePath: abs, content: PARITY_DOC, numLines, startLine: 1, totalLines: numLines } } })
    expect(shell).toContain(PARTIAL_VIEW)
    expect(read).toContain(PARTIAL_VIEW)
    for (const heading of secondLevelHeadings(PARITY_DOC)) {
      expect(shell).toContain(heading)
      expect(read).toContain(heading)
    }
  })

})

describe('postBashHandler: shapes whose stdout is not the file are declined', () => {
  // Each case is a command whose output is not, or not provably, the file's own bytes. The stdout handed in is deliberately the whole file for most of them: that is the hostile case, where a fold would look plausible and be wrong.
  const cases: ReadonlyArray<[string, () => string, string]> = [
    ['a pipe into grep', () => `cat ${SRC_REL} | grep export`, 'neg-pipe'],
    ['a sed line range', () => `sed -n '10,40p' ${SRC_REL}`, 'neg-sed'],
    ['two files concatenated', () => `cat ${SRC_REL} ${OTHER_REL}`, 'neg-two'],
    ['a redirect', () => `cat ${SRC_REL} > out.txt`, 'neg-redir'],
    // The shape a separator denylist waves through: this chains nothing, and truncates ~/.bashrc.
    ['a redirect hidden between two quoted paths', () => `cat "${SRC_REL}" > ~/.bashrc "${OTHER_REL}"`, 'neg-quoted-redir'],
    ['a numbering flag', () => `cat -n ${SRC_REL}`, 'neg-flag'],
    ['bat, whose decorations depend on terminal detection', () => `bat ${SRC_REL}`, 'neg-bat'],
  ]
  for (const [label, cmd, session] of cases) {
    it(`declines ${label}`, async () => {
      const body = await deliveredFor(cmd(), SRC, session)
      expect(body).not.toContain(PARTIAL_VIEW)
    })
  }

  it('declines a stderr merge that actually carried stderr, whose stdout is then longer than the file', async () => {
    const body = await deliveredFor(`cat ${SRC_REL} 2>&1`, `cat: warning printed to stderr\n${SRC}`, 'neg-merge')
    expect(body).not.toContain(PARTIAL_VIEW)
  })

  it('declines when the delivered bytes are shorter than the file, which is the only truncation signal this surface has', async () => {
    // Cut at 60% on a line boundary, not to a token amount: a small prefix would decline on the size and symbol floors instead, and the test would then pass without the truncation guard existing at all.
    const cut = SRC.slice(0, Math.floor(SRC.length * 0.6))
    const body = await deliveredFor(`cat ${SRC_REL}`, cut.slice(0, cut.lastIndexOf(NEWLINE) + 1), 'neg-truncated')
    expect(body).not.toContain(PARTIAL_VIEW)
  })

  it('declines a file holding a secret rather than composing a redacted rewrite of it', async () => {
    const secret = readFileSync(path.join(TMP, SECRET_REL), 'utf-8')
    const body = await deliveredFor(`cat ${SECRET_REL}`, secret, 'neg-secret')
    expect(body).not.toContain(PARTIAL_VIEW)
  })
})

describe('the built bundle folds a whole-file shell read', () => {
  // The shipping path, not the source path: a release once shipped a worker whose production default never ran because every test injected its own callback.
  it('emits the skeleton through `token-goat hook post_tool_use`', () => {
    const payload = {
      session_id: 'bundle-structural',
      hook_event_name: 'PostToolUse',
      cwd: TMP,
      tool_name: 'Bash',
      tool_input: { command: `cat ${SRC_REL}` },
      tool_response: { stdout: SRC, stderr: '', interrupted: false, isImage: false },
    }
    const home = path.join(TMP, 'home')
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TOKEN_GOAT_HOME: home },
    })
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { updatedToolOutput?: { stdout?: string } } }
    const stdout = parsed.hookSpecificOutput?.updatedToolOutput?.stdout
    expect(typeof stdout).toBe('string')
    expect(stdout).toContain(PARTIAL_VIEW)
    for (const line of exportedFunctionLines(SRC)) expect(stdout).toContain(line)
  })
})
