import { describe, it, expect } from 'vitest'
import { translateCopilotPayload, foldToolName, resolveCanonicalToolName } from '../src/bridges/copilot_cli.js'

describe('Copilot CLI tool name folded normalization', () => {
  it('folds tool names removing casing, underscores, and hyphens', () => {
    expect(foldToolName('web_search')).toBe('websearch')
    expect(foldToolName('WebSearch')).toBe('websearch')
    expect(foldToolName('exit_plan_mode')).toBe('exitplanmode')
    expect(foldToolName('ExitPlanMode')).toBe('exitplanmode')
    expect(foldToolName('read_powershell')).toBe('readpowershell')
    expect(foldToolName('read-powershell')).toBe('readpowershell')
  })

  it('resolves canonical token-goat tool names for various casing and separator formats', () => {
    expect(resolveCanonicalToolName('web_search')).toBe('WebSearch')
    expect(resolveCanonicalToolName('WebSearch')).toBe('WebSearch')
    expect(resolveCanonicalToolName('exit_plan_mode')).toBe('ExitPlanMode')
    expect(resolveCanonicalToolName('skill')).toBe('Skill')
    expect(resolveCanonicalToolName('Skill')).toBe('Skill')
    expect(resolveCanonicalToolName('web_fetch')).toBe('WebFetch')
    expect(resolveCanonicalToolName('read_powershell')).toBe('BashOutput')
    expect(resolveCanonicalToolName('powershell')).toBe('Bash')
    expect(resolveCanonicalToolName('read_bash')).toBe('BashOutput')
  })

  it('translates pre_tool_use payload with snake_case tool name into canonical tool name and remaps args', () => {
    const raw = {
      event: 'pre_tool_use',
      tool_name: 'web_search',
      tool_input: { query: 'test search' },
    }
    const translated = translateCopilotPayload(raw)
    expect(translated.tool_name).toBe('WebSearch')
    expect(translated.tool_input).toEqual({ query: 'test search' })
  })

  it('translates view and edit payloads remapping path to file_path regardless of casing', () => {
    const viewRaw = {
      event: 'pre_tool_use',
      tool_name: 'view',
      tool_input: { path: 'C:/test/file.ts' },
    }
    const viewTrans = translateCopilotPayload(viewRaw)
    expect(viewTrans.tool_name).toBe('Read')
    expect(viewTrans.tool_input.file_path).toBe('C:/test/file.ts')

    const editRaw = {
      event: 'pre_tool_use',
      tool_name: 'edit',
      tool_input: { path: 'C:/test/file.ts', old_str: 'a', new_str: 'b' },
    }
    const editTrans = translateCopilotPayload(editRaw)
    expect(editTrans.tool_name).toBe('Edit')
    expect(editTrans.tool_input.file_path).toBe('C:/test/file.ts')
    expect(editTrans.tool_input.old_str).toBe('a')
    expect(editTrans.tool_input.new_str).toBe('b')
  })

  it('translates read_powershell remapping shellId to id', () => {
    const pollRaw = {
      event: 'pre_tool_use',
      tool_name: 'read_powershell',
      tool_input: { shellId: '123' },
    }
    const pollTrans = translateCopilotPayload(pollRaw)
    expect(pollTrans.tool_name).toBe('BashOutput')
    expect(pollTrans.tool_input.id).toBe('123')
  })
})
