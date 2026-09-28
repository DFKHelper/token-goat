/** A real resident server for tests/hook_client_held_slots.test.ts: src/hook_server.ts's runHookServer on the slot named by argv[2], with its real socket, handshake and MAC, serving CLI requests through the real `run` from src/cli.ts. Fixture provenance: HAND-DERIVED. The `hold` command is this file's own and stands in for a hook or command doing synchronous work (a tree-sitter parse, a SQLite query): it appends `hold <slot>` to the file named by argv[3] and then blocks the event loop, never yielding, until the file named by argv[4] exists, which is the state in which a real server cannot read a new caller's hello. Every other command runs for real and appends `run <slot>` once it returns. */
import * as fs from 'node:fs'

import { run } from '../../src/cli.js'
import { runHookServer } from '../../src/hook_server.js'

const [slotArg, log, release] = process.argv.slice(2)
if (slotArg === undefined || log === undefined || release === undefined) throw new Error('usage: held_cli_server.ts <slot> <log file> <release file>')
const slot = Number(slotArg)
const nap = new Int32Array(new SharedArrayBuffer(4))

void runHookServer(slot, async (argv) => {
  if (argv[2] === 'hold') {
    fs.appendFileSync(log, `hold ${slot}\n`)
    while (!fs.existsSync(release)) Atomics.wait(nap, 0, 0, 10)
    return
  }
  await run(argv)
  fs.appendFileSync(log, `run ${slot}\n`)
})
