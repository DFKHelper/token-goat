/**
 * The parts of `refresh-dependabot-lock.mjs` a test can reach.
 *
 * Their own module rather than functions inside the script, because that script runs on import: it
 * resolves a lock file at the top level, so a test that imported it would perform the work instead of
 * examining it. What lives here is what has a wrong answer worth catching -- reading somebody else's
 * wire format, deciding a name is safe to put on a command line, and deciding a guard failed.
 */

/**
 * npm's own grammar for a package name, which is the boundary that keeps a body off the command line.
 *
 * Names read out of a pull request reach `npm update` through a shell, because npm on Windows is a
 * `.cmd` and Node refuses to spawn one without `shell: true` (EINVAL, its mitigation for
 * CVE-2024-27980). With a shell, arguments are concatenated rather than escaped -- Node says so itself
 * in DEP0190 -- so a name of `lodash & whatever` runs `whatever`. This repository is public, a fork's
 * branch name and body are both chosen by whoever opens the pull request, and the branch filter only
 * asks that the name begins `dependabot/npm_and_yarn/`, so the body is attacker-controlled input.
 * Measured, not assumed: a crafted name wrote a file of the attacker's choosing before this existed.
 *
 * The grammar contains no shell metacharacter -- no space, quote, backtick, `&`, `|`, `;`, `$`, `<` or
 * `>` -- so validating against it closes the shell hole at the boundary rather than trying to quote
 * past it. That was the whole of this function's first version, and it was not enough: the shell is
 * one consumer of that argument vector and npm's own option parser is another. npm's published
 * grammar allows a name to begin `-` or `~`, so `--before` and `--force` were accepted as package
 * names and arrived as flags. Measured: a body naming `--before` and `2099-12-31` produced
 * `npm update --before=<cutoff> --before 2099-12-31 zod`, and npm honours the later one, which erases
 * the supply-chain cooldown that is this script's entire reason to exist. So the check is deliberately
 * narrower than npm's grammar: a leading `-` or `~` is refused. Nothing on the registry needs one, a
 * leading `~` would additionally undergo tilde expansion if this ever ran through a POSIX shell, and
 * being unable to distinguish an operand from an option is the defect itself.
 */
export function isValidPackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false
  if (name.startsWith('-') || name.startsWith('~')) return false
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
}

/** A grouped body carries one markdown row per package: `| [name](url) | `from` | `to` |`. The link target is skipped rather than parsed, since only the name is wanted. The two backticked version cells are what distinguish a package row from the header and the `| --- |` separator, so no separate header check is needed and none is kept: an explicit `!== 'Package'` test was here and survived being deleted, which is how it was found to be doing nothing. */
export function packageNamesFromBody(body) {
  const names = []
  for (const line of String(body ?? '').split('\n')) {
    const match = /^\|\s*\[?([^\]|[]+?)\]?(?:\([^)]*\))?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line.trim())
    if (match) names.push(match[1].trim())
  }
  return names
}

/**
 * Turns a failed guard run into a message, and never into an empty one.
 *
 * The caller treats a falsy return as the guard having passed, so every path out of here has to be
 * truthy. The first draft returned only the assertion lines, which is fine when vitest ran and
 * reported: when it did not run at all -- a config error, a missing binary, an out-of-memory kill --
 * nothing matched, it returned the empty string, and the script announced that the disclosure guard
 * accepted the lock file. A guard that could not run is not a guard that passed.
 */
export function summarizeGuardFailure(error) {
  const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  const assertions = output.split('\n').filter((line) => /AssertionError|FAIL|expected/.test(line)).slice(0, 6).join('\n')
  if (assertions) return assertions
  const tail = output.split('\n').filter((line) => line.trim()).slice(-6).join('\n')
  return `the guard did not report a result; it exited ${error?.status ?? 'abnormally'}${tail ? `:\n${tail}` : ' with no output'}`
}
