/**
 * Regression: `token-goat pr-slice` (runPrSlice in read_commands.ts) never called recordStat,
 * and stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `pr-slice`/`pr_slice` entry either
 * -- so its dashboard bucket in `token-goat stats --full` was permanently zero regardless of
 * real usage, the same class of registry/producer desync already fixed for
 * map_lookup/changed_lookup/csv_query/brief_view/session_outline/session_slice/gdrive_sections
 * (see project_runchanged_missing_stat memory). Mocks the `gh`/`git` subprocess boundary (no
 * live network/gh-auth access) and asserts a real stats row appears via summarize() against the
 * real (test-isolated) global stats DB for every slice kind -- a synthetic recordStat/DB insert
 * would not catch the original absence.
 */
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
  const readCommands = await import('../src/read_commands.js')
  const stats = await import('../src/stats.js')
  return { runPrSlice: readCommands.runPrSlice, summarize: stats.summarize }
}

function capture(fn: () => void): void {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = () => true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = () => true
  try {
    fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

const GH_OK = { status: 0 }

describe('runPrSlice stat recording', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
    runGitMock.mockReset()
  })

  it('files slice records a pr_slice stat row through the real global stats DB', async () => {
    const { runPrSlice, summarize } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] }) })

    const before = summarize(30).by_kind['pr_slice']
    const beforeEvents = before?.events ?? 0

    let code: number | undefined
    capture(() => {
      code = runPrSlice({ pr: '42', slice: 'files', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)

    const after = summarize(30).by_kind['pr_slice']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })

  it('diff slice records a pr_slice stat row through the real global stats DB', async () => {
    const { runPrSlice, summarize } = await loadModule()
    const fullDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-b-old',
      '+b-new',
    ].join('\n')
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({ status: 0, stdout: fullDiff })

    const before = summarize(30).by_kind['pr_slice']
    const beforeEvents = before?.events ?? 0

    let code: number | undefined
    capture(() => {
      code = runPrSlice({ pr: '42', slice: 'diff:src/a.ts', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)

    const after = summarize(30).by_kind['pr_slice']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })

  it('comments slice records a pr_slice stat row through the real global stats DB', async () => {
    const { runPrSlice, summarize } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ path: 'src/a.ts', line: 5, body: 'nit: rename this', author: { login: 'reviewer1' } }]),
      })

    const before = summarize(30).by_kind['pr_slice']
    const beforeEvents = before?.events ?? 0

    let code: number | undefined
    capture(() => {
      code = runPrSlice({ pr: '42', slice: 'comments', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)

    const after = summarize(30).by_kind['pr_slice']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })

  it('description slice records a pr_slice stat row through the real global stats DB', async () => {
    const { runPrSlice, summarize } = await loadModule()
    spawnSyncMock
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce(GH_OK)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'Add pr-slice command',
          body: 'Implements the pr-slice CLI command.',
          author: { login: 'octocat' },
          baseRefName: 'main',
          headRefName: 'feature/pr-slice',
          isDraft: false,
        }),
      })

    const before = summarize(30).by_kind['pr_slice']
    const beforeEvents = before?.events ?? 0

    let code: number | undefined
    capture(() => {
      code = runPrSlice({ pr: '42', slice: 'description', repo: 'acme/widgets' })
    })
    expect(code).toBe(0)

    const after = summarize(30).by_kind['pr_slice']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })

  it('pr_slice is registered in stats.ts so its by-command bucket is reachable', async () => {
    const stats = await import('../src/stats.js')
    expect(stats.kindToSource('pr_slice')).toBe(stats.SOURCE_READ)
  })
})
