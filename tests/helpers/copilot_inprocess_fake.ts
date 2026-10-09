import fs from 'node:fs'
import path from 'node:path'

/** Options for {@link writeInProcessFake}: where to record the canonical payload and the event name, and what to answer. */
export interface InProcessFakeOptions {
  capturePath?: string
  argvPath?: string
  response?: string
}

/** Writes a fake token-goat entry into `cwd` and returns its path, to be passed to the Copilot CLI shim as argv[3]. The sibling `token-goat-hook.mjs` exports a `relayInProcess` that records the canonical payload and the event name, then answers `response` (default `{}`). That is the shim's in-process route (src/bridges/copilot_cli.ts tryInProcess), so a test using it never needs a child process to finish inside the shim's fixed 3000 ms spawn timeout. A token-goat.cmd on PATH did: cmd.exe, plus a second node for a capture, with process starts on a loaded Windows host taking from about 55 ms to several seconds; an overrun got the call killed, the shim wrote `{}` and the capture file never appeared. The payload translation under test is built before the route splits, so both routes record the same canonical object. Provenance: HAND-DERIVED from COPILOT_CLI_HOOK_SCRIPT (`timeout: 3000` on the spawn fallback; tryInProcess imports `token-goat-hook.mjs` beside the entry and calls `relayInProcess(tgEvent, canonical)`). */
export function writeInProcessFake(cwd: string, opts: InProcessFakeOptions = {}): string {
  const entryPath = path.join(cwd, 'fake-entry.js')
  fs.writeFileSync(entryPath, '', 'utf8')
  const recordPayload = opts.capturePath === undefined ? '' : `fs.writeFileSync(${JSON.stringify(opts.capturePath)}, JSON.stringify(canonical))`
  const recordEvent = opts.argvPath === undefined ? '' : `fs.writeFileSync(${JSON.stringify(opts.argvPath)}, event)`
  fs.writeFileSync(
    path.join(cwd, 'token-goat-hook.mjs'),
    `import fs from 'node:fs'\nexport async function relayInProcess(event, canonical) {\n  ${recordPayload}\n  ${recordEvent}\n  return ${JSON.stringify(opts.response ?? '{}')}\n}\n`,
    'utf8',
  )
  return entryPath
}
