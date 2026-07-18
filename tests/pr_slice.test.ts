import { describe, expect, it, vi, beforeEach } from 'vitest'

// The gh CLI subprocess (pr_slice.ts) and the git subprocess (util.ts::runGit, used for
// `origin` remote resolution) are mocked independently so no real network/gh-auth/git access
// is required. Never invoke a real `gh` or `git` process in this file.
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

/** Capture stdout/stderr for a function call. */
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

const GH_OK = { status: 0 } // gh --version / gh auth status success
const GIT_REMOTE_OK = { exitCode: 0, stdout: 'git@github.com:acme/widgets.git\n', stderr: '' }

describe('runPrSlice', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
    runGitMock.mockReset()
  })

  it('invalid slice argument is rejected before any subprocess call', async () => {
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'bogus' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/Invalid slice 'bogus'/)
    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('reports a clear error when gh is not installed', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1 }) // gh --version fails
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files', repo: 'acme/widgets' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/gh \(GitHub CLI\) not found on PATH/)
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('reports a clear error when the repo cannot be resolved from the git remote', async () => {
    spawnSyncMock.mockReturnValueOnce(GH_OK) // gh --version
    runGitMock.mockReturnValueOnce({ exitCode: 1, stdout: '', stderr: 'fatal: no such remote' })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/Could not resolve a GitHub repo/)
    expect(stderr).toMatch(/--repo/)
  })

  it('reports a clear error when gh is not authenticated', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK) // gh --version
      .mockReturnValueOnce({ status: 1, stderr: 'not logged into any GitHub hosts' }) // gh auth status
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files', repo: 'acme/widgets' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/gh is not authenticated/)
  })

  it('reports gh\'s error when the PR cannot be found', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK) // gh --version
      .mockReturnValueOnce(GH_OK) // gh auth status
      .mockReturnValueOnce({ status: 1, stderr: 'no pull requests found' }) // gh pr view
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '9999', slice: 'files', repo: 'acme/widgets' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/gh pr view failed for PR #9999/)
    expect(stderr).toMatch(/no pull requests found/)
  })

  it('files slice: happy path with --repo override (no git remote call)', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK) // gh --version
      .mockReturnValueOnce(GH_OK) // gh auth status
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'src/b.ts', additions: 0, deletions: 5 }] }),
      })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)
    expect(stdout).toContain('src/a.ts  +3 -1')
    expect(stdout).toContain('src/b.ts  +0 -5')
    expect(runGitMock).not.toHaveBeenCalled()
    const call = spawnSyncMock.mock.calls[2]
    expect(call?.[0]).toBe('gh')
    expect(call?.[1]).toEqual(['pr', 'view', '42', '--repo', 'acme/widgets', '--json', 'files'])
  })

  it('files slice: --json emits a JSON array', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] }) })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files', repo: 'acme/widgets', json: true })
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.items).toEqual([{ path: 'src/a.ts', additions: 3, deletions: 1 }])
    expect(parsed.truncated).toBe(false)
    expect(parsed.totalCount).toBe(1)
  })

  it('diff:<path> slice: happy path, resolving the repo from the origin git remote', async () => {
    const fullDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 333..444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-b-old',
      '+b-new',
    ].join('\n')
    spawnSyncMock
      .mockReturnValueOnce(GH_OK) // gh --version
      .mockReturnValueOnce(GH_OK) // gh auth status
      .mockReturnValueOnce({ status: 0, stdout: fullDiff }) // gh pr diff
    runGitMock.mockReturnValueOnce(GIT_REMOTE_OK)
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'diff:src/a.ts' })
    })
    expect(code).toBe(0)
    expect(stdout).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(stdout).toContain('-old')
    expect(stdout).toContain('+new')
    expect(stdout).not.toContain('src/b.ts')
    expect(runGitMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], expect.objectContaining({}))
    const diffCall = spawnSyncMock.mock.calls[2]
    expect(diffCall?.[1]).toEqual(['pr', 'diff', '42', '--repo', 'acme/widgets'])
  })

  it('diff:<path> slice: --json wraps the file diff in an object', async () => {
    const fullDiff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({ status: 0, stdout: fullDiff })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '7', slice: 'diff:x.ts', repo: 'acme/widgets', json: true })
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.path).toBe('x.ts')
    expect(parsed.diff).toContain('-a')
    expect(parsed.diff).toContain('+b')
  })

  it('diff:<path> slice: unknown path in the diff reports a clear error', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({ status: 0, stdout: 'diff --git a/only.ts b/only.ts\n--- a/only.ts\n+++ b/only.ts\n' })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stderr } = capture(() => {
      code = runPrSlice({ pr: '7', slice: 'diff:missing.ts', repo: 'acme/widgets' })
    })
    expect(code).toBe(1)
    expect(stderr).toMatch(/No diff found for 'missing.ts'/)
  })

  it('comments slice: happy path', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          { path: 'src/a.ts', line: 12, user: { login: 'reviewer1' }, body: 'nit: rename this', created_at: '2026-01-01T00:00:00Z' },
        ]),
      })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'comments', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)
    expect(stdout).toContain('src/a.ts:12')
    expect(stdout).toContain('reviewer1')
    expect(stdout).toContain('nit: rename this')
    const call = spawnSyncMock.mock.calls[2]
    expect(call?.[1]).toEqual(['api', 'repos/acme/widgets/pulls/42/comments'])
  })

  it('comments slice: --json emits a JSON array', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          { path: 'src/a.ts', line: 12, user: { login: 'reviewer1' }, body: 'nit', created_at: '2026-01-01T00:00:00Z' },
        ]),
      })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'comments', repo: 'acme/widgets', json: true })
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.items).toEqual([{ path: 'src/a.ts', line: 12, author: 'reviewer1', body: 'nit', createdAt: '2026-01-01T00:00:00Z' }])
  })

  it('description slice: happy path', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'Add pr-slice command',
          body: 'Implements #305',
          author: { login: 'octocat' },
          state: 'OPEN',
          isDraft: false,
          baseRefName: 'main',
          headRefName: 'feature/pr-slice',
          url: 'https://github.com/acme/widgets/pull/42',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'description', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)
    expect(stdout).toContain('#42: Add pr-slice command')
    expect(stdout).toContain('OPEN')
    expect(stdout).toContain('octocat')
    expect(stdout).toContain('feature/pr-slice -> main')
    expect(stdout).toContain('Implements #305')
  })

  it('description slice: --json emits the full metadata object', async () => {
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'Add pr-slice command',
          body: null,
          author: null,
          state: 'OPEN',
          isDraft: true,
          baseRefName: 'main',
          headRefName: 'feature/pr-slice',
          url: 'https://github.com/acme/widgets/pull/42',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      })
    const { runPrSlice } = await loadModule()
    let code: number | undefined
    const { stdout } = capture(() => {
      code = runPrSlice({ pr: '42', slice: 'description', repo: 'acme/widgets', json: true })
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed).toMatchObject({ number: 42, title: 'Add pr-slice command', body: null, author: null, isDraft: true })
  })
})
