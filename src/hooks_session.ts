import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, contextOutput } from './hooks_common.js';
import { runGit } from './util.js';

function sessionStartHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) {
      return passOutput();
    }

    const source = (event.raw['source'] as string) || 'unknown';

    if (source === 'compact') {
      return passOutput();
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

function userPromptSubmitHandler(event: HookEvent): HookOutput {
  try {
    const rawPrompt = (event.raw['prompt'] as string) || '';

    if (rawPrompt.trim().length < 8) {
      return passOutput();
    }

    if (!event.sessionId) {
      return passOutput();
    }

    const parts: string[] = [];
    const cwd = event.raw['cwd'] as string | undefined;

    if (cwd) {
      try {
        const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        if (result.exitCode === 0 && result.stdout) {
          const branch = result.stdout.trim();
          if (branch) {
            parts.push(`branch: ${branch}`);
          }
        }
      } catch {
        // Swallow errors
      }
    }

    if (parts.length === 0) {
      return passOutput();
    }

    const summary = '[' + parts.join(' | ') + ']';
    return contextOutput(summary);
  } catch {
    return passOutput();
  }
}

function subagentStopHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) {
      return passOutput();
    }

    const cwd = event.raw['cwd'] as string | undefined;
    if (!cwd) {
      return passOutput();
    }

    try {
      const result = runGit(['status', '--porcelain'], { cwd });
      if (result.exitCode === 0) {
        const gitOutput = result.stdout.trim();
        if (!gitOutput) {
          const prompt = (event.raw['prompt'] as string) || '';
          const hasActionVerbs = /\b(fix|implement|add|create|write|refactor|update|change|edit|modify|delete|remove|patch|resolve|replace|improve)\b/i.test(prompt);
          if (hasActionVerbs) {
            console.warn(
              `subagent-stop: possible hallucination — session=${event.sessionId} but git status is clean`
            );
          }
        }
      }

      return passOutput();
    } catch {
      return passOutput();
    }
  } catch {
    return passOutput();
  }
}

registerHook('session_start', sessionStartHandler);
registerHook('user_prompt_submit', userPromptSubmitHandler);
registerHook('subagent_stop', subagentStopHandler);

export { subagentStopHandler };
