/** The renames in `git diff --name-status -z -M` output; copy entries are dropped. */
export function parseNameStatus(data: Buffer): { from: string; to: string }[]
