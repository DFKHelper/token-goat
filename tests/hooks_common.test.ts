import { describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import {
  contextOutput,
  denyOutput,
  getFilePath,
  getToolInput,
  getToolName,
  isBashTool,
  isEditTool,
  isReadTool,
  isWriteTool,
  passOutput,
} from '../src/hooks_common.js'

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: {},
    sessionId: 's1',
    raw: {},
    ...overrides,
  }
}

describe('hooks_common', () => {
  describe('accessors', () => {
    it('getToolName returns the event tool name', () => {
      expect(getToolName(makeEvent({ toolName: 'Bash' }))).toBe('Bash')
    })

    it('getToolName returns undefined for non-tool events', () => {
      expect(getToolName(makeEvent({ toolName: undefined }))).toBeUndefined()
    })

    it('getToolInput returns the input object', () => {
      const input = { command: 'ls' }
      expect(getToolInput(makeEvent({ toolInput: input }))).toBe(input)
    })

    it('getFilePath extracts file_path', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: '/a/b.ts' } }))).toBe('/a/b.ts')
    })

    it('getFilePath returns undefined when absent', () => {
      expect(getFilePath(makeEvent({ toolInput: {} }))).toBeUndefined()
    })

    it('getFilePath returns undefined for an empty string', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: '' } }))).toBeUndefined()
    })

    it('getFilePath returns undefined for a non-string value', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: 42 } }))).toBeUndefined()
    })
  })

  describe('tool classifiers', () => {
    it('isReadTool', () => {
      expect(isReadTool('Read')).toBe(true)
      expect(isReadTool('Bash')).toBe(false)
      expect(isReadTool(undefined)).toBe(false)
    })

    it('isEditTool', () => {
      expect(isEditTool('Edit')).toBe(true)
      expect(isEditTool('Write')).toBe(false)
      expect(isEditTool(undefined)).toBe(false)
    })

    it('isWriteTool', () => {
      expect(isWriteTool('Write')).toBe(true)
      expect(isWriteTool('Edit')).toBe(false)
      expect(isWriteTool(undefined)).toBe(false)
    })

    it('isBashTool', () => {
      expect(isBashTool('Bash')).toBe(true)
      expect(isBashTool('Read')).toBe(false)
      expect(isBashTool(undefined)).toBe(false)
    })
  })

  describe('output builders', () => {
    it('passOutput', () => {
      expect(passOutput()).toEqual({ hookType: 'pass' })
    })

    it('denyOutput', () => {
      expect(denyOutput('blocked')).toEqual({ hookType: 'deny', message: 'blocked' })
    })

    it('contextOutput', () => {
      expect(contextOutput('hint')).toEqual({ hookType: 'context', context: 'hint' })
    })
  })
})
