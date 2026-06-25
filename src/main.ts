#!/usr/bin/env node
/**
 * Package executable. Thin shim over {@link run} in `cli.ts`.
 *
 * `run` sets `process.exitCode` rather than calling `process.exit()`, so we let
 * the event loop drain naturally — this guarantees buffered stdout is flushed
 * before the process ends, which a hard `exit()` can truncate on Windows pipes.
 */

import { run } from './cli.js'

void run()
