import type { Command } from 'commander'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>
type GuardedAction = Parameters<GuardFn>[0]

export function registerDocumentCommands(program: Command, guard: GuardFn, cmdGdriveSections: GuardedAction): void {
  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .option('--fresh', 'skip the on-disk cache and force a live fetch')
    .action(guard(cmdGdriveSections))
}
