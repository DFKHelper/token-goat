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

const OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES = 6000;

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
        if (bodyBytes > OVERSIZED_FIRST_LOAD_THRESHOLD_BYTES && extractCompactFromMarker(body) !== null) {
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

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preSkillHandler, { toolName: 'Skill' });
registerHook('post_tool_use', postSkillHandler, { toolName: 'Skill' });
