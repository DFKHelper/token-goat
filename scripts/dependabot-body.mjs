import * as path from 'node:path'

/** The parts of `refresh-dependabot-lock.mjs` a test can reach. Their own module rather than functions inside the script, because that script runs on import: it resolves a lock file at the top level, so a test that imported it would perform the work instead of examining it. What lives here is what has a wrong answer worth catching -- reading somebody else's wire format, deciding a name is safe to put on a command line, and deciding a guard failed. */

/** npm's own grammar for a package name, which is the boundary that keeps a body off the command line. Names read out of a pull request reach `npm update`'s argument vector. They used to reach it through a shell, because npm on Windows is a `.cmd` and Node refuses to spawn one without `shell: true` (EINVAL, its mitigation for CVE-2024-27980), and with a shell arguments are concatenated rather than escaped -- Node says so itself in DEP0190 -- so a name of `lodash & whatever` ran `whatever`. {@link npmCommand} now spawns npm with no shell at all, and this check stays the boundary: it is what held while the shell was there, and what keeps a name from reading as an option. This repository is public, a fork's branch name and body are both chosen by whoever opens the pull request, and the branch filter only asks that the name begins `dependabot/npm_and_yarn/`, so the body is attacker-controlled input. Measured, not assumed: a crafted name wrote a file of the attacker's choosing before this existed. The grammar contains no shell metacharacter -- no space, quote, backtick, `&`, `|`, `;`, `$`, `<` or `>` -- so validating against it closes the shell hole at the boundary rather than trying to quote past it. That was the whole of this function's first version, and it was not enough: the shell is one consumer of that argument vector and npm's own option parser is another. npm's published grammar allows a name to begin `-` or `~`, so `--before` and `--force` were accepted as package names and arrived as flags. Measured: a body naming `--before` and `2099-12-31` produced `npm update --before=<cutoff> --before 2099-12-31 zod`, and npm honours the later one, which erases the supply-chain cooldown that is this script's entire reason to exist. So the check is deliberately narrower than npm's grammar: a leading `-` or `~` is refused. Nothing on the registry needs one, a leading `~` would additionally undergo tilde expansion if this ever ran through a POSIX shell, and being unable to distinguish an operand from an option is the defect itself. */
export function isValidPackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false
  if (name.startsWith('-') || name.startsWith('~')) return false
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
}

/** A grouped body carries one markdown row per package, the name cell optionally a link. The link target is skipped rather than parsed, since only the name is wanted. The two backticked version cells are what distinguish a package row from the header and the separator rule, so no separate header check is needed and none is kept: an explicit `!== 'Package'` test was here and survived being deleted, which is how it was found to be doing nothing. Only the first contiguous run of rows is taken, and that bound is the security-relevant part. A Dependabot body does not stop at its summary table: it goes on to embed each dependency's release notes and changelog, which are written by whoever owns that dependency. Dependabot renders that upstream markdown to HTML, so an upstream table becomes `<table>` and cannot match here -- but a fenced code block becomes `<pre><code>`, and the lines inside it keep their leading pipe. Measured: a body whose summary table named only `zod`, followed by a release note carrying a code block with two table-shaped lines, parsed as `['zod', 'evil-package', 'another-one']`. That would hand `npm update` packages no maintainer reviewed and Dependabot never proposed, on the say-so of a dependency's release notes. The summary table is contiguous and comes first, so stopping at the first gap is both the shape of the real document and the whole of the fix. */
export function packageNamesFromBody(body) {
  const names = []
  for (const line of String(body ?? '').split('\n')) {
    const match = /^\|\s*\[?([^\]|[]+?)\]?(?:\([^)]*\))?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line.trim())
    if (match) names.push(match[1].trim())
    else if (names.length > 0) break
  }
  return names.length > 0 ? names : packageNamesFromUpdateLines(body)
}

/** A grouped batch of only a few packages carries no summary table at all: DFKHelper/token-goat#40, two packages, opens with `Bumps the npm-dependencies group with 2 updates` and then gives each package an `Updates \`name\` from A to B` line followed by its release notes, changelog and commits, each in its own `<details>` block. Only lines outside every `<details>` block are read, for the reason the table parse stops at its first gap: everything inside one is upstream text, and a `<pre><code>` block there keeps its lines verbatim, so a release note could carry an `Updates` line of its own. The count in the opening sentence is then required to match, so a body that says two and yields three, or one, is refused rather than resolved. */
function packageNamesFromUpdateLines(body) {
  const text = String(body ?? '')
  const declared = /^Bumps the \S+ group with (\d+) updates?\b/.exec(text)
  if (!declared) return []
  const names = []
  let depth = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const match = depth === 0 ? /^Updates `([^`]+)` from \S+ to \S+$/.exec(trimmed) : null
    if (match) names.push(match[1])
    depth += (trimmed.match(/<details>/g) ?? []).length - (trimmed.match(/<\/details>/g) ?? []).length
  }
  return names.length === Number(declared[1]) ? names : []
}

/** Turns a failed guard run into a message, and never into an empty one. The caller treats a falsy return as the guard having passed, so every path out of here has to be truthy. The first draft returned only the assertion lines, which is fine when vitest ran and reported: when it did not run at all -- a config error, a missing binary, an out-of-memory kill -- nothing matched, it returned the empty string, and the script announced that the disclosure guard accepted the lock file. A guard that could not run is not a guard that passed. */
export function summarizeGuardFailure(error) {
  const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  const assertions = output.split('\n').filter((line) => /AssertionError|FAIL|expected/.test(line)).slice(0, 6).join('\n')
  if (assertions) return assertions
  const tail = output.split('\n').filter((line) => line.trim()).slice(-6).join('\n')
  return `the guard did not report a result; it exited ${error?.status ?? 'abnormally'}${tail ? `:\n${tail}` : ' with no output'}`
}

/** True when an entry from `gh pr list --json number,title,headRefName,author,isCrossRepository` is genuinely Dependabot's. A branch name is not an identity. This repository is public, so anyone may open a pull request from a fork on a branch called `dependabot/npm_and_yarn/anything` and write whatever package table they like in the body -- and the body is what decides which packages get resolved. So the author has to be the Dependabot app and the head branch has to live in this repository. Exported rather than left inline so a test can run it against real `gh` output: a check that only reads the script's source for the right field names passes just as happily when the field names are wrong. */
export function isDependabotPullRequest(pr) {
  return Boolean(pr) && typeof pr.headRefName === 'string' && pr.headRefName.startsWith('dependabot/npm_and_yarn/') && pr.author?.login === 'app/dependabot' && pr.isCrossRepository === false
}

/** How to run npm with no shell in between: through the running Node, on npm's own `npm-cli.js`. Node will not spawn npm's Windows `.cmd` wrapper without `shell: true` (EINVAL, its mitigation for CVE-2024-27980), and with a shell the arguments are concatenated rather than escaped, which is what DEP0190 warned about on every run of this script. `npm run` names the npm it runs as in `npm_execpath`; only npm's own entry is taken from it, since pnpm and yarn set the same variable to their own. A Windows Node install carries npm beside it, and anywhere else `npm` is an executable the platform spawns directly. Null when none of those is found, which is a reason to stop rather than to fall back to a shell. */
export function npmCommand({ platform, env, execPath, exists }) {
  const named = env.npm_execpath
  if (typeof named === 'string' && /(?:^|[\\/])npm-cli\.js$/.test(named) && exists(named)) return { file: execPath, prefix: [named] }
  if (platform !== 'win32') return { file: 'npm', prefix: [] }
  const bundled = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return exists(bundled) ? { file: execPath, prefix: [bundled] } : null
}
