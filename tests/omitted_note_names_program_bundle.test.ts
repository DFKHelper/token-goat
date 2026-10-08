// The note that replaces a suggestion whose quoting a path broke must name the program the suggestion was for, on the real shipping path: the built bundle's `hook pre_tool_use` entry, not the guard called in-process.

// HAND-DERIVED: the file name `it's$MARK.odt` holds both an apostrophe and a `$`, a value neither quote mark holds in both shells, so the pandoc hint cannot spell it and the guard drops the whole command. The expected sentence is what the guard promises (hint_suggestion_guard.ts omitted()), written here independently: the program word, then "(command omitted", never "token-goat (command omitted" for a pandoc command. The payload shape is Claude Code's PreToolUse Read event (hook_event_name, session_id, cwd, tool_name, tool_input.file_path).
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let home: string
let project: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-omitted-note-home-'))
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-omitted-note-proj-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

function hookContext(filePath: string): string {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'e2e-omitted-note', cwd: project, tool_name: 'Read', tool_input: { file_path: filePath } })
  const env = { ...process.env, TOKEN_GOAT_HOME: home }
  const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { input: payload, encoding: 'utf8', env, cwd: project })
  expect(run.status, run.stderr).toBe(0)
  return run.stdout
}

describe('built bundle: the omitted-command note names its program', () => {
  it('says pandoc, not token-goat, when an Office file name no quote can hold is in the pandoc command', () => {
    const file = path.join(project, "it's$MARK.odt")
    fs.writeFileSync(file, 'PK\u0003\u0004 not a real document')
    const out = hookContext(file)
    expect(out).toContain('pandoc (command omitted: the path contains shell metacharacters)')
    expect(out).not.toContain('token-goat (command omitted')
    expect(out).not.toContain('<a value no quote mark can hold>')
  })
})
