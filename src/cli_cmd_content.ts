import type { Command } from 'commander'
import * as path from 'path'
import { runExit } from './cli_dispatch.js'
import type { runBenchCommand } from './cli_bench.js'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>
type GuardedAction = Parameters<GuardFn>[0]

interface ContentCommandHandlers {
  cmdContentCompress: GuardedAction
  cmdRetrieve: GuardedAction
  cmdHandoffCreate: GuardedAction
  cmdHandoffResolve: GuardedAction
  runBenchCommand: typeof runBenchCommand
  out: (text: string) => void
}

export function registerContentCommands(program: Command, guard: GuardFn, handlers: ContentCommandHandlers): void {
  program
    .command('bench')
    .description('replay a corpus of captured command output through the compressors; prints the byte savings ratio and a fidelity check, and exits 1 when a must-keep line was dropped')
    .option('--corpus <dir>', 'corpus directory (default: tests/fixtures/bench, relative to the working directory)')
    .option('--tsv <path>', 'append one result row, keyed by the current commit, creating the file and its header if absent')
    .option('--validate', 'score the corpus with control filters instead: proves the ratio has a floor and the fidelity guard can actually fail')
    .option('-j, --json', 'output as JSON')
    .action((opts: { corpus?: string; tsv?: string; validate?: boolean; json?: boolean }) =>
      // A report graded by its exit code, not an error message: it goes to stdout whether or not a check failed, the way doctor's does.
      runExit(() => {
        const { text, code } = handlers.runBenchCommand({
          corpus: opts.corpus ?? path.join('tests', 'fixtures', 'bench'),
          ...(opts.tsv !== undefined ? { tsv: opts.tsv } : {}),
          ...(opts.validate === true ? { validate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        })
        handlers.out(text)
        return code
      }),
    )

  program
    .command('compress-text [text]')
    .description('compress arbitrary local text and print an opaque recovery ID plus compact payload')
    .option('--file <path>', 'read text from a local file instead of the argument')
    .option('--payload', 'always print the compact payload, even when inlining it costs more tokens than the original text')
    .action(guard(handlers.cmdContentCompress))

  program
    .command('retrieve <id>')
    .description('retrieve original text previously stored by token-goat compress')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the retrieved text')
    .option('--full', 'print the entire retrieved text with no head/tail elision (default behaviour when no other flag is given)')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .action(guard(handlers.cmdRetrieve))

  program
    .command('handoff-create <name> [text]')
    .description('create a project-local named compressed handoff')
    .option('--file <path>', 'read handoff text from a local file instead of the argument')
    .action(guard(handlers.cmdHandoffCreate))

  program
    .command('handoff-resolve <name>')
    .description('resolve a project-local handoff compactly, or return it in full')
    .option('--full', 'return the full handoff text')
    .action(guard(handlers.cmdHandoffResolve))
}
