import * as fs from 'node:fs'
import * as path from 'node:path'

export interface RepoLocalExecutableDecoys {
  marker: string
  preloadOption: string
}

export function createRepoLocalExecutableDecoys(root: string): RepoLocalExecutableDecoys {
  const gitExe = path.join(root, 'git.exe')
  const cmdExe = path.join(root, 'cmd.exe')
  const marker = path.join(root, '.repo-local-executable-ran')
  const preload = path.join(root, '.repo-local-executable-preload.cjs')

  for (const executable of [gitExe, cmdExe]) {
    try {
      fs.linkSync(process.execPath, executable)
    } catch {
      fs.copyFileSync(process.execPath, executable)
    }
  }

  const gitVerbs = JSON.stringify(['rev-parse', 'ls-files', 'cat-file', 'ls-tree', 'diff-tree', 'diff-index', 'npm.cmd'])
  fs.writeFileSync(preload, [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    `const gitVerbs = new Set(${gitVerbs})`,
    `const executable = path.basename(process.execPath).toLowerCase()`,
    `if (['git.exe', 'cmd.exe'].includes(executable) ||`,
    `    process.argv.some((arg) => gitVerbs.has(arg.toLowerCase()))) fs.writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    '',
  ].join('\n'))

  return {
    marker,
    preloadOption: `--require="${preload.replace(/\\/g, '/')}"`,
  }
}
