import type { HookEvent } from './hook_registry.js';
import { registerHook, sessionStateKey } from './hook_registry.js';
import type { HookOutput } from './types.js';
import crypto from 'node:crypto';
import { passOutput, contextOutput, getCwd } from './hooks_common.js';
import { runGit } from './util.js';
import { loadConfig } from './config.js';
import { checkSkillVersionDrift } from './skill_version_drift.js';
import { markHintShown, recordScheduledPrompt, wasHintShown } from './session.js';
import { peekPendingContext, queuePendingContext } from './pending_context.js';
import { dropsPreCompactContext, dropsPromptSubmitContext, resumesCompactionOnPrompt, sessionStartMayBeDeferred } from './harness_channels.js';
import { getHarnessName } from './bridges/registry.js';
import { claimOwedSessionStart, readSessionStartSettled, sessionStartOwed } from './session_start_owed.js';
import { sessionStartOutput } from './hooks_session_start.js';
import { recordStat } from './stats.js';
import {
  accumulateResidentLines,
  lineMayCarryResidentSignal,
  readTranscriptTail,
  repeatedSkillBodyHint,
  summarizeResidentContext,
  taskListPruneHint,
} from './resident_context.js';

/** On the first tool call of a session on a harness whose session-start hook can miss its shim deadline, queue the output that hook owed so the peek below delivers it. Read the marker, claim, and only then compute: the claim is an exclusive create, so of two concurrent first calls one delivers, and a call that lost the claim computes nothing. A subagent is skipped outright, because it never ran a session start of its own and the parent's entry is not its to take. Advisory like the handler around it: a throw is swallowed. */
async function deliverOwedSessionStart(event: HookEvent): Promise<void> {
  try {
    if (event.agentId !== undefined || !sessionStartMayBeDeferred(getHarnessName())) return;
    const stateKey = sessionStateKey(event);
    const gateKey = `session-start-deferred:${stateKey}`;
    if (wasHintShown(gateKey)) return;
    markHintShown(gateKey);
    if (!sessionStartOwed(readSessionStartSettled(event), Date.now()) || !claimOwedSessionStart(event)) return;
    const owed = await sessionStartOutput(event, { skipRecovery: true });
    if (owed.hookType === 'context') queuePendingContext(stateKey, owed.context);
    recordStat('session_start_deferred', 0, 0);
  } catch {
    // Advisory: a failed deferral costs the owed text, never the tool call.
  }
}

/** Deliver anything the prompt-submit hook queued, on the first tool call that follows. Advisory and tool-agnostic: it adds context and never decides a tool's fate. It peeks rather than consumes, and relay.ts clears the queue once the emitted output is confirmed to carry the text -- which is what makes this a no-op for every later call in the turn, and what keeps the text queued on the calls where an advisory result loses to another handler's. See pending_context.ts. The gate names every producer that writes to the queue, not just the one this handler was built for, and a deferred session start is one: on VS Code neither drop set applies, so without it the owed text would be queued and never peeked. Gating on the prompt-submit set alone was correct while that set was the only writer; once pre_compact began queuing on a harness that discards its own response, an empty prompt-submit set would have stranded every queued manifest on disk -- nothing failing, and the hint still counted as emitted. */
async function pendingContextHandler(event: HookEvent): Promise<HookOutput> {
  try {
    if (event.sessionId) await deliverOwedSessionStart(event);
    if (!event.sessionId || (!dropsPromptSubmitContext() && !dropsPreCompactContext() && !sessionStartMayBeDeferred(getHarnessName()))) return passOutput();
    const pending = peekPendingContext(sessionStateKey(event));
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

/** Hints about context the harness injected and no hook ever saw: an oversized task list, and a skill body that slash expansion has sent more than once. See resident_context.ts. Both are one-shot per session, and that is also what bounds the cost: once each hint has fired there is nothing left to look for, so the scan stops running entirely. Until then it reads a capped window from the end of the transcript and, before parsing anything, drops the ~98% of lines that cannot carry either signal. Advisory by construction. A task list may hold items owned by other agents, so the hint names TaskUpdate and stops there; token-goat never edits a task itself. */
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

    // The branch-hint git subprocess is only worth its cost for a substantive prompt -- skip it (and the getCwd/runGit call it implies) for a trivial one like "ok"/"yes"/"continue". This gate must NOT also skip checkSkillVersionDrift below: that check is cheap (no subprocess) and its own "on each user turn" contract must hold even on a short turn -- a session whose next few prompts happen to be short ("continue", "next") previously never learned about a mid-session upgrade at all, since the drift check sat after this same early return.
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

    // One-shot "token-goat was upgraded since you loaded this skill" nudge -- see skill_version_drift.ts. Deliberately not folded into `parts`/the bracketed summary above: it is a standalone, occasional line, not another terse `key: value` fragment.
    const driftNudge = await checkSkillVersionDrift(event.sessionId);

    // Standalone sentences, so they join driftNudge on their own lines rather than the bracketed `key: value` summary.
    const residentHints = residentContextHints(event);

    // The manifest queued when the harness compacted, on a harness whose preCompact answer reaches nothing but whose prompt answer does (see resumesCompactionOnPrompt). Peeked, not taken: relay.ts clears the queue once the serialized output carries it, which is what makes this one-shot. First, because it says what happened before anything below it applies.
    const resumed = resumesCompactionOnPrompt() ? peekPendingContext(sessionStateKey(event)) : null;

    if (parts.length === 0 && !driftNudge && residentHints.length === 0 && resumed === null) {
      return passOutput();
    }

    const lines: string[] = [];
    if (resumed !== null) {
      lines.push(resumed);
    }
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

    // On a harness that discards this event's response, returning the text would deliver nothing. Queue it for the next tool call, where there IS a channel that reaches the model.
    if (dropsPromptSubmitContext()) {
      queuePendingContext(sessionStateKey(event), text);
      return passOutput();
    }
    return contextOutput(text);
  } catch {
    return passOutput();
  }
}

// Matches claims that the changes were committed/pushed — a legitimate explanation for an empty `git status --porcelain` output, so its presence must suppress the hallucination warning rather than trigger it.
const CLAIMED_COMMIT_VERBS_RE = /\b(commit(?:ted|s|ting)?|push(?:ed|es|ing)?)\b/i;

// True when the message claims a commit or push, which explains a clean working tree.
function claimsCommittedChange(message: string): boolean {
  return CLAIMED_COMMIT_VERBS_RE.test(message);
}

registerHook('user_prompt_submit', userPromptSubmitHandler);
// followsMatcher: this handler filters no tool, but it must not force the catch-all matcher. On Claude Code it is a no-op anyway, and on Copilot CLI -- the harness it exists for -- the installed matcher plays no part, since that shim receives every postToolUse event regardless. So accepting the event's existing narrowed matcher costs the delivery nothing and keeps every other harness from paying a hook spawn on tool calls no handler wants.
registerHook('post_tool_use', pendingContextHandler, { advisory: true, followsMatcher: true });

export { claimsCommittedChange, pendingContextHandler, userPromptSubmitHandler };
