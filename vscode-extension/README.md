# token-goat VS Code extension

Send code to Copilot Chat using fewer tokens.

## What this does

When you paste code into Copilot Chat, every line costs tokens. This
extension runs your text through the local `token-goat` compressor first,
then puts the much smaller result into the chat input box for you. The
chat model understands the compressed form, so you get the same answers
while spending fewer tokens.

Nothing is sent automatically: the compressed text appears in the chat
input and you press Enter yourself. Temporary files are deleted after
each use.

## The two commands

Open the Command Palette (`Ctrl+Shift+P`) and type **token-goat**,
right-click inside an editor, or use the goat icon in the editor title bar:

- **token-goat: Send Selection to Chat (Compressed)** — takes the text
  you have highlighted and sends it to chat in compressed form. Useful
  when you want to ask about a specific snippet.

- **token-goat: Send Lines Around Cursor to Chat (Compressed)** — no
  selection needed. Grabs the 25 lines above and 25 lines below your
  cursor (51 lines total) and sends them compressed, with the file name
  and line range noted. Useful for "explain what's happening here"
  questions.

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
