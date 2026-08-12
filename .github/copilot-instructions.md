<!-- token-goat-vscode-begin -->
## token-goat

**Gate — before every file read, answer one question first: is there a token-goat command that returns just what I need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an oversight. The gate is per file: batched or parallel reads do not exempt it.

This gate decides *whether* to reach for a read tool at all. VS Code’s supported MCP integration and its built-in file-read tools only pick the *fallback* once token-goat has been ruled out for this read — they never authorize skipping the gate.

Fallback clauses may name your harness's own native read, search, and edit tools, or its shell helpers. Shell binaries and editor programs are commands invoked through the shell tool, never tool identifiers, and must never appear in an agent's tools frontmatter or an allowed-tools list. This paragraph deliberately names no specific tool or binary: instruction-file loaders harvest such names into a tool allowlist and then warn that every one of them is unknown.

Exemptions (gate passes, read directly): the file is under ~200 lines and you need all of it; it was never indexed (new, untracked, or generated this turn); it is binary or an image; the target has no symbol handle (e.g. a literal mid-function).

Failure shapes to catch yourself in, and the command that replaces each:
- a shell text search with context flags to find a function body → `read "file::symbol"`
- paging one function with view/view_range → `read "file::symbol"`
- reading one heading of a large doc → `section "file::Heading"`
- searching for a symbol's callers → `refs file::symbol --callers`
- searching for a *concept* rather than a literal string → `semantic "description"`
- re-reading output you already captured → `bash-output`/`web-output` by ID
- a directory listing or recursive wildcard walk to orient in an unfamiliar repo → `map --compact`

Commands: `symbol NAME`, `read "file::symbol"`, `section "file::Heading"`, `semantic "description"`, `outline file`/`skeleton file`, `map --compact`, `refs file::symbol --callers`, `changed --symbol`, `config-get file KEY`, `bash-output`/`web-output`, `gdrive-sections <file-id>`.

Sub-agent briefs must carry this gate verbatim: a sub-agent inherits none of this context and its reads spend the same token budget.

`token-goat stats` — self-check. Flat counts during code work mean the gate is being skipped.

**Compressed payloads:** a message containing a token-goat payload block (recognizable by a `recovery: token-goat retrieve <id>` line) is compressed text, not an answer. Call the MCP tool `retrieve_text` with that id to recover the original text, then answer the question the message asks using the recovered text. Never present the raw payload to the user as the response; if the `retrieve_text` tool is unavailable (the MCP server is not running, or the chat is not in Agent mode), say so plainly and ask the user to switch to Agent mode or run `token-goat install --vscode`.

VS Code support: token-goat install --vscode configures a stdio MCP server under the servers root key in your user-profile mcp.json by default (add --project for the workspace .vscode/mcp.json instead). VS Code may call these MCP tools when selected; MCP does not intercept VS Code’s built-in file reads.
<!-- token-goat-vscode-end -->
