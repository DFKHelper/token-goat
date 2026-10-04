/** The routing reminder the SessionStart hook injects. It lives apart from the hook so `stats --payloads` can measure the exact text a session receives: importing hooks_session_start.ts for that would register the hook as a side effect. */

/** Generic reminder used when the cwd is missing, unresolvable, or not indexed. */
const GENERIC_REMINDER =
  'token-goat: prefer surgical reads over the Read/Grep tools on this codebase; shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are just commands, not tool names -- `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::Heading"`, `token-goat semantic "description"`, `token-goat outline <file>`. Run `token-goat index .` if this project is not indexed yet.'

/** Reminder used when the cwd resolves to an indexed project. Deliberately omits the exact symbol count: this string lands in the earliest, most cacheable position of a SessionStart request (the part a provider's prompt/prefix cache matches on), and `countSymbols()` drifts on every reindex -- a live number here would invalidate that cache prefix every session, and every time the index changes mid-session. "Is indexed" is the only signal an agent acts on; the count was decoration in the worst possible position. Byte-identical across reindexes by construction: nothing in this string depends on index state beyond the ok/not-ok branch already selected by the caller. */
const INDEXED_REMINDER =
  'token-goat: this project is indexed. Prefer `symbol <name>`, `read "file::symbol"`, ' +
  '`section "file::Heading"`, `semantic "description"`, or `outline <file>` over a full ' +
  'Read/Grep tool call; for JSON/YAML use `json-query file \'a.b.c\'` or `yaml-query` (nested keys are not symbols); ' +
  'shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls` are still just commands.'

/** Appended to either reminder: a finding kept only in the conversation is lost at the next compaction, and nothing else tells the model a note survives one. */
const NOTE_REMINDER = ' Record a finding that must outlive a compaction with `token-goat note set <key> "<finding>"`; notes come back at every session start.'

/** Build the reminder string for `cwd`: distinguishes an indexed project from the generic fallback. */
export function buildReminder(indexed: boolean): string {
  return (indexed ? INDEXED_REMINDER : GENERIC_REMINDER) + NOTE_REMINDER
}
