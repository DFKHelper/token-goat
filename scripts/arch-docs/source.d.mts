/** The renames in `git diff --name-status -z -M` output; copy entries are dropped. */
export function parseNameStatus(data: Buffer): { from: string; to: string }[]

/** The work tree root of the repository holding `cwd`, read from the filesystem for a plain repository and from git otherwise. */
export function repoRoot(cwd: string): string
