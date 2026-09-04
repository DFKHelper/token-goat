/**
 * The CodeQL job is the only thing in this repository doing interprocedural dataflow analysis, and
 * every way it can stop doing that is silent.
 *
 * `ci.yml` already says the thing this file is the second half of: "a secrets scan the repository
 * configures but never runs is a document, not a control." A code-scanning workflow fails the same
 * way and worse, because it fails *partially*. Narrowing `queries` back to the default suite,
 * dropping the schedule, or adding `src` to `paths-ignore` each leaves a green check and a
 * code-scanning tab that still says "no alerts" -- which reads as a clean bill of health rather
 * than as a scan that stopped looking. None of those edits would fail a test without this file.
 *
 * Text assertions rather than a YAML parse, matching the two sibling workflow guards
 * (`workflow_actions_pinned`, `workflow_permissions`) so all three read the same way and none adds
 * a parser dependency to the suite.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
  'codeql.yml',
)

function workflow(): string {
  expect(
    fs.existsSync(WORKFLOW),
    '.github/workflows/codeql.yml is gone. If code scanning moved to another file or to the ' +
      "repository's default setup, repoint this guard at it; if it was removed on purpose, delete " +
      'this file in the same commit and say so, because the alternative is a repository that ' +
      'claims a SAST pass it no longer runs.',
  ).toBe(true)
  return fs.readFileSync(WORKFLOW, 'utf8')
}

describe('the CodeQL scan stays wired', () => {
  it('analyses this repository as TypeScript', () => {
    expect(workflow()).toMatch(/languages:\s*javascript-typescript/)
  })

  it('uses the extended query suite rather than the default one', () => {
    // The default suite is tuned for near-zero false positives on an arbitrary codebase. This one
    // builds shell command strings and takes file paths from tool output, so the queries the
    // default drops are the ones with something to find here. Narrowing it back is a real
    // reduction in coverage and should not be a quiet one.
    expect(
      workflow(),
      'The CodeQL job is no longer running security-extended. That is a coverage cut, not a ' +
        'configuration tidy-up: the queries the default suite omits are the ones that match this ' +
        "codebase's shape. If the extended suite is too noisy, triage the alerts rather than " +
        'narrowing the suite, and if it really has to change, change this assertion deliberately.',
    ).toMatch(/queries:\s*security-extended/)
  })

  it('does not exclude the source tree it exists to scan', () => {
    const ignored = [...workflow().matchAll(/^\s*-\s*(\S+)\s*$/gm)]
      .map((m) => m[1]!)
      .filter((v) => ['src', 'src/', './src', 'src/**'].includes(v))
    expect(
      ignored,
      'paths-ignore now covers src. Everything this scan is for lives there, so the job would keep ' +
        'passing, keep reporting no alerts, and analyse nothing.',
    ).toEqual([])
  })

  it('runs on pushes to main and on a schedule', () => {
    const src = workflow()
    expect(src).toMatch(/push:/)
    // A push-only scan never re-examines code that has not changed, so a query pack shipped next
    // month finds nothing until someone happens to touch the file it would have flagged.
    expect(
      src,
      'The schedule is gone, so CodeQL now only ever sees code at the moment it changes. Query ' +
        'packs are updated continuously; without a periodic run, an alert that becomes findable ' +
        'next month is never found.',
    ).toMatch(/schedule:/)
  })

  it('grants security-events: write to the analysing job and nothing wider at the top level', () => {
    const src = workflow()
    expect(src).toMatch(/security-events:\s*write/)
    // The top-level block must stay read-only: a workflow-wide write token would hand every future
    // job in this file a scope none of them asked for. Same rule ci.yml states for itself.
    const topLevel = src.slice(0, src.indexOf('jobs:'))
    expect(
      /permissions:\s*\n\s*contents:\s*read\s*\n/.test(topLevel),
      'The top-level permissions block is no longer a read-only contents: read. Keep the default ' +
        'least-privilege and let the analyse job override it, so a job added later starts from ' +
        'read-only rather than inheriting write.',
    ).toBe(true)
    expect(topLevel).not.toMatch(/security-events:\s*write/)
  })
})
