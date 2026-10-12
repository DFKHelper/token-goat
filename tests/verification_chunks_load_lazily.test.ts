// The code behind the Stop advisory and the subagent receipt (change_claim.ts, agent_receipt.ts, hooks_stop.ts, verification_state.ts) loads on first use, because the hook entry parses every eager byte on each tool call. Provenance: the markers are CAPTURE, read out of the built bundle itself (the `// src/<file>.ts` banner esbuild writes above each inlined module, and two string literals from change_claim.ts and hooks_stop.ts that survive minification-free bundling), not from a list of expected chunks; the loaded-module log is CAPTURE from a real `import()` of dist/token-goat-hook.mjs under a module-customization hook.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BUNDLE, CORE_BUNDLE, HOOK_BUNDLE, ROOT } from './helpers/bundle.js'

const DIST = path.join(ROOT, 'dist')
const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers')
const LAZY_MODULES = ['src/change_claim.ts', 'src/agent_receipt.ts', 'src/hooks_stop.ts', 'src/verification_state.ts']
const LAZY_STRINGS = ['FIRST_PERSON_CLAIM_RE', 'unverified work before you stop']

/** Chunk files `file` imports with a static `import ... from "./..."` or `import "./..."`; a deferred `import("./...")` matches neither pattern. */
function staticImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const out = new Set<string>()
  for (const re of [/from\s*"(\.\/[^"]+\.mjs)"/g, /(?:^|[;\n])import\s*"(\.\/[^"]+\.mjs)"/g]) {
    for (const m of text.matchAll(re)) if (m[1] !== undefined) out.add(path.join(DIST, path.basename(m[1])))
  }
  return [...out]
}

/** The entry plus every file it reaches through static imports: what the engine parses and evaluates before the entry's own code runs. */
function eagerFiles(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const next = queue.shift() as string
    if (seen.has(next) || !fs.existsSync(next)) continue
    seen.add(next)
    queue.push(...staticImports(next))
  }
  return [...seen]
}

const textOf = (files: readonly string[]): string => files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

/** Every dist file holding `needle`, the lazy chunks the other tests in this file need to exist. */
function distFilesContaining(needle: string): string[] {
  return fs
    .readdirSync(DIST)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(DIST, f))
    .filter((f) => fs.readFileSync(f, 'utf8').includes(needle))
}

describe('the verification code is a lazy chunk of the built bundle', () => {
  it('ships the code in a chunk, so the absence checks below are not vacuous', () => {
    for (const needle of [...LAZY_STRINGS, ...LAZY_MODULES.map((m) => `// ${m}`)]) {
      expect(distFilesContaining(needle), needle).not.toHaveLength(0)
    }
  })

  it.each([
    ['the launcher', BUNDLE],
    ['the CLI core entry', CORE_BUNDLE],
    ['the hook entry', HOOK_BUNDLE],
  ])('keeps it out of %s and everything that entry imports statically', (_name, entry) => {
    const text = textOf(eagerFiles(entry))
    for (const needle of [...LAZY_STRINGS, ...LAZY_MODULES.map((m) => `// ${m}`)]) expect(text.includes(needle), needle).toBe(false)
  })

  it('does not load any chunk that holds it when the hook entry is imported', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lazy-'))
    try {
      const log = path.join(scratch, 'loaded.txt')
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(HELPERS, 'esm_load_log_register.mjs')).href, '-e', 'import(process.env.HOOK_URL).then(() => process.exit(0))'], {
        encoding: 'utf8',
        env: { ...process.env, ESM_LOAD_LOG: log, HOOK_URL: pathToFileURL(HOOK_BUNDLE).href, TOKEN_GOAT_HOME: path.join(scratch, 'home') },
        timeout: 60_000,
      })
      expect(run.status, run.stderr).toBe(0)
      const loaded = fs.readFileSync(log, 'utf8').split('\n').filter((u) => u.includes('token-goat-chunk-'))
      // The hook entry really did load its eager chunks, so an empty log cannot pass this check.
      expect(loaded.length).toBeGreaterThan(10)
      const lazyChunks = new Set(LAZY_STRINGS.flatMap(distFilesContaining).map((f) => path.basename(f)))
      expect(loaded.filter((u) => lazyChunks.has(path.basename(u)))).toEqual([])
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})
