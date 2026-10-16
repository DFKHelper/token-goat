/** A supervisor that dies before the shim has cleaned up must not leave its descendants running: the process group outlives its leader while any member runs, so the shim's cleanupFailed kills the group and not just the supervisor pid. Provenance: HAND-DERIVED. The entry kills its own supervisor with SIGKILL after starting a grandchild and writing that grandchild's pid, so the pid comes from the process that owns it and not from the shim's bookkeeping. POSIX only: the shim detaches the supervisor into its own group there, and Windows ownership is covered by copilot_session_start_tree.test.ts. */
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { cleanupTrees, readOwnedPid, runTreeShim, treeFixture } from '../helpers/copilot_session_start_tree.js'
import { processAlive as alive } from '../helpers/process_alive.js'

// Cleanup is synchronous process-table work, so no fixed wall-clock bound applies to it.
afterEach(cleanupTrees, 0)

it.skipIf(process.platform === 'win32')('kills the group when the supervisor dies before cleanup, so its grandchild does not survive', async () => {
  const fixture = treeFixture()
  const grandchildFile = join(fixture.root, 'grandchild.pid')
  const entry = join(fixture.root, 'entry.cjs')
  // The grandchild stays in the supervisor's group and ends on its own when the fixture directory is deleted, so a failed run cannot leave it behind cleanup.
  writeFileSync(entry, `
const fs = require('node:fs')
const cp = require('node:child_process')
const root = ${JSON.stringify(fixture.root)}
const idle = "const fs = require('node:fs'); setInterval(() => { if (!fs.existsSync(process.argv[1])) process.exit(0) }, 200)"
const grandchild = cp.spawn(process.execPath, ['-e', idle, root], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(grandchildFile)}, String(grandchild.pid))
process.kill(process.pid, 'SIGKILL')
`)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: 12_000 }).done
  const grandchild = readOwnedPid(grandchildFile)
  while (alive(grandchild)) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(result.stderr, 'the shim did not report the supervisor dying before cleanup').toMatch(/process-tree cleanup failed: supervisor exited before tree cleanup/)
})
