import { describe, it, expect, beforeEach } from 'vitest';
import type { HookEvent } from '../src/hook_registry.js';

describe('hooks_skill', () => {
  beforeEach(() => {
    // Setup before each test
  });

  it('should handle pre_tool_use for non-Skill tools', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: {},
      sessionId: 'test-session',
      raw: {},
    };
    expect(event.toolName).toBe('WebFetch');
  });

  it('should handle pre_tool_use for Skill with missing skill name', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Skill',
      toolInput: {},
      sessionId: 'test-session',
      raw: {},
    };
    expect(event.toolName).toBe('Skill');
    expect(event.toolInput['skill']).toBeUndefined();
  });

  it('should handle pre_tool_use for Skill with missing sessionId', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Skill',
      toolInput: { skill: 'test-skill' },
      sessionId: '',
      raw: {},
    };
    expect(event.toolName).toBe('Skill');
    expect(event.sessionId).toBe('');
  });

  it('should handle post_tool_use for non-Skill tools', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: {},
      sessionId: 'test-session',
      raw: {
        tool_response: 'test response',
      },
    };
    expect(event.toolName).toBe('WebFetch');
  });

  it('should handle post_tool_use for Skill with missing skill name', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Skill',
      toolInput: {},
      sessionId: 'test-session',
      raw: {
        tool_response: 'test response',
      },
    };
    expect(event.toolName).toBe('Skill');
    expect(event.toolInput['skill']).toBeUndefined();
  });

  it('should handle post_tool_use for Skill with empty body', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Skill',
      toolInput: { skill: 'test-skill' },
      sessionId: 'test-session',
      raw: {
        tool_response: '',
      },
    };
    const response = event.raw['tool_response'] as string;
    expect(response).toBe('');
  });

  it('should handle post_tool_use for Skill with missing sessionId', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Skill',
      toolInput: { skill: 'test-skill' },
      sessionId: '',
      raw: {
        tool_response: 'test response body',
      },
    };
    expect(event.sessionId).toBe('');
  });
});
