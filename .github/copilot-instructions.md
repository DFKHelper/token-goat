<!-- token-goat-vscode-begin -->
## token-goat

**Gate — before every file read, answer one question first: is there a token-goat command that returns just what I need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an oversight. The gate is per file: batched or parallel reads do not exempt it.

This gate decides *whether* to reach for a read tool at all. VS Code’s supported MCP integration and its built-in file-read tools only pick the *fallback* once token-goat has been ruled out for this read — they never authorize skipping the gate.

Shell binaries and editor programs are commands run through the shell tool, never tool identifiers: keep them out of an agent's tools and allowed-tools lists, where loaders harvest the names and warn that each is unknown.

Exemptions (gate passes, read directly): the file is under ~200 lines and you need all of it; it was never indexed (new, untracked, or generated this turn); it is a genuinely opaque binary (not an image); the target has no symbol handle (e.g. a literal mid-function).

Failure shapes to catch yourself in, and the command that replaces each:
- not knowing which command answers a question you can already state in words → `answer "<question>"`, which runs the right command and refuses rather than guess
- a shell text search with context flags to find a function body → `read "file::symbol"`
- paging one function with view/view_range → `read "file::symbol"`
- issuing sequential or overlapping line-range reads across a file (paging) → `read "file::symbol"` / `outline file` / `skeleton file` / rg <pattern> <file>
- a read refused by a `[tg]` deny, retried with a shifted range, different lines, or another read tool → never retry reading the file at different lines; run the command the deny names or use bash-output / token-goat read
- reading a symbol plus chasing its callers and containing doc section as separate reads → `brief "file::symbol"`
- reading one heading of a large doc → `section "file::Heading"`
- searching for a symbol's callers → `refs file::symbol --callers`
- searching across symbols, headings, text, and concepts concurrently → `search "<query>"`
- searching for a *concept* rather than a literal string → `semantic "description"`
- re-reading output you already captured → `bash-output`/`web-output`/`mcp-output` by ID
- a directory listing or recursive wildcard walk to orient in an unfamiliar repo → `map --compact`
- pulling one value or subtree out of a JSON/YAML/XML file (manifest, lockfile, spec, config) → `json-query file 'a.b.c'` / `yaml-query file 'a.b.c'` / `xml-query file 'a.b.c'`
- opening an image to check its dimensions, format, or size → `image-meta file`
- opening a screenshot, diagram, or scan to read the text in it → `image-text file`
- running tests immediately on edited code without fast static validation → run language validator first (e.g. `ruff check --select F821 <file>`, `node --check`, `tsc --noEmit`) to catch missing imports and syntax errors before test execution
- passing concatenated or unquoted paths to shell tools → verify whitespace and argument separation in multi-path commands (e.g. `git add path1 path2`, never `git add path1path2`)

Commands: `symbol NAME`, `changed --symbol`, `config-get file KEY`, `json-outline`/`yaml-outline`/`xml-outline`, `gdrive-sections <file-id>`, and `token-goat --help` for the rest.

Sub-agent briefs must carry this gate verbatim: a sub-agent inherits none of this context and its reads spend the same token budget.

`token-goat stats` — self-check. Flat counts during code work mean the gate is being skipped.

**Compressed payloads:** a message containing a token-goat payload block (recognizable by a `recovery: token-goat retrieve <id>` line) is compressed text, not an answer. Call the MCP tool `retrieve_text` with that id to recover the original text, then answer the question the message asks using the recovered text. Never present the raw payload to the user as the response; if the `retrieve_text` tool is unavailable (the MCP server is not running, or the chat is not in Agent mode), say so plainly and ask the user to switch to Agent mode or run `token-goat install --vscode`.

VS Code support: token-goat install --vscode configures a stdio MCP server under the servers root key in your user-profile mcp.json by default (add --project for the workspace .vscode/mcp.json instead), and agent hooks that see VS Code’s built-in tool calls. The hooks can deny a repeated read, add a hint, and shrink an image before view_image loads it; they cannot fold or trim what a built-in read returns, and they leave terminal commands unchanged.
<!-- token-goat-vscode-end -->

<!-- token-goat-begin -->
## token-goat

**Gate — before every file read, answer one question first: is there a token-goat command that returns just what I need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an oversight. The gate is per file: batched or parallel reads do not exempt it.

This gate decides *whether* to reach for a read tool at all. Copilot CLI's native view, grep, and glob tools (with PowerShell commands Get-Content/Select-String as search fallbacks) only pick the *fallback* once token-goat has been ruled out for this read — they never authorize skipping the gate.

Shell binaries and editor programs are commands run through the shell tool, never tool identifiers: keep them out of an agent's tools and allowed-tools lists, where loaders harvest the names and warn that each is unknown.

Exemptions (gate passes, read directly): file under ~200 lines (tokens <file>) and need all of it; unindexed (new/untracked); opaque binary (not image); target has no symbol handle.

Failure shapes to catch yourself in, and the command that replaces each:
- not knowing which command answers a question you can already state in words → answer "<question>", which runs the right command and refuses rather than guess
- a shell text search with context flags to find a function body → read "file::symbol"
- paging one function with view/view_range → read "file::symbol"
- issuing sequential or overlapping line-range reads across a file (paging) → read "file::symbol" / outline file / skeleton file / rg <pattern> <file>
- a read refused by a [tg] deny, retried with a shifted range, different lines, or another read tool → never retry reading the file at different lines; run the command the deny names or use bash-output / token-goat read
- reading a symbol plus chasing its callers and containing doc section as separate reads → brief "file::symbol"
- reading one heading of a large doc → section "file::Heading"
- searching for a symbol's callers → refs file::symbol --callers
- searching across symbols, headings, text, and concepts concurrently → search "<query>"
- searching for a *concept* rather than a literal string → semantic "description"
- re-reading output you already captured → bash-output/web-output/mcp-output by ID
- a directory listing or recursive wildcard walk to orient in an unfamiliar repo → map --compact
- pulling one value or subtree out of a JSON/YAML/XML file (manifest, lockfile, spec, config) → json-query file 'a.b.c' / yaml-query file 'a.b.c' / xml-query file 'a.b.c'
- opening an image for dimensions/format/size → image-meta file
- opening a screenshot, diagram, or scan to read the text in it → image-text file
- running tests immediately on edited code without fast static validation → run language validator first (e.g. ruff check --select F821 <file>, node --check, tsc --noEmit) to catch missing imports and syntax errors before test execution
- checking file size/lines before reading → tokens <file>
- passing concatenated or unquoted paths to shell tools → verify whitespace and argument separation in multi-path commands (e.g. git add path1 path2, never git add path1path2)

Commands: symbol NAME, tokens <file>, changed --symbol, config-get file KEY, json-outline/yaml-outline/xml-outline, gdrive-sections <file-id>, and token-goat --help for the rest.

Sub-agent briefs must carry this gate verbatim: a sub-agent inherits none of this context and its reads spend the same token budget.

token-goat stats — self-check. Flat counts during code work mean the gate is being skipped.
<!-- token-goat-end -->
