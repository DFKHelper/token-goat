/**
 * `TEXT_FILE_TYPE_EXTS`/`BINARY_FILE_TYPE_EXTS` in src/hooks_read.ts decide whether a read even
 * reaches `dispatchFileTypeHandler`. Their comment calls them the single source of truth mirroring
 * that dispatcher's own split, and until this guard existed nothing held them to it: `.svg` and
 * `.xml` were routed by the dispatcher to handlers with 8 KB and 20 KB thresholds while the gate
 * omitted both, so neither threshold was reachable below the 100 KB generic catch-all, and by then
 * the catch-all would have fired anyway. The whole suite stayed green because every test for those
 * handlers called them directly, which supplies precisely the routing the shipping path omits.
 *
 * This is the drift check rather than a behavior test: tests/file_type_dispatch_reaches_hook.test.ts
 * proves the two extensions that were broken now fire through `preReadHandler`, and this file proves
 * the *next* handler added to the dispatcher cannot be silently unreachable in the same way. It
 * deliberately reads both lists out of source rather than importing them, because the sets are
 * module-private and exporting them purely for a test would widen the module's surface to satisfy
 * the guard rather than the product.
 *
 * Markdown is excluded on purpose: `dispatchFileTypeHandler` returns null for md/mdx/markdown/rst
 * so the caller skips the result, which means those extensions are handled upstream and genuinely
 * do not belong in the gate.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.resolve('src')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8')
}

/**
 * Extensions `dispatchFileTypeHandler` routes on, read out of its own body. Covers both shapes it
 * uses: `ext === 'pdf'` and `['odt', 'ods'].includes(ext)`. The md/rst early return is dropped
 * because it returns null rather than dispatching.
 */
function dispatchedExtensions(): string[] {
  const source = readSource(path.join('hints', 'file_type_handler.ts'))
  const start = source.indexOf('export function dispatchFileTypeHandler')
  expect(start, 'dispatchFileTypeHandler was not found in src/hints/file_type_handler.ts; this guard scans by name and a rename makes it scan nothing').toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n}', start))

  const found = new Set<string>()
  for (const m of body.matchAll(/ext === '([a-z0-9]+)'/g)) if (m[1]) found.add(m[1])
  for (const m of body.matchAll(/\[([^\]]*)\]\.includes\(ext\)/g)) {
    for (const lit of (m[1] ?? '').matchAll(/'([a-z0-9]+)'/g)) if (lit[1]) found.add(lit[1])
  }
  // Handled upstream: the dispatcher returns null for these rather than producing a result.
  for (const upstream of ['md', 'mdx', 'markdown', 'rst']) found.delete(upstream)
  return [...found].sort()
}

/** The union the read hook gates on, read out of the two Set literals in src/hooks_read.ts. */
function gatedExtensions(): string[] {
  const source = readSource('hooks_read.ts')
  const found = new Set<string>()
  for (const name of ['BINARY_FILE_TYPE_EXTS', 'TEXT_FILE_TYPE_EXTS']) {
    const m = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`))
    expect(m, `${name} was not found as a Set literal in src/hooks_read.ts; this guard reads it from source, so a change in shape must be reflected here rather than silently emptying the comparison`).not.toBeNull()
    for (const lit of (m?.[1] ?? '').matchAll(/'([a-z0-9]+)'/g)) if (lit[1]) found.add(lit[1])
  }
  return [...found].sort()
}

describe('every file type the dispatcher handles is one the read hook lets through to it', () => {
  it('routes each dispatched extension through the hook gate', () => {
    // Both anchors are extensions whose handlers carry a threshold well under the 100 KB generic
    // gate, which is the condition that makes an omission invisible rather than merely wrong.
    const dispatched = pinnedPopulation({
      what: 'extensions dispatchFileTypeHandler routes to a handler',
      items: dispatchedExtensions(),
      floor: 15,
      mustInclude: ['svg', 'xml', 'csv', 'pdf'],
    })
    const gated = new Set(gatedExtensions())

    const unreachable = dispatched.filter((ext) => !gated.has(ext))
    expect(
      unreachable,
      `dispatchFileTypeHandler routes ${unreachable.join(', ')} to a handler, but BINARY_FILE_TYPE_EXTS/` +
        `TEXT_FILE_TYPE_EXTS in src/hooks_read.ts do not list them, so a read of one never reaches the ` +
        `dispatcher until it is already past FILE_TYPE_THRESHOLDS.generic (100 KB) and the catch-all ` +
        `would have handled it regardless. The handler's own threshold is dead. Add the extension to ` +
        `the matching set, or, if it really is meant to be reachable only as a large generic file, say ` +
        `so beside the handler.`,
    ).toEqual([])
  })

  it('gates nothing the dispatcher has no handler for, so the two lists stay a mirror rather than a superset', () => {
    const dispatched = new Set(dispatchedExtensions())
    const orphaned = gatedExtensions().filter((ext) => !dispatched.has(ext))
    expect(
      orphaned,
      `src/hooks_read.ts gates ${orphaned.join(', ')} into dispatchFileTypeHandler, which has no branch ` +
        `for them and will fall through to handleGenericLarge. That is the catch-all applied under a ` +
        `type-specific name: either give the type a handler or drop it from the set.`,
    ).toEqual([])
  })
})
