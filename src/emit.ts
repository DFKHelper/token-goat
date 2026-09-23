/**
 * The two writers every command surface uses to put its result on stdout and its diagnostics on
 * stderr.
 *
 * Eight modules each held a byte-identical private copy of this pair, differing only in the name of
 * a local. That is not a formatting detail: `emit` is where the decision to strip ANSI lives, so a
 * copy that drifts is a command whose output is coloured when the rest of the CLI's is not, or that
 * writes escape bytes into a pipe. Keeping one definition makes that decision un-forkable.
 *
 * This is a leaf on purpose. It imports the two helpers it needs and nothing else, so no module can
 * reach a cycle through it -- a cycle here would break every command at once, and a cycle involving
 * a widely-imported module is the failure shape that typecheck and vitest both pass and only the
 * built bundle catches. Neither this file nor any of the eight it replaces is hashed into
 * PARSER_FINGERPRINT or EMBED_FINGERPRINT, so the fold bills no one a reparse or a re-embed.
 */

import { colorStdout, stripAnsiEscapes } from './render/ansi.js'
import { ensureNewline } from './util.js'

/** Write `text` to stdout, stripping ANSI when the stream is not a colour-capable terminal, and guaranteeing exactly one trailing newline. */
export function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsiEscapes(text)
  process.stdout.write(ensureNewline(payload))
}

/** Write `text` to stderr with a guaranteed trailing newline. Unlike {@link emit} it does not strip ANSI, which is how all eight copies this replaces behaved; stderr has no `colorStdout` equivalent gating it. */
export function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}
