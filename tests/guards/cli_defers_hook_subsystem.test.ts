/**
 * Guard against re-eagerising the hook subsystem from the CLI entry point.
 *
 * src/relay.ts side-effect-imports every hook handler so the registry is populated by the time a
 * hook runs. That makes a *static* import of relay from src/cli.ts enormously expensive: V8
 * compiles a module in full before running any of it, so every CLI command -- `symbol`, `read`,
 * even `--version` -- paid to parse every handler, the whole bash tool-filter registry and the HTML
 * extractor before doing anything, though only `token-goat hook` needs any of it. The same holds
 * for src/bash_runner.ts, which pulls the tool-filter registry in for the `compress` command alone.
 *
 * Both are loaded with `await import(...)` inside the one command that needs them. Nothing fails
 * when someone converts either back to a top-level import -- the CLI still works, the suite stays
 * green, startup just silently gets ~10% slower again -- so the property is asserted here directly.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_SRC = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'cli.ts'), 'utf8')

/** Module specifiers whose cost must stay behind a dynamic import in cli.ts. */
const DEFERRED = ['./relay.js', './bash_runner.js']

describe('cli.ts defers the hook subsystem', () => {
  for (const spec of DEFERRED) {
    it(`does not statically import ${spec}`, () => {
      // Matches any top-level `import ... from '<spec>'` and the bare side-effect form, but not
      // `await import('<spec>')`, which is a call expression rather than an import statement.
      const staticImport = new RegExp(`^import\\s[^\\n]*['"]${spec.replace('.', '\\.')}['"]`, 'm')
      expect(staticImport.test(CLI_SRC), `cli.ts statically imports ${spec}`).toBe(false)
    })

    it(`loads ${spec} with a dynamic import`, () => {
      expect(CLI_SRC.includes(`await import('${spec}')`), `cli.ts never dynamically imports ${spec}`).toBe(true)
    })
  }

  it('cli_statusline.ts reads stdin via stdin_json.ts, not relay.ts', () => {
    const src = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'cli_statusline.ts'), 'utf8')
    expect(src).toContain("from './stdin_json.js'")
    expect(/^import\s[^\n]*['"]\.\/relay\.js['"]/m.test(src), 'cli_statusline.ts imports relay.js').toBe(false)
  })
})
