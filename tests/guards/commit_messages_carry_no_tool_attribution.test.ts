/**
 * No commit message in this repository's history credits the tool that helped
 * write it.
 *
 * `.lefthook-scripts/check-commit-msg.sh` stops one arriving through `git
 * commit`, and that is where a developer sees the error. It is not sufficient
 * on its own: a rebase, an amend, a merge, `--no-verify`, and a clone that
 * never ran `lefthook install` all produce commits the hook never sees. This
 * scans what actually landed, so a message that got past the hook is caught
 * before it is pushed rather than after.
 *
 * The check covers the whole reachable history rather than only new commits,
 * because "new" has no stable definition here -- the upstream ref is not always
 * fetched, and an offending message is as likely to arrive by rewriting an old
 * commit as by writing a new one. Reading every message costs under 100 ms.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * PROVENANCE: HAND-DERIVED. These are the two trailers and the one URL shape an
 * assistant harness appends, written from that instruction text rather than
 * from any message in this repository, so the guard does not encode only the
 * spellings that happen to have occurred here.
 */
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
    // Without this, a `git log` that returned nothing -- a shallow clone, a
    // renamed default branch, a spawn that failed into an empty string --
    // would make every assertion below pass by having nothing to test.
    expect(history.length).toBeGreaterThan(1_000)
  })

  it.each(FORBIDDEN)('carry no $what', ({ re, sample }) => {
    // The population is defined by absence, so the pattern gets a positive of
    // its own: a typo that matches nothing would otherwise read as clean.
    expect(re.test(sample), 'the pattern no longer matches the thing it forbids').toBe(true)

    const offenders = history.filter((commit) => re.test(commit.body)).map((commit) => commit.sha.slice(0, 8))
    expect(
      offenders,
      'a commit message credits a tool; rewrite it and force-push, then check the hook is installed (npx lefthook install)',
    ).toEqual([])
  })
})
