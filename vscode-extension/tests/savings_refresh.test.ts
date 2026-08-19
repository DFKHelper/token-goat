import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refreshSavingsBar,
  resetSavingsRefreshStateForTests,
  SAVINGS_REFRESH_INTERVAL_MS,
  SAVINGS_REFRESH_MIN_INTERVAL_MS,
  scheduleRefresh,
  setSavingsBarForTests,
} from '../src/extension'

const { runTokenGoat } = vi.hoisted(() => ({
  runTokenGoat: vi.fn(),
}))

vi.mock('../src/launcher', () => ({
  runTokenGoat,
  resolveTokenGoatEntrypoint: vi.fn(),
  resolveNodeExecutable: vi.fn(),
  assertSafeArgSegment: vi.fn(),
  runGitDiff: vi.fn(),
}))

const fakeStatusBar = {
  text: '',
  tooltip: '',
  color: undefined as unknown,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
}

vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => fakeStatusBar),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def: unknown) => def),
    })),
    onDidChangeActiveTextEditor: vi.fn(),
    onDidSaveTextDocument: vi.fn(),
    workspaceFolders: undefined,
    isTrusted: true,
  },
  lm: {
    registerMcpServerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ThemeColor: class {
    constructor(public readonly id: string) {}
  },
  StatusBarAlignment: { Right: 2 },
}))

const statsSample = JSON.stringify({
  total_tokens_saved: 12345,
  total_bytes_saved: 67890,
  total_events: 10,
  window_days: 30,
  by_day: [],
})

describe('savings refresh rate limiting (30-second throttle)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSavingsRefreshStateForTests()
    setSavingsBarForTests(fakeStatusBar as never)
    runTokenGoat.mockReset()
    runTokenGoat.mockResolvedValue(statsSample)
  })

  afterEach(() => {
    resetSavingsRefreshStateForTests()
    setSavingsBarForTests(undefined)
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('declares 30-second interval constants', () => {
    expect(SAVINGS_REFRESH_MIN_INTERVAL_MS).toBe(30_000)
    expect(SAVINGS_REFRESH_INTERVAL_MS).toBe(30_000)
  })

  it('runs initial refresh immediately on startup', async () => {
    await refreshSavingsBar()
    expect(runTokenGoat).toHaveBeenCalledTimes(1)
    expect(runTokenGoat).toHaveBeenCalledWith(['stats', '--json'])
  })

  it('does not refresh more than once within a 30-second window', async () => {
    await refreshSavingsBar()
    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // Repeated calls at +1s, +10s, +29s are suppressed
    vi.advanceTimersByTime(1_000)
    await refreshSavingsBar()
    vi.advanceTimersByTime(10_000)
    await refreshSavingsBar()
    vi.advanceTimersByTime(18_000) // now at +29s
    await refreshSavingsBar()

    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // After 30s have elapsed, the next refresh executes
    vi.advanceTimersByTime(1_000) // now at +30s
    await refreshSavingsBar()
    expect(runTokenGoat).toHaveBeenCalledTimes(2)
  })

  it('scheduleRefresh debounces and delays when called within the 30s cooldown', async () => {
    await refreshSavingsBar()
    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // Trigger scheduleRefresh at +5s
    vi.advanceTimersByTime(5_000)
    scheduleRefresh()

    // Rapid event bursts at +6s, +10s, +15s do not spawn extra timers
    vi.advanceTimersByTime(1_000)
    scheduleRefresh()
    vi.advanceTimersByTime(4_000)
    scheduleRefresh()
    vi.advanceTimersByTime(5_000)
    scheduleRefresh()

    // At +20s, still no refresh has executed
    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // Advance to 30s past the first refresh (25s after the scheduleRefresh trigger)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(runTokenGoat).toHaveBeenCalledTimes(2)
  })

  it('scheduleRefresh executes after short debounce if 30s have already passed', async () => {
    await refreshSavingsBar()
    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // 40 seconds pass with no events
    vi.advanceTimersByTime(40_000)

    // An event schedules refresh
    scheduleRefresh()
    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    // Debounce timer (500ms) fires
    await vi.advanceTimersByTimeAsync(500)
    expect(runTokenGoat).toHaveBeenCalledTimes(2)
  })

  it('guards against concurrent overlapping refresh calls', async () => {
    let finishFirst: (val: string) => void = () => {}
    const slowFirstCall = new Promise<string>((resolve) => {
      finishFirst = resolve
    })

    runTokenGoat.mockImplementationOnce(() => slowFirstCall)

    const p1 = refreshSavingsBar()
    const p2 = refreshSavingsBar()

    expect(runTokenGoat).toHaveBeenCalledTimes(1)

    finishFirst(statsSample)
    await Promise.all([p1, p2])

    expect(runTokenGoat).toHaveBeenCalledTimes(1)
  })
})
