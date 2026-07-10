import type { HookEvent } from '../../src/hook_registry.js'

export function makeHookEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: {},
    sessionId: 's1',
    agentId: undefined,
    raw: {},
    ...overrides,
  }
}
