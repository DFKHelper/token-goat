import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildStatuslineData, renderStatusline, runStatuslineCommand, type StatuslineData } from '../src/cli_statusline.js'

/**
 * Replace process.stdin with a fake emitter and capture process.stdout writes.
 * Mirrors relay.test.ts's withFakeIo helper (same fake-stdin shape readStdinJson
 * expects: 'data' / 'end' / 'error' listeners plus a destroy() method).
 */
function withFakeIo(): {
  emit: (payload: string) => void
  emitError: (err: Error) => void
  neverEnd: () => void
  written: () => string
  restore: () => void
} {
  const fakeStdin = new EventEmitter() as EventEmitter & { destroy: () => void }
  fakeStdin.destroy = (): void => {
    // no-op: statusline never needs to observe destruction in these tests
  }
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })

  let out = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })

  return {
    emit(payload: string): void {
      queueMicrotask(() => {
        fakeStdin.emit('data', Buffer.from(payload, 'utf8'))
        fakeStdin.emit('end')
      })
    },
    emitError(err: Error): void {
      queueMicrotask(() => fakeStdin.emit('error', err))
    },
    // Deliberately emits nothing: simulates a caller that invokes `token-goat
    // statusline` with stdin attached to a pipe/tty that never sends data and
    // never closes -- the exact "no hang" scenario requirement #5 targets.
    neverEnd(): void {
      // intentional no-op
    },
    written: () => out,
    restore(): void {
      writeSpy.mockRestore()
      if (origStdin) Object.defineProperty(process, 'stdin', origStdin)
    },
  }
}

let io: ReturnType<typeof withFakeIo>
let prevNoColor: string | undefined

beforeEach(() => {
  io = withFakeIo()
  prevNoColor = process.env['NO_COLOR']
  delete process.env['NO_COLOR']
})

afterEach(() => {
  io.restore()
  if (prevNoColor === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = prevNoColor
})

const FULL_DATA: StatuslineData = {
  project: 'token-goat',
  model: 'Opus',
  contextPct: 12,
  indexPending: 0,
  savedToday: 42_100,
}

describe('buildStatuslineData', () => {
  it('extracts project, model, and context percentage from a full payload', () => {
    const data = buildStatuslineData({
      model: { id: 'claude-opus-4-8', display_name: 'Opus' },
      workspace: { current_dir: 'C:\\Projects\\token-goat' },
      context_window: { used_percentage: 8 },
    })
    expect(data.project).toBe('token-goat')
    expect(data.model).toBe('Opus')
    expect(data.contextPct).toBe(8)
    // index/stats lookups run against the isolated per-test data dir (see
    // tests/setup/isolate-home.ts) -- never null in a working install, but the
    // exact value depends on other tests' state, so only assert the type here.
    expect(data.indexPending === null || typeof data.indexPending === 'number').toBe(true)
    expect(data.savedToday === null || typeof data.savedToday === 'number').toBe(true)
  })

  it('falls back to cwd when workspace.current_dir is absent', () => {
    const data = buildStatuslineData({ cwd: '/some/other/project' })
    expect(data.project).toBe('other/project'.split('/').pop())
  })

  it('degrades gracefully on a completely empty payload (no crash, sensible defaults)', () => {
    const data = buildStatuslineData({})
    expect(typeof data.project).toBe('string')
    expect(data.project.length).toBeGreaterThan(0)
    expect(data.model).toBeNull()
    expect(data.contextPct).toBeNull()
  })

  it('ignores a non-string model.display_name instead of surfacing it as text', () => {
    const data = buildStatuslineData({ model: { display_name: 123 as unknown as string } })
    expect(data.model).toBeNull()
  })

  it('ignores a non-number context_window.used_percentage', () => {
    const data = buildStatuslineData({ context_window: { used_percentage: 'a lot' as unknown as number } })
    expect(data.contextPct).toBeNull()
  })
})

describe('renderStatusline', () => {
  it('renders one line with no embedded newlines', () => {
    const line = renderStatusline(FULL_DATA)
    expect(line).not.toContain('\n')
    expect(line.length).toBeGreaterThan(0)
  })

  it('includes model, context, and index-freshness segments when present', () => {
    const line = renderStatusline(FULL_DATA)
    expect(line).toContain('token-goat')
    expect(line).toContain('Opus')
    expect(line).toContain('ctx 12%')
    expect(line).toContain('idx fresh')
    expect(line).toContain('tg saved 42.1K')
  })

  it('shows "idx N pending" when the reindex queue is non-empty', () => {
    const line = renderStatusline({ ...FULL_DATA, indexPending: 3 })
    expect(line).toContain('idx 3 pending')
  })

  it('omits missing fields cleanly instead of printing null/undefined', () => {
    const data: StatuslineData = { project: 'solo', model: null, contextPct: null, indexPending: null, savedToday: null }
    const line = renderStatusline(data)
    expect(line).toContain('solo')
    expect(line).not.toMatch(/null|undefined|NaN/)
  })

  it('omits the savings segment when nothing was saved today', () => {
    const line = renderStatusline({ ...FULL_DATA, savedToday: 0 })
    expect(line).not.toContain('tg saved')
  })
})

describe('runStatuslineCommand — stdin handling', () => {
  it('valid stdin payload produces a single correctly-formatted output line', async () => {
    io.emit(JSON.stringify({ model: { display_name: 'Sonnet' }, workspace: { current_dir: '/x/my-project' }, context_window: { used_percentage: 20 } }))
    await runStatuslineCommand()
    const lines = io.written().split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('Sonnet')
    expect(lines[0]).toContain('my-project')
    expect(lines[0]).toContain('ctx 20%')
  })

  it('empty stdin falls back to a still-non-empty line instead of crashing', async () => {
    io.emit('')
    await expect(runStatuslineCommand()).resolves.toBeUndefined()
    expect(io.written().trim().length).toBeGreaterThan(0)
  })

  it('malformed (non-JSON) stdin falls back gracefully', async () => {
    io.emit('this is not { json')
    await expect(runStatuslineCommand()).resolves.toBeUndefined()
    expect(io.written().trim().length).toBeGreaterThan(0)
  })

  it('stdin read error falls back gracefully', async () => {
    io.emitError(new Error('stream broke'))
    await expect(runStatuslineCommand()).resolves.toBeUndefined()
    expect(io.written().trim().length).toBeGreaterThan(0)
  })

  it('a partial payload (missing model/context fields) still renders a sensible line', async () => {
    io.emit(JSON.stringify({ workspace: { current_dir: '/x/partial-project' } }))
    await runStatuslineCommand()
    const out = io.written()
    expect(out).toContain('partial-project')
    expect(out).not.toMatch(/null|undefined/)
  })

  it('--json emits the underlying data as JSON, not the rendered line', async () => {
    io.emit(JSON.stringify({ model: { display_name: 'Haiku' }, workspace: { current_dir: '/x/json-project' } }))
    await runStatuslineCommand({ json: true })
    const parsed = JSON.parse(io.written()) as StatuslineData
    expect(parsed.model).toBe('Haiku')
    expect(parsed.project).toBe('json-project')
    // JSON mode is never colorized -- it's a machine-readable payload.
    expect(io.written()).not.toContain('\x1b[')
  })

  it('does NOT hang when stdin never sends data or an end event (critical: must never block the terminal UI)', async () => {
    io.neverEnd()
    const start = Date.now()
    // The vitest default test timeout (5s) would fail this test if the command
    // ever actually hung; asserting a much tighter bound below additionally
    // proves it resolves via its own short internal timeout, not by luck.
    await runStatuslineCommand()
    const elapsedMs = Date.now() - start
    expect(elapsedMs).toBeLessThan(3000)
    expect(io.written().trim().length).toBeGreaterThan(0)
  }, 10000)
})

describe('runStatuslineCommand — color handling', () => {
  it('emits ANSI escapes on a color-capable TTY with NO_COLOR unset', async () => {
    const origIsTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      io.emit(JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: '/x/color-project' } }))
      await runStatuslineCommand()
      expect(io.written()).toContain('\x1b[')
      expect(io.written()).toContain('Opus')
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
    }
  })

  it('emits no ANSI escapes when NO_COLOR is set, even on a TTY', async () => {
    const origIsTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    process.env['NO_COLOR'] = '1'
    try {
      io.emit(JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: '/x/no-color-project' } }))
      await runStatuslineCommand()
      expect(io.written()).not.toContain('\x1b[')
      expect(io.written()).toContain('Opus')
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
    }
  })

  it('emits no ANSI escapes on a non-TTY (e.g. output piped to a file), regardless of NO_COLOR', async () => {
    const origIsTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    try {
      io.emit(JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: '/x/pipe-project' } }))
      await runStatuslineCommand()
      expect(io.written()).not.toContain('\x1b[')
      expect(io.written()).toContain('Opus')
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
    }
  })
})
