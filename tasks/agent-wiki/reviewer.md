# Reviewer agent notes — token-goat

## `git diff` in this repo does not return a reviewable diff (2026-09-13)
token-goat's own Bash output filter compresses `git diff`, and its heuristic drops hunks it judges to be "likely whitespace/formatting". On one review of `src/pdf_extract.ts` it delivered 2 of 17 hunks. Nothing in the output says how many were dropped in a way that survives a skim, so the review reads as complete and is not. It also elided a `+` line adding a module doc comment, which reads as a *deletion* of that comment — a finding invented out of the filter rather than the change.

`TOKEN_GOAT_BASH_COMPRESS=0` does not suppress it: the compression is applied by a harness hook around the tool call, not by anything in the child process's environment, so an env prefix on the command reaches the wrong layer. (Worse, that prefix does reach vitest through lefthook, where it has caused runs of 83 and then 54 failures that read as a regression.)

Route every diff you intend to actually read through a file:

    git diff > scratch/x.diff        # then read scratch/x.diff

Same for `git show` and `git diff --cached`. `git diff --stat` is fine — it is a count, and a count is what tells you the prose diff lied to you. Compare the stat's hunk and line totals against what you were shown before concluding a review is complete.
