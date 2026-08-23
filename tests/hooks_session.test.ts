import { tempConfigPath } from './helpers/temp-config.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
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

const _testConfigPath = tempConfigPath('tg-hooks-session-config-test.toml');

import { pendingContextHandler, subagentStopHandler, userPromptSubmitHandler } from '../src/hooks_session.js';
import { clearModuleCaches } from '../src/reset.js';
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

  it('user_prompt_submit passes through without calling git for short prompts', async () => {
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
    const result = await userPromptSubmitHandler(event);
    expect(result.hookType).toBe('pass');
    expect(util.runGit).not.toHaveBeenCalled();
  });

  it('advises only once when a continuation loop starts', async () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: 'continue' },
    };

    const first = await userPromptSubmitHandler(event);
    const second = await userPromptSubmitHandler(event);

    expect((first as { context: string }).context).toContain('checkpoint')
    expect(second.hookType).toBe('pass')
  });

  it('advises independently for continuation loops in separate sessions', async () => {
    const first = await userPromptSubmitHandler({
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: 'continue' },
    });
    const second = await userPromptSubmitHandler({
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: 'continue' },
    });

    expect(first.hookType).toBe('context');
    expect(second.hookType).toBe('context');
  });

  it.each([25, 100, 250])('advises after %i observed scheduled prompt deliveries', async (sequence) => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: '[Scheduled prompt #5] Continue improving the project.' },
    };

    for (let occurrence = 1; occurrence < sequence; occurrence += 1) {
      const result = await userPromptSubmitHandler(event);
      expect(result.hookType).toBe([25, 100, 250].includes(occurrence) ? 'context' : 'pass');
    }
    const threshold = await userPromptSubmitHandler(event);
    const subsequent = await userPromptSubmitHandler(event);

    expect((threshold as { context: string }).context).toContain('start a fresh session');
    expect(subsequent.hookType).toBe('pass');
  });

  it('does not treat the schedule identifier as an observed occurrence count', async () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: '[Scheduled prompt #25] Continue improving the project.' },
    };

    expect((await userPromptSubmitHandler(event)).hookType).toBe('pass');
  });

  it('advises when an identical embedded skill payload is replayed', async () => {
    const event: HookEvent = {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt: '<skill-context name="example">Repeated payload</skill-context>' },
    };

    expect((await userPromptSubmitHandler(event)).hookType).toBe('pass')
    const replay = await userPromptSubmitHandler(event);
    expect((replay as { context: string }).context).toContain('already provided')
  });

  it('does not treat the first skill payload in a separate session as a replay', async () => {
    const prompt = '<skill-context name="example">Repeated payload</skill-context>';
    const firstSession = await userPromptSubmitHandler({
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt },
    });
    const secondSession = await userPromptSubmitHandler({
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: nonce(),
      agentId: undefined,
      raw: { prompt },
    });

    expect(firstSession.hookType).toBe('pass');
    expect(secondSession.hookType).toBe('pass');
  });

  it('user_prompt_submit emits a branch hint for longer prompts', async () => {
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
    const result = await userPromptSubmitHandler(event);
    expect(result.hookType).toBe('context');
    expect((result as { context: string }).context).toContain('feature/foo');
  });

  it('subagent_stop passes through without calling git when sessionId is missing', async () => {
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

  it('subagent_stop passes through without calling git when cwd is missing', async () => {
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
    it('does not warn when the report is a readonly research summary and git status is clean', async () => {
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

    it('does not warn when the report claims a fix AND a commit and git status is clean (legitimate success, not a hallucination)', async () => {
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

    it('does not warn when the report claims work was pushed and git status is clean', async () => {
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

    it('warns when the report claims an implementation and git status is clean', async () => {
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

    it('does not warn when the report claims a fix but git status has changes', async () => {
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

    it('does not warn when the report has no claimed-change verbs despite clean status', async () => {
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

    it('does not warn when raw event has no last_assistant_message field (real minimal payload shape)', async () => {
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
    it('userPromptSubmitHandler passes the configured value through to runGit as timeoutMs', async () => {
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

      await userPromptSubmitHandler(event);

      expect(util.runGit).toHaveBeenCalledWith(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: '/tmp/repo', timeoutMs: 777 },
      );
    });

    it('subagentStopHandler passes the configured value through to runGit as timeoutMs', async () => {
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
    it('userPromptSubmitHandler never calls runGit when raw.cwd is not a string', async () => {
      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId: 'test-session',
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check', cwd: 12345 },
      };

      await userPromptSubmitHandler(event);

      expect(util.runGit).not.toHaveBeenCalled();
    });

    it('subagentStopHandler never calls runGit when raw.cwd is not a string', async () => {
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
    it('surfaces the drift nudge alongside the branch line when both apply', async () => {
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

      const result = await userPromptSubmitHandler(event);
      expect(result.hookType).toBe('context');
      const context = (result as { context: string }).context;
      expect(context).toContain('branch: main');
      expect(context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
      expect(context).toContain('token-goat commands');
    });

    it('surfaces the drift nudge on its own when there is no branch to report', async () => {
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

      const result = await userPromptSubmitHandler(event);
      expect(result.hookType).toBe('context');
      expect((result as { context: string }).context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
    });

    it('does not repeat the nudge on a second turn in the same session', async () => {
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

      const first = await userPromptSubmitHandler(event);
      expect(first.hookType).toBe('context');

      const second = await userPromptSubmitHandler(event);
      // No branch (empty stdout) and no drift left to report (already notified) -> nothing to say.
      expect(second.hookType).toBe('pass');
    });

    it('does not nudge a session that never loaded the token-goat skill', async () => {
      vi.mocked(util.runGit).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
      const event: HookEvent = {
        eventName: 'user_prompt_submit',
        toolName: undefined,
        toolInput: {},
        sessionId: nonce(),
        agentId: undefined,
        raw: { prompt: 'this is a long enough prompt to pass the length check' },
      };

      const result = await userPromptSubmitHandler(event);
      expect(result.hookType).toBe('pass');
    });

    // Regression: the short-prompt length gate (< 8 trimmed chars) predates the drift-nudge
    // feature and originally only existed to skip the git-branch subprocess for trivial prompts
    // like "ok"/"yes"/"go". checkSkillVersionDrift was later added AFTER that same early return,
    // so real, pending drift was silently never surfaced (and never marked notified) whenever a
    // session's next turn happened to be short -- a very common real pattern ("continue", "yes",
    // "go on", "next"). The nudge should still surface on a short prompt, even though no branch
    // line is computed for it.
    it('still surfaces the drift nudge on a short prompt (below the git-branch length gate)', async () => {
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

      const result = await userPromptSubmitHandler(event);
      expect(util.runGit).not.toHaveBeenCalled();
      expect(result.hookType).toBe('context');
      expect((result as { context: string }).context).toContain(`upgraded v0.0.0-test-old -> v${VERSION}`);
    });
  });
});

/**
 * Hints about harness-injected context: an oversized task list, and a skill body that slash-command
 * expansion has sent more than once.
 *
 * Neither shape ever reaches a hook -- PreToolUse never fires for TaskCreate/TaskUpdate, and slash
 * expansion happens before any hook runs -- so the only place they are observable is the transcript
 * file whose path the hook payload already carries. These tests drive that path end to end: a real
 * file on disk, read through the same tail-and-filter the hook uses.
 */
describe('resident-context hints', () => {
  const written: string[] = [];

  afterEach(() => {
    while (written.length > 0) {
      const file = written.pop();
      if (file !== undefined) {
        try {
          unlinkSync(file);
        } catch {
          // Already gone.
        }
      }
    }
  });

  function writeTranscript(lines: string[]): string {
    const file = join(tmpdir(), `tg-hs-transcript-${process.pid}-${nonce()}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    written.push(file);
    return file;
  }

  function taskReminder(completed: number, pending: number, descriptionSize: number): string {
    const items = [
      ...Array.from({ length: completed }, (_, i) => ({
        id: `c${i}`,
        subject: `done ${i}`,
        description: 'd'.repeat(descriptionSize),
        status: 'completed',
      })),
      ...Array.from({ length: pending }, (_, i) => ({
        id: `p${i}`,
        subject: `todo ${i}`,
        description: 'p'.repeat(descriptionSize),
        status: 'pending',
      })),
    ];
    return JSON.stringify({ attachment: { type: 'task_reminder', itemCount: items.length, content: items } });
  }

  function skillBody(name: string, size: number): string {
    // Forward-slash spelling on purpose; the Windows backslash spelling is covered in
    // tests/resident_context.test.ts, and the name parser accepts either separator.
    const text = `Base directory for this skill: /home/someone/.claude/skills/${name}\n\n# ${name}\n\n${'x'.repeat(size)}`;
    return JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  function promptEvent(sessionId: string, transcriptPath?: string): HookEvent {
    return {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId,
      agentId: undefined,
      raw: { prompt: 'ok', ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}) },
    };
  }

  it('warns about a large task list and points at the tool that can prune it', async () => {
    const transcript = writeTranscript([taskReminder(40, 4, 900)]);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('context');
    const context = (result as { context: string }).context;
    expect(context).toContain('40 of 44');
    expect(context).toContain('TaskUpdate');
  });

  it('warns only once per session, so the scan stops running after it fires', async () => {
    const transcript = writeTranscript([taskReminder(40, 4, 900)]);
    const sessionId = nonce();

    const first = await userPromptSubmitHandler(promptEvent(sessionId, transcript));
    const second = await userPromptSubmitHandler(promptEvent(sessionId, transcript));

    expect((first as { context: string }).context).toContain('TaskUpdate');
    expect(second.hookType).toBe('pass');
  });

  it('says nothing about a small task list', async () => {
    const transcript = writeTranscript([taskReminder(2, 1, 20)]);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('pass');
  });

  it('says nothing about a large list that is all outstanding work', async () => {
    // Nothing completed means nothing to prune; advising a prune here would be wrong.
    const transcript = writeTranscript([taskReminder(0, 40, 900)]);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('pass');
  });

  it('attributes a skill body that slash expansion injected more than once', async () => {
    const transcript = writeTranscript([skillBody('superman', 40_000), skillBody('superman', 40_000)]);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('context');
    const context = (result as { context: string }).context;
    expect(context).toContain('`superman`');
    expect(context).toContain('2 times');
  });

  it('says nothing about a skill body injected once', async () => {
    const transcript = writeTranscript([skillBody('superman', 40_000)]);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('pass');
  });

  it('passes through when the payload carries no transcript path', async () => {
    const result = await userPromptSubmitHandler(promptEvent(nonce()));

    expect(result.hookType).toBe('pass');
  });

  it('passes through when the transcript path does not exist, rather than throwing', async () => {
    const missing = join(tmpdir(), `tg-hs-absent-${nonce()}.jsonl`);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), missing));

    expect(result.hookType).toBe('pass');
  });

  it('passes through on a corrupt transcript rather than failing the user turn', async () => {
    const transcript = writeTranscript(['not json', '{"broken":', '']);

    const result = await userPromptSubmitHandler(promptEvent(nonce(), transcript));

    expect(result.hookType).toBe('pass');
  });
});

/**
 * Harness routing for prompt-submit hints.
 *
 * Copilot CLI runs the prompt-submit hook and then drops whatever it returns, so returning context
 * there delivers nothing at all. The hint is queued instead and handed over on the next tool call,
 * where postToolUse's additionalContext does reach the model.
 *
 * Both halves are pinned in one test on purpose. A queue with no drain and a drain with no queue
 * each deliver nothing, and each would still pass a test that watched only its own side.
 */
describe('prompt-submit hint routing by harness', () => {
  const written: string[] = [];
  let prevHarness: string | undefined;

  beforeEach(() => {
    prevHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE'];
  });

  afterEach(() => {
    if (prevHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE'];
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevHarness;
    clearModuleCaches();
    while (written.length > 0) {
      const file = written.pop();
      if (file !== undefined) {
        try {
          unlinkSync(file);
        } catch {
          // Already gone.
        }
      }
    }
  });

  // Harness detection is memoized, so the cache has to be dropped after the env changes.
  function setHarness(name: string): void {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = name;
    clearModuleCaches();
  }

  /** A transcript carrying one oversized task list, which is enough to produce a hint. */
  function bigTaskListTranscript(): string {
    const items = Array.from({ length: 44 }, (_, i) => ({
      id: `t${i}`,
      subject: `item ${i}`,
      description: 'd'.repeat(900),
      status: i < 40 ? 'completed' : 'pending',
    }));
    const line = JSON.stringify({
      attachment: { type: 'task_reminder', itemCount: items.length, content: items },
    });
    const file = join(tmpdir(), `tg-hs-routing-${process.pid}-${nonce()}.jsonl`);
    writeFileSync(file, `${line}\n`, 'utf8');
    written.push(file);
    return file;
  }

  function submitEvent(sessionId: string, transcriptPath: string): HookEvent {
    return {
      eventName: 'user_prompt_submit',
      toolName: undefined,
      agentId: undefined,
      toolInput: {},
      sessionId,
      raw: { prompt: 'ok', transcript_path: transcriptPath },
    };
  }

  function toolEvent(sessionId: string): HookEvent {
    return {
      eventName: 'post_tool_use',
      toolName: 'Read',
      agentId: undefined,
      toolInput: {},
      sessionId,
      raw: {},
    };
  }

  it('queues the hint on Copilot CLI and delivers it on the next tool call', async () => {
    setHarness('copilot_cli');
    const sessionId = nonce();

    const submitted = await userPromptSubmitHandler(submitEvent(sessionId, bigTaskListTranscript()));
    expect(submitted.hookType).toBe('pass');

    const delivered = pendingContextHandler(toolEvent(sessionId));
    expect(delivered.hookType).toBe('context');
    expect((delivered as { context: string }).context).toContain('TaskUpdate');

    // The drain runs on every tool call, so a second one must add nothing; otherwise a one-shot
    // nudge becomes a per-tool-call tax for the rest of the session.
    expect(pendingContextHandler(toolEvent(sessionId)).hookType).toBe('pass');
  });

  it('returns the hint directly on Claude Code, and leaves nothing queued behind it', async () => {
    setHarness('claudecode');
    const sessionId = nonce();

    const submitted = await userPromptSubmitHandler(submitEvent(sessionId, bigTaskListTranscript()));
    expect(submitted.hookType).toBe('context');
    expect((submitted as { context: string }).context).toContain('TaskUpdate');

    // Queuing here as well would deliver the same hint twice, once per channel.
    expect(pendingContextHandler(toolEvent(sessionId)).hookType).toBe('pass');
  });
});
