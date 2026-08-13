/**
 * Guard against the "handler forwards the caller's projectRoot instead of the validated root" class.
 *
 * Every MCP tool handler in `src/mcp_server.ts` resolves the caller-supplied `projectRoot` through
 * `resolveToolRoot` into a local `root`, then confines the requested targets against that `root`.
 * The confinement verdict is only meaningful if the command it guards is then run against the SAME
 * root. The `section` handler forwarded the raw, possibly-undefined caller value instead
 * (`...(projectRoot !== undefined ? { projectRoot } : {})`), so a relative spec was resolved against
 * a root the gate never validated -- content outside the confined root could be returned even though
 * `confineTargets` had approved a different path. Eleven sibling handlers passed `projectRoot: root`
 * correctly; `section` was the lone outlier, which is exactly the shape that survives review.
 *
 * A one-line fix closes the instance. This guard closes the class: it fails if ANY handler in the
 * file reintroduces the raw-forward form, so the next handler added cannot quietly repeat it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

describe('mcp handlers use the gate-validated root', () => {
  it('no handler forwards the caller-supplied projectRoot instead of the validated root', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp_server.ts'), 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((e) => /projectRoot\s*!==\s*undefined\s*\?\s*\{\s*projectRoot\s*\}/.test(e.line))

    expect(
      offenders.map((o) => `src/mcp_server.ts:${o.no}: ${o.line}`),
      offenders.length === 0
        ? ''
        : 'An MCP handler forwards the caller-supplied projectRoot instead of the `root` returned by ' +
          'resolveToolRoot. The confinement gate validates targets against `root`, so running the ' +
          'command against a different root makes that verdict meaningless and can return content ' +
          'from outside the confined root. Pass `projectRoot: root` as every sibling handler does.',
    ).toEqual([])
  })

  it('the validated-root form is actually present, so the guard cannot pass vacuously', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp_server.ts'), 'utf8')
    const validated = src.match(/projectRoot:\s*root\b/g) ?? []
    expect(validated.length, 'No handler passes `projectRoot: root`, so the guard above would pass against a file that lost the pattern entirely -- check src/mcp_server.ts still wires handlers this way.').toBeGreaterThan(5)
  })
})
