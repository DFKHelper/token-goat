/** Project-scope `install --vscode --project` creates `.github/copilot-instructions.md` (and `.github` itself when absent); uninstall must remove what the install created and keep what the user already had. PROVENANCE: HAND-DERIVED. The expected end states follow from the install writing a delimited block into the file and the created-configs ledger recording only what was absent beforehand; copilot_cli_install.ts's `--local` instructions file is the in-repo precedent for the same ownership rule. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installVscode, uninstallVscode } from '../src/bridges/vscode_install.js'

const ENV_KEYS = ['APPDATA', 'HOME', 'USERPROFILE'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
let root: string
let project: string

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-proj-uninstall-')))
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  for (const k of ENV_KEYS) process.env[k] = path.join(root, 'home')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('project-scope instructions file ownership', () => {
  it('removes the instructions file and the .github directory it created', () => {
    installVscode({ project: true, projectRoot: project })
    expect(fs.existsSync(path.join(project, '.github', 'copilot-instructions.md'))).toBe(true)
    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.existsSync(path.join(project, '.github'))).toBe(false)
  })

  it('keeps a pre-existing instructions file and its content', () => {
    const file = path.join(project, '.github', 'copilot-instructions.md')
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, '# mine\n')
    installVscode({ project: true, projectRoot: project })
    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.readFileSync(file, 'utf8')).toBe('# mine\n')
  })

  it('keeps a pre-existing .github directory but removes the file it added', () => {
    fs.mkdirSync(path.join(project, '.github'))
    fs.writeFileSync(path.join(project, '.github', 'CODEOWNERS'), '* @me\n')
    installVscode({ project: true, projectRoot: project })
    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.readdirSync(path.join(project, '.github'))).toEqual(['CODEOWNERS'])
  })
})
