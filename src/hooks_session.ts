import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, contextOutput, getCwd } from './hooks_common.js';
import { runGit } from './util.js';
import { loadConfig } from './config.js';
import { checkSkillVersionDrift } from './skill_version_drift.js';

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
    const cwd = getCwd(event);

    if (cwd) {
      try {
        const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: loadConfig().hints.git_hint_max_ms });
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

    // One-shot "token-goat was upgraded since you loaded this skill" nudge -- see
    // skill_version_drift.ts. Deliberately not folded into `parts`/the bracketed summary above:
    // it is a standalone, occasional line, not another terse `key: value` fragment.
    const driftNudge = checkSkillVersionDrift(event.sessionId);

    if (parts.length === 0 && !driftNudge) {
      return passOutput();
    }

    const lines: string[] = [];
    if (parts.length > 0) {
      lines.push('[' + parts.join(' | ') + ']');
    }
    if (driftNudge) {
      lines.push(driftNudge);
    }
    return contextOutput(lines.join('\n'));
  } catch {
    return passOutput();
  }
}

// Matches common completion-tense verbs a subagent would use in its own
// final report when it CLAIMS to have made changes (e.g. "Fixed the bug
// and committed the change") — as opposed to inferring intent from the
// task it was assigned. Handles common inflections (fix/fixed/fixing).
// Deliberately excludes commit/push verbs: a clean `git status --porcelain`
// is also the expected, correct outcome after a successful commit, so
// those verbs cannot be used as hallucination signals on their own — see
// CLAIMED_COMMIT_VERBS_RE below.
const CLAIMED_CHANGE_VERBS_RE =
  /\b(fix(?:ed|es|ing)?|implement(?:ed|s|ing)?|add(?:ed|s|ing)?|creat(?:e|ed|es|ing)|writ(?:e|ten|es|ing)|refactor(?:ed|s|ing)?|updat(?:e|ed|es|ing)|chang(?:e|ed|es|ing)|edit(?:ed|s|ing)?|modif(?:y|ied|ies|ying)|delet(?:e|ed|es|ing)|remov(?:e|ed|es|ing)|patch(?:ed|es|ing)?|resolv(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|improv(?:e|ed|es|ing)|appl(?:y|ied|ies|ying))\b/i;

// Matches claims that the changes were committed/pushed — a legitimate
// explanation for an empty `git status --porcelain` output, so its
// presence must suppress the hallucination warning rather than trigger it.
const CLAIMED_COMMIT_VERBS_RE = /\b(commit(?:ted|s|ting)?|push(?:ed|es|ing)?)\b/i;

function subagentStopHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) {
      return passOutput();
    }

    const cwd = getCwd(event);
    if (!cwd) {
      return passOutput();
    }

    try {
      const result = runGit(['status', '--porcelain'], { cwd, timeoutMs: loadConfig().hints.git_hint_max_ms });
      if (result.exitCode === 0) {
        const gitOutput = result.stdout.trim();
        if (!gitOutput) {
          // last_assistant_message is the subagent's own final report — the
          // real signal is whether the agent CLAIMS to have made changes
          // (fixed/committed/implemented/...) while git shows none, not
          // whether the assigned task merely asked for changes.
          const lastAssistantMessage = (event.raw['last_assistant_message'] as string) || '';
          const claimsChanges = CLAIMED_CHANGE_VERBS_RE.test(lastAssistantMessage);
          const claimsCommitted = CLAIMED_COMMIT_VERBS_RE.test(lastAssistantMessage);
          if (claimsChanges && !claimsCommitted) {
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

registerHook('user_prompt_submit', userPromptSubmitHandler);
registerHook('subagent_stop', subagentStopHandler);

export { subagentStopHandler, userPromptSubmitHandler };
