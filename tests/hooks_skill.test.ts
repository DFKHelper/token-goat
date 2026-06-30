import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HookEvent } from '../src/hook_registry.js';
import { runHook } from '../src/hook_registry.js';
import { preSkillHandler, postSkillHandler } from '../src/hooks_skill.js';
import {
  setSkillOutputsDirForTesting,
  setSkillsSourceDirForTesting,
  getAllCachedSkills,
} from '../src/skill_cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.resolve(__dirname, '.temp-hooks-skill-cache');
const sourceDir = path.resolve(__dirname, '.temp-hooks-skill-source');

async function freshDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true });
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
  return {
    eventName: 'post_tool_use',
    toolName: 'Skill',
    toolInput: { skill },
    sessionId,
    raw: { tool_response: body },
  };
}

describe('postSkillHandler — caches the loaded body under the real skill name', () => {
  // Regression for the bug where postSkillHandler was a no-op stub: it extracted the
  // skill name + body but never called storeOutput, so `skill-compact <name>` could
  // never find a skill loaded via the Skill tool. Pre-fix this assertion sees zero
  // cached skills; post-fix it sees the body cached under the name the user types.
  it('stores the body so the skill is recallable by its directory name', async () => {
    const body = 'Body for the ollama skill.\n<!-- COMPACT_END -->\nrules go here';
    const result = await postSkillHandler(skillPostEvent('ollama', body));
    expect(result.hookType).toBe('pass');

    const cached = await getAllCachedSkills();
    const names = cached.map((s) => s.name);
    expect(names).toContain('ollama');
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

describe('preSkillHandler — pass-through scaffold (no side-effect by design)', () => {
  it('returns pass for a Skill event and stores nothing', async () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Skill',
      toolInput: { skill: 'ollama' },
      sessionId: 'sess-1',
      raw: {},
    };
    expect(preSkillHandler(event).hookType).toBe('pass');
    expect(await getAllCachedSkills()).toHaveLength(0);
  });

  it('returns pass for a non-Skill tool', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: {},
      sessionId: 'sess-1',
      raw: {},
    };
    expect(preSkillHandler(event).hookType).toBe('pass');
  });
});
