/**
 * Intent-based suggestions for command names that don't exist.
 *
 * Commander already prints its own `(Did you mean X?)` line, but that suggestion is pure edit
 * distance over the registered names, so it fires on spelling slips and misfires badly on a
 * *conceptual* miss. `token-goat search foo` -- probably the single most natural name to reach for
 * -- resolves to `(Did you mean arch?)`, pointing at the import-graph analyser, which has nothing to
 * do with searching. An agent that follows that suggestion wastes a call and learns the wrong model
 * of the CLI.
 *
 * These are the names a caller reaches for when they know what they *want* but not what it's
 * called. Every key here is verified absent from the registered command set: this module never
 * shadows a real command, it only annotates a failure that has already happened. Commander's own
 * output is left untouched -- the hint is appended after it.
 */

/**
 * Wrong names grouped by the intent behind them, each mapped to the commands that actually serve it.
 * Kept deliberately small: a guess list long enough to need maintenance is one that will drift out of
 * sync with the real commands, and a wrong hint is worse than none.
 */
const INTENT_SUGGESTIONS: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    ['search', 'lookup', 'query'],
    "`grep <pattern>` for literal text, `semantic \"<description>\"` to search by concept, or `symbol <name>` to find a definition by name",
  ],
  [
    ['cat', 'show', 'view', 'open', 'print', 'display'],
    '`read "<file>::<symbol>"` for one symbol, `section "<file>::<heading>"` for one heading, or `outline <file>` for the shape of a whole file',
  ],
  [
    ['def', 'definition', 'goto', 'declaration'],
    '`symbol <name>` to locate a definition, or `read "<file>::<symbol>"` to print its body',
  ],
  [
    ['usages', 'references', 'whocalls', 'callsites'],
    '`refs <file>::<symbol>` for every reference, or `callers <symbol>` for the functions that call it',
  ],
  [
    ['tree', 'ls', 'list', 'files'],
    '`map --compact` to orient in a repo, or `outline <file>` / `skeleton <file>` for one file',
  ],
  [
    ['summary', 'summarize', 'describe', 'explain'],
    '`brief "<file>::<symbol>"` for one symbol, `map --compact` for a project, or `commands` to list everything this CLI can do',
  ],
]

/**
 * The intent hint for an unknown command name, or null when there is nothing better to say than
 * commander's own edit-distance guess. Matching is case-insensitive because an agent writing
 * `token-goat Search` has made the same conceptual miss as one writing `search`.
 */
export function suggestForUnknownCommand(name: string): string | null {
  const needle = name.trim().toLowerCase()
  if (needle === '') return null
  for (const [names, suggestion] of INTENT_SUGGESTIONS) {
    if (names.includes(needle)) return suggestion
  }
  return null
}

/**
 * The command name commander tried to resolve: the first bare argv entry after the node binary and
 * the script path. Skips leading flags (`token-goat --foo search`) and anything that looks like a
 * flag value, so the hint keys on the same token commander rejected. Returns null when argv carries
 * no command at all.
 */
export function attemptedCommandName(argv: readonly string[]): string | null {
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}
