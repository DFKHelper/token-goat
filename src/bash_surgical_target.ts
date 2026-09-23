/**
 * Resolves one real, runnable target inside a file the whole-file deny is about to block on.
 *
 * The deny is a hard block: the agent asked for the file, was refused, and the only thing it has
 * to go on is the sentence the refusal printed. That sentence named a placeholder --
 * `token-goat section "CHANGELOG.md::SectionHeading"`, `token-goat config-get "package.json"
 * KEY_NAME` -- so the agent's next move was to guess a name. Measured against the built binary on
 * 2026-09-21, the placeholders themselves do not run: `token-goat section
 * "CHANGELOG.md::SectionHeading"` exits 1 with "Section 'SectionHeading' not found", and
 * `token-goat config-get "package.json" KEY_NAME` exits 1 with "Key 'KEY_NAME' not found". A
 * refusal that hands back an unrunnable command spends the agent's next turn on syntax instead of
 * on the thing it wanted.
 *
 * One thing this is NOT, worth stating because the opposite was assumed here first and measured
 * false: it is not rescuing a near-miss guess. `section` resolves fuzzily, so `token-goat section
 * "CHANGELOG.md::Unreleased"` DOES succeed against a heading the index holds as `[Unreleased]`,
 * printing "redirected from". The gap being closed is placeholder-to-runnable, nothing wider.
 *
 * What this returns is a name the index actually holds for that file, so the command printed in
 * the refusal runs verbatim. It resolves nothing when the file is missing, unindexed, indexed
 * stale, or holds no name safe to quote -- in which case the caller keeps its existing
 * placeholder wording, which is no worse than before.
 *
 * Deliberately NOT a judgement about which name the agent wanted: it returns the file's first
 * indexed name in line order. The claim being made is "this command runs", not "this is the
 * section you meant", and the surrounding hint still points at `outline` for the whole list.
 *
 * Related but not a duplicate: hooks_read.ts::realSymbolReadHint answers the same question for the
 * Read hook's own deny sites and is left alone. It builds a whole sentence around `read
 * "file::Symbol"`, which is the right shape for a source file and the wrong one for the branches
 * this serves -- a markdown heading is indexed as a one-line symbol, so `read "file::Heading"`
 * returns the heading line rather than the section under it, and a config key is not a `read`
 * target at all. What is shared is the name lookup and escapeHintName, imported from there rather
 * than restated here.
 */
import { statSync } from 'node:fs'

import { resolveIndexPath } from './paths.js'
import { querySymbols } from './index_reader.js'
import { indexMatchesDisk } from './index_freshness.js'
import { escapeHintName } from './hooks_read.js'
import { commandPathIsTouchable } from './bash_extractors.js'
import type { HookEvent } from './hook_registry.js'

/** Every symbol in one file, never a page of them -- the first name in LINE order is wanted, and a page is ordered by whatever the query planner chose. Same sentinel and same reason as bash_range_savings.ts's own lookup. */
const ALL_SYMBOLS_IN_FILE = -1

/**
 * A name that cannot be pasted into the printed command unchanged is worse than no name: it turns
 * a placeholder the agent knows to replace into a broken command it has no reason to distrust.
 * escapeHintName does the quoting and refuses anything displaySafeText would rewrite -- a
 * token-goat marker, a control character -- which matters because the cd-stripped spelling of
 * these hints goes out on the context channel, and that channel does not fence its payload the way
 * the deny channel does. `::` is rejected on top of that: it is the spec separator itself, so a
 * name containing one re-splits the argument it was interpolated into.
 */
function quotableName(name: string): string | null {
  const safe = escapeHintName(name)
  return safe === '' || safe.includes('::') ? null : safe
}

/**
 * The first indexed name in `hintPath`, or null when no honest one is available.
 *
 * Null means "keep your placeholder", never "use an empty name". Staleness is checked for the same
 * reason bash_range_savings.ts checks it: a name from yesterday's index would be printed as a
 * command that runs today and returns the wrong thing, or nothing, which is the failure this
 * function exists to prevent rather than a smaller version of it.
 *
 * The path gate runs first and runs on the path AS WRITTEN, before resolveIndexPath, which is the
 * same ordering bash_extractors.ts's own touch sites use and is load-bearing rather than tidy: this
 * is a pre_tool_use path, so nothing has approved the command yet, and resolveIndexPath is itself an
 * fs call on Windows -- normalizePath expands an 8.3-shaped segment through realpathSync.native, so
 * resolving `\\host\share\PROGRA~1\x` first would already have dialled the host the gate exists to
 * refuse. `event` is optional for the same reason commandPathIsTouchable's is: a caller with no
 * event still gets the network half of the rule, only the workspace half needs one.
 */
export function runnableTargetFor(hintPath: string, cwd: string, event?: HookEvent): string | null {
  try {
    if (!commandPathIsTouchable(hintPath, event)) return null
    const resolved = resolveIndexPath(hintPath, cwd)
    if (!statSync(resolved).isFile()) return null
    if (!indexMatchesDisk(resolved)) return null
    const symbols = querySymbols({ filePath: resolved, limit: ALL_SYMBOLS_IN_FILE })
    if (symbols.length === 0) return null
    const inLineOrder = [...symbols].sort((a, b) => a.lineStart - b.lineStart)
    for (const s of inLineOrder) {
      const safe = quotableName(s.name)
      if (safe !== null) return safe
    }
    return null
  } catch {
    // Any failure to resolve a name is a reason to keep the placeholder, not to guess one.
    return null
  }
}
