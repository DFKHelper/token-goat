/** The owner record for a Copilot hooks directory, split out of copilot_cli_install.ts so the hook path (vscode_duplicate.ts) can read it without loading the installer and everything it imports. */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Which token-goat installs rely on the hooks file in one hooks directory. VS Code's agent reads the same `~/.copilot/hooks` and `.github/hooks` directories Copilot CLI does, so `install --copilot` and `install --vscode` share one `token-goat.json` and one shim there. Removing the file for one of them must not take it away from the other, so each install records itself in a sidecar and the files go only when the last owner leaves. The sidecar's name must not end in `.json`: VS Code treats every `.json` file in a hooks directory as a hooks file. */
export type CopilotHooksOwner = 'copilot' | 'vscode'

export const HOOKS_CONFIG_FILE = 'token-goat.json'
const HOOKS_OWNERS_FILE = 'token-goat.owners'

export function copilotHooksOwnersPath(hooksDir: string): string {
  return path.join(hooksDir, HOOKS_OWNERS_FILE)
}

/** Owners recorded for `hooksDir`. A hooks file with no sidecar predates the sidecar, when only `install --copilot` wrote it, so it counts as Copilot's. */
export function readCopilotHooksOwners(hooksDir: string): Set<CopilotHooksOwner> {
  const owners = new Set<CopilotHooksOwner>()
  let text: string
  try {
    text = fs.readFileSync(copilotHooksOwnersPath(hooksDir), 'utf8')
  } catch {
    if (fs.existsSync(path.join(hooksDir, HOOKS_CONFIG_FILE))) owners.add('copilot')
    return owners
  }
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim()
    if (name === 'copilot' || name === 'vscode') owners.add(name)
  }
  return owners
}
