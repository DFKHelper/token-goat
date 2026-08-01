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
import { getDb } from '../src/db.js';
import { globalDbPath } from '../src/constants.js';
import { VERSION } from '../src/version.js';

function nonce(): string {
  return `hsvd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function seedOldSkillVersionSnapshot(sessionId: string): void {
  const db = getDb(globalDbPath());
  db.prepare(
    `INSERT INTO skill_version_snapshots (session_id, skill_name, loaded_version, loaded_commands_json, notified_at)
     VALUES (@sessionId, 'token-goat', '0.0.0-test-old', '[]', NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       skill_name = 'token-goat', loaded_version = '0.0.0-test-old', loaded_commands_json = '[]', notified_at = NULL`,
  ).run({ sessionId });
}

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

  it('user_prompt_submit passes through without calling git for short prompts', () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        prompt: 'k',
        cwd: '/tmp',
      },
    };
    const result = userPromptSubmitHandler(event);
    expect(result.hookType).toBe('pass');
    expect(util.runGit).not.toHaveBeenCalled();
  });

  it('user_prompt_submit emits a branch hint for longer prompts', () => {
    vi.mocked(util.runGit).mockReturnValue({ stdout: 'feature/foo', stderr: '', exitCode: 0 });
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        prompt: 'this is a longer test prompt that should pass the length check',
        cwd: '/tmp/repo',
      },
    };
    const result = userPromptSubmitHandler(event);
    expect(result.hookType).toBe('context');
    expect((result as { context: string }).context).toContain('feature/foo');
  });

  it('subagent_stop passes through without calling git when sessionId is missing', () => {
    const event: HookEvent = {
      eventName: 'subagent_stop',
      toolName: undefined,
      toolInput: {},
      sessionId: '',
      agentId: undefined,
      raw: { cwd: '/tmp/repo' },
    };
    const result = subagentStopHandler(event);
    expect(result.hookType).toBe('pass');
    expect(util.runGit).not.toHaveBeenCalled();
  });

  it('subagent_stop passes through without calling git when cwd is missing', () => {
    const event: HookEvent = {
      eventName: 'subagent_stop',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test-session',
      agentId: undefined,
      raw: {},
    };
    const result = subagentStopHandler(event);
    expect(result.hookType).toBe('pass');
    expect(util.runGit).not.toHaveBeenCalled();
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
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
        agentId: undefined,
        raw: { cwd: '/tmp/repo' },
      };

      subagentStopHandler(event);

      expect(util.runGit).toHaveBeenCalledWith(
        ['status', '--porcelain'],
        { cwd: '/tmp/repo', timeoutMs: 333 },
      );
    });
  });

  describe('non-string raw.cwd (regression: both handlers previously cast `event.raw[\'cwd\'] as string | undefined` with no runtime check, so a malformed/harness-divergent payload where cwd is present but not a string -- e.g. a number -- would pass the truthy check and be handed straight to runGit as its cwd option)', () => {
    it('userPromptSubmitHandler never calls runGit when raw.cwd is not a string', () => {
      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check', cwd: 12345 },
      };

      userPromptSubmitHandler(event);

      expect(util.runGit).not.toHaveBeenCalled();
    });

    it('subagentStopHandler never calls runGit when raw.cwd is not a string', () => {
      const event: HookEvent = {
        eventName: 'subagent_stop',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        agentId: undefined,
        raw: { cwd: 12345 },
      };

      subagentStopHandler(event);

      expect(util.runGit).not.toHaveBeenCalled();
    });
  });

  describe('skill_version_drift wiring (token-goat upgraded since the skill was loaded)', () => {
    it('surfaces the drift nudge alongside the branch line when both apply', () => {
      vi.mocked(util.runGit).mockReturnValue({ stdout: 'main', stderr: '', exitCode: 0 });
      const sessionId = nonce();
      seedOldSkillVersionSnapshot(sessionId);

      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId,
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check', cwd: '/tmp/repo' },
      };

      const result = userPromptSubmitHandler(event);
      expect(result.hookType).toBe('context');
      const context = (result as { context: string }).context;
      expect(context).toContain('branch: main');
      expect(context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
      expect(context).toContain('token-goat commands');
    });

    it('surfaces the drift nudge on its own when there is no branch to report', () => {
      vi.mocked(util.runGit).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
      const sessionId = nonce();
      seedOldSkillVersionSnapshot(sessionId);

      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId,
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check' },
      };

      const result = userPromptSubmitHandler(event);
      expect(result.hookType).toBe('context');
      expect((result as { context: string }).context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
    });

    it('does not repeat the nudge on a second turn in the same session', () => {
      vi.mocked(util.runGit).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
      const sessionId = nonce();
      seedOldSkillVersionSnapshot(sessionId);

      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId,
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check' },
      };

      const first = userPromptSubmitHandler(event);
      expect(first.hookType).toBe('context');

      const second = userPromptSubmitHandler(event);
      // No branch (empty stdout) and no drift left to report (already notified) -> nothing to say.
      expect(second.hookType).toBe('pass');
    });

    it('does not nudge a session that never loaded the token-goat skill', () => {
      vi.mocked(util.runGit).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId: nonce(),
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check' },
      };

      const result = userPromptSubmitHandler(event);
      expect(result.hookType).toBe('pass');
    });

    // Regression: the short-prompt length gate (< 8 trimmed chars) predates the drift-nudge
    // feature and originally only existed to skip the git-branch subprocess for trivial prompts
    // like "ok"/"yes"/"go". checkSkillVersionDrift was later added AFTER that same early return,
    // so real, pending drift was silently never surfaced (and never marked notified) whenever a
    // session's next turn happened to be short -- a very common real pattern ("continue", "yes",
    // "go on", "next"). The nudge should still surface on a short prompt, even though no branch
    // line is computed for it.
    it('still surfaces the drift nudge on a short prompt (below the git-branch length gate)', () => {
      const sessionId = nonce();
      seedOldSkillVersionSnapshot(sessionId);

      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId,
        agentId: undefined,
        raw: { prompt: 'ok', cwd: '/tmp/repo' },
      };

      const result = userPromptSubmitHandler(event);
      expect(util.runGit).not.toHaveBeenCalled();
      expect(result.hookType).toBe('context');
      expect((result as { context: string }).context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
    });
  });
});
