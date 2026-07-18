/**
 * Surgical GitHub PR reads via the `gh` CLI.
 *
 * `gh pr view`/`gh pr diff`/`gh api .../pulls/N/comments` each return a payload that can be
 * huge (a large diff, dozens of review comments, a long description) when an agent only needs
 * one slice of it. This module fetches and formats exactly one slice -- changed files, one
 * file's diff, review comments, or description/metadata -- mirroring json_query.ts's and
 * openapi_query.ts's "extract one thing instead of the whole document" shape, except the
 * source document here is `gh` subprocess output instead of a local file.
 *
 * `gh` availability/auth are cached per-process the same way video_chapters.ts caches
 * ffprobe's availability -- a single spawnSync probe, reused for the life of the process.
 */

import { spawnSync } from 'node:child_process'

let _ghAvailable: boolean | undefined

/** True when `gh` (the GitHub CLI) is present on PATH. Cached per-process. */
export function isGhAvailable(): boolean {
  if (_ghAvailable !== undefined) return _ghAvailable
  try {
    const res = spawnSync('gh', ['--version'], { stdio: 'ignore' })
    _ghAvailable = res.status === 0
  } catch {
    _ghAvailable = false
  }
  return _ghAvailable
}

let _ghAuthenticated: boolean | undefined

/** True when `gh auth status` reports an authenticated session. Cached per-process. */
export function isGhAuthenticated(): boolean {
  if (_ghAuthenticated !== undefined) return _ghAuthenticated
  try {
    const res = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
    _ghAuthenticated = res.status === 0
  } catch {
    _ghAuthenticated = false
  }
  return _ghAuthenticated
}

/** Extracts `owner/repo` out of a git remote URL (SSH `git@github.com:owner/repo.git` or
 * HTTPS `https://github.com/owner/repo(.git)?`), or null when the URL isn't a recognizable
 * GitHub remote. */
export function parseGithubRepoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (ssh?.[1] !== undefined) return ssh[1]
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (https?.[1] !== undefined) return https[1]
  return null
}

/** The four `pr-slice` slice specs. */
export type PrSliceSpec =
  | { kind: 'files' }
  | { kind: 'diff'; path: string }
  | { kind: 'comments' }
  | { kind: 'description' }

/** Parses the raw `<slice>` CLI argument into a {@link PrSliceSpec}, or null when it doesn't
 * match any recognized slice (an empty `diff:` path counts as unrecognized). */
export function parsePrSliceArg(raw: string): PrSliceSpec | null {
  if (raw === 'files') return { kind: 'files' }
  if (raw === 'comments') return { kind: 'comments' }
  if (raw === 'description') return { kind: 'description' }
  if (raw.startsWith('diff:')) {
    const filePath = raw.slice('diff:'.length)
    return filePath.length > 0 ? { kind: 'diff', path: filePath } : null
  }
  return null
}

function ghErrorMessage(res: { stderr?: string; stdout?: string }): string {
  const stderr = (res.stderr ?? '').trim()
  if (stderr.length > 0) return stderr
  return (res.stdout ?? '').trim()
}

/** Runs `gh pr view <pr> --repo <repo> --json <fields>` and returns the parsed JSON payload.
 * Throws a clear error (gh's own stderr, or a parse-failure message) on any failure. */
function ghPrViewJson(pr: string, repo: string, fields: string): unknown {
  const res = spawnSync('gh', ['pr', 'view', pr, '--repo', repo, '--json', fields], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`gh pr view failed for PR #${pr} in ${repo}: ${ghErrorMessage(res)}`)
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`gh pr view returned unparseable JSON for PR #${pr} in ${repo}`)
  }
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
}

/** Fetches the changed-files list (path plus +/- line counts) for a PR. */
export function fetchPrFiles(pr: string, repo: string): PrFile[] {
  const data = ghPrViewJson(pr, repo, 'files') as { files?: Array<{ path: string; additions: number; deletions: number }> }
  return (data.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }))
}

export interface PrDescription {
  number: number
  title: string
  body: string | null
  author: string | null
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  url: string
  createdAt: string
  updatedAt: string
}

/** Fetches title/body/author/state/refs/URL/timestamps for a PR -- metadata only, no files or
 * comments. */
export function fetchPrDescription(pr: string, repo: string): PrDescription {
  const data = ghPrViewJson(
    pr,
    repo,
    'number,title,body,author,state,isDraft,baseRefName,headRefName,url,createdAt,updatedAt',
  ) as {
    number: number
    title: string
    body?: string | null
    author?: { login?: string } | null
    state: string
    isDraft: boolean
    baseRefName: string
    headRefName: string
    url: string
    createdAt: string
    updatedAt: string
  }
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? null,
    author: data.author?.login ?? null,
    state: data.state,
    isDraft: data.isDraft,
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    url: data.url,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

/** Runs `gh pr diff <pr> --repo <repo>` and returns the full unified diff text. */
export function fetchPrDiff(pr: string, repo: string): string {
  const res = spawnSync('gh', ['pr', 'diff', pr, '--repo', repo], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`gh pr diff failed for PR #${pr} in ${repo}: ${ghErrorMessage(res)}`)
  }
  return res.stdout
}

const DIFF_GIT_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/

/** Extracts just the diff block for one file (`diff --git a/<path> b/<path>` through the next
 * such header, or end of text) out of a full unified diff produced by `gh pr diff`. Returns
 * null when no block matches the given path. */
export function extractFileDiff(diffText: string, filePath: string): string | null {
  const lines = diffText.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = DIFF_GIT_HEADER_RE.exec(lines[i] ?? '')
    if (m === null) continue
    if (m[1] === filePath || m[2] === filePath) {
      start = i
      break
    }
  }
  if (start < 0) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (DIFF_GIT_HEADER_RE.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export interface PrReviewComment {
  path: string
  line: number | null
  author: string | null
  body: string
  createdAt: string
  diffHunk?: string
}

/** Fetches review comments via `gh api repos/<repo>/pulls/<pr>/comments`. Returns gh's default
 * first page (not paginated) -- a surgical slice, not a full comment-history dump. */
export function fetchPrComments(pr: string, repo: string): PrReviewComment[] {
  const res = spawnSync('gh', ['api', `repos/${repo}/pulls/${pr}/comments`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`gh api pulls/comments failed for PR #${pr} in ${repo}: ${ghErrorMessage(res)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    throw new Error(`gh api pulls/comments returned unparseable JSON for PR #${pr} in ${repo}`)
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((c) => {
    const rec = c as Record<string, unknown>
    const user = rec['user'] as Record<string, unknown> | undefined
    const line = rec['line']
    const diffHunk = rec['diff_hunk']
    return {
      path: String(rec['path'] ?? ''),
      line: typeof line === 'number' ? line : null,
      author: typeof user?.['login'] === 'string' ? (user['login'] as string) : null,
      body: String(rec['body'] ?? ''),
      createdAt: String(rec['created_at'] ?? ''),
      ...(typeof diffHunk === 'string' ? { diffHunk } : {}),
    }
  })
}

/** Formats a changed-files list as `path  +additions -deletions` lines. */
export function formatFilesSlice(files: readonly PrFile[]): string {
  if (files.length === 0) return '(no files changed)'
  return files.map((f) => `${f.path}  +${f.additions} -${f.deletions}`).join('\n')
}

/** Formats a PR's description/metadata as a short text block. */
export function formatDescriptionSlice(d: PrDescription): string {
  const lines = [
    `#${d.number}: ${d.title}`,
    `${d.state}${d.isDraft ? ' (draft)' : ''} — ${d.author ?? '(unknown author)'}`,
    `${d.headRefName} -> ${d.baseRefName}`,
    d.url,
    '',
    d.body !== null && d.body.length > 0 ? d.body : '(no description)',
  ]
  return lines.join('\n')
}

/** Formats review comments as one block per comment. */
export function formatCommentsSlice(comments: readonly PrReviewComment[]): string {
  if (comments.length === 0) return '(no review comments)'
  return comments
    .map((c) => `${c.path}${c.line !== null ? `:${c.line}` : ''} — ${c.author ?? '(unknown)'} (${c.createdAt})\n${c.body}`)
    .join('\n\n')
}
