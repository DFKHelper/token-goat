# token-goat VS Code extension

This lightweight extension has two commands:

- **token-goat: Send Selection as Compressed Payload** calls the local
  `token-goat compress-text` CLI and opens VS Code chat with the resulting payload.
- **token-goat: Send Surgical Read Payload** calls `token-goat compress-text`
  for the active cursor's 51-line excerpt and opens VS Code chat with its
  compressed payload. This avoids indexing temporary files.

The extension uses only supported VS Code APIs. `workbench.action.chat.open`
prefills a chat query; it does not submit the chat automatically.

Build and install manually:

```sh
npm install
npm run compile
npx @vscode/vsce package
code --install-extension token-goat-vscode-0.1.0.vsix
```

`token-goat install --vscode` deliberately configures only the project-local
MCP server and Copilot instructions. It does not copy or install this VSIX.
