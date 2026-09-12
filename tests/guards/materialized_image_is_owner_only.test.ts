/**
 * Guard: every bridge that materializes a shrunk image into the shared temp directory writes it owner-only.
 *
 * The file is a copy of an image out of someone's workspace, and `os.tmpdir()` is world-readable on
 * a normal POSIX box, so a default-mode write publishes it to every account on the machine for as
 * long as it sits there. `vscode_hooks.ts` already passed `{ mode: 0o600 }`; the two sibling bridges
 * that grew the same materialize step did not, and nothing compared them.
 *
 * These two write sites live inside shim templates rather than in ordinary module code: the bridges
 * emit them as source text for another runtime to execute, so no unit test can call them and only
 * the text itself can be checked. That is exactly why they drifted from the handler that does have
 * a runtime test (`tests/vscode_image_path_confinement.test.ts` asserts the 0o600 mode on the real
 * written file), and why this guard reads the templates directly.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Every bridge source that carries a shim template writing a materialized image to the temp dir. */
const TEMPLATE_SOURCES = ['bridges/shrink_block.ts', 'bridges/pi.ts']

describe('a materialized shrunk image is written owner-only', () => {
  it('finds the write site in each bridge template rather than passing on an empty population', () => {
    // Both assertions below are "no unmoded write found", which an empty population satisfies just
    // as well as a correct one. If either template stops containing the write at all, that is a
    // rename this guard must report rather than quietly certify.
    const withoutWrite = TEMPLATE_SOURCES.filter((rel) => !fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').includes('writeFileSync(file, buf'))
    expect(
      withoutWrite,
      `these bridges no longer contain the materialized-image write this guard checks, so it is reading nothing: ${withoutWrite.join(', ')}`,
    ).toEqual([])
  })

  it('passes mode 0o600 at every such write', () => {
    const unprotected = TEMPLATE_SOURCES.filter((rel) => {
      const source = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
      return [...source.matchAll(/writeFileSync\(file, buf([^)]*)\)/g)].some((m) => !m[1]!.includes('0o600'))
    })
    expect(
      unprotected,
      'these write a copy of a workspace image into the shared temp directory at the default mode, ' +
        `which is world-readable on POSIX: ${unprotected.join(', ')}`,
    ).toEqual([])
  })
})
