/**
 * Guard against reintroducing the "console.debug corrupts the hook wire
 * protocol" class of bug.
 *
 * Hook handlers communicate with the harness by writing a single JSON
 * document to stdout (see relay.ts's `process.stdout.write(...)` calls).
 * Anything else printed to stdout interleaves with that document and
 * corrupts the wire protocol -- the harness gets malformed JSON instead of a
 * clean hook response.
 *
 * Commit a1bd685f hit exactly this: `_LOG.debug` in src/hooks_cli.ts used
 * `console.debug`, and `console.debug` writes to STDOUT in Node (unlike
 * `console.warn`/`console.error`, which go to stderr -- verified with
 * `node -e "console.debug('X')" 1>/dev/null` printing nothing, while
 * `2>/dev/null` still prints). The bug was latent -- harmless only because
 * that code path happened to be unreachable, until another fix made it
 * reachable. Nothing else in the codebase would have caught a hook module
 * reaching for `console.log`/`console.debug`/`console.info`, so this guard
 * scans for that mistake directly rather than relying on it staying
 * unreachable by luck.
 *
 * Scope: every hooks_*.ts file with a top-level registerHook() call (the
 * same discovery this repo's tests/guards/relay_hook_imports.test.ts
 * already does), plus src/relay.ts (the sole entry point every
 * `token-goat hook <event>` invocation goes through) and src/hooks_cli.ts
 * (payload normalization shared by every hook invocation, and the site of
 * the original bug). `console.warn`/`console.error` are NOT forbidden --
 * both go to stderr and are legitimate there.
 *
 * Deliberately NOT transitive over imports. A hooks_*.ts file can legally
 * import a module that itself uses console.log for an unrelated purpose --
 * e.g. src/hooks_session_start.ts imports checkSymbolBodySize from
 * src/cli_doctor.ts, which is also token-goat's CLI renderer and contains
 * many legitimate console.log calls for terminal output. A naive "any
 * module a hook transitively imports must be console.log-free" rule would
 * false-positive on that immediately. This guard only inspects the files
 * listed above directly; a bad console call several imports deep from a
 * hook module is a real but different failure class this guard does not
 * claim to catch.
 *
 * If a hook module needs to write to stdout, it should use
 * `process.stdout.write(...)` for the single JSON wire response the way
 * relay.ts does, never console.log/console.debug/console.info.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Every `hooks_*.ts` file directly under src/ with a top-level `registerHook(` call, same discovery as tests/guards/relay_hook_imports.test.ts. */
function registeringHooksFiles(): string[] {
  // Pinned, and this one has two independent ways to empty: the `hooks_` filename convention and
  // the `registerHook(` call shape. A refactor to either -- a rename, or wrapping registration in a
  // helper -- leaves this returning [] with no error, which is the exact shape of the guard-gate
  // regression this repo has already shipped once.
  return [
    ...pinnedPopulation({
      what: 'src/hooks_*.ts modules with a top-level registerHook( call',
      items: fs
        .readdirSync(SRC_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^hooks_.*\.ts$/.test(entry.name))
        .map((entry) => entry.name)
        .filter((file) => /^registerHook\(/m.test(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')))
        .sort(),
      floor: 15,
      mustInclude: ['hooks_read.ts', 'hooks_bash.ts', 'hooks_edit.ts'],
    }),
  ]
}

/** Files in scope for this guard: the hook-registering modules, relay.ts (the wire entry point), and hooks_cli.ts (shared payload normalization). */
function filesInScope(): string[] {
  return [...new Set([...registeringHooksFiles(), 'relay.ts', 'hooks_cli.ts'])].sort()
}

/** A `console.log(`, `console.debug(`, or `console.info(` call, with its 1-based line number, found in `file`'s source. Comments and strings are not excluded -- a match inside a comment or string in one of these files is still worth a human look, and none currently exist. */
function findForbiddenConsoleCalls(file: string): { line: number; text: string }[] {
  const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
  const hits: { line: number; text: string }[] = []
  src.split('\n').forEach((lineText, idx) => {
    if (/console\.(log|debug|info)\(/.test(lineText)) {
      hits.push({ line: idx + 1, text: lineText.trim() })
    }
  })
  return hits
}

describe('no stdout-writing console call in the hook wire path', () => {
  const scope = filesInScope()

  it('found at least one file in scope (sanity check that discovery is not silently matching nothing)', () => {
    expect(scope.length).toBeGreaterThan(0)
  })

  it('relay.ts and hooks_cli.ts are always in scope regardless of hook discovery', () => {
    expect(scope).toEqual(expect.arrayContaining(['relay.ts', 'hooks_cli.ts']))
  })

  for (const file of scope) {
    it(`${file} contains no console.log/console.debug/console.info call`, () => {
      const hits = findForbiddenConsoleCalls(file)
      const message = hits
        .map(
          (h) =>
            `src/${file}:${h.line}: ${h.text}\n  -> use process.stdout.write(...) for the hook's JSON wire response instead (see relay.ts); console.log/debug/info write to stdout and corrupt the wire protocol`,
        )
        .join('\n')
      expect(hits, message).toEqual([])
    })
  }
})
