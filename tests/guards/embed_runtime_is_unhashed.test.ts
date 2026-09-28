/** Which ONNX Runtime build runs the embedding model, and how it is found, loaded and fetched, lives in src/embed_runtime.ts precisely so that no fingerprint hashes it. EMBED_FINGERPRINT digests its source files whole, and moving it discards every stamp on every machine, so a loader edit hashed into it -- a retry interval, a download message, a new place to look for the binary -- would bill every user a full re-embed for a change that moves no number. What a runtime can change about a vector is which build and which release computes it, and that reaches the stamp through backendId() instead, as the vector-space half: switching builds or releases discards and rebuilds the vectors, and nothing else about the loader does. Both halves are held here: the loader stays out of every hashed list, no hashed file loads a runtime package itself (which would put the loader back behind the digest by another route), and backendId() still names the build and its version. HAND-DERIVED: the file lists come from scripts/parser-fingerprint.mjs at run time, and the load forms are Node's own `require`/`require.resolve`/`import()` syntax and ECMAScript's static `from` clause, not shapes read off this repo's code; the non-vacuity assertions turn a stale name or pattern into a failure rather than a silent pass. */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { embedFingerprintSources, extractionSources } from '../../scripts/parser-fingerprint.mjs'
import { pinnedPopulation } from './population.js'

const ROOT = process.cwd()
const RUNTIME = 'src/embed_runtime.ts'
const PINNED_FILE = 'src/pinned_file.ts'

const relative = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** A call that loads or locates an ONNX Runtime package: `require(...)`, `_require(...)`, `require.resolve(...)` or `import(...)`, with a quoted or template specifier. */
const LOAD_CALL = /(?:\b_?require(?:\.resolve)?|\bimport)\s*\(\s*[`'"]onnxruntime-/
/** A static import or re-export of an ONNX Runtime package. */
const STATIC_FROM = /\bfrom\s+['"]onnxruntime-/

/** Every file either fingerprint hashes, pinned so an empty list cannot report "no hashed file loads a runtime". The anchors are the two hashed files that sit either side of the runtime: embed_model.ts builds sessions through it and embeddings.ts stamps its identity. */
function hashedFiles(): readonly string[] {
  const all = [...new Set([...embedFingerprintSources(), ...extractionSources()].map(relative))].sort()
  return pinnedPopulation({ what: 'files hashed by EMBED_FINGERPRINT or PARSER_FINGERPRINT', items: all, floor: 60, mustIncludeExact: ['src/embed_model.ts', 'src/embeddings.ts'] })
}

describe('the inference runtime loader lives outside every hashed fingerprint source', () => {
  it('is where the runtime is actually loaded, so the assertions below cannot pass against an empty module', () => {
    const text = read(RUNTIME)
    expect(text, `${RUNTIME} no longer builds inference sessions -- the loader moved, and this guard must follow it`).toMatch(/^export async function createInferenceSession\b/m)
    expect(LOAD_CALL.test(text), `${RUNTIME} no longer loads a runtime package by any form LOAD_CALL recognises, so the pattern below would miss the real one`).toBe(true)
  })

  it('is not hashed by embedFingerprintSources() or extractionSources(), and neither is the pinned-download helper it shares with the model', () => {
    const embed = new Set(embedFingerprintSources().map(relative))
    const extraction = new Set(extractionSources().map(relative))
    for (const file of [RUNTIME, PINNED_FILE]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is gone; update this guard`).toBe(true)
      expect(embed.has(file), `${file} is hashed into EMBED_FINGERPRINT, so every edit to how the runtime is found or fetched re-embeds every indexed file on every machine`).toBe(false)
      expect(extraction.has(file), `${file} is hashed into PARSER_FINGERPRINT, so every edit to it reparses every indexed file`).toBe(false)
    }
  })

  it('is the only way a hashed file reaches a runtime package', () => {
    const offenders = hashedFiles().filter((file) => {
      const text = read(file)
      return LOAD_CALL.test(text) || STATIC_FROM.test(text)
    })
    expect(offenders, `these hashed files load an onnxruntime package themselves instead of going through ${RUNTIME}: ${offenders.join(', ')}`).toEqual([])
  })

  it('still reaches the stamp through backendId(), which names the build and its version', () => {
    const text = read('src/embeddings.ts')
    const start = text.search(/^function backendId\(/m)
    expect(start, 'src/embeddings.ts no longer declares backendId()').toBeGreaterThan(-1)
    const body = text.slice(start, text.indexOf('\n}', start))
    // Without the build's name, a switch between the native binding and the WebAssembly build would keep vectors computed by the other one; without the version, a runtime upgrade would.
    expect(body).toContain('activeRuntime()')
    expect(body).toContain('runtimeVersion()')
  })
})
