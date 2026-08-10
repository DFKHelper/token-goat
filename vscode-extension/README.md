# token-goat VS Code extension

Send code to Copilot Chat using fewer tokens.

## What this does

When you paste a long ticket, log file, or chunk of code into Copilot Chat,
every line costs tokens. This extension shrinks the text first with the local
`token-goat` compressor and puts the smaller version into the chat input box.
The chat model understands the compressed form, so you get the same answers
while spending fewer tokens. A little status-bar counter shows how many bytes
you've saved.

Nothing is sent automatically: the compressed text appears in the chat input
and you press Enter yourself. Temporary files are deleted after each use.

## The everyday commands (no coding knowledge needed)

In Copilot Chat, type `@token-goat` and pick one, or open the Command Palette
(`Ctrl+Shift+P`) and type **token-goat**:

- **Send Clipboard to Chat** (`/paste`) — copy a ticket, email, or error
  message anywhere, then send it compressed. No file or selection needed.
- **Summarize / Draft a Reply / Extract Action Items / Explain This Error**
  (`/summarize`, `/reply`, `/actions`, `/explain`) — one click: takes the
  selected text, or whatever you last copied, compresses it, and asks the
  question in plain language.
- **Send Errors/Warnings Only** (`/errors`) — open or right-click a log file
  and send just the errors, warnings, and the lines around them, instead of
  the whole multi-megabyte file.
- **List Archive Contents** — right-click a `.zip` someone attached to see
  what's inside without extracting it.

You can also right-click any file in the Explorer to send it compressed.

## The developer commands

Right-click inside a code editor, use the icon in the editor title bar, or
`@token-goat` in chat:

- **Send Selection** (`/selection`) — the highlighted text, compressed.
- **Send Lines Around Cursor** (`/context`) — the 25 lines above and below
  the cursor (configurable via `token-goat.contextLines`).
- **Send Symbol at Cursor** (`/symbol`) — the full function/class under the
  cursor, resolved through the token-goat index.
- **Send Whole File** (`/file`) and **Send Git Diff** (`/diff`).

## Requirements

- The `token-goat` CLI must be installed globally and on your PATH
  (`npm install -g token-goat`). On Windows the extension invokes the
  `token-goat.cmd` shim that npm creates.

## Build and install manually

```sh
npm install
npm run compile
npx @vscode/vsce package
code --install-extension token-goat-vscode-0.1.0.vsix
```

`token-goat install --vscode` deliberately configures only the project-local
MCP server and Copilot instructions. It does not copy or install this VSIX.
