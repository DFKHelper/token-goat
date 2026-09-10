// Regression: `token-goat pr-slice` (runPrSlice in read_commands.ts) fences its diff/comments/
// description output for injection (see tests/cli_pr_slice_injection_fence.test.ts) but never
// redacted it. A PR diff, review comment, or description is authorable by anyone who opens a PR
// or leaves a review, exactly the same class of externally-sourced text WebSearch/WebFetch/MCP
// results already redact before display (see CLAUDE.arch.md's Security Boundaries section). Fixing
// this closes that the same way, without disturbing the existing fencing coverage.
// Mocks the `gh`/`git` subprocess boundary (no live network/gh-auth access), mirroring
// tests/pr_slice.test.ts and tests/cli_pr_slice_injection_fence.test.ts.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

const runGitMock = vi.fn()
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, runGit: (...args: unknown[]) => runGitMock(...args) }
})

async function loadModule() {
  vi.resetModules()
  return await import('../src/read_commands.js')
}

function capture(fn: () => void): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  try {
    fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { stdout, stderr }
}

const GH_OK = { status: 0 }
// FORMAT-DERIVED: AKIA + 16 alphanumeric chars is exactly the shape src/secret_redact.ts's
// aws_access_key pattern matches (/AKIA[0-9A-Z]{16}/g). The literal value is AWS's own public
// documentation example key (used throughout AWS SDK docs as a placeholder), not a real credential.
const SECRET = 'AKIAIOSFODNN7EXAMPLE'

describe('pr-slice secret redaction', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
    runGitMock.mockReset()
  })

  it('redacts a secret-shaped string in a diff hunk', async () => {
    const { runPrSlice } = await loadModule()
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      `+const key = '${SECRET}'`,
    ].join('\n')
    spawnSyncMock.mockReturnValueOnce(GH_OK).mockReturnValueOnce(GH_OK).mockReturnValueOnce({ status: 0, stdout: diffText })

    const { stdout } = capture(() => runPrSlice({ pr: '42', slice: 'diff:src/a.ts', repo: 'acme/widgets' }))
    expect(stdout).not.toContain(SECRET)
  })

  it('redacts a secret-shaped string in a review comment body', async () => {
    const { runPrSlice } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ path: 'src/a.ts', line: 5, body: `use ${SECRET} here`, user: { login: 'reviewer1' } }]),
      })

    const { stdout } = capture(() => runPrSlice({ pr: '42', slice: 'comments', repo: 'acme/widgets' }))
    expect(stdout).not.toContain(SECRET)
  })

  it('redacts a secret-shaped string in a description body', async () => {
    const { runPrSlice } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'Add feature',
          body: `deploy with ${SECRET}`,
          author: { login: 'octocat' },
          baseRefName: 'main',
          headRefName: 'feature/x',
          isDraft: false,
        }),
      })

    const { stdout } = capture(() => runPrSlice({ pr: '42', slice: 'description', repo: 'acme/widgets' }))
    expect(stdout).not.toContain(SECRET)
  })

  it('--json redacts the diff field without corrupting the JSON envelope', async () => {
    const { runPrSlice } = await loadModule()
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      `+const key = '${SECRET}'`,
    ].join('\n')
    spawnSyncMock.mockReturnValueOnce(GH_OK).mockReturnValueOnce(GH_OK).mockReturnValueOnce({ status: 0, stdout: diffText })

    const { stdout } = capture(() => runPrSlice({ pr: '42', slice: 'diff:src/a.ts', repo: 'acme/widgets', json: true }))
    const parsed = JSON.parse(stdout) as { path: string; diff: string }
    expect(parsed.path).toBe('src/a.ts')
    expect(parsed.diff).not.toContain(SECRET)
  })

  it('--json redacts the description body field without corrupting the JSON envelope', async () => {
    const { runPrSlice } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'Add feature',
          body: `deploy with ${SECRET}`,
          author: { login: 'octocat' },
          baseRefName: 'main',
          headRefName: 'feature/x',
          isDraft: false,
        }),
      })

    const { stdout } = capture(() => runPrSlice({ pr: '42', slice: 'description', repo: 'acme/widgets', json: true }))
    const parsed = JSON.parse(stdout) as { number: number; title: string; body: string }
    expect(parsed.number).toBe(42)
    expect(parsed.body).not.toContain(SECRET)
  })
})
