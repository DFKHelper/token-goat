/**
 * Reads the package names out of a Dependabot pull request body.
 *
 * Its own module rather than a function inside `refresh-dependabot-lock.mjs`, so a test can import it
 * without running the script. This is a wire format somebody else controls: if Dependabot restyles the
 * table the parse returns nothing, and a resolve that names no packages is indistinguishable from one
 * that had nothing to do, so the failure would be silence rather than an error.
 */

/** A grouped body carries one markdown row per package: `| [name](url) | `from` | `to` |`. The link target is skipped rather than parsed, since only the name is wanted. The two backticked version cells are what distinguish a package row from the header and the `| --- |` separator, so no separate header check is needed and none is kept: an explicit `!== 'Package'` test was here and survived being deleted, which is how it was found to be doing nothing. */
export function packageNamesFromBody(body) {
  const names = []
  for (const line of String(body ?? '').split('\n')) {
    const match = /^\|\s*\[?([^\]|[]+?)\]?(?:\([^)]*\))?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line.trim())
    if (match) names.push(match[1].trim())
  }
  return names
}
