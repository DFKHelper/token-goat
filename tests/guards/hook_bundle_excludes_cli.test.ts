/**
 * Structural guard on what the hook bundle *evaluates* at import time.
 *
 * `dist/token-goat-hook.mjs` is `import()`ed by the Claude Code hook shim on nearly every tool
 * call, so every module in its statically evaluated graph runs its top-level code that often.
 * A single static `import { buildProgram } from './cli.js'` in skill_version_drift.ts -- reached
 * from relay.ts via hooks_session.ts -- pulled the whole CLI into that graph: commander, the MCP
 * server, every graph/text/read command and every tool filter. The bundle was 3.48 MB instead of
 * 1.38 MB and import+eval cost ~55 ms instead of ~29 ms, on every hook, to serve two rare call
 * sites. Nothing failed; the hook was just twice as expensive as it needed to be, which is only
 * visible to someone who profiles it.
 *
 * The assertion is on the *static* graph, not on bundle size: esbuild inlines a dynamically
 * imported local module into the same file, so size alone cannot tell a deferred module from an
 * eager one. Walking only `import-statement` edges is what distinguishes them.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')

/**
 * Modules a hook must never evaluate. cli.ts is the entry to the whole command surface, and
 * commander is the single largest thing only it needs -- listing the dependency too catches a
 * reintroduction that routes around cli.ts itself. Deliberately not listed: mcp_server.ts, which
 * every entry already reaches only dynamically, so it would assert nothing; and
 * graph_commands.ts, which session-start's index-health check legitimately reaches.
 */
const FORBIDDEN = ['src/cli.ts', 'node_modules/commander/lib/command.js']

async function staticGraph(entry: string): Promise<Set<string>> {
  const result = await esbuild.build({
    absWorkingDir: REPO,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    metafile: true,
    // Mirrors esbuild.config.mjs's EXTERNAL_NATIVE_DEPS. Kept loose here on purpose: this guard
    // is about which of *our own* modules are eagerly reachable, not about dependency layout.
    external: [
      'better-sqlite3', 'sqlite-vec', 'tree-sitter', 'tree-sitter-*', 'sharp', 'puppeteer-core',
      'pdfjs-dist', 'pdfjs-dist/*', 'exceljs', 'fflate', 'fast-xml-parser',
      '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', '@xenova/transformers',
      'tesseract.js', 'typescript',
    ],
    define: { 'import.meta.env': '{}', __TG_VERSION__: '"0.0.0-test"' },
    logLevel: 'silent',
  })
  const inputs = result.metafile.inputs
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const next = queue.shift()!
    for (const imp of inputs[next]?.imports ?? []) {
      // `dynamic-import` edges are exactly the ones esbuild defers to first use; skipping them
      // is the whole point of this walk. Everything else is eager, and that includes `require-call`
      // -- commander is CJS internally, so its own modules hang off require edges, not imports.
      if (imp.external || imp.kind === 'dynamic-import' || imp.kind === 'require-resolve') continue
      if (seen.has(imp.path)) continue
      seen.add(imp.path)
      queue.push(imp.path)
    }
  }
  return seen
}

describe('hook bundle static graph', () => {
  it('does not eagerly evaluate the CLI from the hook entry', async () => {
    const graph = await staticGraph('src/hook_lib.ts')
    const leaked = FORBIDDEN.filter((f) => graph.has(f))
    expect(leaked, `hook entry statically imports ${leaked.join(', ')}`).toEqual([])
  }, 60_000)

  it('still reaches the CLI from the CLI entry, so the walk is not vacuously passing', async () => {
    // Without this, a typo in FORBIDDEN or a broken metafile walk would make the test above pass
    // for the wrong reason and stop guarding anything.
    const graph = await staticGraph('src/main.ts')
    for (const f of FORBIDDEN) expect(graph.has(f), `${f} should be reachable from main.ts`).toBe(true)
  }, 60_000)
})
