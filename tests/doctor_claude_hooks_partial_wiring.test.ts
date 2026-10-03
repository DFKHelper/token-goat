/** Doctor's "Claude Code hooks" row claims settings.json was overwritten or deleted, so it may only fire when no token-goat hook entry is left in either scope. A scope missing one event is the "Claude Code hook events" row's finding. PROVENANCE: HAND-DERIVED. The scenario is the reproduced one (install, run one hook, delete only hooks.PostToolUse from settings.json, run doctor); the settings shape (`hooks` keyed by event name, each an array of `{ hooks: [...] }` groups) is what Claude Code documents at https://code.claude.com/docs/en/hooks and what installHooks wrote into the scratch project in this run. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { runDoctor } from '../src/cli_doctor.js'
import { getGlobalDb } from '../src/stats.js'
import { clearModuleCaches } from '../src/reset.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let project = ''
let originalCwd = ''
let spies: WriteSpy[] = []

beforeEach(async () => {
  originalCwd = process.cwd()
  project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-partial-')))
  process.chdir(project)
  spies = [spyOnWrite(process.stdout, []), spyOnWrite(process.stderr, [])]
  await run(['node', 'token-goat', 'install', '--project', '--no-index'])
  // A Claude Code hook that ran while the hooks were wired: the row under test needs recent activity to fire at all.
  getGlobalDb().prepare('INSERT INTO stats (ts, kind, harness) VALUES (?, ?, ?)').run(Math.floor(Date.now() / 1000) - 60, 'hook:pre_tool_use', 'claudecode')
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  process.chdir(originalCwd)
  clearModuleCaches()
  fs.rmSync(project, { recursive: true, force: true })
})

function doctorRows(): Array<{ name: string; status: string; message: string }> {
  return runDoctor(project, path.join(project, 'config.toml'), project, [])
}

function editProjectSettings(edit: (hooks: Record<string, unknown>) => void): void {
  const file = path.join(project, '.claude', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> }
  edit(settings.hooks)
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

describe('doctor "Claude Code hooks" row', () => {
  it('stays quiet when one event is missing, and leaves the finding to the hook events row', () => {
    editProjectSettings((hooks) => { delete hooks.PostToolUse })
    const rows = doctorRows()
    expect(rows.find((r) => r.name === 'Claude Code hooks')).toBeUndefined()
    const events = rows.find((r) => r.name === 'Claude Code hook events')
    expect(events?.status).toBe('warn')
    expect(events?.message).toContain('PostToolUse')
  })

  it('still warns that the file was overwritten when no token-goat hook is wired at all', () => {
    editProjectSettings((hooks) => { for (const key of Object.keys(hooks)) delete hooks[key] })
    const row = doctorRows().find((r) => r.name === 'Claude Code hooks')
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('probably overwritten or deleted')
  })
})
