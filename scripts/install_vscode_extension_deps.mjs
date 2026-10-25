// Installs vscode-extension's own dependencies for a fresh linked worktree.
// Runs `npm ci --ignore-scripts` inside vscode-extension so that no lifecycle script runs.
// npm is located beside the running node binary, since a bare `npm` is a `.cmd` shim on Windows.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const extensionDir = path.resolve(scriptDir, '..', 'vscode-extension')

// Candidate locations of npm-cli.js for a node binary: Windows keeps npm beside node.exe, Unix under lib/.
function npmCliCandidates(nodeBinDir) {
  return [
    path.join(nodeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeBinDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
}

function findNpmCli() {
  const found = npmCliCandidates(path.dirname(process.execPath)).find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`npm-cli.js not found beside ${process.execPath}; install npm next to this node binary`)
  }
  return found
}

if (!fs.existsSync(path.join(extensionDir, 'package-lock.json'))) {
  throw new Error(`no package-lock.json in ${extensionDir}; run this from a token-goat checkout`)
}

const result = spawnSync(process.execPath, [findNpmCli(), 'ci', '--ignore-scripts'], {
  cwd: extensionDir,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
}
