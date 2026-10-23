import type { GitResult } from '../../src/types.js'

// Canned answers for the two git calls that fingerprint a repository (src/bash_output_cache.ts::gitStateFingerprintSync) and for the three file listings the nested-skill scan reads (src/claude_hidden_rules.ts::scanGitCheckout), so a row that asserts what the hook does with a known repository state never waits on a real git finishing inside its time bound. Any other git call is left to the real runGit under its default bound, untouched.

// Provenance: CAPTURE. git version 2.53.0.windows.1, in a scratch repository built the way tests/helpers/git-repo.ts builds its fixture (`git init`, `a.txt` holding `one\n`, `git add .`, one commit with GIT_AUTHOR_DATE and GIT_COMMITTER_DATE set to FIXTURE_COMMIT_DATE, user t <t@t.t>): `git rev-parse --show-toplevel HEAD` printed the repository root, a newline, this sha and a newline.
export const CAPTURED_HEAD = '32ba05faacf1c3dc7aed01ce1e67d38e6e89f51d'

// Provenance: HAND-DERIVED. Any 40-hex sha other than CAPTURED_HEAD stands for the head after a second commit lands; only its difference from CAPTURED_HEAD matters to a row.
export const SECOND_HEAD = '0123456789abcdef0123456789abcdef01234567'

// Provenance: CAPTURE. Same scratch repository and git version as CAPTURED_HEAD: `git status --porcelain -z --untracked-files=all` printed nothing on the clean tree, ` M a.txt` plus a NUL after `a.txt` once a.txt held `two\n`, and that entry followed by `?? b.txt` plus a NUL once an untracked b.txt existed.
export const STATUS_CLEAN = ''
export const STATUS_A_MODIFIED = ' M a.txt\0'

// Provenance: HAND-DERIVED. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node ETIMEDOUT CAPTURE documented at src/util.ts::runGit).
export const KILLED_GIT: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, unfinished: true, timedOut: true }

// Provenance: CAPTURE. git version 2.53.0.windows.1, in a scratch directory with no repository above it: `git rev-parse --show-toplevel HEAD` and `git status --porcelain -z --untracked-files=all` each printed `fatal: not a git repository (or any of the parent directories): .git` on stderr, nothing on stdout, and exited 128.
export const NOT_A_REPOSITORY: GitResult = { stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', unfinished: false, exitCode: 128 }

// Provenance: CAPTURE. Same scratch repository and git version as CAPTURED_HEAD: `git ls-files -z -s` printed `100644 5626abf0f72e58d7a153368ba57db4c673c0e171 0`, a tab, `a.txt` and a NUL; `git ls-files -z -o --exclude-standard` and `git ls-files -z -o -i --exclude-standard --directory` printed nothing.
const LISTING_TRACKED = '100644 5626abf0f72e58d7a153368ba57db4c673c0e171 0\ta.txt\0'

/** The repository state the canned answers describe, and how many fingerprint calls they have served (a row that wants proof the seam is live reads `served`). `repository` false answers the fingerprint calls as git does outside any repository. */
export interface CannedGit {
  head: string
  status: string
  served: number
  repository: boolean
}

export function cannedGit(): CannedGit {
  return { head: CAPTURED_HEAD, status: STATUS_CLEAN, served: 0, repository: true }
}

/** The canned state of a directory that is in no repository. */
export function cannedNoRepository(): CannedGit {
  return { ...cannedGit(), repository: false }
}

/** The canned answer for a fingerprint call, or null for any other git call. `cwd` stands for the repository root, which the real `rev-parse --show-toplevel` prints. */
export function cannedFingerprintAnswer(state: CannedGit, cwd: string | undefined, args: readonly string[]): GitResult | null {
  const argv = args.join(' ')
  if (argv === 'rev-parse --show-toplevel HEAD') {
    state.served += 1
    if (!state.repository) return NOT_A_REPOSITORY
    return { stdout: `${cwd ?? ''}\n${state.head}\n`, stderr: '', unfinished: false, exitCode: 0 }
  }
  if (argv === 'status --porcelain -z --untracked-files=all') {
    state.served += 1
    if (!state.repository) return NOT_A_REPOSITORY
    return { stdout: state.status, stderr: '', unfinished: false, exitCode: 0 }
  }
  return null
}

/** The canned answer for one of the three listings the nested-skill scan takes of a checkout that holds one tracked file and nothing else, or null for any other git call. That file is no skill, command or agent, so the scan finds nothing to read. */
export function cannedSkillListing(args: readonly string[]): GitResult | null {
  const argv = args.join(' ')
  if (argv === 'ls-files -z -s') return { stdout: LISTING_TRACKED, stderr: '', unfinished: false, exitCode: 0 }
  if (argv === 'ls-files -z -o --exclude-standard' || argv === 'ls-files -z -o -i --exclude-standard --directory') return { stdout: '', stderr: '', unfinished: false, exitCode: 0 }
  return null
}
