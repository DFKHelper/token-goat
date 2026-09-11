/**
 * A skipped test reports success.
 *
 * Seven test files gate their real-embedding cases on `modelFilesPresent()`, so `npm test` never
 * downloads the 33 MB of weights and stays offline by default. The same gate means the test run no
 * longer populates CI's model cache as a side effect of running, which it used to be the only thing
 * doing: with nothing else placing the weights, a cold cache would stay cold, the save step's
 * "is it worth saving" check would find no `.onnx`, and the whole population would skip on every
 * platform forever without one red run anywhere.
 *
 * So this guard asserts the two halves that have to stay true together: every CI job that restores
 * the model cache also has a step that places the model, ordered before the test step; and wherever
 * the workflow declares the weights are required, they are actually present, so those tests run.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { modelFilesPresent } from '../../src/embed_model.js'

import { pinnedPopulation } from './population.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const testsDir = path.join(repoRoot, 'tests')

/** The call every model-gated test file makes. Named once, so a rename empties the population below instead of quietly passing. */
const GATE_CALL = 'modelFilesPresent()'

/** The environment variable a job sets to declare "the weights are warmed here, so those tests must run". */
const REQUIRE_VAR = 'TOKEN_GOAT_REQUIRE_EMBED_MODEL'

interface WorkflowStep {
  readonly name?: string
  readonly run?: string
  readonly uses?: string
  readonly if?: string
  readonly with?: Record<string, unknown>
}

function ciJobs(): Record<string, { steps?: WorkflowStep[] }> {
  const doc = loadYaml(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>
  }
  return doc.jobs ?? {}
}

/** Jobs that restore the pinned model cache, which are exactly the jobs that have to place the model too. */
function jobsRestoringTheModelCache(): readonly string[] {
  const jobs = ciJobs()
  return pinnedPopulation({
    what: 'ci.yml jobs restoring the embedding model cache',
    items: Object.entries(jobs)
      .filter(([, job]) => (job.steps ?? []).some((s) => (s.uses ?? '').includes('actions/cache/restore') && String(s.with?.['key'] ?? '').includes('tg-model-')))
      .map(([id]) => id),
    floor: 3,
    mustInclude: ['test-linux', 'test-windows', 'test-macos'],
  })
}

/** Test files whose real-embedding cases are gated on the weights being present. */
function modelGatedTestFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'fixtures') walk(full)
        continue
      }
      if (!entry.name.endsWith('.test.ts')) continue
      // This guard names the call in order to search for it, so counting itself would keep the population non-empty after every other caller had gone.
      if (full === fileURLToPath(import.meta.url)) continue
      if (fs.readFileSync(full, 'utf8').includes(GATE_CALL)) found.push(path.relative(repoRoot, full).replaceAll('\\', '/'))
    }
  }
  walk(testsDir)
  return pinnedPopulation({
    what: `test files gating real embeddings on ${GATE_CALL}`,
    items: found,
    floor: 7,
    mustInclude: ['tests/semantic_embeddings_e2e.test.ts', 'tests/embeddings_index_wiring.test.ts'],
  })
}

describe('the model-gated tests can still be run somewhere', () => {
  const jobs = jobsRestoringTheModelCache()
  const gated = modelGatedTestFiles()

  it('finds the gated test files at all, so an empty sweep cannot pass as a clean one', () => {
    expect(gated.length).toBeGreaterThanOrEqual(7)
  })

  it.each(jobs.map((j) => [j]))(
    '%s places the embedding model in a step of its own, before the step that runs the tests',
    (jobId) => {
      const steps = ciJobs()[jobId]?.steps ?? []
      const placesModel = steps.findIndex((s) => (s.run ?? '').includes('model:warm'))
      const runsTests = steps.findIndex((s) => (s.run ?? '').includes('npm test') || String(s.with?.['command'] ?? '').includes('npm test'))

      expect(
        placesModel,
        `job "${jobId}" restores the embedding model cache but no step places the model. The test run used to ` +
          `populate that cache as a side effect of downloading the weights; it no longer downloads anything, so a ` +
          `cold cache now stays cold, never gets saved, and every ${GATE_CALL} test skips on every platform for ` +
          `good. Skips are green, so nothing else would report this. Add the warm step back.`,
      ).toBeGreaterThanOrEqual(0)

      expect(runsTests, `job "${jobId}" has no step running the suite, so this ordering check has nothing to order against`).toBeGreaterThanOrEqual(0)
      expect(placesModel, `job "${jobId}" places the embedding model after it runs the tests, which is too late for them to use it`).toBeLessThan(runsTests)
    },
  )

  it.each(jobs.map((j) => [j]))('%s declares the weights required, so a silent skip there is a failure', (jobId) => {
    const steps = ciJobs()[jobId]?.steps ?? []
    expect(
      steps.some((s) => (s.run ?? '').includes(`${REQUIRE_VAR}=1`)),
      `job "${jobId}" warms the model but never sets ${REQUIRE_VAR}=1, so the assertion below has nothing to hold it to ` +
        `and the gated tests could go back to skipping there unnoticed.`,
    ).toBe(true)
  })

  it.each(jobs.map((j) => [j]))('%s still refuses to save a half-populated cache', (jobId) => {
    const steps = ciJobs()[jobId]?.steps ?? []
    const save = steps.find((s) => (s.uses ?? '').includes('actions/cache/save'))
    expect(save, `job "${jobId}" no longer saves the model cache, so a cold cache would pay the download every run`).toBeDefined()
    expect(
      save?.if ?? '',
      `job "${jobId}" saves the model cache unconditionally. A cache saved half-populated is restored forever under a ` +
        `key that already exists, so it can never be replaced.`,
    ).toContain('model-cache-complete.outputs.ok')
  })

  it(`has the weights present wherever ${REQUIRE_VAR} says they must be`, () => {
    if (process.env[REQUIRE_VAR] !== '1') {
      // Locally the weights are optional, so all this environment can check is that the gate answers rather than throws.
      expect(typeof modelFilesPresent()).toBe('boolean')
      return
    }
    expect(
      modelFilesPresent(),
      `${REQUIRE_VAR}=1, so the warm step was supposed to have placed the pinned embedding model, but the gate the ` +
        `${gated.length} model-gated test files read still says it is absent. Every one of them is skipping here, and ` +
        `a skipped test reports success.`,
    ).toBe(true)
  })
})
