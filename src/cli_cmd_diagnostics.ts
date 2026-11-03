import type { Command } from 'commander'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>
type GuardedAction = Parameters<GuardFn>[0]

interface DiagnosticCommandHandlers {
  cmdStats: GuardedAction
  cmdDoctor: GuardedAction
  cmdBashOutput: GuardedAction
  cmdWebOutput: GuardedAction
  cmdMcpOutput: GuardedAction
  cmdPrSlice: GuardedAction
}

export function registerDiagnosticCommands(
  program: Command,
  guard: GuardFn,
  handlers: DiagnosticCommandHandlers,
): void {
  program
    .command('stats')
    .description('show session statistics (bare = totals only; --full for the breakdown)')
    .option('-j, --json', 'output as JSON')
    .option('--full', 'show the full breakdown (by source, by command, by day)')
    .option('--short', 'force the rich short KPI view even when stdout is not a TTY (e.g. piped)')
    .option('--methodology', 'explain local savings estimates and their billing limits')
    .option('--hooks', 'show the per-event/per-harness hook latency breakdown (median/p95/slowest/last-seen)')
    .option('--payloads', "show what token-goat adds to every session's context, and whether the files each note names were read again")
    .option('--window-days <days>', 'days to include (0 = all time)', '30')
    .option('--home-dir <path>', 'home directory (for testing)')
    .action(guard(handlers.cmdStats))

  program
    .command('doctor')
    .description('diagnose token-goat health')
    .option('--fast', 'skip slow host process scanning for quick health check')
    .option('--context', 'include context footprint analysis')
    .option('--json', 'emit check results as JSON instead of text')
    .option('--repair', 'automatically repair fixable issues (permissive settings, missing semantics models)')
    .option('--fix', 'alias for --repair')
    .option('--probe <harness>', 'run one real prompt through a harness (claudecode, codex, copilot_cli) and check that token-goat\'s context hooks reach the model; exits 3 for an editor host (vscode, visualstudio, jetbrains) that has no headless mode')
    .action(guard(handlers.cmdDoctor))

  program
    .command('bash-output [id]')
    .description('retrieve cached bash output by ID or file')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the output')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--file <path>', 'read from raw output file instead of cache')
    .option('--transcript', 'parse the --file as a JSONL agent transcript: keep assistant text blocks in order before filtering')
    .option('--verify-last-write [seconds]', 'verify the file or cache entry was written within [seconds] (default: 60s) to catch stale/no-op terminal output')
    .option('--strict', 'exit non-zero when --verify-last-write detects stale output')
    .action(guard(handlers.cmdBashOutput))

  program
    .command('web-output [id]')
    .description('retrieve a cached WebFetch response body by ID')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the response')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--raw', 'return the body as actually fetched, before extractCleanText cleaning, instead of the default cleaned text')
    .action(guard(handlers.cmdWebOutput))

  program
    .command('mcp-output [id]')
    .description('retrieve a cached MCP tool result by ID (the id an MCP post_tool_use hook cached, or a `[token-goat: compressed, full via mcp-output <id>]` label points here)')
    .option('--head <n>', 'show first N lines (or first N items with --json-query)')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the result')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--json-query <path>', 'query JSON content using a dot/bracket path expression (e.g. "issues[*].key"); filters are the ones json-query takes, see json-query --help')
    .option('--file <path>', 'read and query an on-disk tool spill file (e.g. content.json) instead of cache')
    .option('--json', 'emit query results as structured JSON envelope')
    .action(guard(handlers.cmdMcpOutput))

  program
    .command('pr-slice <pr> <slice>')
    .description(
      'one slice of a GitHub PR (files / one file\'s diff / review comments / description) via `gh` instead of a full `gh pr view`/`gh pr diff` dump\n\n' +
        'pr is a PR number or URL. slice is one of: files (changed files with +/- counts), ' +
        "diff:<path> (one file's diff hunk), comments (review comments), description (title/body/metadata)",
    )
    .option('--repo <owner/repo>', "target repo (default: resolved from the current directory's git remote 'origin')")
    .option('--json', 'emit the slice as JSON instead of text')
    .action(guard(handlers.cmdPrSlice))
}
