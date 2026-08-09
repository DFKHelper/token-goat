import { tempConfigPath } from './helpers/temp-config.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// vi.mock is hoisted -- this redirects configPath() to a per-test-file temp file so the
// hints.pre_skill_advisory wiring tests below can set a non-default config value
// deterministically. Mirrors tests/hooks_read.test.ts's config.toml mock.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    configPath: () => _testConfigPath,
  };
});

const _testConfigPath = tempConfigPath('tg-hooks-skill-config-test.toml');

import type { HookEvent } from '../src/hook_registry.js';
import { runHook } from '../src/hook_registry.js';
import { preSkillHandler, postSkillHandler } from '../src/hooks_skill.js';
import {
  setSkillOutputsDirForTesting,
  setSkillsSourceDirForTesting,
  getAllCachedSkills,
  hasSessionOutput,
  storeOutput,
} from '../src/skill_cache.js';
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js';
import { makeHookEvent } from './helpers/hook-event.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.resolve(__dirname, '.temp-hooks-skill-cache');
const sourceDir = path.resolve(__dirname, '.temp-hooks-skill-source');

async function freshDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // not present yet
  }
  await fs.mkdir(dir, { recursive: true });
}

beforeEach(async () => {
  await freshDir(cacheDir);
  await freshDir(sourceDir);
  setSkillOutputsDirForTesting(cacheDir);
  setSkillsSourceDirForTesting(sourceDir);
});

afterEach(() => {
  setSkillOutputsDirForTesting(null);
  setSkillsSourceDirForTesting(null);
});

function skillPostEvent(skill: string, body: string, sessionId = 'sess-1'): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Skill',
    toolInput: { skill },
    sessionId,
    raw: { tool_response: body },
  });
}

describe('postSkillHandler — caches the loaded body under the real skill name', () => {
  // Regression for the bug where postSkillHandler was a no-op stub: it extracted the skill name + body but never called storeOutput, so `skill-compact <name>` could never find a skill loaded via the Skill tool. Pre-fix this assertion sees zero cached skills; post-fix it sees the body cached under the name the user types.
  it('stores the body so the skill is recallable by its directory name', async () => {
    const body = 'Body for the ollama skill.\n<!-- COMPACT_END -->\nrules go here';
    const result = await postSkillHandler(skillPostEvent('ollama', body));
    expect(result.hookType).toBe('pass');

    const cached = await getAllCachedSkills();
    const names = cached.map((s) => s.name);
    // The cache is reset in beforeEach, so this one postSkillHandler call is the only entry.
    expect(names).toEqual(['ollama']);
    const entry = cached.find((s) => s.name === 'ollama');
    expect(entry).toBeDefined();
    expect(entry!.bodyLen).toBe(Buffer.byteLength(body, 'utf-8'));
  });

  it('drives through the real registry dispatch (runHook), not just the function', async () => {
    const body = 'Registry-dispatched body.\n<!-- COMPACT_END -->\nx';
    const out = await runHook(skillPostEvent('codex', body, 'sess-reg'));
    expect(out.hookType).toBe('pass');

    const cached = await getAllCachedSkills();
    expect(cached.map((s) => s.name)).toContain('codex');
  });

  it('does not store for a non-Skill tool', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { skill: 'ollama' },
      sessionId: 'sess-1',
      agentId: undefined,
      raw: { tool_response: 'irrelevant body <!-- COMPACT_END -->' },
    };
    const result = await postSkillHandler(event);
    expect(result.hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });

  it('does not store when the skill name is missing', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Skill',
      toolInput: {},
      sessionId: 'sess-1',
      agentId: undefined,
      raw: { tool_response: 'body <!-- COMPACT_END -->' },
    };
    const result = await postSkillHandler(event);
    expect(result.hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });

  it('does not store when the sessionId is missing', async () => {
    const result = await postSkillHandler(skillPostEvent('ollama', 'body <!-- COMPACT_END -->', ''));
    expect(result.hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });

  it('does not store when the body is empty', async () => {
    const result = await postSkillHandler(skillPostEvent('ollama', ''));
    expect(result.hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });
});

function skillPreEvent(skill: string, sessionId = 'sess-1'): HookEvent {
  return makeHookEvent({
    toolName: 'Skill',
    toolInput: { skill },
    sessionId,
  });
}

describe('hasSessionOutput — same-session skill-load detection', () => {
  it('is false before any load and true after the body is cached this session', async () => {
    expect(await hasSessionOutput('sess-h', 'ollama')).toBe(false);
    await storeOutput('sess-h', 'ollama', 'cached body for ollama');
    expect(await hasSessionOutput('sess-h', 'ollama')).toBe(true);
  });

  it('is session-scoped: a load under one session is not seen by another', async () => {
    await storeOutput('sess-A', 'codex', 'cached body for codex');
    expect(await hasSessionOutput('sess-A', 'codex')).toBe(true);
    expect(await hasSessionOutput('sess-B', 'codex')).toBe(false);
  });

  it('returns false for an empty session id or unsafe name', async () => {
    await storeOutput('sess-A', 'codex', 'cached body for codex');
    expect(await hasSessionOutput('', 'codex')).toBe(false);
    expect(await hasSessionOutput('sess-A', '')).toBe(false);
  });
});

describe('preSkillHandler — duplicate-load advisory', () => {
  it('passes the first (cold) load of a skill', async () => {
    const out = await preSkillHandler(skillPreEvent('ollama'));
    expect(out.hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });

  it('returns pass for a non-Skill tool', async () => {
    const out = await preSkillHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: {},
      sessionId: 'sess-1',
      agentId: undefined,
      raw: {},
    });
    expect(out.hookType).toBe('pass');
  });

  // Regression for F5: once a skill body is cached this session, a second Skill invocation must be denied with a compact-recall pointer instead of re-injecting the whole body. Drives the REAL registry: post stores via runHook, then a pre dispatch through runHook must come back deny. A no-op preSkillHandler (the pre-fix scaffold) returns pass here and fails this test.
  it('denies a second load through the real runHook dispatch and points at compact recall', async () => {
    const post = await runHook(skillPostEvent('ollama', 'Body for ollama.', 'sess-dup'));
    expect(post.hookType).toBe('pass');

    const pre = await runHook(skillPreEvent('ollama', 'sess-dup'));
    expect(pre.hookType).toBe('deny');
    if (pre.hookType === 'deny') {
      expect(pre.message).toContain('already loaded this session');
      expect(pre.message).toContain('token-goat skill-body ollama --compact');
    }
  });

  it('does not deny a different skill that was not loaded this session', async () => {
    await runHook(skillPostEvent('ollama', 'Body for ollama.', 'sess-dup2'));
    const pre = await runHook(skillPreEvent('codex', 'sess-dup2'));
    expect(pre.hookType).toBe('pass');
  });
});

describe('preSkillHandler — oversized first-load gate', () => {
  // Regression for the bug where only REPEAT loads were size-gated: a skill's full body still landed in context once per session on its first (cold) invocation, even when a compact slice was available on disk. Pre-fix, this cold-load call returns pass (no prior hasSessionOutput entry to trigger the duplicate-load path); post-fix it must deny and name a working recall command for the full body. (The `--compact` spelling this used to assert pinned the refetch pointer itself, which the inline-slice change below deliberately removes on this branch; the invariant worth keeping is deny + a real recall command, so it now asserts the full-body command.)
  it('denies the very first load of an oversized skill that has a compact marker', async () => {
    const skillDir = path.join(sourceDir, 'big-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary of the big skill.';
    const detail = 'x'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('big-skill', 'sess-cold'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain('big-skill');
      expect(out.message).toContain('token-goat skill-body big-skill');
    }
  });

  // Regression: on this branch the handler had ALREADY extracted the compact slice (it is the gate condition) and then threw it away, denying with a pointer telling the agent to run `skill-body <name> --compact` to fetch the very bytes just computed -- an extra reasoning turn plus a Bash round-trip per occurrence. Pre-fix the deny message contains the pointer and not the slice; post-fix the slice ships inline and only the FULL-body command is named.
  it('inlines the compact slice on the oversized first load instead of telling the agent to re-fetch it', async () => {
    const skillDir = path.join(sourceDir, 'inline-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary line one.\nCompact summary line two.';
    const body = `${compact}\n<!-- COMPACT_END -->\n${'x'.repeat(7000)}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('inline-skill', 'sess-inline'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain(compact);
      expect(out.message).toContain('token-goat skill-body inline-skill');
      expect(out.message).not.toContain('--compact');
      // Lossless: the detail past the marker is NOT inlined, it stays behind the named command.
      expect(out.message).not.toContain('x'.repeat(7000));
    }
  });

  // Negative control that holds on BOTH sides of the fix: a compact slice big enough to trip the same oversize gate is not worth inlining, so the original pointer deny stands verbatim and the slice bytes stay out of the message.
  it('still emits the plain pointer deny when the compact slice is itself oversized', async () => {
    const skillDir = path.join(sourceDir, 'huge-compact-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'z'.repeat(6001);
    const body = `${compact}\n<!-- COMPACT_END -->\n${'x'.repeat(7000)}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('huge-compact-skill', 'sess-huge'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain('token-goat skill-body huge-compact-skill --compact');
      expect(out.message).not.toContain(compact);
    }
  });

  it('passes the first load of an oversized skill with no compact marker', async () => {
    const skillDir = path.join(sourceDir, 'big-no-marker');
    await fs.mkdir(skillDir, { recursive: true });
    const body = 'y'.repeat(7000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('big-no-marker', 'sess-cold2'));
    expect(out.hookType).toBe('pass');
  });

  it('passes the first load of a small skill even with a compact marker', async () => {
    const skillDir = path.join(sourceDir, 'small-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const body = 'short compact\n<!-- COMPACT_END -->\nshort detail';
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('small-skill', 'sess-cold3'));
    expect(out.hookType).toBe('pass');
  });
});

// Regression: hints.pre_skill_advisory was defined, validated, persisted, and displayed in
// config.ts but had zero consumers -- both preSkillHandler denies (already-loaded-this-session,
// oversized-first-load) fired unconditionally regardless of the flag's value.
describe('hints.pre_skill_advisory wiring', () => {
  afterEach(() => {
    invalidateConfigCache();
    try {
      fsSync.unlinkSync(_testConfigPath);
    } catch {
      // ok -- may not exist
    }
  });

  it('pre_skill_advisory=true (default) still denies a second load, exactly as today', async () => {
    const cfg = defaultConfig();
    cfg.hints.pre_skill_advisory = true;
    saveConfig(cfg);

    const post = await runHook(skillPostEvent('ollama', 'Body for ollama.', 'sess-flag-true-dup'));
    expect(post.hookType).toBe('pass');

    const pre = await runHook(skillPreEvent('ollama', 'sess-flag-true-dup'));
    expect(pre.hookType).toBe('deny');
    if (pre.hookType === 'deny') {
      expect(pre.message).toContain('already loaded this session');
    }
  });

  it('pre_skill_advisory=true (default) still denies the first load of an oversized skill, exactly as today', async () => {
    const cfg = defaultConfig();
    cfg.hints.pre_skill_advisory = true;
    saveConfig(cfg);

    const skillDir = path.join(sourceDir, 'big-skill-flag-true');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary of the big skill.';
    const detail = 'x'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('big-skill-flag-true', 'sess-flag-true-cold'));
    expect(out.hookType).toBe('deny');
  });

  it('pre_skill_advisory=false suppresses the already-loaded-this-session deny', async () => {
    const cfg = defaultConfig();
    cfg.hints.pre_skill_advisory = false;
    saveConfig(cfg);

    const post = await runHook(skillPostEvent('ollama', 'Body for ollama.', 'sess-flag-false-dup'));
    expect(post.hookType).toBe('pass');

    const pre = await runHook(skillPreEvent('ollama', 'sess-flag-false-dup'));
    expect(pre.hookType).toBe('pass');
  });

  it('pre_skill_advisory=false suppresses the oversized-first-load deny', async () => {
    const cfg = defaultConfig();
    cfg.hints.pre_skill_advisory = false;
    saveConfig(cfg);

    const skillDir = path.join(sourceDir, 'big-skill-flag-false');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary of the big skill.';
    const detail = 'x'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('big-skill-flag-false', 'sess-flag-false-cold'));
    expect(out.hookType).toBe('pass');
  });
});
