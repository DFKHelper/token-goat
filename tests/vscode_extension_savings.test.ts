import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// This tests src/vscode_savings.ts, the canonical copy of the pure logic that vscode-extension/src/savings.ts ships. The two must stay byte-identical (see the guard test below); a direct import of the extension's own file here would pull a CommonJS-package source into this project's ESM/verbatimModuleSyntax program and fail typecheck:tests, since the two sides use incompatible module kinds by design (VS Code requires CJS, this repo's tests are ESM).
import { formatSavingsBar, parseStatsJson, type StatsJson } from '../src/vscode_savings.js'

function statsFixture(overrides: Partial<StatsJson> = {}): StatsJson {
  return {
    total_tokens_saved: 1086245675,
    total_bytes_saved: 4302154201,
    total_events: 62729,
    window_days: 30,
    by_day: [{ date: '2026-08-12', events: 58, bytes_saved: 575936, tokens_saved: 144003 }],
    ...overrides,
  }
}

describe('vscode-extension savings display', () => {
  it('parses a well-formed stats --json payload', () => {
    const raw = JSON.stringify(statsFixture())
    expect(parseStatsJson(raw)).toEqual(statsFixture())
  })

  it('rejects malformed JSON', () => {
    expect(parseStatsJson('not json')).toBeNull()
  })

  it('rejects a payload missing the fields the display depends on', () => {
    expect(parseStatsJson(JSON.stringify({ some_other_shape: true }))).toBeNull()
  })

  it('renders the full-window total, not a bytes-derived approximation', () => {
    const rendered = formatSavingsBar(statsFixture())
    expect(rendered.text).toBe('$(gist-secret) token-goat: 1,086,245,675 tokens saved (30d)')
    expect(rendered.tooltip).toContain('1,086,245,675 tokens saved over the last 30 day(s)')
  })

  it('labels the window explicitly rather than calling it a session', () => {
    const rendered = formatSavingsBar(statsFixture())
    expect(rendered.text.toLowerCase()).not.toContain('session')
    expect(rendered.tooltip.toLowerCase()).not.toContain('session')
  })

  it('renders zero savings without hiding the ledger state', () => {
    const rendered = formatSavingsBar(statsFixture({ total_tokens_saved: 0 }))
    expect(rendered.text).toBe('$(gist-secret) token-goat: 0 tokens saved')
  })

  it('renders a negative total as a loss, never clamped to zero', () => {
    const rendered = formatSavingsBar(statsFixture({ total_tokens_saved: -500 }))
    expect(rendered.text).toBe('$(gist-secret) token-goat: -500 tokens (net loss, 30d)')
    expect(rendered.tooltip).toContain('net loss of 500 tokens')
  })

  it('falls back to a placeholder when stats is null (CLI missing, exec failure, or unparseable output)', () => {
    const rendered = formatSavingsBar(null)
    expect(rendered.text).toBe('$(gist-secret) token-goat')
    expect(rendered.tooltip).toContain('token-goat is ready')
  })

  // src/vscode_savings.ts exists only so this logic can be typechecked under the ESM/verbatimModuleSyntax tests project without pulling the CommonJS extension package into that program; vscode-extension/src/savings.ts is what actually ships. If they drift, the tested behavior stops describing the shipped behavior, so a byte-for-byte diff fails loudly instead of silently.
  it('stays byte-identical to the shipped vscode-extension/src/savings.ts copy', () => {
    const canonical = fs.readFileSync(path.join(__dirname, '..', 'src', 'vscode_savings.ts'), 'utf8')
    const shipped = fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'src', 'savings.ts'), 'utf8')
    expect(shipped).toBe(canonical)
  })
})
