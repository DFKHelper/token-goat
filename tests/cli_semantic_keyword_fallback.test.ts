/**
 * What `semantic` tells the user when the embedding model is not installed.
 *
 * `@xenova/transformers` is opt-in now -- it carried six advisories with no forward patch, one of
 * them critical -- so "no embedding model" is the state a default install is in, not an exotic one.
 * `semantic` keeps working there: `runSemantic` fuses a dense pass with a BM25 pass and the BM25
 * pass is unconditional, so results still come back, matched on words instead of meaning.
 *
 * That is a degradation with no error, no exception and no empty result, which is the shape of
 * change nobody notices. So the warning is the whole of the mitigation, and it has to be both
 * present and true.
 *
 * It used to be neither. `searchSemantic` printed "Embeddings not available; semantic search
 * disabled" and returned `[]`. Dogfooding the built binary with the package removed showed that
 * line printing directly above real keyword hits -- the claim was simply false, and it was false
 * structurally rather than by a slip of wording: `searchSemantic` cannot know whether its caller
 * runs a keyword pass, so any claim it makes about the user's final result is a guess. The
 * warning now lives in `runSemantic`, the one place that knows. These tests pin both halves: the
 * results survive, and the sentence describing them is accurate.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { canonicalize } from '../src/project.js'

import type * as EmbeddingsModule from '../src/embeddings.js'

let modelAvailable = true

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    isAvailable: () => modelAvailable,
    // What the real function does when the model is absent: returns nothing, says nothing. Mocked
    // rather than called, because the real one would try to load the package that is present in
    // this repository -- the state under test is the one this repository can never be in.
    searchSemantic: async () => [],
  }
})

const { run } = await import('../src/cli.js')
const { indexFileSync } = await import('../src/parser.js')
const { globalDbPath } = await import('../src/constants.js')

// The fixture root has to end up spelled exactly the way runSemantic will spell it, or the
// project-scoped BM25 query compares two spellings of the same directory as prefixes, matches
// nothing, and the test fails for a reason unrelated to what it tests. Both CI runners produce a
// different spelling than a developer machine does, and the two need different repairs:
//
//   macOS   os.tmpdir() is /var/folders/..., a symlink to /private/var/folders/.... Only
//           realpathSync resolves that; canonicalize deliberately does not call realpath.
//   Windows GitHub runners hand out 8.3 short names (RUNNER~1). Only canonicalize expands those;
//           realpathSync returns the short form unchanged (verified, not assumed).
//
// So both are applied, in that order, and canonicalize is the same function resolveProjectRoot
// puts the root through -- which is what makes the two sides agree by construction rather than by
// coincidence on whichever platform happens to be running. tests/cli_context_stats.test.ts records
// this repository hitting exactly this on macOS and Windows CI before.
const TMP = canonicalize(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semfallback-'))))
// posix.join, not path.join: the project-scoped SQL compares a normalized (forward-slash) root
// against the stored path as-is, and canonicalizeIndexPath keeps whichever separator its caller
// used. The production walk indexes with forward slashes, so a backslash path here would store a
// row no project-scoped query can ever see. TMP is already forward-slash (canonicalize emits
// posix form), so joining posix-style keeps the whole path in one spelling.
const FIXTURE = path.posix.join(TMP, 'auth.ts')

beforeAll(() => {
  fs.writeFileSync(
    FIXTURE,
    'export function refreshCredential(id: string): string {\n' + "  return id + '-refreshed'\n" + '}\n',
  )
  // A real symbol row in the real global index, so the BM25 pass below is the production query
  // against production data rather than a stub standing in for it. Indexed from inside the
  // fixture directory because rows are attributed to the project root resolved at index time:
  // indexing from the repository root files them under the repository, and the project-scoped
  // query below then correctly finds nothing.
  const cwd = process.cwd()
  process.chdir(TMP)
  try {
    indexFileSync(FIXTURE, globalDbPath())
  } finally {
    process.chdir(cwd)
  }
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

afterEach(() => {
  modelAvailable = true
})

async function runSemanticCli(query: string): Promise<{ stdout: string; warnings: string[] }> {
  const prev = process.exitCode
  process.exitCode = 0
  const chunks: string[] = []
  const warnings: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  // `semantic` has no project flag: runSemantic resolves the root from process.cwd(), so the
  // fixture is only reachable from inside it.
  const cwd = process.cwd()
  process.chdir(TMP)
  try {
    await run(['node', 'token-goat', 'semantic', query])
    return { stdout: chunks.join(''), warnings }
  } finally {
    process.chdir(cwd)
    out.mockRestore()
    warn.mockRestore()
    process.exitCode = prev
  }
}

describe('semantic with no embedding model installed', () => {
  it('still returns keyword results, so the warning must not claim the feature is off', async () => {
    modelAvailable = false
    const { stdout, warnings } = await runSemanticCli('refreshCredential')

    // The half that survives. Without this assertion the wording checks below are vacuous: a
    // message saying "keyword search still ran" is only correct if keyword search still ran.
    expect(stdout, 'BM25 runs unconditionally, so a literal-word query still matches').toContain(
      'refreshCredential',
    )

    const warning = warnings.join('\n')
    expect(warning, 'the user must be told meaning-matching is off').toContain('Matching on meaning is off')
    expect(warning, 'and told where the results did come from').toContain('keyword search alone')
    // The exact sentence that used to print here and was false. Pinned by its literal text rather
    // than by a property, because the failure was a claim about the user's results, and a future
    // rewrite that reintroduces the claim would reintroduce the defect verbatim.
    expect(warning, 'the old claim contradicted the results printed directly beneath it').not.toContain(
      'semantic search disabled',
    )
  })

  it('names the command that restores it, in the form that actually resolves', async () => {
    modelAvailable = false
    const { warnings } = await runSemanticCli('refreshCredential')
    const warning = warnings.join('\n')

    // A globally installed token-goat resolves the model as a sibling in the same global
    // node_modules, so -g is load-bearing; a project install must not have it. A warning that
    // names the package without the command, or the command in the wrong form, sends the reader
    // to an install that succeeds and still does not load.
    expect(warning).toContain('npm install -g @xenova/transformers')
    expect(warning).toContain('drop -g if token-goat is a project dependency')
  })

  it('says nothing at all when the model is present', async () => {
    modelAvailable = true
    const { stdout, warnings } = await runSemanticCli('refreshCredential')
    // Anchors the absence: a run that produced no output at all would satisfy the negative
    // assertion below while proving nothing, which is exactly how this test first passed against
    // a command that had rejected its own arguments.
    expect(stdout, 'the command must actually have run').toContain('refreshCredential')
    // The warning is only useful if it means something. Printing it on every run, including the
    // fully working one, would train the reader to ignore the line that carries the whole cost of
    // making the package opt-in.
    expect(warnings.join('\n')).not.toContain('Matching on meaning is off')
  })
})
