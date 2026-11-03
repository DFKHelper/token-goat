/** No commit message in this repository's history credits the tool that helped write it. `.lefthook-scripts/check-commit-msg.sh` stops one arriving through `git commit`, and that is where a developer sees the error. It is not sufficient on its own: a rebase, an amend, a merge, `--no-verify`, and a clone that never ran `lefthook install` all produce commits the hook never sees. This scans what actually landed, so a message that got past the hook is caught before it is pushed rather than after. The check covers the whole reachable history rather than only new commits, because "new" has no stable definition here -- the upstream ref is not always fetched, and an offending message is as likely to arrive by rewriting an old commit as by writing a new one. Reading every message costs under 100 ms. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/bundle.js'
import { HOOK_BASH, slash } from '../helpers/hook-bash.js'

/** PROVENANCE: HAND-DERIVED. These are the two trailers and the one URL shape an assistant harness appends, written from that instruction text rather than from any message in this repository, so the guard does not encode only the spellings that happen to have occurred here. */
const FORBIDDEN: readonly { readonly what: string; readonly re: RegExp; readonly sample: string }[] = [
  {
    what: 'a Co-Authored-By trailer',
    re: /^[ \t]*co-authored-by:/im,
    sample: 'fix: a thing\n\nCo-Authored-By: Some Model <noreply@example.invalid>\n',
  },
  {
    what: 'a Claude-Session line',
    re: /^[ \t]*claude-session:/im,
    sample: 'fix: a thing\n\nClaude-Session: https://example.invalid/s/1\n',
  },
  {
    what: 'a session URL',
    re: /claude\.ai\/code\/session/i,
    sample: 'fix: a thing\n\nhttps://claude.ai/code/session_0123456789\n',
  },
]

/** PROVENANCE: HAND-DERIVED. The pattern is the single line in `.lefthook-scripts/model-name-pattern.txt`, the same file `check-commit-msg.sh` greps with, so the hook and this guard cannot drift. The samples are written from the maintainer's rule of 2026-10-20 (Opus, Sonnet, Haiku, Fable, Sol or GPT with a version, claude-<family> ids), and the safe strings are the host products this tool supports plus words that merely contain "sol". */
const MODEL_NAME_RE = new RegExp(
  readFileSync(new URL('../../.lefthook-scripts/model-name-pattern.txt', import.meta.url), 'utf8').split('\n')[0],
  'i',
)
const MODEL_NAME_SAMPLES: readonly string[] = [
  'fix: Opus review findings',
  'fix: a thing\n\nSonnet found it',
  'docs: haiku-sized notes',
  'fix: a thing\n\nreviewed by Fable.',
  'docs(changelog): Sol 6.1 review updates',
  'fix: Sol-6 findings',
  'fix: Luna 6 and Terra 6 findings',
  'fix: gpt-4o output',
  'fix: GPT-5 output',
  'fix: a thing\n\nModel: claude-opus-5-5',
  'fix: claude-sonnet-4 output',
]
const MODEL_NAME_SAFE: readonly string[] = [
  'fix(gemini): route a tool',
  'fix: Gemini CLI settings',
  'feat: Codex CLI hook',
  'fix: Codex and Copilot paths',
  'docs: Claude Code hooks',
  'fix: keep Gemini, Qwen and OpenClaw settings comments',
  'fix: solve the solution for solid solar states',
  'fix: sol is a word',
  'fix: luna and terrain handling',
]
/** Commits kept in history with a model name in the message, exempt from the model-name rule only: the maintainer kept the first two on 2026-10-20, and the rest were already on main when the rule landed. */
const MODEL_NAME_EXEMPT_SHAS: readonly string[] = [
  '5cd1b8ab58f132f35d8cb8e3103622646dfaaf70',
  '4b53ca0b1257ae920e7d0eaec5183a2cf1200619',
  'c36ee805cf29352fe4864eec1bfbdd8bf221938a',
  'ab426b5f2d4a3366e79681fe7d0d359974f220e5',
  'eff32f69b3b1bf932741977282d139f469fea391',
  '57096c93124dfa9de2a8777f94dbf4bd2833d319',
  '9db17bfd48f945c3ae275af557777a7fbed3558b',
  '6c136d6d8af0160b9972ad39a2d8a76efef50341',
  '4f17577c05a9f6231c546feb4f44fe459927a984',
  '7c15c14a2c70ce853d8ee7b3b4ab67729f361491',
  '64ca9b4d0e7755933f3e6f6a9205fe67008ca172',
  '04aea12cb70d7a4d615a4ab235ceb477c3057adf',
  '28bda0b97292eb5872bbb2463c292f0c77965f8f',
  '9ff162a11243693cb5acfaecae9f14e5f1b1502f',
  '56cc92ddddd7e9304aaa283de7c18a1164bc4bcd',
]

/** Separators no commit message can contain, so a body can never split a record. */
const RECORD = String.fromCharCode(0x1e)
const FIELD = String.fromCharCode(0x00)

function messages(): { sha: string; body: string }[] {
  const raw = execFileSync('git', ['log', '--format=%H%x00%B%x1e', 'HEAD'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return raw
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, ...rest] = record.split(FIELD)
      return { sha, body: rest.join(FIELD) }
    })
}

describe('commit messages', () => {
  const history = messages()

  it('reaches a history worth checking', () => {
    // Without this, a `git log` that returned nothing -- a shallow clone, a renamed default branch, a spawn that failed into an empty string -- would make every assertion below pass by having nothing to test.
    expect(history.length).toBeGreaterThan(1_000)
  })

  it.each(FORBIDDEN)('carry no $what', ({ re, sample }) => {
    // The population is defined by absence, so the pattern gets a positive of its own: a typo that matches nothing would otherwise read as clean.
    expect(re.test(sample), 'the pattern no longer matches the thing it forbids').toBe(true)

    const offenders = history.filter((commit) => re.test(commit.body)).map((commit) => commit.sha.slice(0, 8))
    expect(
      offenders,
      'a commit message credits a tool; rewrite it and force-push, then check the hook is installed (npx lefthook install)',
    ).toEqual([])
  })
})

describe('model names in commit messages', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'tg-model-name-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Runs the real hook on a temp message file, with HOME and the denylist variable pointed into the temp dir so no real confidential list is read. */
  function runHook(message: string): { status: number | null; stderr: string } {
    const msg = path.join(tmp, 'COMMIT_EDITMSG')
    writeFileSync(msg, message)
    const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_CONFIDENTIAL_NAMES: slash(path.join(tmp, 'none.txt')), HOME: slash(tmp), USERPROFILE: tmp }
    const script = path.join(ROOT, '.lefthook-scripts', 'check-commit-msg.sh')
    const r = spawnSync(HOOK_BASH as string, [slash(script), slash(msg)], { env, encoding: 'utf8' })
    if (r.error) throw r.error
    return { status: r.status, stderr: r.stderr }
  }

  const hasBash = HOOK_BASH !== null

  it.each(MODEL_NAME_SAMPLES)('the pattern refuses %j', (sample) => {
    expect(MODEL_NAME_RE.test(sample), 'the pattern no longer matches a model name').toBe(true)
  })

  it.each(MODEL_NAME_SAFE)('the pattern passes %j', (sample) => {
    expect(MODEL_NAME_RE.test(sample), 'the pattern matches a host product or an ordinary word').toBe(false)
  })

  it.skipIf(!hasBash).each(MODEL_NAME_SAMPLES)('the hook refuses %j', (sample) => {
    const r = runHook(sample + '\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/names an AI model/)
  })

  it.skipIf(!hasBash).each(MODEL_NAME_SAFE)('the hook passes %j', (sample) => {
    const r = runHook(sample + '\n')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('carries no model name in history, apart from the two commits the maintainer kept', () => {
    const offenders = messages()
      .filter((commit) => MODEL_NAME_RE.test(commit.body) && !MODEL_NAME_EXEMPT_SHAS.includes(commit.sha))
      .map((commit) => commit.sha.slice(0, 8))
    expect(offenders, 'a commit message names an AI model; rewrite it and force-push, then check the hook is installed (npx lefthook install)').toEqual([])
  })

  it('still finds a model name in each exempted commit, so the exemption cannot go stale', () => {
    const exempt = messages().filter((commit) => MODEL_NAME_EXEMPT_SHAS.includes(commit.sha))
    expect(exempt.map((commit) => commit.sha).sort()).toEqual([...MODEL_NAME_EXEMPT_SHAS].sort())
    for (const commit of exempt) expect(MODEL_NAME_RE.test(commit.body)).toBe(true)
  })
})
