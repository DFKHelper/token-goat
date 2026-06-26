import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, getToolName, getToolInput } from './hooks_common.js';
import { recordStat } from './stats.js';

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
  const toolResponse = raw['tool_response'];
  if (typeof toolResponse === 'string') {
    return toolResponse;
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const resp = toolResponse as Record<string, unknown>;
    const text =
      typeof resp['output'] === 'string'
        ? resp['output']
        : typeof resp['body'] === 'string'
          ? resp['body']
          : typeof resp['text'] === 'string'
            ? resp['text']
            : typeof resp['content'] === 'string'
              ? resp['content']
              : '';
    return text;
  }
  return '';
}

function preSkillHandler(event: HookEvent): HookOutput {
  try {
    const toolName = getToolName(event);

    if (toolName !== 'Skill') {
      return passOutput();
    }

    const toolInput = getToolInput(event);
    const skillName = extractSkillName(toolInput);
    if (!skillName) {
      return passOutput();
    }

    if (!event.sessionId) {
      return passOutput();
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

function postSkillHandler(event: HookEvent): HookOutput {
  try {
    const toolName = getToolName(event);

    if (toolName !== 'Skill') {
      return passOutput();
    }

    const toolInput = getToolInput(event);
    const skillName = extractSkillName(toolInput);
    if (!skillName) {
      return passOutput();
    }

    if (!event.sessionId) {
      return passOutput();
    }

    recordStat('skill_load');

    const body = extractSkillBody(event.raw);
    if (!body) {
      return passOutput();
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preSkillHandler, { toolName: 'Skill' });
registerHook('post_tool_use', postSkillHandler, { toolName: 'Skill' });
