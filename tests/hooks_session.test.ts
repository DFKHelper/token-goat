import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookEvent } from '../src/hook_registry.js';
import * as util from '../src/util.js';

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runGit: vi.fn() };
});

// Redirects configPath() to a per-test-file temp file so the hints.git_hint_max_ms wiring
// tests can set a non-default config value deterministically. Mirrors tests/hooks_bash.test.ts.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, configPath: () => _testConfigPath };
});

const _testConfigPath = join(tmpdir(), `tg-hooks-session-config-test-${process.pid}.toml`);

import { subagentStopHandler, userPromptSubmitHandler } from '../src/hooks_session.js';
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js';

describe('hooks_session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateConfigCache();
  });

  afterEach(() => {
    invalidateConfigCache();
    try {
      unlinkSync(_testConfigPath);
    } catch {
      // ok -- may not exist
    }
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
    it('does not warn when the report is a readonly research summary and git status is clean', () => {
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
          last_assistant_message: 'Searched the codebase and found the relevant function at line 42',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when the report claims a fix AND a commit and git status is clean (legitimate success, not a hallucination)', () => {
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
          last_assistant_message: 'Fixed the bug in auth.ts and committed the change',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when the report claims work was pushed and git status is clean', () => {
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
          last_assistant_message: 'Implemented the feature, committed, and pushed to origin',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('warns when the report claims an implementation and git status is clean', () => {
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
          last_assistant_message: 'I have implemented the new feature for user profiles',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('subagent-stop')
      );
      warnSpy.mockRestore();
    });

    it('does not warn when the report claims a fix but git status has changes', () => {
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
          last_assistant_message: 'Fixed the bug in the auth module',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when the report has no claimed-change verbs despite clean status', () => {
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
          last_assistant_message: 'Examined the architecture and explained how it works',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when raw event has no last_assistant_message field (real minimal payload shape)', () => {
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
          transcript_path: '/tmp/transcript.jsonl',
          hook_event_name: 'SubagentStop',
        },
      };

      subagentStopHandler(event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('hints.git_hint_max_ms wiring', () => {
    it('userPromptSubmitHandler passes the configured value through to runGit as timeoutMs', () => {
      const cfg = defaultConfig();
      cfg.hints.git_hint_max_ms = 777;
      saveConfig(cfg);
      invalidateConfigCache();

      vi.mocked(util.runGit).mockReturnValue({ stdout: 'main', stderr: '', exitCode: 0 });

      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: { prompt: 'this is a long enough prompt to pass the length check', cwd: '/tmp/repo' },
      };

      userPromptSubmitHandler(event);

      expect(util.runGit).toHaveBeenCalledWith(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: '/tmp/repo', timeoutMs: 777 },
      );
    });

    it('subagentStopHandler passes the configured value through to runGit as timeoutMs', () => {
      const cfg = defaultConfig();
      cfg.hints.git_hint_max_ms = 333;
      saveConfig(cfg);
      invalidateConfigCache();

      vi.mocked(util.runGit).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });

      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        raw: { cwd: '/tmp/repo' },
      };

      subagentStopHandler(event);

      expect(util.runGit).toHaveBeenCalledWith(
        ['status', '--porcelain'],
        { cwd: '/tmp/repo', timeoutMs: 333 },
      );
    });
  });
});
