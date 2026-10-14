// A whole-file dump of a file the Read gate would hand over whole passes, and the refusal that remains names a command that runs. CAPTURE (session transcripts 2026-08 to 2026-10): eight `cat` refusals of 0.8-12.6 KB files, most of them heading-less memory notes, each named `token-goat section "<file>::SectionHeading"`, which exits 1 with "has no headings"; none was run, and six were followed by a Read or sed of the same whole file. The fixtures are HAND-DERIVED to those shapes: an 806-byte note with no heading (the size of the first captured one), a doc past the floor with and without headings, and data files on either side of their type's threshold.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FILE_TYPE_THRESHOLDS } from '../src/hints/file_type_handler.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookOutput } from '../src/types.js'
import { ROOT, runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

let proj: string
let home: string
let seq = 0

function bash(command: string): HookOutput {
  seq += 1
  return preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: `cat-floor-${seq}`, raw: { cwd: proj } }))
}

function write(name: string, body: string): string {
  fs.writeFileSync(path.join(proj, name), body, 'utf8')
  return name
}

function denial(out: HookOutput): string {
  if (out.hookType !== 'deny') throw new Error(`expected a refusal, got ${JSON.stringify(out)}`)
  return out.message
}

/** The command a refusal leads with. */
function ledCommand(message: string): string {
  const m = /`(token-goat [^`]+)`/.exec(message)
  if (m === null) throw new Error('no command in: ' + message)
  return m[1] ?? ''
}

/** Runs a printed `token-goat <verb> "<arg>"` through the built bundle, from the project directory the hook resolved the path against. */
function runPrinted(command: string): { status: number | null; stdout: string; stderr: string } {
  const m = /^token-goat (\S+) "([^"]+)"$/.exec(command)
  if (m === null) throw new Error('unexpected command shape: ' + command)
  return runBundle([m[1] ?? '', m[2] ?? ''], { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home }) })
}

const NOTE_LINE = 'Shopify Admin API notes: rate limits, the bulk endpoint and the token that goes in the header.\n'
const headinglessNote = (bytes: number): string => NOTE_LINE.repeat(Math.ceil(bytes / NOTE_LINE.length)).slice(0, bytes)
const headedDoc = (bytes: number): string => {
  let out = '# Artwork Policy\n\n'
  for (let i = 1; out.length < bytes; i++) out += `## Clause ${i}\n\n${NOTE_LINE.repeat(4)}\n`
  return out
}

beforeEach(() => {
  clearModuleCaches()
  // Under the repo's ignored .tmp, not the system temp: the Bash hook lets every read of a system-temp file through, so nothing there is ever refused.
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
  proj = fs.mkdtempSync(path.join(ROOT, '.tmp', 'tg-cat-floor-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cat-floor-home-'))
})

afterEach(() => {
  for (const d of [proj, home]) fs.rmSync(d, { recursive: true, force: true })
  clearModuleCaches()
})

describe('cat of a file the Read gate would hand over whole', () => {
  it('passes an 806-byte heading-less note', () => {
    const note = write('reference_shopify_api.md', headinglessNote(806))
    expect(bash(`cat ${note}`).hookType).toBe('pass')
  })

  it('passes every spelling of the whole-file dump the refusal covers', () => {
    const note = write('note.md', headinglessNote(806))
    for (const command of [`cat "${note}"`, `bat ${note}`, `cat ${note} 2>&1`, `cat ${note} ${write('other.md', headinglessNote(900))}`, `sed -n '1,9p' ${note}`]) {
      expect(bash(command).hookType, command).not.toBe('deny')
    }
  })

  it('passes a JSON file under its type threshold and refuses one past it', () => {
    const small = write('small.json', JSON.stringify({ rows: 'x'.repeat(FILE_TYPE_THRESHOLDS.json - 100) }))
    const big = write('big.json', JSON.stringify({ rows: 'x'.repeat(FILE_TYPE_THRESHOLDS.json + 100) }))
    expect(bash(`cat ${small}`).hookType).toBe('pass')
    expect(denial(bash(`cat ${big}`))).toContain('token-goat json-')
  })

  it('still refuses a small .env file, which the Read gate also refuses to re-read at any size', () => {
    write('.env', 'DATABASE_URL=postgres://h/db\n')
    expect(denial(bash('cat .env'))).toContain('token-goat config-get ".env" "DATABASE_URL"')
  })

  it('refuses a multi-file cat for the files past the floor and names only those', () => {
    const small = write('small.md', headinglessNote(800))
    const big = write('big.md', headedDoc(200_000))
    const message = denial(bash(`cat ${small} ${big}`))
    expect(message).toContain('big.md')
    expect(message).not.toContain('small.md')
  })
})

describe('the refusal that remains names a command that runs', () => {
  it('names a real heading for a 200 KB doc with headings', () => {
    const doc = write('policy.md', headedDoc(200_000))
    const command = ledCommand(denial(bash(`cat ${doc}`)))
    expect(command).toBe('token-goat section "policy.md::Clause 1"')
    const ran = runPrinted(command)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('Shopify Admin API notes')
  })

  it('names a read of the first lines for a heading-less doc past the floor, never a section placeholder', () => {
    const note = write('project_taobao_intake.md', headinglessNote(30_000))
    const message = denial(bash(`cat ${note}`))
    expect(message).not.toContain('SectionHeading')
    const command = ledCommand(message)
    expect(command).toBe('token-goat read "project_taobao_intake.md::1-80"')
    const ran = runPrinted(command)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('Shopify Admin API notes')
  })

  it('names a read of the first lines for a large .txt file, never a grep for `<pattern>`', () => {
    const notes = write('notes.txt', headinglessNote(30_000))
    const message = denial(bash(`cat ${notes}`))
    expect(message).not.toContain('<pattern>')
    const ran = runPrinted(ledCommand(message))
    expect(ran.status, ran.stderr).toBe(0)
  })

  it('names a read of the first lines for a whole-file sed range over a large heading-less doc', () => {
    const lines = 320
    const note = write('ranged.md', NOTE_LINE.repeat(lines))
    expect(fs.statSync(path.join(proj, note)).size).toBeGreaterThan(FILE_TYPE_THRESHOLDS.txt)
    const message = denial(bash(`sed -n '1,${lines}p' ${note}`))
    expect(ledCommand(message)).toBe('token-goat read "ranged.md::1-80"')
  })
})
