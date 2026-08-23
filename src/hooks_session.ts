import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import crypto from 'node:crypto';
import { passOutput, contextOutput, getCwd } from './hooks_common.js';
import { runGit } from './util.js';
import { loadConfig } from './config.js';
import { checkSkillVersionDrift } from './skill_version_drift.js';
import { markHintShown, recordScheduledPrompt, wasHintShown } from './session.js';
import { getHarnessName } from './bridges/registry.js';
import { drainPendingContext, queuePendingContext } from './pending_context.js';
import { recordStat } from './stats.js';
import {
  accumulateResidentLines,
  lineMayCarryResidentSignal,
  readTranscriptTail,
  repeatedSkillBodyHint,
  summarizeResidentContext,
  taskListPruneHint,
} from './resident_context.js';

/**
 * Harnesses that run the prompt-submit hook but drop whatever it returns.
 *
 * Empty today, and that is a finding rather than an oversight. Copilot CLI was the only member,
 * on the strength of its own hooks reference saying command-hook output "is dropped"
 * (https://docs.github.com/en/copilot/reference/hooks-reference). That documentation is wrong for
 * `additionalContext`, at least as of 1.0.80: a project-scope config-file command hook (under
 * `<cwd>/.github/hooks/`) returned `{"additionalContext":"<marker>"}` and the marker appeared
 * verbatim in the session's `user.message.transformedContent`, wrapped in `<system_reminder>`.
 * That it reached the model rather than only the on-disk record is settled by the provider's own
 * returned usage: ~140 input tokens billed for a turn whose raw `content` is 35 bytes. Scope: this
 * was demonstrated once, on one of two turns, and the delivery rate is unknown -- see the longer
 * account in `src/bridges/copilot_cli.ts`. The doc's claim about `modifiedPrompt` was not retested
 * and is assumed to still hold; token-goat does not want that field regardless.
 *
 * The set and the reroute below are kept rather than deleted because they are the fallback if a
 * future Copilot release makes the documentation true again: re-adding a harness name here is the
 * whole fix, with no other code change. Membership stays evidence-backed in both directions --
 * adding a harness silently reroutes its hints and removing one silently discards them, so
 * neither move should ever rest on documentation alone. See BRIDGES_STATUS for the harness-level
 * record of what each event can actually carry.
 */
const PROMPT_SUBMIT_CONTEXT_DROPPED = new Set<string>([]);

function dropsPromptSubmitContext(): boolean {
  return PROMPT_SUBMIT_CONTEXT_DROPPED.has(getHarnessName());
}

/**
 * Deliver anything the prompt-submit hook queued, on the first tool call that follows.
 *
 * Advisory and tool-agnostic: it adds context and never decides a tool's fate. The drain is
 * one-shot, so this is a no-op for every later call in the turn, and a no-op entirely on a harness
 * that surfaces prompt-submit context directly.
 */
function pendingContextHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId || !dropsPromptSubmitContext()) return passOutput();
    const pending = drainPendingContext(event.sessionId);
    return pending === null ? passOutput() : contextOutput(pending);
  } catch {
    return passOutput();
  }
}

const EMBEDDED_SKILL_CONTEXT_RE = /^\s*<skill-context\b/i;
const CONTINUATION_PROMPT_RE = /^(?:continue|resume|next|go on)$/i;
const SCHEDULED_PROMPT_RE = /^\[Scheduled prompt #(\d+)\]/i;
const SCHEDULED_PROMPT_PRESSURE_THRESHOLDS = new Set([25, 100, 250]);

function promptFingerprint(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * Hints about context the harness injected and no hook ever saw: an oversized task list, and a
 * skill body that slash expansion has sent more than once. See resident_context.ts.
 *
 * Both are one-shot per session, and that is also what bounds the cost: once each hint has fired
 * there is nothing left to look for, so the scan stops running entirely. Until then it reads a
 * capped window from the end of the transcript and, before parsing anything, drops the ~98% of
 * lines that cannot carry either signal.
 *
 * Advisory by construction. A task list may hold items owned by other agents, so the hint names
 * TaskUpdate and stops there; token-goat never edits a task itself.
 */
function residentContextHints(event: HookEvent): string[] {
  const transcriptPath = event.raw['transcript_path'];
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return [];

  const taskKey = `resident-task-list:${event.sessionId}`;
  const skillKey = `resident-skill-body:${event.sessionId}`;
  const wantTask = !wasHintShown(taskKey);
  const wantSkill = !wasHintShown(skillKey);
  if (!wantTask && !wantSkill) return [];

  const lines = readTranscriptTail(transcriptPath).filter(lineMayCarryResidentSignal);
  if (lines.length === 0) return [];
  const summary = summarizeResidentContext(accumulateResidentLines(lines));

  const hints: string[] = [];
  if (wantTask) {
    const hint = taskListPruneHint(summary.latestTaskList);
    if (hint !== null) {
      markHintShown(taskKey);
      hints.push(hint);
    }
  }
  if (wantSkill) {
    const hint = repeatedSkillBodyHint(summary.repeatedSkillBodies);
    if (hint !== null) {
      markHintShown(skillKey);
      hints.push(hint);
    }
  }
  if (hints.length > 0) recordStat('session_hint', 0, 0);
  return hints;
}

async function userPromptSubmitHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const rawPrompt = (event.raw['prompt'] as string) || '';

    if (!event.sessionId) {
      return passOutput();
    }

    const parts: string[] = [];
    const prompt = rawPrompt.trim();

    if (EMBEDDED_SKILL_CONTEXT_RE.test(prompt)) {
      const key = `embedded-skill:${event.sessionId}:${promptFingerprint(prompt)}`;
      if (wasHintShown(key)) {
        parts.push('This identical embedded skill payload was already provided in this session; treat it as loaded and do not re-read its full body.');
      } else {
        markHintShown(key);
      }
    }

    if (CONTINUATION_PROMPT_RE.test(prompt)) {
      const key = `continuation-checkpoint:${event.sessionId}`;
      if (!wasHintShown(key)) {
        markHintShown(key);
        parts.push('Before a long continuation loop, checkpoint the current goal and evidence; start a fresh session when earlier context is no longer needed.');
      }
    }

    const scheduledPrompt = SCHEDULED_PROMPT_RE.exec(prompt);
    if (scheduledPrompt !== null) {
      const occurrence = recordScheduledPrompt(event.sessionId);
      if (SCHEDULED_PROMPT_PRESSURE_THRESHOLDS.has(occurrence)) {
        const key = `scheduled-prompt-pressure:${event.sessionId}:${occurrence}`;
        if (!wasHintShown(key)) {
          markHintShown(key);
          parts.push(`This is scheduled prompt delivery #${occurrence} (schedule #${scheduledPrompt[1]}). Checkpoint the current objective and start a fresh session before continuing if earlier context is no longer needed; this cannot reclaim tokens already injected.`);
        }
      }
    }

    // The branch-hint git subprocess is only worth its cost for a substantive prompt -- skip it
    // (and the getCwd/runGit call it implies) for a trivial one like "ok"/"yes"/"continue". This
    // gate must NOT also skip checkSkillVersionDrift below: that check is cheap (no subprocess)
    // and its own "on each user turn" contract must hold even on a short turn -- a session whose
    // next few prompts happen to be short ("continue", "next") previously never learned about a
    // mid-session upgrade at all, since the drift check sat after this same early return.
    if (prompt.length >= 8) {
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
    }

    // One-shot "token-goat was upgraded since you loaded this skill" nudge -- see
    // skill_version_drift.ts. Deliberately not folded into `parts`/the bracketed summary above:
    // it is a standalone, occasional line, not another terse `key: value` fragment.
    const driftNudge = await checkSkillVersionDrift(event.sessionId);

    // Standalone sentences, so they join driftNudge on their own lines rather than the bracketed
    // `key: value` summary.
    const residentHints = residentContextHints(event);

    if (parts.length === 0 && !driftNudge && residentHints.length === 0) {
      return passOutput();
    }

    const lines: string[] = [];
    if (parts.length > 0) {
      lines.push('[' + parts.join(' | ') + ']');
    }
    if (driftNudge) {
      lines.push(driftNudge);
    }
    for (const hint of residentHints) {
      lines.push(hint);
    }
    const text = lines.join('\n');

    // On a harness that discards this event's response, returning the text would deliver nothing.
    // Queue it for the next tool call, where there IS a channel that reaches the model.
    if (dropsPromptSubmitContext()) {
      queuePendingContext(event.sessionId, text);
      return passOutput();
    }
    return contextOutput(text);
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
// followsMatcher: this handler filters no tool, but it must not force the catch-all matcher.
// On Claude Code it is a no-op anyway, and on Copilot CLI -- the harness it exists for -- the
// installed matcher plays no part, since that shim receives every postToolUse event regardless.
// So accepting the event's existing narrowed matcher costs the delivery nothing and keeps every
// other harness from paying a hook spawn on tool calls no handler wants.
registerHook('post_tool_use', pendingContextHandler, { advisory: true, followsMatcher: true });

export { pendingContextHandler, subagentStopHandler, userPromptSubmitHandler };
