/** Package executable. Thin shim over {@link run} in `cli.ts`. `run` sets `process.exitCode` rather than calling `process.exit()`, so we let the event loop drain naturally — this guarantees buffered stdout is flushed before the process ends, which a hard `exit()` can truncate on Windows pipes. A read-only command whose output goes to a pipe is offered to a resident server first (hook_client.ts), and the CLI is only loaded when none answers: loading it is most of what such a call costs, and a server has already paid for that once. */

import { runCliViaServer } from './hook_client.js'
import { installEpipeGuard } from './process_util.js'

// Must be installed before any output is produced: a consumer that closes early (`| head -2`) makes the very first large write fail with EPIPE, which is an unhandled 'error' event and a crash.
installEpipeGuard()

void runCliViaServer(process.argv).then(async (served) => {
  if (!served) await (await import('./cli.js')).run()
})
