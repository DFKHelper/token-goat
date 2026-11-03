import type { Command } from 'commander'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>
type GuardedAction = Parameters<GuardFn>[0]

interface IndexCommandHandlers {
  cmdIndex: GuardedAction
  cmdMap: GuardedAction
  cmdBridgesStatus: GuardedAction
  cmdCommands: GuardedAction
  cmdMcpServe: GuardedAction
}

interface IndexCommandLimits {
  maxFilesScanned: number
  maxFilesScannedForced: number
  inlineEmbedBudgetMs: number
}

export function registerIndexCommands(
  program: Command,
  guard: GuardFn,
  handlers: IndexCommandHandlers,
  limits: IndexCommandLimits,
): void {
  program
    .command('index [path]')
    .description('parse all git-tracked files and (re)build the symbol index')
    .option('--walk', 'if not a git repo, index a bounded directory walk instead (skips .env / generated / oversized trees)')
    .option('--force', 'bypass the SHA-freshness cache and reindex every tracked file, even byte-identical ones (e.g. after a parser upgrade changes what gets extracted)')
    .option('--force-walk', `index a non-git folder via --walk and raise its ${limits.maxFilesScanned} source-file refusal to ${limits.maxFilesScannedForced} (slow; produces a large index)`)
    .option('--embed', `embed every file before returning; without it, files still waiting after ${limits.inlineEmbedBudgetMs / 1000} s of embedding are left to the background worker`)
    .action(guard(handlers.cmdIndex))

  program
    .command('map')
    .description('project overview')
    .option('-c, --compact', 'compact, low-token summary')
    .option('--json', 'emit the project map as JSON instead of text')
    .action(guard(handlers.cmdMap))

  program
    .command('bridges-status')
    .description('hook-event parity matrix across every AI-harness bridge (read-only static analysis, never invokes a real harness binary)')
    .option('--json', 'emit the matrix as JSON instead of text')
    .action(guard(handlers.cmdBridgesStatus))

  program
    .command('commands')
    .description('machine-readable manifest of every registered command, its options, and its arguments')
    .option('--json', 'emit the manifest as JSON instead of text')
    .option('--grep <pattern>', 'filter to commands whose name, description, or aliases match this regex')
    .action(guard(handlers.cmdCommands))

  program
    .command('mcp-serve')
    .description('run token-goat as an MCP stdio server exposing surgical reads and local compression/handoff tools')
    .action(guard(handlers.cmdMcpServe))
}
