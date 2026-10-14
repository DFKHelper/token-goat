/** HAND-DERIVED: a start whose payload arrived but whose deadline passed before the shim read it is still stamped begun, so the first tool call delivers the reminder once. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { assertOwedDeliveredOnce, BUNDLE, cleanupTrees, runTreeShim, startBegan, treeFixture } from '../helpers/copilot_session_start_tree.js'

afterEach(cleanupTrees, 0)

it('stamps a start whose payload is in the pipe after the deadline passed, then defers it to the first tool call', async () => {
  const fixture = treeFixture()
  // The unmodified shim: its budget runs from process birth, which the preload overruns before a line of the shim executes.
  writeFileSync(fixture.shim, COPILOT_CLI_HOOK_SCRIPT)
  const spin = join(fixture.root, 'spin.cjs')
  const flushed = join(fixture.root, 'payload.flushed')
  // The preload holds the shim until the test has flushed the payload into the pipe and 3.5 s have passed, so the order is fixed by the test and not by how loaded the machine is.
  writeFileSync(spin, `const fs = require('node:fs')\nconst born = Date.now()\nwhile (!fs.existsSync(${JSON.stringify(flushed)}) || Date.now() < born + 3500) {}\n`)
  const sessionId = 'late-payload'
  const run = runTreeShim({
    fixture, entry: BUNDLE, quietLimitMs: 30_000, nodeArgs: ['--require', spin], endInput: false,
    payload: { sessionId, workingDirectory: fixture.project },
  })
  // Writes complete in order, so this whitespace (allowed after the object) calling back means the payload before it is in the pipe.
  await new Promise<void>((resolve, reject) => run.child.stdin.write(' ', (error) => { if (error) reject(error); else resolve() }))
  writeFileSync(flushed, 'yes')
  const result = await run.done
  expect(result.stdout, result.stderr).toBe('{}')
  expect(result.stderr).toMatch(/SessionStart failed open/)
  expect(startBegan(fixture, sessionId), 'the payload was read, so the start must be stamped begun').toBe(true)
  const delivered = await assertOwedDeliveredOnce(fixture, 'copilot_cli', sessionId)
  expect(delivered).not.toBeNull()
})
