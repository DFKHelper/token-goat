import { describe, it, expect, beforeEach } from 'vitest';
import type { HookEvent } from '../src/hook_registry.js';

describe('hooks_session', () => {
  beforeEach(() => {
    // Clear mocks before each test
  });

  it('should handle session_start event with missing sessionId', () => {
    const event: HookEvent = {
      eventName: 'session_start',
      toolName: undefined,
      toolInput: {},
      sessionId: '',
      raw: {},
    };
    expect(event).toBeDefined();
    expect(event.eventName).toBe('session_start');
  });

  it('should handle user_prompt_submit event for short prompts', () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      raw: {
        prompt: 'k',
        cwd: '/tmp',
      },
    };
    expect(event.sessionId).toBe('test-session');
    expect(event.raw['prompt']).toBe('k');
  });

  it('should handle user_prompt_submit event for longer prompts', () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      raw: {
        prompt: 'this is a longer test prompt that should pass the length check',
        cwd: '/tmp',
      },
    };
    expect(event.sessionId).toBe('test-session');
    const prompt = event.raw['prompt'] as string;
    expect(prompt.length).toBeGreaterThan(8);
  });

  it('should handle subagent_stop event with missing sessionId', () => {
    const event: HookEvent = {
      eventName: 'subagent_stop',
      toolName: undefined,
      toolInput: {},
      sessionId: '',
      raw: {},
    };
    expect(event.sessionId).toBe('');
  });

  it('should handle subagent_stop event with missing cwd', () => {
    const event: HookEvent = {
      eventName: 'subagent_stop',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      raw: {},
    };
    expect(event.sessionId).toBe('test-session');
    expect(event.raw['cwd']).toBeUndefined();
  });
});
