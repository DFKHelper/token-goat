/** Copilot CLI's user-scope directory, in a module small enough for the hook path to import. */
import * as os from 'node:os'
import * as path from 'node:path'

/** The user-scope Copilot directory. Copilot CLI documents `COPILOT_HOME` as replacing `~/.copilot` wholesale for both hooks and instructions ("If `COPILOT_HOME` is set, create the file in `$COPILOT_HOME/hooks/`" -- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks). Ignoring it is a silent total failure rather than a degraded one: install reports success, writes a valid config to `~/.copilot`, and Copilot never reads that path, so every hook simply never fires and nothing surfaces the mismatch. Blank/whitespace is treated as unset, matching how an exported-but-empty variable behaves everywhere else. Lives in its own module so the Skill hook can resolve Copilot's skill directories without loading the installer. */
export function copilotCliUserRoot(): string {
  const override = process.env['COPILOT_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.copilot')
}
