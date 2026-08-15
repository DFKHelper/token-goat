/**
 * Guard: the built bundle must not load a heavy optional dependency just to start.
 *
 * `cli.ts` defers the MCP server behind `await import('./mcp_server.js')` and its comment says
 * that keeps `@modelcontextprotocol/sdk` off the startup path. It did not. The bundle is a single
 * file, so esbuild inlines `mcp_server.ts` into it and hoists that module's static `import` of an
 * external package to the top of the bundle, where ESM evaluates it before any code runs. A lazy
 * import of a local module does nothing for the external packages that module imports.
 *
 * The cost was 154 module file loads and ~140ms on every single invocation of the binary --
 * `token-goat --version`, every hook Claude Code fires on every tool call, every test that spawns
 * the bundle -- to serve the one command that is an MCP server. Nothing failed, because nothing
 * asserted what startup loads; the only statement of intent was a comment, and a comment cannot go
 * red. So this asserts it against the real artifact instead.
 *
 * If this fails, find the static `import` of the named package and move it inside the function
 * that needs it. Do not relax the list: every entry here is a package no trivial command needs.
 */
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { BUNDLE } from '../helpers/bundle.js'

// Packages that only one command or code path needs, and that cost real time to evaluate.
// ajv/ajv-formats are transitive through the MCP SDK and are listed because they are the bulk of
// the file loads, so a regression naming them is easier to read than one naming only the SDK.
const MUST_NOT_LOAD = ['@modelcontextprotocol', 'ajv', 'ajv-formats', 'zod', 'jsonc-parser']

/** Every node_modules file the bundle loads while running `args`, via Node's own module tracing. */
function startupModuleLoads(args: string[]): string[] {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_DEBUG: 'module' },
    timeout: 60000,
  })
  expect(res.status, `bundle exited ${String(res.status)} running ${args.join(' ')}`).toBe(0)
  const loads: string[] = []
  for (const line of (res.stderr ?? '').split(/\r?\n/)) {
    if (!line.includes('load "')) continue
    const match = /node_modules[\\/]+((?:@[^\\/"]+[\\/]+)?[^\\/"]+)/.exec(line)
    if (match?.[1] !== undefined) loads.push(match[1].replace(/[\\/]+/g, '/'))
  }
  return loads
}

describe('built bundle startup', () => {
  // --version is the floor: it does nothing at all, so anything loaded here is loaded by every
  // command in the binary, including the hooks that fire on every tool call.
  it('does not load MCP, schema-validation, or JSONC dependencies just to print --version', () => {
    const loaded = new Set(startupModuleLoads(['--version']))
    const offenders = MUST_NOT_LOAD.filter((pkg) => [...loaded].some((l) => l === pkg || l.startsWith(`${pkg}/`)))
    expect(offenders, `these load on every invocation of the binary: ${offenders.join(', ')}`).toEqual([])
  })

  // A real read command, so the guard cannot be satisfied by a --version fast path that skips the
  // work every other command does.
  it('does not load them for an ordinary read command either', () => {
    const loaded = new Set(startupModuleLoads(['outline', 'src/util.ts']))
    const offenders = MUST_NOT_LOAD.filter((pkg) => [...loaded].some((l) => l === pkg || l.startsWith(`${pkg}/`)))
    expect(offenders, `these load for a plain read: ${offenders.join(', ')}`).toEqual([])
  })

  // Bounds the whole class rather than the packages that happened to regress: a new heavy static
  // import shows up as a jump here even when it is not on the list above. Measured at 13 after the
  // fix and 154 before it, so this has room to breathe without being decorative.
  it('loads few enough modules at startup that a new eager dependency is visible', () => {
    const count = startupModuleLoads(['--version']).length
    expect(count, `startup loaded ${count} node_modules files; it was 154 before the eager MCP SDK import was fixed`).toBeLessThan(40)
  })
})
