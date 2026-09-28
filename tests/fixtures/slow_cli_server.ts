/** A real resident server for tests/hook_client_cli_wait.test.ts: src/hook_server.ts's runHookServer on slot 0, with its real socket, handshake and MAC, serving CLI requests through the real `run` from src/cli.ts behind a gate. Fixture provenance: HAND-DERIVED. The gate is this file's own and stands in for a command slower than the client's response timeout: it appends `start` to the file named by argv[2] when a command begins, holds the command until the file named by argv[3] exists, and appends `done` once `run` has returned. */
import * as fs from 'node:fs'

import { run } from '../../src/cli.js'
import { runHookServer } from '../../src/hook_server.js'

const [log, release] = process.argv.slice(2)
if (log === undefined || release === undefined) throw new Error('usage: slow_cli_server.ts <log file> <release file>')

void runHookServer(0, async (argv) => {
  fs.appendFileSync(log, 'start\n')
  while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20))
  await run(argv)
  fs.appendFileSync(log, 'done\n')
})
