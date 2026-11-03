import type { Command } from 'commander'
import { VERSION } from './constants.js'
import type { cmdInstall } from './cli_install.js'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>

interface SystemCommandHandlers {
  cmdInstall: typeof cmdInstall
  out: (text: string) => void
}

export function registerSystemCommands(program: Command, guard: GuardFn, handlers: SystemCommandHandlers): void {
  program
    .command('upgrade')
    .alias('update')
    .description('check for updates and upgrade token-goat to the latest version')
    .option('--check', 'check whether an update is available without installing')
    .option('-j, --json', 'emit version check status as JSON')
    .action((opts: { check?: boolean; json?: boolean }) =>
      guard(async () => {
        const { cmdUpgrade } = await import('./cli_upgrade.js')
        await cmdUpgrade(opts, () => handlers.cmdInstall({}))
      })(),
    )

  program
    .command('version')
    .description('print the token-goat version')
    .action(
      guard(() => {
        handlers.out(VERSION)
      }),
    )
}
