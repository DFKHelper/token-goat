/**
 * Package executable. Thin shim over {@link run} in `cli.ts`.
 *
 * `run` sets `process.exitCode` rather than calling `process.exit()`, so we let
 * the event loop drain naturally — this guarantees buffered stdout is flushed
 * before the process ends, which a hard `exit()` can truncate on Windows pipes.
 */

import { run } from './cli.js'
import { installEpipeGuard } from './util.js'

// Must be installed before any output is produced: a consumer that closes early (`| head -2`) makes
// the very first large write fail with EPIPE, which is an unhandled 'error' event and a crash.
installEpipeGuard()

void run()
