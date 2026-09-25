import * as fs from 'node:fs'
import * as path from 'node:path'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'

/** The job that holds the npm token must not be a job that runs dependency code. The npm supply-chain attacks worth defending against no longer need an install hook: the package installs cleanly and fires from inside a method the host calls during normal use. `runtime_dependency_set_is_locked.test.ts` bounds what that can reach on a *user's* machine. This bounds the other direction, which is much larger: a compromised **dev** dependency reaching users through a release. `npm ci` resolves roughly 490 packages here and `npm test` executes them, so when the build and the publish shared one job, that code ran on the same filesystem as the credential -- free to rewrite `dist/` before it shipped, or to add a `prepublishOnly` to package.json that `npm publish` would then run with NODE_AUTH_TOKEN in its environment. Provenance does not help: it attests that the official workflow produced the artifact, which would be true. So the checks below are about *separation*, not about detecting malice. The publishing job may not install anything, may not run the suite, and must pass `--ignore-scripts` so "nothing else runs here" is a property of the command rather than of whatever happens to be on disk. What this does not claim: that the release is untamperable. `npm run build` is esbuild, so dependency code runs upstream of the artifact no matter how the jobs are arranged. The artifact crossing the boundary is the residual risk, and it is smaller than a writable checkout plus a token. Provenance: CAPTURE. Parsed from `.github/workflows/publish.yml` itself -- the file GitHub executes -- not from a fixture or a transcription of it. */

const workflow = path.join(ROOT, '.github', 'workflows', 'publish.yml')

interface Job {
  readonly name: string
  readonly body: string
}

/** The workflow's jobs, split on column-2 keys under `jobs:`. Each body is every line up to the next job, less comment lines: a comment describing the next job sits above its key, inside the previous job's span, and would otherwise be read as that job's text. */
function jobs(): Job[] {
  const lines = fs
    .readFileSync(workflow, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  expect(start, 'publish.yml has no `jobs:` block, so nothing below is reading what it thinks it is').toBeGreaterThanOrEqual(0)

  const found: Job[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const header = /^ {2}([\w-]+):\s*$/.exec(lines[i]!)
    if (header === null) continue
    let end = i + 1
    while (end < lines.length && !/^ {2}[\w-]+:\s*$/.test(lines[end]!)) end++
    found.push({ name: header[1]!, body: lines.slice(i, end).join('\n') })
  }
  return found
}

/** The job that receives the registry token, identified by the secret it reads rather than by its name. */
function publishingJob(): Job {
  const holders = jobs().filter((j) => j.body.includes('secrets.NPM_TOKEN'))
  expect(holders.map((j) => j.name), 'exactly one job should hold the registry token').toHaveLength(1)
  return holders[0]!
}

describe('the job that publishes to npm', () => {
  it('finds the jobs it means to check, so an empty parse cannot read as a clean one', () => {
    const names = jobs().map((j) => j.name)
    expect(names, 'the workflow no longer splits build from publish').toEqual(expect.arrayContaining(['build', 'publish']))
    // Each body must be substantial: a splitter that matched the headers but captured nothing would satisfy every check below by having no text to fail on.
    for (const job of jobs()) expect(job.body.split('\n').length, `the ${job.name} job parsed as empty`).toBeGreaterThan(3)
  })

  it('is not the job that installs dependencies', () => {
    expect(publishingJob().body, 'installing here puts ~490 packages of third-party code in the same job as the token').not.toMatch(/\bnpm (ci|install)\b/)
  })

  it('is not the job that runs the suite', () => {
    expect(publishingJob().body, 'the suite executes every dev dependency; that belongs upstream of the credential').not.toMatch(/\bnpm (test|run build)\b/)
  })

  it('runs no lifecycle scripts of its own', () => {
    // Without this, `npm publish` fires prepack/prepare/prepublishOnly from whatever package.json is on disk at that moment -- the exact hook a tampering dependency would add.
    expect(publishingJob().body, 'npm publish must be passed --ignore-scripts').toMatch(/npm publish[^\n]*--ignore-scripts/)
  })

  it('still publishes with provenance', () => {
    // Separation is not a reason to drop the attestation, and a rearranged workflow is exactly when it gets lost.
    expect(publishingJob().body).toMatch(/npm publish[^\n]*--provenance/)
  })

  it('shares id-token: write only with an attestation job that runs no repository code', () => {
    // actions/attest-build-provenance mints its Sigstore certificate through the OIDC token, so the job attesting the Linux binaries needs the grant too. It may hold it only while it checks out nothing and runs nothing beyond a hash check, so the privilege never sits beside code from the repository or its dependencies.
    const granted = jobs().filter((j) => /id-token:\s*write/.test(j.body))
    expect(granted.map((j) => j.name), 'provenance signing privilege belongs to the job that publishes').toContain(publishingJob().name)
    for (const job of granted.filter((j) => j.name !== publishingJob().name)) {
      expect(job.body, `${job.name} holds id-token: write without attesting anything`).toMatch(/uses: actions\/attest-build-provenance@/)
      expect(job.body, `${job.name} holds id-token: write and checks out the repository`).not.toMatch(/uses: actions\/checkout@/)
      const runs = [...job.body.matchAll(/^\s+run: (.*)$/gm)].map((m) => m[1]!)
      expect(runs, `${job.name} holds id-token: write and runs more than a hash check`).toEqual(runs.filter((r) => /^sha256sum -c [\w .-]+$/.test(r)))
    }
  })

  it('cannot run before the build it publishes', () => {
    const doc = yaml.load(fs.readFileSync(workflow, 'utf8')) as { jobs: Record<string, { needs?: string | string[] }> }
    const needs = doc.jobs[publishingJob().name]!.needs
    expect([needs ?? []].flat(), 'without `needs`, the publish job races the build and uploads whatever is in the artifact store').toContain('build')
  })

  it('refuses a non-main ref on its own terms', () => {
    // Inherited through `needs` this is already true, but the job holding the credential should not depend on an upstream job having been skipped for its own safety.
    expect(publishingJob().body).toMatch(/if:.*refs\/heads\/main/)
  })

  it('leaves the building job with no access to the token', () => {
    const build = jobs().find((j) => j.name === 'build')!
    expect(build.body, 'the job that runs dependency code must not read any secret').not.toMatch(/secrets\./)
    expect(build.body, 'nor hold signing privilege').not.toMatch(/id-token:\s*write/)
  })
})
