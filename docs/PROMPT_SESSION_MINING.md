# Session Mining Prompt for token-goat Improvements

Use this prompt in any Copilot CLI, Claude Code, or IDE AI chat session to inspect the transcript for missed context savings, hook friction, tool errors, or performance bottlenecks, and generate a concise feedback card for the token-goat maintainer.

---

## User Prompt

```text
Audit our entire session history for token-goat optimization opportunities and generate a concise report for the maintainer.

Analyze:
1. Missed surgical reads: Where did we read whole files or large sections when token-goat `symbol`, `read`, or `section` could have saved tokens?
2. Hook friction & hints: Did token-goat hints fire that were ignored? Did hook denials cause friction or confusion?
3. Large command outputs: Were there large logs, diffs, or terminal outputs that `token-goat compress` could have shrunk?
4. Performance & bugs: Did any token-goat commands fail, hang, or misparse?

Output a "Maintainer Feedback Card" (under 150 words) with:
- Task Summary: (1 sentence on what we did)
- Friction & Missed Savings: (2–3 bullet points with specific files/tools)
- Recommended Fix: (1 concrete change/feature to improve token-goat)
```

---

## Example Output

```markdown
### Maintainer Feedback Card
- **Task Summary:** Refactored user authentication endpoints and updated database migration scripts in TypeScript.
- **Friction & Missed Savings:**
  - Full `view` was called 4 times on `src/auth.ts` (850 lines) to look up `verifyToken` instead of `token-goat read "src/auth.ts::verifyToken"`.
  - Hint hook fired 6 times suggesting `token-goat section`, but agent ignored it because the prompt didn't enforce surgical reads.
  - Test output was printed raw (3,200 lines) instead of being piped through `token-goat compress -f vitest`.
- **Recommended Fix:** Make the preToolUse read hook auto-fold large function bodies on first read of files >500 lines to prevent accidental context flooding.
```
