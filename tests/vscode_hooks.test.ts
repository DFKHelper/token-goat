/**
 * VS Code agent-hook response shaping (serializeOutput's vscode branch, src/bridges/vscode_hooks.ts).
 *
 * PROVENANCE: FORMAT-DERIVED. Every response field asserted below is one ChatHookService reads in
 * VS Code 1.136.0's resources/app/extensions/copilot/dist/extension.js: PreToolUse takes only
 * hookSpecificOutput.{permissionDecision, permissionDecisionReason, updatedInput, additionalContext};
 * PostToolUse takes hookSpecificOutput.additionalContext and a top-level decision; Stop and
 * SubagentStop take decision/reason inside hookSpecificOutput. Payloads use the envelope
 * executePreToolUseHook builds there, with tool names and input keys from the ToolName enum in the
 * same file and the languageModelTools schemas in resources/app/extensions/copilot/package.json.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, recordStat: vi.fn() }
})

import { serializeOutput, type HookEvent } from '../src/hook_registry.js'
import { emitRewrite } from '../src/hooks_common.js'
import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { recordStat } from '../src/stats.js'
import type { HookEventName, HookOutput } from '../src/types.js'

const NATIVE_INPUTS: Record<string, Record<string, unknown>> = {
  read_file: { filePath: '/w/src/a.ts', startLine: 1, endLine: 40 },
  view_image: { filePath: '/w/shot.png' },
  list_dir: { path: '/w/src' },
  grep_search: { query: 'needle', isRegexp: false, includePattern: 'src/**' },
  file_search: { query: '**/*.ts' },
  create_file: { filePath: '/w/new.ts', content: 'x' },
  replace_string_in_file: { filePath: '/w/a.ts', oldString: 'a', newString: 'b' },
  insert_edit_into_file: { explanation: 'e', filePath: '/w/a.ts', code: 'c' },
  edit_notebook_file: { filePath: '/w/n.ipynb', editType: 'insert', cellId: 'c1', newCode: 'x' },
  run_in_terminal: { command: 'npm test', explanation: 'run tests', goal: 'test', mode: 'sync' },
}

function vscodeEvent(tool: string, input: Record<string, unknown>, eventName: HookEventName = 'pre_tool_use'): HookEvent {
  const payload = { timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: 'vs', tool_name: tool, tool_input: input, tool_use_id: 'tu-1' }
  return buildEvent(eventName, normalizePayload(payload, 'vscode'))
}

function serialize(output: HookOutput, eventName: HookEventName, event?: HookEvent): Record<string, unknown> {
  return JSON.parse(serializeOutput(output, eventName, 'vscode', event)) as Record<string, unknown>
}

const savedOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
afterEach(() => {
  if (savedOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedOverride
  vi.mocked(recordStat).mockClear()
})

describe('serializeOutput (vscode): deny', () => {
  it('pre_tool_use deny is hookSpecificOutput.permissionDecision "deny" with the reason, never a top-level decision VS Code ignores there', () => {
    const out = serialize({ hookType: 'deny', message: '[tg] already read' }, 'pre_tool_use', vscodeEvent('read_file', NATIVE_INPUTS['read_file']!))
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[tg] already read' },
    })
    expect(out['decision']).toBeUndefined()
    expect(out['modifiedArgs']).toBeUndefined()
    expect(out['modifiedResult']).toBeUndefined()
  })

  it('stop and subagent_stop put decision/reason inside hookSpecificOutput, where VS Code reads them for those events', () => {
    expect(serialize({ hookType: 'deny', message: 'keep going' }, 'subagent_stop')).toEqual({
      hookSpecificOutput: { hookEventName: 'SubagentStop', decision: 'block', reason: 'keep going' },
    })
    expect(serialize({ hookType: 'deny', message: 'keep going' }, 'stop')).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: 'keep going' },
    })
  })

  it('user_prompt_submit deny stays a top-level decision/reason, which VS Code reads for that event', () => {
    expect(serialize({ hookType: 'deny', message: 'no' }, 'user_prompt_submit')).toEqual({ decision: 'block', reason: 'no' })
  })
})

describe('serializeOutput (vscode): rewrites', () => {
  it('rewriteOutput on post_tool_use is {}: VS Code has no field that replaces a tool result', () => {
    const out = serializeOutput({ hookType: 'rewriteOutput', updatedOutput: 'folded' }, 'post_tool_use', 'vscode', vscodeEvent('read_file', NATIVE_INPUTS['read_file']!, 'post_tool_use'))
    expect(out).toBe('{}')
    expect(out).not.toContain('updatedToolOutput')
    expect(out).not.toContain('modifiedResult')
  })

  it('the same rewriteOutput still reaches Claude Code as updatedToolOutput (the vscode branch is scoped to vscode)', () => {
    const out = serializeOutput({ hookType: 'rewriteOutput', updatedOutput: 'folded' }, 'post_tool_use', 'claudecode')
    expect(out).toContain('updatedToolOutput')
  })

  for (const [tool, input] of Object.entries(NATIVE_INPUTS)) {
    it(`rewriteInput for ${tool} goes back to VS Code under the tool's own key names, with no permissionDecision`, () => {
      const event = vscodeEvent(tool, input)
      const out = serialize({ hookType: 'rewriteInput', updatedInput: { ...event.toolInput } }, 'pre_tool_use', event)
      const hso = out['hookSpecificOutput'] as Record<string, unknown>
      expect(hso['hookEventName']).toBe('PreToolUse')
      expect(hso['updatedInput']).toEqual(input)
      expect('permissionDecision' in hso).toBe(false)
    })
  }

  it('a changed value survives the key reversal (replace_string_in_file newString, run_in_terminal command)', () => {
    const edit = vscodeEvent('replace_string_in_file', NATIVE_INPUTS['replace_string_in_file']!)
    const editOut = serialize({ hookType: 'rewriteInput', updatedInput: { ...edit.toolInput, new_string: 'z' } }, 'pre_tool_use', edit)
    expect((editOut['hookSpecificOutput'] as Record<string, unknown>)['updatedInput']).toEqual({ filePath: '/w/a.ts', oldString: 'a', newString: 'z' })

    const term = vscodeEvent('run_in_terminal', NATIVE_INPUTS['run_in_terminal']!)
    const termOut = serialize({ hookType: 'rewriteInput', updatedInput: { ...term.toolInput, command: 'token-goat compress -f npm -c x' } }, 'pre_tool_use', term)
    expect((termOut['hookSpecificOutput'] as Record<string, unknown>)['updatedInput']).toEqual({
      command: 'token-goat compress -f npm -c x',
      explanation: 'run tests',
      goal: 'test',
      mode: 'sync',
    })
  })
})

describe('serializeOutput (vscode): context', () => {
  it('pre_tool_use and post_tool_use context go out as hookSpecificOutput.additionalContext', () => {
    expect(serialize({ hookType: 'context', context: 'hint' }, 'pre_tool_use', vscodeEvent('read_file', NATIVE_INPUTS['read_file']!))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hint' },
    })
    expect(serialize({ hookType: 'context', context: 'hint' }, 'post_tool_use')).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hint' },
    })
    expect(serialize({ hookType: 'context', context: 'hint' }, 'session_start')).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hint' },
    })
  })

  it('stop context is {}: VS Code reads no additionalContext for Stop', () => {
    expect(serializeOutput({ hookType: 'context', context: 'note' }, 'stop', 'vscode')).toBe('{}')
  })

  it('an image-shrink payload on read_file is {}: the base64 never ships as context text', () => {
    const out = serializeOutput({ hookType: 'context', context: 'shrunk\ndata:image/png;base64,iVBORw0KGgo=' }, 'pre_tool_use', 'vscode', vscodeEvent('read_file', NATIVE_INPUTS['read_file']!))
    expect(out).toBe('{}')
  })

  it('an image-shrink payload on view_image is {} too: the handler writes the copy itself, so the serializer never writes one', () => {
    expect(serializeOutput({ hookType: 'context', context: 'shrunk\ndata:image/png;base64,iVBORw0KGgo=' }, 'pre_tool_use', 'vscode', vscodeEvent('view_image', NATIVE_INPUTS['view_image']!))).toBe('{}')
  })

  it('a rewriteInput pointing view_image at a shrunk copy reaches VS Code under its own filePath key', () => {
    const out = serialize({ hookType: 'rewriteInput', updatedInput: { file_path: '/tmp/token-goat-shrink-1-2-x.jpeg' } }, 'pre_tool_use', vscodeEvent('view_image', NATIVE_INPUTS['view_image']!))
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { filePath: '/tmp/token-goat-shrink-1-2-x.jpeg' } } })
  })
})

describe('emitRewrite under the vscode harness', () => {
  it('passes, and books no saving or redaction, because the rewrite would never reach the model', () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
    const out = emitRewrite('short [REDACTED:aws-key]', 'bash', { kind: 'bash_compress', originalBytes: 10_000, detail: 'npm' })
    expect(out.hookType).toBe('pass')
    expect(vi.mocked(recordStat)).not.toHaveBeenCalled()
  })

  it('still rewrites and books the saving on Claude Code', () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    const out = emitRewrite('short', 'bash', { kind: 'bash_compress', originalBytes: 10_000, detail: 'npm' })
    expect(out.hookType).toBe('rewriteOutput')
    expect(vi.mocked(recordStat)).toHaveBeenCalled()
  })
})
