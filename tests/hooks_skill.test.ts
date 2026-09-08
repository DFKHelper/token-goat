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
import { summarize } from '../src/stats.js';
import { getDb } from '../src/db.js';
import { dataDir } from '../src/constants.js';
import { PER_FILE_COUNTERFACTUAL_CEILING } from '../src/util.js';

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

  // Regression: a denied re-load genuinely blocks the cached body from reaching the model
  // (same shape as hooks_read.ts's read_count_deny), so the session_hint stat it records
  // should credit those bytes, not the (0, 0) default a bare `recordStat('session_hint')`
  // call produces. Pre-fix this delta is 0; post-fix it equals the cached body's byte size.
  it('credits the blocked body bytes on the duplicate-load deny, not zero', async () => {
    const body = 'Body for ollama.';
    await runHook(skillPostEvent('ollama', body, 'sess-credit'));

    const before = summarize(30).by_kind['session_hint']?.bytes_saved ?? 0
    const pre = await runHook(skillPreEvent('ollama', 'sess-credit'));
    expect(pre.hookType).toBe('deny');
    const delta = (summarize(30).by_kind['session_hint']?.bytes_saved ?? 0) - before

    expect(delta).toBe(Buffer.byteLength(body, 'utf-8'));
  });

  it('caps the credited bytes at PER_FILE_COUNTERFACTUAL_CEILING for an oversized cached body', async () => {
    const body = 'x'.repeat(PER_FILE_COUNTERFACTUAL_CEILING + 50_000);
    await runHook(skillPostEvent('ollama', body, 'sess-credit-cap'));

    const before = summarize(30).by_kind['session_hint']?.bytes_saved ?? 0
    const pre = await runHook(skillPreEvent('ollama', 'sess-credit-cap'));
    expect(pre.hookType).toBe('deny');
    const delta = (summarize(30).by_kind['session_hint']?.bytes_saved ?? 0) - before

    expect(delta).toBe(PER_FILE_COUNTERFACTUAL_CEILING);
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
    // Original intent unchanged -- a slice too large to inline still gets the pointer. Only the bound moved: the inline decision no longer reuses the 6000-byte oversize gate, so the fixture has to clear COMPACT_INLINE_MAX_BYTES (24_000) to still be "oversized" for this purpose.
    const compact = 'z'.repeat(24_001);
    const body = `${compact}\n<!-- COMPACT_END -->\n${'x'.repeat(7000)}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('huge-compact-skill', 'sess-huge'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain('token-goat skill-body huge-compact-skill --compact');
      expect(out.message).not.toContain(compact);
    }
  });

  // The band this change actually opens: a slice over the 6000-byte oversize gate but under the inline cap used to be denied, and the agent then ran `skill-body --compact` and received these exact bytes one turn later, having also paid the deny text, a reasoning turn and a Bash spawn. Denying never withheld anything -- it only delayed it and added a round trip, which is why the old branch recorded traffic and zero savings.
  it('inlines a compact slice that is over the oversize gate but under the inline cap', async () => {
    const skillDir = path.join(sourceDir, 'midband-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'm'.repeat(9000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${'x'.repeat(50_000)}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('midband-skill', 'sess-mid'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain(compact);
      expect(out.message).not.toContain('--compact');
    }
  });

  it('points rather than inlines when the compact slice saves nothing against the body', async () => {
    const skillDir = path.join(sourceDir, 'degenerate-compact');
    await fs.mkdir(skillDir, { recursive: true });
    // A marker at the very end makes the "compact" slice the whole body: inlining it would hand over every byte while claiming a saving, so the pointer has to win even though the slice is under the cap.
    const compact = 'q'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent('degenerate-compact', 'sess-degen'));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny') {
      expect(out.message).toContain('token-goat skill-body degenerate-compact --compact');
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

  it('cached-skill notice offers skill-section before skill-body', async () => {
    const skillName = 'cached-skill-section-test';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const body = 'Cached skill body.';
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const sessionId = 'sess-cached-skill-test';

    // First load to cache the skill via the hook
    const post = await runHook(skillPostEvent(skillName, body, sessionId));
    expect(post.hookType).toBe('pass');

    // Second load should trigger the cached-skill notice
    const pre = await runHook(skillPreEvent(skillName, sessionId));
    expect(pre.hookType).toBe('deny');
    if (pre.hookType === 'deny' && pre.message) {
      expect(pre.message).toContain('skill-section');
      expect(pre.message).toContain('skill-body');
      expect(pre.message.indexOf('skill-section') < pre.message.lastIndexOf('skill-body')).toBe(true);
    }
  });

  it('inlined-compact notice offers skill-section before skill-body', async () => {
    const skillName = 'inlined-compact-skill-section-test';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary.';
    const detail = 'x'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const sessionId = 'sess-inlined-compact-test';
    const out = await preSkillHandler(skillPreEvent(skillName, sessionId));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny' && out.message) {
      expect(out.message).toContain('inlined below');
      expect(out.message).toContain('skill-section');
      expect(out.message).toContain('skill-body');
      expect(out.message.indexOf('skill-section') < out.message.lastIndexOf('skill-body')).toBe(true);
    }
  });

  it('oversized-skill notice offers skill-section before skill-body', async () => {
    const skillName = 'oversized-skill-section-test';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    // Create a skill that is oversized but the compact won't inline (compact > COMPACT_INLINE_MAX_BYTES)
    const compact = 'x'.repeat(25000);
    const detail = 'y'.repeat(7000);
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const sessionId = 'sess-oversized-test';
    const out = await preSkillHandler(skillPreEvent(skillName, sessionId));
    expect(out.hookType).toBe('deny');
    if (out.hookType === 'deny' && out.message) {
      expect(out.message).toContain('has a compact slice available');
      expect(out.message).toContain('skill-section');
      expect(out.message).toContain('skill-body');
      expect(out.message.indexOf('skill-section') < out.message.lastIndexOf('skill-body')).toBe(true);
    }
  });
});

// HAND-DERIVED fixtures below: bodies are constructed directly from the heading/byte-count
// thresholds the production code checks (OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES, OUTLINE_MIN_HEADINGS,
// OUTLINE_MAX_REPLACEMENT_RATIO), not read off preSkillHandler's own implementation.
describe('preSkillHandler — heading-tree fallback for an oversized skill with no compact marker', () => {
  it('(a) denies with the heading tree inlined and names both recall commands when there are enough headings and the tree clears the ratio cap', async () => {
    const skillName = 'heading-tree-enough-headings';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    // 8 short headings, each followed by a 1200-byte filler paragraph: >6000 bytes total, well
    // past OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES, but the rendered tree (a handful of short
    // bullet lines) stays a small fraction of that -- clears OUTLINE_MAX_REPLACEMENT_RATIO (0.4).
    const paragraph = 'p'.repeat(1200);
    const body = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    const bodyBytes = Buffer.byteLength(body, 'utf-8');
    expect(bodyBytes).toBeGreaterThan(6000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const before = summarize(30).by_kind['skill_heading_tree_inlined']?.bytes_saved ?? 0;
    const out = await preSkillHandler(skillPreEvent(skillName, 'sess-heading-tree-a'));
    expect(out.hookType).toBe('deny');
    if (out.hookType !== 'deny' || !out.message) return;

    // Anti-vacuity guard: the inlined tree has to be materially smaller than the body before
    // any assertion about its content means anything -- otherwise a branch that accidentally
    // inlined the whole body back would still pass a bare "contains these substrings" check.
    expect(out.message.length).toBeLessThan(bodyBytes * 0.5);

    expect(out.message).toContain('with no compact slice');
    expect(out.message).toContain('inlined below');
    expect(out.message).toContain('Section 0');
    expect(out.message).toContain('token-goat skill-section ' + skillName);
    expect(out.message).toContain('token-goat skill-body ' + skillName);
    expect(out.message.indexOf('skill-section') < out.message.lastIndexOf('skill-body')).toBe(true);

    const delta = (summarize(30).by_kind['skill_heading_tree_inlined']?.bytes_saved ?? 0) - before;
    expect(delta).toBeGreaterThan(0);
  });

  it('(b) passes through when the body is oversized but has fewer headings than OUTLINE_MIN_HEADINGS', async () => {
    const skillName = 'heading-tree-too-few-headings';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    // 3 headings (below the 6-heading floor), padded past the oversize threshold with filler.
    const paragraph = 'p'.repeat(2100);
    const body = Array.from({ length: 3 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(6000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent(skillName, 'sess-heading-tree-b'));
    expect(out.hookType).toBe('pass');
  });

  it('(c) passes through when the rendered tree would not clear OUTLINE_MAX_REPLACEMENT_RATIO', async () => {
    const skillName = 'heading-tree-ratio-too-large';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    // 45 headings, each carrying a long title and no body text under it, so headings are nearly
    // the entire file: the rendered tree ends up close to the same size as the body it would
    // replace, well past OUTLINE_MAX_REPLACEMENT_RATIO (0.4).
    const longTitle = 'L'.repeat(150);
    const body = Array.from({ length: 45 }, (_, i) => `## H${i} ${longTitle}`).join('\n');
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(6000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent(skillName, 'sess-heading-tree-c'));
    expect(out.hookType).toBe('pass');
  });

  it('(d) an oversized skill whose compact slice is small enough to inline takes that path, not the heading tree, even when its detail section has plenty of headings', async () => {
    const skillName = 'heading-tree-marker-unaffected';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const compact = 'Compact summary.';
    const paragraph = 'p'.repeat(1200);
    // Same shape of detail as fixture (a) -- enough headings to satisfy the tree gate on its own -- but behind a 16-byte slice that clears the inline ratio comfortably. Inlining the slice beats mapping the body, so the tree must not run here. This is specifically NOT the claim that a marker suppresses the tree: a slice too large to inline DOES get one, which is the parity case at the end of this file.
    const detail = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    const body = `${compact}\n<!-- COMPACT_END -->\n${detail}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent(skillName, 'sess-heading-tree-d'));
    expect(out.hookType).toBe('deny');
    if (out.hookType !== 'deny' || !out.message) return;
    expect(out.message).toContain('compact slice');
    expect(out.message).not.toContain('with no compact slice');
    expect(out.message).not.toContain('headings) is inlined below');
  });

  it('(e) a small skill with no compact marker, enough headings, and a tree that would otherwise clear the ratio cap still passes through because it is under the size threshold', async () => {
    const skillName = 'heading-tree-under-size-threshold';
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    // Same shape as fixture (a) -- 8 headings, each with enough filler that the rendered tree
    // would clear OUTLINE_MAX_REPLACEMENT_RATIO -- but scaled down so the body itself never
    // crosses OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES (6000). This isolates the size gate: a
    // fixture with too few headings or a bad ratio would still pass for the wrong reason.
    const paragraph = 'p'.repeat(600);
    const body = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(6000);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');

    const out = await preSkillHandler(skillPreEvent(skillName, 'sess-heading-tree-e'));
    expect(out.hookType).toBe('pass');
  });
});

// HAND-DERIVED fixtures below: both bodies are constructed directly from the heading-count
// thresholds the production code checks (OUTLINE_MIN_HEADINGS, the MAX_HEADINGS=40 display cap
// inside extractMarkdownHeadings, OUTLINE_MAX_REPLACEMENT_RATIO), not read off preSkillHandler's
// own implementation or its message-building logic.
describe('preSkillHandler — heading-tree message states the true total when the displayed tree is capped', () => {
  it('over-cap (51 real headings) and under-cap (8 real headings) fixtures produce DIFFERENT deny-message wording', async () => {
    const paragraph = 'p'.repeat(1200);
    const overCapName = 'heading-tree-over-cap';
    const overCapDir = path.join(sourceDir, overCapName);
    await fs.mkdir(overCapDir, { recursive: true });
    const overCapBody = Array.from({ length: 51 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    await fs.writeFile(path.join(overCapDir, 'SKILL.md'), overCapBody, 'utf-8');

    const underCapName = 'heading-tree-under-cap';
    const underCapDir = path.join(sourceDir, underCapName);
    await fs.mkdir(underCapDir, { recursive: true });
    const underCapBody = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n${paragraph}`).join('\n\n');
    await fs.writeFile(path.join(underCapDir, 'SKILL.md'), underCapBody, 'utf-8');

    const overCapOut = await preSkillHandler(skillPreEvent(overCapName, 'sess-heading-tree-over-cap'));
    const underCapOut = await preSkillHandler(skillPreEvent(underCapName, 'sess-heading-tree-under-cap'));
    expect(overCapOut.hookType).toBe('deny');
    expect(underCapOut.hookType).toBe('deny');
    if (overCapOut.hookType !== 'deny' || !overCapOut.message || underCapOut.hookType !== 'deny' || !underCapOut.message) return;

    // Anti-vacuity guard, evaluated before either fixture's content is checked: if a bug made
    // both bodies take the same message branch, a pair of tests that only check "contains the
    // right substring" could both still pass.
    expect(overCapOut.message).not.toBe(underCapOut.message);
    const overCapSentence = overCapOut.message.slice(0, overCapOut.message.indexOf('Use `token-goat skill-section'));
    const underCapSentence = underCapOut.message.slice(0, underCapOut.message.indexOf('Use `token-goat skill-section'));
    expect(overCapSentence).not.toBe(underCapSentence);

    expect(overCapOut.message).toContain('its heading tree shows 40 of 51 headings');
    expect(overCapOut.message).toContain('token-goat skill-body ' + overCapName);
    expect(overCapOut.message).not.toContain('40 headings) is inlined below');

    expect(underCapOut.message).toContain('its heading tree (8 headings) is inlined below');
    expect(underCapOut.message).not.toContain('reachable only through');
  });
});


// HAND-DERIVED fixtures: each body is built from the thresholds the production code checks
// (OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES, the compactBytes * 2 <= bodyBytes inline ratio,
// OUTLINE_MIN_HEADINGS, OUTLINE_MAX_REPLACEMENT_RATIO), never read off preSkillHandler.
// The marker POSITION is CAPTURE-shaped: three skills installed on the machine this was written on
// carry <!-- COMPACT_END --> at 97%, 97% and 62% of their body, which is the shape that lands here.
describe('preSkillHandler -- an oversized skill whose compact slice is too large to inline still gets a map', () => {
  /** 8 headings with 1200-byte paragraphs, and the marker placed so the slice is ~97% of the body: past the inline ratio, so this is the arm that used to hand back a bare pointer. */
  function lateMarkerBody(): string {
    const paragraph = 'p'.repeat(1200);
    const sections = Array.from({ length: 8 }, (_, i) => '## Section ' + i + String.fromCharCode(10) + paragraph).join(String.fromCharCode(10, 10));
    return sections + String.fromCharCode(10) + '<!-- COMPACT_END -->' + String.fromCharCode(10) + 'trailing note';
  }

  /** Newest detail string for a stat kind. summarize() aggregates and drops `detail`, where the marker provenance lives. */
  function latestDetail(kind: string): string {
    const db = getDb(path.join(dataDir(), 'global.db'));
    const row = db.prepare('select detail from stats where kind = ? order by id desc limit 1').get(kind) as { detail: string | null } | undefined;
    return row?.detail ?? '';
  }

  async function installSkillBody(skillName: string, body: string): Promise<number> {
    const skillDir = path.join(sourceDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');
    return Buffer.byteLength(body, 'utf-8');
  }

  // Pre-fix this returned 'is large (N bytes) and has a compact slice available. Use `token-goat
  // skill-section <name> `<heading>` ...' -- a pointer naming a command whose one required argument
  // the deny never supplied, so recovering the heading list cost a separate call the handler had
  // every byte needed to answer. It is the single most-taken branch on this surface.
  it('inlines the heading tree rather than naming skill-section without ever saying what the headings are', async () => {
    const body = lateMarkerBody();
    const bodyBytes = await installSkillBody('late-marker-tree', body);

    const out = await preSkillHandler(skillPreEvent('late-marker-tree', 'sess-late-marker'));
    expect(out.hookType).toBe('deny');
    if (out.hookType !== 'deny' || !out.message) return;

    // The headings themselves, which is the whole point: skill-section is unusable without them.
    expect(out.message).toContain('Section 0');
    expect(out.message).toContain('Section 7');
    // Anti-vacuity: a branch that regressed to handing back the body would still contain every heading. The replacement has to be materially smaller than what it replaced.
    expect(out.message.length).toBeLessThan(bodyBytes * 0.5);
    // The slice is still reachable -- it exists, it is just too big to inline, so the pointer to it stays.
    expect(out.message).toContain('--compact');
    expect(out.message).toContain('too large to inline');
  });

  // The load-bearing invariant, and the one the bug inverted: a marker in the wrong place used to
  // be strictly worse than no marker at all, because only the no-marker arm reached the tree.
  it('gives a badly-placed marker the same map a skill with no marker gets', async () => {
    const withMarker = lateMarkerBody();
    const withoutMarker = withMarker.slice(0, withMarker.indexOf('<!-- COMPACT_END -->'));
    await installSkillBody('parity-with-marker', withMarker);
    await installSkillBody('parity-no-marker', withoutMarker);

    const marked = await preSkillHandler(skillPreEvent('parity-with-marker', 'sess-parity-a'));
    const markedDetail = latestDetail('skill_heading_tree_inlined');
    const bare = await preSkillHandler(skillPreEvent('parity-no-marker', 'sess-parity-b'));
    const bareDetail = latestDetail('skill_heading_tree_inlined');

    expect(marked.hookType).toBe('deny');
    expect(bare.hookType).toBe('deny');
    if (marked.hookType !== 'deny' || bare.hookType !== 'deny' || !marked.message || !bare.message) return;
    // Both arms deliver the same eight headings. Compared as a set rather than as whole strings: the two messages differ on purpose in how they describe the slice, and pinning that prose here would make every future wording change a failure in the wrong file.
    const headingsOf = (m: string): string[] => (m.match(/Section \d/g) ?? []).sort();
    expect(headingsOf(marked.message)).toEqual(headingsOf(bare.message));
    expect(headingsOf(marked.message).length).toBe(8);
    // Same kind, same credit, and the detail keeps the authoring signal the merge would otherwise bury: 'unusable' is a fixable marker placement, 'none' is a skill that never opted in.
    expect(markedDetail).toContain('marker=unusable');
    expect(bareDetail).toContain('marker=none');
  });

  // The credit has to price the counterfactual this arm actually had. The body was never going to
  // be delivered here -- the pointer deny already stopped it -- so crediting body-minus-tree would
  // book bytes nothing was ever going to send. The marker sits at ~60% in this fixture precisely so
  // the two candidate numbers are far apart; on a real skill the marker sits near the end and they
  // land within a few percent of each other, which is what would have made the wrong one look right.
  it('credits the slice the old pointer named, not the body that was already being withheld', async () => {
    const paragraph = 'p'.repeat(1200);
    const sections = Array.from({ length: 8 }, (_, i) => '## Section ' + i + String.fromCharCode(10) + paragraph);
    const slice = sections.slice(0, 5).join(String.fromCharCode(10, 10));
    const body = slice + String.fromCharCode(10) + '<!-- COMPACT_END -->' + String.fromCharCode(10) + sections.slice(5).join(String.fromCharCode(10, 10));
    const bodyBytes = await installSkillBody('credit-counterfactual', body);
    const sliceBytes = Buffer.byteLength(slice, 'utf-8');
    // Past the inline ratio (so this takes the tree arm) but well short of the whole body (so the two counterfactuals are distinguishable).
    expect(sliceBytes * 2).toBeGreaterThan(bodyBytes);
    expect(sliceBytes).toBeLessThan(bodyBytes * 0.8);

    const out = await preSkillHandler(skillPreEvent('credit-counterfactual', 'sess-credit'));
    expect(out.hookType).toBe('deny');
    if (out.hookType !== 'deny' || !out.message) return;

    const db = getDb(path.join(dataDir(), 'global.db'));
    const row = db.prepare("select bytes_saved from stats where kind = 'skill_heading_tree_inlined' order by id desc limit 1").get() as { bytes_saved: number } | undefined;
    const credited = row?.bytes_saved ?? 0;
    expect(credited).toBeGreaterThan(0);
    // The mutation-killer: the credit can never exceed the slice the pointer named. The body-shaped number this replaced is bodyBytes minus the same tree, which on this fixture is over 9 KB against a 6 KB slice, so it fails this line outright.
    expect(credited).toBeLessThanOrEqual(sliceBytes);
    // And it is the slice minus a small tree, not some unrelated smaller number.
    expect(credited).toBeGreaterThan(sliceBytes * 0.9);
  });

  // Guards the fix against over-reach: a body with nothing to map must still fall back to the
  // pointer, because a tree of one heading is not worth the round trip.
  it('still falls back to the bare pointer when the body has too little structure to map', async () => {
    await installSkillBody('late-marker-flat', 'x'.repeat(25_000) + String.fromCharCode(10) + '<!-- COMPACT_END -->' + String.fromCharCode(10) + 'y'.repeat(7000));

    const out = await preSkillHandler(skillPreEvent('late-marker-flat', 'sess-late-flat'));
    expect(out.hookType).toBe('deny');
    if (out.hookType !== 'deny' || !out.message) return;
    expect(out.message).toContain('has a compact slice available');
    expect(out.message).not.toContain('heading tree');
  });
});
