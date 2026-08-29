/**
 * Guard: the ONNX inference session must never be created without an explicit thread count.
 *
 * ONNX Runtime sizes its intra-op thread pool to the host when the session is created bare, and
 * that pool is what every embedding call fans out across. Measured on a 26-logical-core machine
 * (CAPTURE, a real run against the cached `model_quantized.onnx`, not read off documentation):
 *
 *   threads in the process, baseline                        13
 *   after require('onnxruntime-node')                       13
 *   after InferenceSession.create(model)                    30   <- 17 threads, no options passed
 *   after InferenceSession.create(model, {intraOp: 1, ...})  30   <- the pinned session added none
 *
 * So a bare `create` is the difference between a background indexer taking a couple of cores and
 * one taking most of the machine for as long as the walk lasts. It shipped that way, and nothing
 * caught it, because there is no failure: indexing works perfectly, it just takes the whole box.
 * That is invisible to every functional test, which is why this is a structural check.
 *
 * If this fails, pass session options at the named call site rather than relaxing the check.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

const CREATE_CALL = 'InferenceSession.create('

interface CreateCall {
  file: string
  args: string
}

/** Every `.ts` file under src/, recursively. */
function walkSrc(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSrc(full))
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Extract the argument text of each `InferenceSession.create(...)` call in `src/`.
 *
 * Balanced-paren scan rather than a regex: the options object contains its own braces and the
 * model path contains its own parens (`path.join(...)`), and a non-greedy regex to the first `)`
 * would cut the call in half -- reporting "no second argument" for a call that has one, or the
 * reverse. Getting that wrong in the permissive direction is the failure this guard exists to
 * prevent, so the scan is worth the fifteen lines.
 */
function createCalls(): CreateCall[] {
  const found: CreateCall[] = []
  for (const file of walkSrc(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8')
    let from = 0
    for (;;) {
      const at = source.indexOf(CREATE_CALL, from)
      if (at < 0) break
      let depth = 0
      let end = at + CREATE_CALL.length - 1
      for (; end < source.length; end++) {
        const ch = source[end]
        if (ch === '(') depth++
        else if (ch === ')') {
          depth--
          if (depth === 0) break
        }
      }
      found.push({ file: path.relative(SRC_DIR, file), args: source.slice(at + CREATE_CALL.length, end) })
      from = end + 1
    }
  }
  return found
}

describe('ONNX session creation', () => {
  // The population pin. Every assertion below is "no call is bare", which an empty list satisfies
  // -- and the list empties silently if the call is renamed, moved behind a wrapper, or the
  // runtime is swapped. Then this file goes green forever while checking nothing. Assert the
  // subjects exist before asserting anything about them.
  it('finds the session-creation call it is supposed to be checking', () => {
    const calls = createCalls()
    expect(
      calls.length,
      `no ${CREATE_CALL}...) call found anywhere under src/. Either the embedding model no longer ` +
        `uses onnxruntime-node, or the call moved behind a wrapper this scan cannot see -- in ` +
        `which case the checks below are passing vacuously and need re-pointing, not deleting.`,
    ).toBeGreaterThan(0)
  })

  it('passes an explicit thread count at every call site', () => {
    const bare = createCalls().filter((call) => !call.args.includes('intraOpNumThreads'))
    expect(
      bare.map((c) => c.file),
      'these create an ONNX session with no intraOpNumThreads, so ONNX Runtime sizes its thread ' +
        'pool to the whole host and one embedding call fans out across every core',
    ).toEqual([])
  })

  // A hardcoded count would work today and be wrong on the next machine, and would silently ignore
  // the config key and env override that exist to tune exactly this.
  it('takes the thread count from configuration rather than a literal', () => {
    const literal = createCalls().filter((call) => /intraOpNumThreads\s*:\s*\d/.test(call.args))
    expect(
      literal.map((c) => c.file),
      'these hardcode a thread count; it must come from worker.embed_threads so it stays tunable',
    ).toEqual([])
  })
})
