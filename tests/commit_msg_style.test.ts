import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT } from './helpers/bundle.js'
import { HOOK_BASH, slash } from './helpers/hook-bash.js'

/** The commit-msg hook refuses a message whose paragraphs are hard-wrapped, and one that carries a verification checklist. GitHub shows a commit body exactly as written, so a body wrapped at 72 columns reads as lines that stop mid-sentence; 149 of the 400 commits before this check went in were wrapped that way, against a repository that otherwise writes one line per paragraph. These run the real script under the real bash. */

const SCRIPT = slash(path.join(ROOT, '.lefthook-scripts', 'check-commit-style.sh'))

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-commit-style-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function runHook(message: string): { status: number | null; stderr: string } {
  const msg = path.join(tmp, 'COMMIT_EDITMSG')
  fs.writeFileSync(msg, message)
  const r = spawnSync(HOOK_BASH as string, [SCRIPT, slash(msg)], { encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stderr: r.stderr }
}

/** CAPTURE: the subject and first paragraph of 9218ac3d's message as first pushed, as `git log -1 --format=%B 9218ac3d` printed it. The message was rewritten on one line per paragraph, and the commit is now fbaa73e1. */
const WRAPPED_9218AC3D = [
  'fix(doctor): count the user-level install in the gate and harness checks',
  '',
  '`token-goat doctor` reported the instruction gate missing in every',
  'project on a machine where `token-goat install` had already written it,',
  'because the check looked only at CLAUDE.md, AGENTS.md and',
  '.github/copilot-instructions.md in the project root.',
  '',
].join('\n')

/** CAPTURE: a list item from the same message, wrapped onto indented continuation lines. */
const WRAPPED_BULLET_9218AC3D = [
  'fix(doctor): count the user-level install in the gate and harness checks',
  '',
  '- tests/cli_doctor_repair.test.ts and',
  '  tests/cli_doctor_index_threshold.test.ts: run runDoctorRepair against',
  '  a temp home and project.',
  '',
].join('\n')

/** CAPTURE: 9a9c8012's whole message as first pushed, one line per paragraph. The commit is now d8340fff, and its SHA references now name the rewritten commits. */
const UNWRAPPED_9A9C8012 = [
  'docs(ledger): yield row for loop 83',
  '',
  '9218ac3d and 480f9d47 fix defects in the doctor and upgrade work pulled in at 069ee6ea and ef28ad06. `doctor` missed the gate and harness configuration that `token-goat install` writes at user level, so `doctor --fix` appended a second gate to the project\'s own instruction files. `upgrade` failed on Windows, replaced an `npm link`ed checkout, asked the registry while offline, and kept announcing a version already installed. No release tag contains either pulled commit, so the row is marked not reachable. The work was done interactively, so its spend was not measured.',
  '',
].join('\n')

describe('commit-msg hook: hard-wrapped prose', () => {
  // With no bash at all the hook cannot run on this machine either, so there is nothing to observe; that is a skip, not a pass.
  const hasBash = HOOK_BASH !== null

  it.skipIf(!hasBash)('refuses a paragraph wrapped across lines and names each continuation line', () => {
    const r = runHook(WRAPPED_9218AC3D)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/hard-wrapped/)
    expect(r.stderr).toContain('line 4: project on a machine')
    expect(r.stderr).toContain('line 6: .github/copilot-instructions.md')
    expect(r.stderr).not.toContain('line 3:')
  })

  it.skipIf(!hasBash)('refuses a list item wrapped onto indented continuation lines', () => {
    const r = runHook(WRAPPED_BULLET_9218AC3D)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('line 4:   tests/cli_doctor_index_threshold.test.ts')
  })

  it.skipIf(!hasBash)('refuses a wrapped paragraph saved with CRLF line endings', () => {
    expect(runHook(WRAPPED_9218AC3D.replace(/\n/g, '\r\n')).status).toBe(1)
  })

  it.skipIf(!hasBash)('refuses a subject that runs onto a second line', () => {
    // HAND-DERIVED: git takes the whole first paragraph as the subject, so a second line there is a wrapped subject.
    expect(runHook('fix(doctor): count the user-level install in the gate\nand harness checks\n').status).toBe(1)
  })

  it.skipIf(!hasBash)('passes a message written one line per paragraph', () => {
    const r = runHook(UNWRAPPED_9A9C8012)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(runHook(UNWRAPPED_9A9C8012.replace(/\n/g, '\r\n')).status).toBe(0)
  })

  it.skipIf(!hasBash)('passes lists, nested lists, tables, trailers and code', () => {
    // HAND-DERIVED: every line that follows another non-blank line here is a list item, a table row, a trailer after a trailer, indented code after indented code, or inside a fence.
    const message = [
      'feat(cli): add a flag',
      '',
      'Three things change:',
      '- the flag',
      '  - and its short form',
      '* its help text',
      '1. the docs',
      '2) the changelog',
      '',
      '| before | after |',
      '| --- | --- |',
      '',
      'Run it like this:',
      '',
      '    token-goat stats --payloads',
      '    token-goat stats --payloads --json',
      '',
      '```',
      'output line one',
      'output line two',
      '```',
      '',
      'Refs: #123',
      'Signed-off-by: A Person <a@example.com>',
      '',
    ].join('\n')
    const r = runHook(message)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it.skipIf(!hasBash)('ignores comment lines and everything below the scissors line of `git commit -v`', () => {
    // FORMAT-DERIVED: git's wt-status.c writes the comment character, a space and cut_line ("------------------------ >8 ------------------------"), then two comment lines, then the diff with no comment prefix; git drops all of it from the stored message.
    const message = [
      'docs: fix a typo',
      '# Please enter the commit message for your changes. Lines starting',
      "# with '#' will be ignored, and an empty message aborts the commit.",
      '# ------------------------ >8 ------------------------',
      '# Do not modify or remove the line above.',
      '# Everything below it will be ignored.',
      'diff --git a/README.md b/README.md',
      'index 1111111..2222222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '',
    ].join('\n')
    const r = runHook(message)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    // An editor on Windows can save the file back with CRLF, which must not hide the scissors line.
    expect(runHook(message.replace(/\n/g, '\r\n')).status).toBe(0)
  })

  it.skipIf(!hasBash)('still checks prose that follows a fenced block', () => {
    // HAND-DERIVED: the fence closes, so the two prose lines after it are an ordinary wrapped paragraph.
    expect(runHook('docs: x\n\n```\na\nb\n```\n\nfirst half of a sentence\nsecond half\n').status).toBe(1)
  })
})

describe('commit-msg hook: verification checklists', () => {
  const hasBash = HOOK_BASH !== null

  it.skipIf(!hasBash)('refuses the checklist headings even when each is a single line', () => {
    // CAPTURE: the headings of 17f9e0a7's message as first pushed (now fcdd4689, with the checklist removed), each paragraph on one line, so the wrap check alone passes them.
    const message = [
      "feat(stats): --payloads shows what token-goat adds to every session's context",
      '',
      "Why didn't a test catch this? Nothing was broken, so there was nothing to catch.",
      '',
      'What prevents a regression:',
      '- tests/cli_payloads.test.ts',
      '',
      'Mutation check: 9 of 9 mutations are killed.',
      '',
      'Dogfood: installed globally, in an isolated home.',
      '',
    ].join('\n')
    const r = runHook(message)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/verification checklist/)
    expect(r.stderr).not.toMatch(/hard-wrapped/)
    for (const line of [3, 5, 8, 10]) expect(r.stderr).toContain(`line ${line}: `)
  })

  it.skipIf(!hasBash)('passes the same words inside a sentence', () => {
    // HAND-DERIVED: only a line that opens with a checklist heading is refused.
    expect(runHook('test: cover the dogfood path\n\nThe mutation check script now runs on Windows too.\n').status).toBe(0)
  })
})
