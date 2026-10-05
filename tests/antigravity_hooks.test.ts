/** Antigravity CLI (agy 1.2.11) payload normalization and response shaping: normalizePayload's antigravity branch (src/hooks_cli.ts) and serializeOutput's antigravity branch (src/bridges/antigravity_hooks.ts). PROVENANCE: - Payload envelope and response fields: FORMAT-DERIVED from agy's own hooks guide, ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md (agy 1.2.11): PreToolUse sends {toolCall: {name, args}, stepIdx, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName}; PostToolUse adds result and error; PreToolUse reads decision/reason/overwrite; PostToolUse expects {}. `overwriteResult` is read off the PostToolHookResult message in agy.exe 1.2.11's embedded proto descriptor. - Tool names and argument keys (view_file {AbsolutePath, StartLine, EndLine}, run_command {CommandLine, Cwd, WaitMsBeforeAsync}, grep_search {Query, SearchPath, ...}, replace_file_content {TargetFile, TargetContent, ReplacementContent, ...}, write_to_file {TargetFile, CodeContent, Overwrite}): CAPTURE, read out of the transcript of a real agy run on 2026-09-29. - The flat {tool_name, tool_input} shape: FORMAT-DERIVED from rtk-ai/rtk PR #2093's agy integration. - "An empty reply leaves the call on its normal permission path": CAPTURE, a hook answering {} in a real agy run on 2026-09-29. - Paths, ids and command strings are HAND-DERIVED placeholders. */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, recordStat: vi.fn() }
})

import { serializeOutput, type HookEvent } from '../src/hook_registry.js'
import { ANTIGRAVITY_TOOL_NAME_KEY, normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { recordStat } from '../src/stats.js'
import type { HookEventName, HookOutput } from '../src/types.js'

const WORKSPACE = '/w/project'

function agyPayload(name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolCall: { name, args },
    stepIdx: 7,
    conversationId: 'conv-1',
    workspacePaths: [WORKSPACE],
    transcriptPath: '/h/.gemini/antigravity-cli/conv-1/transcript.jsonl',
    artifactDirectoryPath: '/h/.gemini/antigravity-cli/conv-1/artifacts',
    modelName: 'model-x',
    ...extra,
  }
}

function agyEvent(name: string, args: Record<string, unknown>, eventName: HookEventName = 'pre_tool_use', extra: Record<string, unknown> = {}): HookEvent {
  return buildEvent(eventName, normalizePayload(agyPayload(name, args, extra), 'antigravity'))
}

function serialize(output: HookOutput, eventName: HookEventName, event?: HookEvent): Record<string, unknown> {
  return JSON.parse(serializeOutput(output, eventName, 'antigravity', event)) as Record<string, unknown>
}

afterEach(() => {
  vi.mocked(recordStat).mockClear()
})

describe('normalizePayload (antigravity)', () => {
  it('lifts toolCall.name/args, conversationId and workspacePaths[0] into the canonical keys', () => {
    const out = normalizePayload(agyPayload('run_command', { CommandLine: 'npm test', Cwd: WORKSPACE, WaitMsBeforeAsync: 500 }), 'antigravity')
    expect(out['tool_name']).toBe('Bash')
    expect(out['tool_input']).toEqual({ command: 'npm test', Cwd: WORKSPACE, WaitMsBeforeAsync: 500 })
    expect(out['session_id']).toBe('conv-1')
    expect(out['cwd']).toBe(WORKSPACE)
    expect(out[ANTIGRAVITY_TOOL_NAME_KEY]).toBe('run_command')
    expect(out['_tg_harness']).toBe('antigravity')
  })

  it('never maps transcriptPath to transcript_path, because agy transcripts are not Claude Code JSONL', () => {
    const out = normalizePayload(agyPayload('view_file', { AbsolutePath: '/w/a.ts' }), 'antigravity')
    expect(out['transcript_path']).toBeUndefined()
  })

  it('renames view_file StartLine/EndLine to the startLine/endLine pair a ranged read is recognized by', () => {
    const out = normalizePayload(agyPayload('view_file', { AbsolutePath: '/w/a.ts', StartLine: 10, EndLine: 40 }), 'antigravity')
    expect(out['tool_name']).toBe('Read')
    expect(out['tool_input']).toEqual({ file_path: '/w/a.ts', startLine: 10, endLine: 40 })
  })

  it.each([
    ['view_file', { AbsolutePath: '/w/a.ts' }, 'Read', { file_path: '/w/a.ts' }],
    ['list_dir', { DirectoryPath: '/w/src' }, 'Read', { file_path: '/w/src' }],
    ['list_directory', { DirectoryPath: '/w/src' }, 'Read', { file_path: '/w/src' }],
    ['grep_search', { Query: 'needle', SearchPath: '/w', IsRegex: false }, 'Grep', { pattern: 'needle', path: '/w', IsRegex: false }],
    ['find_by_name', { Pattern: '*.ts', SearchDirectory: '/w' }, 'Glob', { pattern: '*.ts', path: '/w' }],
    ['find', { Pattern: '*.ts', SearchDirectory: '/w' }, 'Glob', { pattern: '*.ts', path: '/w' }],
    ['replace_file_content', { TargetFile: '/w/a.ts', TargetContent: 'a', ReplacementContent: 'b', AllowMultiple: false }, 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b', AllowMultiple: false }],
    ['multi_replace_file_content', { TargetFile: '/w/a.ts', TargetContent: 'a', ReplacementContent: 'b' }, 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }],
    ['file_change', { TargetFile: '/w/a.ts', TargetContent: 'a', ReplacementContent: 'b' }, 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }],
    ['write_to_file', { TargetFile: '/w/n.ts', CodeContent: 'x', Overwrite: true }, 'Write', { file_path: '/w/n.ts', content: 'x', Overwrite: true }],
    ['search_web', { query: 'q' }, 'WebSearch', { query: 'q' }],
  ])('%s maps to %s with canonical input keys', (name, args, tool, input) => {
    const out = normalizePayload(agyPayload(name, args), 'antigravity')
    expect(out['tool_name']).toBe(tool)
    expect(out['tool_input']).toEqual(input)
  })

  it('passes an unknown tool through by name with its arguments untouched', () => {
    const out = normalizePayload(agyPayload('read_url_content', { Url: 'https://example.com' }), 'antigravity')
    expect(out['tool_name']).toBe('read_url_content')
    expect(out['tool_input']).toEqual({ Url: 'https://example.com' })
    expect(out[ANTIGRAVITY_TOOL_NAME_KEY]).toBe('read_url_content')
  })

  it('accepts the flat {tool_name, tool_input} shape rtk saw, without overwriting its keys from toolCall', () => {
    const out = normalizePayload({ tool_name: 'view_file', tool_input: { AbsolutePath: '/w/a.ts' }, toolCall: { name: 'run_command', args: {} }, session_id: 's-flat', cwd: '/w/flat', conversationId: 'conv-1', workspacePaths: [WORKSPACE] }, 'antigravity')
    expect(out['tool_name']).toBe('Read')
    expect(out['tool_input']).toEqual({ file_path: '/w/a.ts' })
    expect(out['session_id']).toBe('s-flat')
    expect(out['cwd']).toBe('/w/flat')
  })

  it('leaves cwd unset when workspacePaths is empty rather than inventing one', () => {
    const out = normalizePayload(agyPayload('view_file', { AbsolutePath: '/w/a.ts' }, { workspacePaths: [] }), 'antigravity')
    expect(out['cwd']).toBeUndefined()
  })

  it('wraps a PostToolUse result as tool_response.output, and carries a non-empty error beside it', () => {
    const ok = normalizePayload(agyPayload('run_command', { CommandLine: 'ls' }, { result: 'a\nb\n', error: '' }), 'antigravity')
    expect(ok['tool_response']).toEqual({ output: 'a\nb\n' })
    const failed = normalizePayload(agyPayload('run_command', { CommandLine: 'false' }, { result: '', error: 'exit status 1' }), 'antigravity')
    expect(failed['tool_response']).toEqual({ output: '', error: 'exit status 1' })
  })
})

describe('serializeOutput (antigravity): pre_tool_use', () => {
  it('a pass is {}, never decision "allow", which would skip the user\'s own permission prompt', () => {
    const out = serializeOutput({ hookType: 'pass' }, 'pre_tool_use', 'antigravity', agyEvent('run_command', { CommandLine: 'rm -rf build' }))
    expect(out).toBe('{}')
    expect(out).not.toContain('allow')
  })

  it('a deny is {decision: "deny", reason}', () => {
    expect(serialize({ hookType: 'deny', message: '[tg] already read' }, 'pre_tool_use', agyEvent('view_file', { AbsolutePath: '/w/a.ts' }))).toEqual({ decision: 'deny', reason: '[tg] already read' })
  })

  it('a context note goes in reason with no decision', () => {
    expect(serialize({ hookType: 'context', context: '[tg] try token-goat read' }, 'pre_tool_use', agyEvent('view_file', { AbsolutePath: '/w/a.ts' }))).toEqual({ reason: '[tg] try token-goat read' })
  })

  it('a context carrying a base64 image is dropped to {}, since reason cannot point agy at a replacement file', () => {
    expect(serialize({ hookType: 'context', context: 'shrunk: data:image/png;base64,AAAA' }, 'pre_tool_use', agyEvent('view_file', { AbsolutePath: '/w/shot.png' }))).toEqual({})
  })

  it('a rewrite goes out as overwrite in the tool\'s own argument keys, with no decision', () => {
    const event = agyEvent('run_command', { CommandLine: 'npm test', Cwd: WORKSPACE })
    const out = serialize({ hookType: 'rewriteInput', approve: true, updatedInput: { command: 'token-goat compress -- npm test', Cwd: WORKSPACE } }, 'pre_tool_use', event)
    expect(out).toEqual({ overwrite: { CommandLine: 'token-goat compress -- npm test', Cwd: WORKSPACE } })
  })

  it('a view_file rewrite maps startLine/endLine back to StartLine/EndLine', () => {
    const event = agyEvent('view_file', { AbsolutePath: '/w/a.ts' })
    const out = serialize({ hookType: 'rewriteInput', approve: true, updatedInput: { file_path: '/w/a.ts', startLine: 1, endLine: 80 } }, 'pre_tool_use', event)
    expect(out).toEqual({ overwrite: { AbsolutePath: '/w/a.ts', StartLine: 1, EndLine: 80 } })
  })

  it('a rewrite with no recorded agy tool name is sent as-is', () => {
    expect(serialize({ hookType: 'rewriteInput', approve: true, updatedInput: { command: 'x' } }, 'pre_tool_use')).toEqual({ overwrite: { command: 'x' } })
  })
})

describe('serializeOutput (antigravity): other events', () => {
  it('post_tool_use rewriteOutput becomes overwriteResult when the payload carried a result string', () => {
    const event = agyEvent('run_command', { CommandLine: 'npm test' }, 'post_tool_use', { result: 'long log', error: '' })
    expect(serialize({ hookType: 'rewriteOutput', updatedOutput: 'short log' }, 'post_tool_use', event)).toEqual({ overwriteResult: 'short log' })
  })

  it('post_tool_use rewriteOutput is {} when there was no result to replace', () => {
    const event = agyEvent('run_command', { CommandLine: 'npm test' }, 'post_tool_use')
    expect(serialize({ hookType: 'rewriteOutput', updatedOutput: 'short log' }, 'post_tool_use', event)).toEqual({})
  })

  it('post_tool_use context has no agy channel and is {}', () => {
    const event = agyEvent('run_command', { CommandLine: 'npm test' }, 'post_tool_use', { result: 'x' })
    expect(serialize({ hookType: 'context', context: '[tg] note' }, 'post_tool_use', event)).toEqual({})
  })

  it.each(['session_start', 'stop', 'pre_compact'] as const)('%s answers {} even for a deny', (eventName) => {
    expect(serialize({ hookType: 'deny', message: 'no' }, eventName)).toEqual({})
  })
})
