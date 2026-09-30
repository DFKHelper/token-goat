import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { distSources, insideComment } from './bundle_specifiers.js'

/** The built bundle never loads `node:http` through an ESM import. On Node 22, importing `http` as ESM builds a module facade by reading every export, and one export is a lazy `WebSocket` getter that loads Node's bundled undici, whose HTTP/1 client compiles llhttp with `WebAssembly.compile` as it loads. Where WebAssembly is off (`--jitless`, which disables `--expose_wasm`, and any Node built without it), that read throws, and the rejection ends the process before a single command runs: `token-goat --version` exited 1. The fix loads `http` through `createRequire`, which builds no facade. Node 24 no longer reads the getter, so on a local Node 24 only the static scan below is red, while CI's Node 22 runs the spawn too. Provenance: CAPTURE. The crash stack is from Node 22.23.2 (win-x64, WebAssembly deleted by a preload) importing the CLI chunk, `lazyUndici (node:http:123:21)` / `Object.get [as WebSocket] (node:http:178:12)` / `BuiltinModule.syncExports` / `lazyllhttp`, and the same `ReferenceError: WebAssembly is not defined` failed CI run 36657103525 under `NODE_OPTIONS=--jitless` on Linux, Windows and macOS. A bare `node --jitless --input-type=module -e "await import('node:http')"` reproduces it on that Node with no token-goat code at all, and the same program with `node:https`, `createRequire(import.meta.url)('node:http')` or `process.getBuiltinModule('node:http')` exits 0. */

// ESM positions only: a CJS require of `http` is the fix, not the defect.
const ESM_HTTP = [/\bfrom\s*["'](?:node:)?http["']/g, /\bimport\s*\(\s*["'](?:node:)?http["']/g, /\bimport\s*["'](?:node:)?http["']/g]

function esmHttpImports(source: string): string[] {
  const hits: string[] = []
  for (const re of ESM_HTTP) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      if (!insideComment(source, m.index)) hits.push(m[0])
    }
  }
  return hits
}

describe('the built bundle never imports node:http as an ES module', () => {
  it('has no static, dynamic or side-effect ESM import of http or node:http', () => {
    const sources = distSources()
    // The matcher must still see an ESM builtin import the bundle is known to make, or an empty result proves nothing.
    expect(sources.some((s) => /\bfrom\s*["']node:https["']/.test(s)), 'the bundle no longer has `from "node:https"`, so nothing here proves the matcher can still find an ESM builtin import').toBe(true)
    expect(sources.flatMap(esmHttpImports)).toEqual([])
  })

  it('matches each ESM form and leaves the createRequire form alone', () => {
    // HAND-DERIVED: the shapes esbuild emits for a namespace import, a dynamic import and a side-effect import, and the shape the fix uses.
    expect(esmHttpImports('import * as http from "http";')).toHaveLength(1)
    expect(esmHttpImports('import http2 from "node:http";')).toHaveLength(1)
    expect(esmHttpImports('await import("node:http")')).toHaveLength(1)
    expect(esmHttpImports('import "http";')).toHaveLength(1)
    expect(esmHttpImports('from "https"; from "http2"; createRequire(import.meta.url)("node:http")')).toEqual([])
  })

  it('starts under --jitless, where WebAssembly does not exist', () => {
    const res = spawnSync(process.execPath, ['--jitless', path.join(ROOT, 'dist', 'token-goat.mjs'), '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
    expect(res.stderr).not.toContain('WebAssembly is not defined')
    expect(res.status, res.stderr).toBe(0)
  })
})
