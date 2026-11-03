import type { Command } from 'commander'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>
type GuardedAction = Parameters<GuardFn>[0]

interface IntegrationCommandHandlers {
  cmdHook: GuardedAction
  cmdInstall: GuardedAction
  cmdUninstall: GuardedAction
  cmdMcpStatus: GuardedAction
  cmdWorkerStart: GuardedAction
  cmdWorkerStop: GuardedAction
  cmdWorkerStatus: GuardedAction
  cmdHookServerRun: GuardedAction
  cmdHookServerStatus: GuardedAction
  cmdHookServerStop: GuardedAction
}

export function registerIntegrationCommands(
  program: Command,
  guard: GuardFn,
  handlers: IntegrationCommandHandlers,
): void {
  program
    .command('hook <event>')
    .description('hook relay entrypoint (reads JSON on stdin)')
    .option('--harness <name>', 'override harness detection for this invocation (sets TOKEN_GOAT_HARNESS_OVERRIDE)')
    .action(guard(handlers.cmdHook))

  program
    .command('install')
    .description('install hooks into Claude Code settings, or with harness flags into those harnesses instead')
    .option('-p, --project', 'install into project scope instead of user scope')
    .option('--user', 'with --vscode, install into user scope instead of this project (every project at once, but nothing past the first folder of a multi-root workspace)')
    .option('--codex', 'patch Codex CLI ($CODEX_HOME or ~/.codex: config.toml, AGENTS.md)')
    .option('--gemini', 'patch Gemini CLI (~/.gemini/settings.json)')
    .option('--qwen', 'patch Qwen Code (~/.qwen/settings.json)')
    .option('--kimi', 'register a Kimi Code hook config, shim, instructions block and skill ($KIMI_CODE_HOME or ~/.kimi-code: config.toml, hooks/token-goat-shim.cjs, AGENTS.md, skills/token-goat/SKILL.md)')
    .option('--pi', 'drop a pi (pi-coding-agent) extension (~/.pi/agent/extensions/token-goat.ts)')
    .option('--opencode', 'drop an opencode plugin (~/.config/opencode/plugins/token-goat.ts, or under $XDG_CONFIG_HOME when set)')
    .option('--hermes', 'verify token-goat hooks are present for Hermes Agent (writes nothing new)')
    .option('--openclaw', 'register an OpenClaw plugin (~/.openclaw/openclaw.json, ~/.openclaw/plugins/token-goat.ts)')
    .option('--copilot', 'register a Copilot CLI hook config and routing block (~/.copilot/hooks/token-goat.json, ~/.copilot/hooks/token-goat-shim.cjs, ~/.copilot/copilot-instructions.md; with --local or -p/--project, <project>/.github/hooks/token-goat.json, <project>/.github/hooks/token-goat-shim.cjs, <project>/.github/copilot-instructions.md)')
    .option('--grok', 'register a Grok CLI (xAI Grok Build) hook config (~/.grok/hooks/token-goat.json, ~/.grok/hooks/token-goat-shim.cjs)')
    .option('--antigravity', 'register an Antigravity CLI (agy) plugin (~/.gemini/config/plugins/token-goat/: plugin.json, hooks.json, and token-goat-hook.cmd on Windows)')
    .option('--vscode', 'configure a VS Code MCP server (the workspace .vscode/mcp.json by default; --user for the user-profile mcp.json) and Copilot routing guidance')
    .option('--visualstudio', 'configure a Visual Studio (2022 17.14+ / 2026) Copilot MCP server and routing guidance, no hooks (%USERPROFILE%\\.mcp.json and %USERPROFILE%\\copilot-instructions.md; -p/--project for <project>/.mcp.json and <project>/.github/copilot-instructions.md)')
    .option('--zed', 'register token-goat as a Zed MCP context server (%APPDATA%\\Zed\\settings.json on Windows, ~/.config/zed/settings.json elsewhere, plus a generated shim script); Zed has no hooks API, so this is user scope only, no -p/--project support')
    .option('--cursor', 'register a Cursor MCP server (~/.cursor/mcp.json by default; -p/--project for <project>/.cursor/mcp.json); writes no Cursor hooks config -- Cursor already imports the Claude Code hooks `token-goat install` writes to ~/.claude/settings.json')
    .option('--jetbrains', 'configure a JetBrains Suite (WebStorm, IntelliJ, PyCharm, Rider) MCP server and Copilot routing guidance')
    .option('--neovim', 'install Neovim Lua integration module (<project>/.nvim/token-goat.lua, or user plugin dir)')
    .option('--aider', 'install Aider coding conventions (<project>/CONVENTIONS.md, or ~/.aider.conventions.md)')
    .option('--detect', 'inspect the current workspace and detect all IDEs and coding agent ecosystems')
    .option('--auto', 'automatically install token-goat across all detected developer ecosystems')
    .option('--all', 'install token-goat across all supported IDE and coding agent environments')
    .option('--local', 'with --pi or --copilot, install the project-local config instead of the global one (<project>/.pi/extensions/token-goat.ts, <project>/.github/hooks/token-goat.json); the same as -p/--project')
    .option('--no-index', 'do not queue the project in the current directory for its first index (TOKEN_GOAT_INSTALL_INDEX=0 does the same)')
    .action(guard(handlers.cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings, or with harness flags from those harnesses instead')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .option('--user', 'with --vscode, remove the user-scope install instead of this project one')
    .option('--codex', 'strip the Codex CLI integration ($CODEX_HOME or ~/.codex: config.toml, AGENTS.md)')
    .option('--gemini', 'strip the Gemini CLI integration (~/.gemini/settings.json)')
    .option('--qwen', 'strip the Qwen Code integration (~/.qwen/settings.json)')
    .option('--kimi', 'strip the Kimi Code integration (config.toml hooks, hooks/token-goat-shim.cjs, the AGENTS.md block and skills/token-goat under $KIMI_CODE_HOME or ~/.kimi-code)')
    .option('--pi', 'remove the pi (pi-coding-agent) extension')
    .option('--opencode', 'remove the opencode plugin')
    .option('--hermes', 'no-op verification flag for symmetry with install (removes no files)')
    .option('--openclaw', 'remove the OpenClaw plugin and config entry')
    .option('--copilot', 'remove the Copilot CLI hook config and shim script, and strip the token-goat block from ~/.copilot/copilot-instructions.md (or <project>/.github/copilot-instructions.md with --local or -p/--project)')
    .option('--grok', 'remove the Grok CLI hook config and shim script')
    .option('--antigravity', 'remove the Antigravity CLI (agy) plugin (~/.gemini/config/plugins/token-goat/)')
    .option('--vscode', 'remove the VS Code MCP server (project scope by default; --user for the user-profile one) and routing guidance')
    .option('--visualstudio', 'remove the Visual Studio MCP server entry and routing guidance (user scope by default; -p/--project for the project one)')
    .option('--zed', 'remove the Zed MCP context server entry and its generated shim script')
    .option('--cursor', 'remove the Cursor MCP server entry (user scope by default; -p/--project for the project one)')
    .option('--jetbrains', 'remove the JetBrains MCP server entry and Copilot routing guidance')
    .option('--neovim', 'remove the Neovim Lua integration module')
    .option('--aider', 'remove Aider coding conventions')
    .option('--all', 'uninstall token-goat across all supported environments')
    .option('--local', 'with --pi or --copilot, remove the project-local config instead of the global one; the same as -p/--project')
    .option('--purge', 'also delete the data directories (index, caches, session state, logs); refuses while the worker is running')
    .action(guard(handlers.cmdUninstall))

  program
    .command('mcp-status')
    .description('check whether an MCP integration is already configured (used by the VS Code extension)')
    .option('--vscode', 'check VS Code mcp.json (user scope, plus workspace scope with --project)')
    .option('--visualstudio', 'check the Visual Studio %USERPROFILE%\\.mcp.json (plus the project .mcp.json with --project)')
    .option('-p, --project', 'also check the project file: .vscode/mcp.json for --vscode, .mcp.json for --visualstudio (relative to --cwd or the real cwd)')
    .action(guard(handlers.cmdMcpStatus))

  const worker = program.command('worker').description('background indexer lifecycle')
  worker.command('start').description('start the background indexer').action(guard(handlers.cmdWorkerStart))
  worker.command('stop').description('stop the background indexer; exits 1 and says so when the worker is left running').action(guard(handlers.cmdWorkerStop))
  worker.command('status').description('check if the indexer is running').action(guard(handlers.cmdWorkerStatus))

  const hookServer = program.command('hook-server').description('resident processes that answer hook calls and read-only commands without starting Node for each one')
  hookServer.command('run', { hidden: true }).description('serve one slot (started automatically by the first hook call)').option('--slot <n>', 'which slot to serve', '0').action(guard(handlers.cmdHookServerRun))
  hookServer.command('status').description('list the running hook servers').option('-j, --json', 'output as JSON').action(guard(handlers.cmdHookServerStatus))
  hookServer.command('stop').description('stop every running hook server (the next hook call starts a fresh one)').action(guard(handlers.cmdHookServerStop))
}
