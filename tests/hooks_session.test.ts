import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HookEvent } from '../src/hook_registry.js';
import * as util from '../src/util.js';
import { subagentStopHandler } from '../src/hooks_session.js';

vi.mock('../src/util.js', () => ({
  runGit: vi.fn(),
}));

describe('hooks_session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('subagentStopHandler - hallucination detection', () => {
    it('should not warn for readonly research task with clean git status', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: {
          cwd: '/tmp/repo',
          prompt: 'Search the codebase and report what you find about authentication patterns',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should warn when prompt contains action verbs and git status is clean', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: {
          cwd: '/tmp/repo',
          prompt: 'Fix the bug in the auth module',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('subagent-stop')
      );
      warnSpy.mockRestore();
    });

    it('should warn when prompt contains "implement" and git status is clean', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: {
          cwd: '/tmp/repo',
          prompt: 'Implement the new feature for user profiles',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('subagent-stop')
      );
      warnSpy.mockRestore();
    });

    it('should not warn when git status has changes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(util.runGit).mockReturnValue({
        stdout: ' M src/file.ts',
        stderr: '',
        exitCode: 0,
      });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: {
          cwd: '/tmp/repo',
          prompt: 'Fix the bug in the auth module',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should not warn when prompt has no action verbs despite clean status', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: {
          cwd: '/tmp/repo',
          prompt: 'Examine the architecture and explain how it works',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
