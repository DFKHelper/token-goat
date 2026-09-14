# MCP PostToolUse payload shape, and whether a block array can replace a tool result

Answers the two questions `tasks/***REMOVED***-mining-plan.md` Task 0 is blocked on. Task 0 asks them of
`mcp__claude-in-chrome__*`, whose tools were not available in the capturing session. Neither question
is specific to that server, so both were put to a connected one instead (`plugin:github:github`).

Provenance: CAPTURE. A temporary PostToolUse hook was registered in `.claude/settings.local.json`
(gitignored, removed afterwards) writing the raw stdin payload to `%TEMP%\tg-mcp-probe\`. Claude Code
build: the session of 2026-09-13. The raw payloads are deliberately NOT committed: they carry the
authenticated user's GitHub profile, including an email address. Only the shape is recorded here.

## (a) Is `tool_response` a bare array of content blocks?

**Yes.** Two captures, both a bare array with no `.content` wrapper:

| tool | `typeof tool_response` | `Array.isArray` | top-level keys | block types |
|---|---|---|---|---|
| `mcp__plugin_github_github__get_me` | `object` | `true` | n/a (array) | `text` |
| `mcp__plugin_github_github__get_latest_release` | `object` | `true` | n/a (array) | `text` |

Note the trap in the first column: `typeof` is `object` for an array too, so a reader that branches on
`typeof tr !== 'object'` passes an array through to code expecting `tr.content`, and a reader that
checks `tr.content` first finds `undefined` and silently yields nothing. `Array.isArray` is the only
check that separates them.

## (b) Does Claude Code accept a block ARRAY as `hookSpecificOutput.updatedToolOutput`?

**Yes — ARRAY_ACCEPTED.** A hook returning
`updatedToolOutput: [{ type: 'text', text: 'PROBE-ARRAY-ACCEPTED shape=bare-array' }]` for an MCP tool
had that array delivered to the model in place of the real result, verbatim and alone.

The verdict is only visible from the next turn. A hook reading back its own stdout proves nothing about
what the model received, and the first two attempts here read as ARRAY_REJECTED for an unrelated reason
(below) before the confound was controlled for.

## (c) Only one hook's `updatedToolOutput` survives, and token-goat's is the one that wins

Found while answering (b), not looked for. token-goat's own PostToolUse hook matches `^mcp__`. With it
registered, the probe's replacement never reached the model **for either shape** — array or plain
string — while the probe itself demonstrably ran, writing its capture file every time. Removing
`^mcp__` from token-goat's matcher and changing nothing else made the very same array land.

So a second PostToolUse hook cannot rewrite an MCP result alongside token-goat: exactly one
`updatedToolOutput` is applied and token-goat's is it. Two consequences, in opposite directions:

- For the plan's Task 2, this is good news and removes a risk. token-goat is the hook whose rewrite
  actually ships, so the work belongs in `postMcpHandler` rather than anywhere else.
- As a fact about the product, it means token-goat silently suppresses any other tool's MCP result
  rewriting. Worth knowing before anyone debugs the disappearance from the other side.

A probe that measures a rewrite while another rewriter is installed is measuring the wrong thing. The
control -- disable the other one, change nothing else, re-run -- is what turned a false negative into
the answer, and it is cheap.

## A committed example of the shape

`list_tags-bare-array.json` is one of these payloads, kept whole so a test can be written against a
real one rather than against a hand-typed guess at the format. It is a `list_tags` call against the
public `sqlite/sqlite` repository, chosen because nothing in the request or the reply names a person:
the tool input is an owner, a repo and a page size, and the reply is two public tag names and their
commit hashes. `cwd`, `session_id`, `transcript_path`, `tool_use_id` and `prompt_id` were removed;
nothing else was altered. Captured 2026-09-14 by the same temporary hook described above.

Note for anyone re-running Task 0 against `mcp__claude-in-chrome__*`: those tools were unavailable in
the 2026-09-14 session too, a second time. The bare-array shape is not specific to a server, so the
capture above answers the shape question; what is still uncaptured is a payload carrying an IMAGE
block beside text blocks, which Task 2 wants.
