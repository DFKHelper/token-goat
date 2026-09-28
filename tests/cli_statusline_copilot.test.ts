/**
 * `token-goat statusline` as GitHub Copilot CLI's `statusLine` command. Copilot CLI 1.0.88 has one: `~/.copilot/settings.json` `{"statusLine":{"type":"command","command":"..."}}` runs the command with the session JSON on stdin, the same contract as Claude Code's. The fields this command reads (`workspace.current_dir`, `cwd`, `model.display_name`) are present under the same names, but Copilot's `context_window.used_percentage` is not the figure Copilot's own footer shows: it is measured against `context_window_size` (264000 here) and stays 0 until the first model reply, while the footer divides `current_context_tokens` by `displayed_context_limit` (192000) and reports that as `current_context_used_percentage`.
 *
 * PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88/S1-001-statusline.json, S2-004-statusline.json and S2-009-statusline.json are the stdin Copilot CLI 1.0.88 gave a recording statusLine command (`%TEMP%\tg-captures\S1|S2\raw\statusline-NNN.json`, interactive sessions with model gpt-5-mini, recorded 2026-09-28), with the workspace and home paths substituted as the loader describes. S1-001 is a session's first render; S2-004 is after the prompt is sent and before any reply (used_percentage 0, current_context_used_percentage 9); S2-009 is after two view tool calls (used_percentage 6, current_context_used_percentage 9).
 */
import { describe, expect, it } from 'vitest'

import { buildStatuslineData, renderStatusline, type StatuslinePayload } from '../src/cli_statusline.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'

const PROJ = 'C:\\Users\\someone\\work\\sample-ws'

function capture(name: string): StatuslinePayload {
  return copilotCapture(name, { proj: PROJ, home: 'C:\\Users\\someone' }) as StatuslinePayload
}

describe('statusline on a Copilot CLI 1.0.88 payload (CAPTURE S1/S2)', () => {
  it('names the workspace and the model Copilot reports', () => {
    const data = buildStatuslineData(capture('S2-009-statusline'))
    expect(data.project).toBe('sample-ws')
    expect(data.model).toBe('gpt-5-mini · medium')
  })

  it('shows the context percentage Copilot shows, not used_percentage', () => {
    expect(buildStatuslineData(capture('S2-009-statusline')).contextPct).toBe(9)
    expect(buildStatuslineData(capture('S2-004-statusline')).contextPct).toBe(9)
    expect(stripAnsiEscapes(renderStatusline(buildStatuslineData(capture('S2-004-statusline'))))).toContain('ctx 9%')
  })

  it('renders the first frame, whose used_percentage and context_window_size are null', () => {
    const payload = capture('S1-001-statusline')
    expect(payload.context_window?.used_percentage).toBeNull()
    const data = buildStatuslineData(payload)
    expect(data.project).toBe('sample-ws')
    expect(data.contextPct).toBe(0)
    expect(stripAnsiEscapes(renderStatusline(data))).toMatch(/^sample-ws \| gpt-5-mini · medium \| ctx 0%/)
  })

  it('still reads used_percentage from a payload without the Copilot key (Claude Code shape, HAND-DERIVED from the documented schema)', () => {
    expect(buildStatuslineData({ cwd: PROJ, context_window: { used_percentage: 42 } }).contextPct).toBe(42)
  })
})
