import { readFile } from 'node:fs/promises';
import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, denyOutput, getToolName, getToolInput, extractToolResponseField, BODY_FIRST_TOOL_RESPONSE_KEYS } from './hooks_common.js';
import { loadConfig } from './config.js';
import { recordStat } from './stats.js';
import {
  storeOutput,
  installedSkillPath,
  incrementSkillHit,
  hasSessionOutput,
  extractCompactFromMarker,
} from './skill_cache.js';
import { recordSkillVersionSnapshot } from './skill_version_drift.js';

const OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES = 6000;

// Largest compact slice still worth inlining rather than pointing at. Deliberately NOT the oversize gate above: that number answers "is the full body too big to hand over", which is a different question from "is this slice cheaper to inline than to make the agent fetch". Denying never prevents the bytes -- the agent runs `skill-body --compact` and receives the identical slice one turn later, having also paid the deny text, a reasoning turn, and a Bash spawn -- so inlining wins at every size the slice is actually smaller than the body. The cap exists only to stop a degenerate marker (a "compact" slice nearly as large as the body it summarises) from being force-fed; past it, the pointer deny still gives the agent the choice.
const COMPACT_INLINE_MAX_BYTES = 24_000;

function extractSkillName(toolInput: Record<string, unknown>): string | null {
  const skill = toolInput['skill'] as string;
  if (skill && typeof skill === 'string') {
    return skill;
  }
  const command = toolInput['command'] as string;
  if (command && typeof command === 'string') {
    return command;
  }
  return null;
}

function extractSkillBody(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, BODY_FIRST_TOOL_RESPONSE_KEYS);
}

/** Shared prologue for {@link preSkillHandler}/{@link postSkillHandler}: only a Skill call with
 * an extractable skill name and a session id is in scope; everything else passes through. */
function resolveSkillContext(event: HookEvent): { skillName: string } | null {
  const toolName = getToolName(event);
  if (toolName !== 'Skill') {
    return null;
  }

  const toolInput = getToolInput(event);
  const skillName = extractSkillName(toolInput);
  if (!skillName) {
    return null;
  }

  if (!event.sessionId) {
    return null;
  }

  return { skillName };
}

export async function preSkillHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const ctx = resolveSkillContext(event);
    if (ctx === null) {
      return passOutput();
    }
    const { skillName } = ctx;

    if (!loadConfig().hints.pre_skill_advisory) {
      return passOutput();
    }

    // Skill already loaded earlier this session: its body is cached and recallable, so re-loading just re-injects the whole thing. Deny and point at the cheaper compact recall instead.
    if (await hasSessionOutput(event.sessionId, skillName)) {
      recordStat('session_hint');
      return denyOutput(
        'Skill `' + skillName + '` was already loaded this session and is cached. Use `token-goat skill-body ' +
          skillName + ' --compact` to recall the compact slice (or `token-goat skill-body ' + skillName +
          '` for the full body) instead of re-loading it.',
      );
    }

    // First (cold) load of an oversized skill with an extractable compact: gate this too, or the full body still lands in context once per skill per session regardless of repeat-load protection.
    const sourcePath = await installedSkillPath(skillName);
    if (sourcePath) {
      try {
        const body = await readFile(sourcePath, 'utf-8');
        const bodyBytes = Buffer.byteLength(body, 'utf-8');
        const compact = bodyBytes > OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES ? extractCompactFromMarker(body) : null;
        if (compact !== null) {
          // The compact slice is already in hand here, so denying with a pointer to `skill-body --compact` costs an extra agent turn (reasoning + Bash call + that command's echo) to re-fetch content this handler just computed. Inline it instead whenever it is genuinely smaller than the body and under COMPACT_INLINE_MAX_BYTES. This used to reuse the oversize gate as the inline bound, which put every slice between 6 KB and the body's size on the deny path -- the agent paid the round trip and received exactly the same bytes anyway, which is why that branch's stat shows real traffic and zero savings. With no marker, a slice no smaller than the body, or a read failure, the original pointer deny stands verbatim.
          const compactBytes = Buffer.byteLength(compact, 'utf-8');
          // At least half the body has to disappear for inlining to beat pointing. "Any saving at all" is too weak a test: a marker placed at the very end makes the slice the whole body minus the marker line, which passes a bare `compactBytes < bodyBytes` while handing over every byte and booking it as a saving. Past that ratio the pointer is the better trade, because the agent may not need the body at all.
          if (compactBytes * 2 <= bodyBytes && compactBytes <= COMPACT_INLINE_MAX_BYTES) {
            const savedBytes = bodyBytes - compactBytes;
            recordStat('skill_compact_inlined', savedBytes, Math.round(savedBytes / 4));
            return denyOutput(
              'Skill `' + skillName + '` is large (' + bodyBytes + ' bytes); its compact slice (' + compactBytes +
                ' bytes) is inlined below instead of the full body. Run `token-goat skill-body ' + skillName +
                '` if you need the full body.\n\n' + compact,
            );
          }
          recordStat('skill_oversized_first_load');
          return denyOutput(
            'Skill `' + skillName + '` is large (' + bodyBytes +
              ' bytes) and has a compact slice available. Use `token-goat skill-body ' + skillName +
              ' --compact` to load the compact slice instead of the full body.',
          );
        }
      } catch {
        // fail-soft: unreadable file just falls through to the normal load
      }
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

export async function postSkillHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const ctx = resolveSkillContext(event);
    if (ctx === null) {
      return passOutput();
    }
    const { skillName } = ctx;

    recordStat('skill_load');

    const body = extractSkillBody(event.raw);
    if (!body) {
      return passOutput();
    }

    // Persist the loaded body under the real skill name (toolInput.skill), so skill-compact/skill-body/skill-list can recall it after compaction. Keyed by skill name + content hash; storeOutput dedups identical bodies across sessions. sourcePath points at the on-disk install when present, so getSkillFilePath resolves it without the disk-scan fallback.
    const sourcePath = await installedSkillPath(skillName);
    await storeOutput(event.sessionId, skillName, body, sourcePath ? { sourcePath } : undefined);
    // Increment hit count for skill recall tracking.
    await incrementSkillHit(skillName);
    // Stamp this (re)load's CLI version/command set as the session's drift baseline -- see
    // skill_version_drift.ts. No-op unless skillName is 'token-goat' itself.
    await recordSkillVersionSnapshot(event.sessionId, skillName);

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preSkillHandler, { toolName: 'Skill' });
registerHook('post_tool_use', postSkillHandler, { toolName: 'Skill' });
