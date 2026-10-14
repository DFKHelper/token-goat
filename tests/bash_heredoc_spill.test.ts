// A long Bash command's quoted heredocs move into temp files on Claude Code for Windows, whose Bash tool fails a command of about 7,300 characters or more before any of it runs. CAPTURE (session transcripts, Claude Code 2.1.220-2.1.296 on win32): 63 commands of 6,500 characters or more, all heredocs; every one of 7,963 characters or more failed with `/usr/bin/bash: -c: line 1: unexpected EOF while looking for matching` and a quote (exit 2), and token-goat's PreToolUse answered `{}` to each. The commands below are HAND-DERIVED to the shapes those had (a `cat > file <<'EOF'` of a markdown document, a command after it), padded to the lengths the measurements name.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HEREDOC_CERTAIN_FAILURE_CHARS, HEREDOC_SPILL_EFFECTIVE_CHARS, SPILL_MAX_AGE_MS, effectiveCommandLength, hasHeredocOpener, heredocSpillDir, spillQuotedHeredocs, writeSpilledBodies, type HeredocSpill } from '../src/bash_heredoc_spill.js'
import { tokenGoatHome } from '../src/constants.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookOutput } from '../src/types.js'
import { makeHookEvent } from './helpers/hook-event.js'

const DIR = 'C:/Temp/tg-heredoc'

function spilled(command: string): { command: string; bodies: string[]; paths: string[] } {
  const out: HeredocSpill = spillQuotedHeredocs(command, DIR)
  if ('refused' in out) throw new Error('refused: ' + out.refused)
  return { command: out.command, bodies: out.files.map((f) => f.body), paths: out.files.map((f) => f.path) }
}

function refusal(command: string): string {
  const out = spillQuotedHeredocs(command, DIR)
  if (!('refused' in out)) throw new Error('expected a refusal, got ' + out.command)
  return out.refused
}

describe('spillQuotedHeredocs', () => {
  it('replaces one heredoc with a read of a file holding its body lines, each with its newline', () => {
    const out = spilled("cat > notes.md <<'EOF'\n# Notes\nIt's a body with 'single' and \"double\" quotes.\nEOF")
    expect(out.bodies).toEqual(["# Notes\nIt's a body with 'single' and \"double\" quotes.\n"])
    expect(out.paths[0]).toMatch(/^C:\/Temp\/tg-heredoc\/[0-9a-f]{16}-[0-9a-f]{12}\.txt$/)
    expect(out.command).toBe(`cat > notes.md < '${out.paths[0]}'`)
  })

  it('keeps everything after the closing line as written', () => {
    const out = spilled("cat > f.md <<'EOF'\nbody\nEOF\nwc -c f.md && echo done")
    expect(out.command).toBe(`cat > f.md < '${out.paths[0]}'\nwc -c f.md && echo done`)
  })

  it('keeps the rest of the operator line, before and after the operator', () => {
    const out = spilled("cat <<'EOF' > f.md && wc -c f.md\nbody\nEOF")
    expect(out.command).toBe(`cat < '${out.paths[0]}' > f.md && wc -c f.md`)
    const mid = spilled("tee out.txt <<'EOF' >/dev/null\nbody\nEOF")
    expect(mid.command).toBe(`tee out.txt < '${mid.paths[0]}' >/dev/null`)
  })

  it('replaces two heredocs on two lines, each with its own file', () => {
    const out = spilled("cat > a.md <<'A'\nfirst\nA\ncat > b.md <<\"B\"\nsecond\nB\nls")
    expect(out.bodies).toEqual(['first\n', 'second\n'])
    expect(out.command).toBe(`cat > a.md < '${out.paths[0]}'\ncat > b.md < '${out.paths[1]}'\nls`)
  })

  it('replaces two heredocs opened on one line, whose bodies follow one another', () => {
    const out = spilled("cat <<'A' > a.md && cat <<'B' > b.md\nfirst\nA\nsecond\nB\necho ok")
    expect(out.bodies).toEqual(['first\n', 'second\n'])
    expect(out.command).toBe(`cat < '${out.paths[0]}' > a.md && cat < '${out.paths[1]}' > b.md\necho ok`)
  })

  it('reads a backslash-quoted delimiter as quoted', () => {
    const out = spilled('cat > f.sh <<\\EOF\necho "$HOME"\nEOF')
    expect(out.bodies).toEqual(['echo "$HOME"\n'])
    expect(out.command).toBe(`cat > f.sh < '${out.paths[0]}'`)
  })

  it('keeps lines that only look like the closing line inside the body', () => {
    const body = 'EOF;\n EOF\nEOFX\nxEOF\n\tEOF\nEOF \n'
    expect(spilled(`cat > f.txt <<'EOF'\n${body}EOF`).bodies).toEqual([body])
  })

  it('spills an empty body to an empty file', () => {
    expect(spilled("cat > empty.txt <<'EOF'\nEOF").bodies).toEqual([''])
  })

  // HAND-DERIVED from the audit: a content-addressed name let two sessions spilling one body truncate each other's file, and let a path planted ahead of time be written through.
  it('names a new file for every body, an identical one or the same command spilled again included', () => {
    const command = "cat > a <<'A'\nsame\nA\ncat > b <<'B'\nsame\nB"
    const first = spilled(command)
    const again = spilled(command)
    expect(new Set([...first.paths, ...again.paths]).size).toBe(4)
  })

  // HAND-DERIVED from the audit: bash reads the delimiter of `<<'EOF'x` as `EOFx`, while the lexer closed the body at the first `EOF` line, so the spilled body would have stopped there and `echo INJECTED` run as a command.
  it.each([
    "cat > f.txt <<'EOF'x\nsafe line\nEOF\necho INJECTED\nEOFx",
    'cat > f.txt <<"EOF"y\nsafe line\nEOF\necho INJECTED\nEOFy',
    "cat > f.txt <<\\EOF'x'\nsafe line\nEOF\necho INJECTED\nEOFx",
  ])('leaves a delimiter that runs on past its quotes as written: %j', (command) => {
    expect(refusal(command)).toContain('runs on past its quotes')
  })

  it('still spills a delimiter ended by a blank, an operator or the line end', () => {
    for (const command of ["cat <<'EOF' > f\nx\nEOF", "cat <<'EOF'|tee f\nx\nEOF", "cat <<'EOF';echo ok\nx\nEOF", "cat <<'EOF'&&echo ok\nx\nEOF", "cat > f <<'EOF'\nx\nEOF"]) {
      expect(spilled(command).bodies, command).toEqual(['x\n'])
    }
  })

  // HAND-DERIVED: a heredoc writing a .env file with a key shaped like an AWS access key id, which redactSecrets recognises; the body would be written to disk verbatim, so it is not spilled.
  it('leaves a heredoc whose body holds a credential as written', () => {
    expect(refusal("cat > .env <<'EOF'\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nEOF")).toContain('credential')
  })

  it.each([
    ['an unquoted heredoc', 'cat > f <<EOF\n$HOME\nEOF', 'unquoted'],
    ['a <<- heredoc', "cat > f <<-'EOF'\n\tbody\n\tEOF", '<<-'],
    ['an unterminated heredoc', "cat > f <<'EOF'\nbody", 'certainty'],
    ['a backtick outside the body', "echo `date` && cat > f <<'EOF'\nbody\nEOF", 'certainty'],
    ['a backslash outside the body', "echo a\\ b && cat > f <<'EOF'\nbody\nEOF", 'certainty'],
    ['a here-string beside the heredoc', "cat <<< x && cat > f <<'EOF'\nbody\nEOF", 'certainty'],
    ['a heredoc operator inside a string', "echo \"use <<'X'\" && cat > f <<'EOF'\nbody\nEOF", 'certainty'],
    ['a carriage-return line ending', "cat > f <<'EOF'\r\nbody\r\nEOF\r\n", 'certainty'],
  ])('leaves %s as written', (_, command, reason) => {
    expect(refusal(command)).toContain(reason)
  })
})

describe('the length the spill is measured by', () => {
  it('counts the room escaping takes for quotes and backslashes', () => {
    expect(effectiveCommandLength('abc')).toBe(3)
    expect(effectiveCommandLength("a'b")).toBe(6)
    expect(effectiveCommandLength('a"b\\c')).toBe(7)
  })

  it('finds a heredoc of any form, and not a here-string or a shift', () => {
    for (const c of ["cat <<'EOF'", 'cat <<"EOF"', 'cat <<\\EOF', 'cat <<EOF', 'cat <<-EOF', 'cat << EOF']) expect(hasHeredocOpener(c), c).toBe(true)
    for (const c of ['cat <<< word', 'echo $((1<<2))', 'echo a']) expect(hasHeredocOpener(c), c).toBe(false)
  })
})

/** A `cat > notes.md <<'EOF'` of a markdown document whose raw length is `chars`, followed by a check of the written file. */
function longHeredoc(chars: number, delimiter = "'EOF'"): string {
  const head = `cat > notes.md <<${delimiter}\n`
  const tail = '\nEOF\nwc -c notes.md'
  const line = 'A line of the document the agent is writing, with no quote marks in it at all.\n'
  return head + line.repeat(Math.ceil(chars / line.length)).slice(0, chars - head.length - tail.length - 1) + '.' + tail
}

describe('the Bash pre hook on Claude Code for Windows', () => {
  const realPlatform = process.platform
  let temp: string
  let seq = 0

  function bash(command: string, mode = 'default', harness = 'claude'): HookOutput {
    seq += 1
    return preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command, description: 'Write notes' }, sessionId: `heredoc-spill-${seq}`, raw: { tool_name: 'Bash', tool_input: { command }, _tg_harness: harness, permission_mode: mode, cwd: temp } }))
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-heredoc-spill-'))
    // tokenGoatHome() reads this on every call, so any spilled body would land in this test's own directory.
    vi.stubEnv('TOKEN_GOAT_HOME', temp)
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    vi.stubEnv('HERMES_SESSION_ID', '')
    vi.stubEnv('HERMES_HOME', '')
    vi.stubEnv('CLAUDE_CODE_VERSION', '2.1.0')
    clearModuleCaches()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.unstubAllEnvs()
    clearModuleCaches()
    fs.rmSync(temp, { recursive: true, force: true })
  })

  it('the fixtures are the lengths their tests name', () => {
    expect(longHeredoc(9_000)).toHaveLength(9_000)
    expect(effectiveCommandLength(longHeredoc(7_000))).toBeGreaterThanOrEqual(HEREDOC_SPILL_EFFECTIVE_CHARS)
    expect(longHeredoc(7_000).length).toBeLessThan(HEREDOC_CERTAIN_FAILURE_CHARS)
  })

  // HAND-DERIVED from the audit: in default mode the rewrite went out with no decision, so Claude Code prompted on `cat > notes.md < '<file>'`, a command whose body the prompt could not show. Only an approved rewrite ships now (tests/bash_heredoc_spill_e2e.test.ts drives the approved path through the built bundle); this one is refused, and nothing is written.
  it('in default mode, where the rewrite would go to a prompt, refuses a command long enough to fail and writes nothing', () => {
    const out = bash(longHeredoc(9_000))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') {
      expect(out.message).toContain('would go to a permission prompt that could not show the body moved out of it')
      expect(out.message).toContain('Write tool')
    }
    expect(fs.existsSync(path.join(temp, 'heredoc_spill'))).toBe(false)
  })

  it('in default mode lets a command short of certain failure run as written', () => {
    expect(bash(longHeredoc(7_000)).hookType).toBe('pass')
    expect(fs.existsSync(path.join(temp, 'heredoc_spill'))).toBe(false)
  })

  it('where the permission check skips the rewrite, refuses a command long enough to fail and writes nothing', () => {
    const out = bash(longHeredoc(9_000), 'auto')
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') {
      expect(out.message).toContain('9,000 characters long')
      expect(out.message).toContain('unexpected EOF while looking for matching')
      expect(out.message).toContain('the permission check for this call keeps the command as written')
      expect(out.message).toContain('Write tool')
    }
    expect(fs.existsSync(path.join(temp, 'heredoc_spill'))).toBe(false)
  })

  it('where the permission check skips the rewrite, lets a command short of certain failure run as written', () => {
    expect(bash(longHeredoc(7_000), 'auto').hookType).toBe('pass')
  })

  it('refuses a long unquoted heredoc, which it cannot spill, and lets a shorter one run', () => {
    const out = bash(longHeredoc(9_000, 'EOF'))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('unquoted')
    expect(bash(longHeredoc(7_000, 'EOF')).hookType).toBe('pass')
  })

  it('leaves a 3 KB heredoc alone', () => {
    expect(bash(longHeredoc(3_000)).hookType).toBe('pass')
  })

  it('leaves the command alone off Windows, where the limit does not apply', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(bash(longHeredoc(9_000)).hookType).toBe('pass')
  })

  it('leaves the command alone for another harness, bridged or under the claude payload shape', () => {
    expect(bash(longHeredoc(9_000), 'default', 'codex').hookType).toBe('pass')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    clearModuleCaches()
    expect(bash(longHeredoc(9_000)).hookType).toBe('pass')
  })
})

// HAND-DERIVED from the audit: the spill wrote to a predictable path under the system temp directory, trusting whatever already stood there, and kept every body forever.
describe('writeSpilledBodies', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-heredoc-spill-home-'))
    vi.stubEnv('TOKEN_GOAT_HOME', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function spillOf(body: string): { dir: string; path: string } {
    const dir = heredocSpillDir()
    const out = spillQuotedHeredocs(`cat > f.txt <<'EOF'\n${body}EOF`, dir)
    if ('refused' in out) throw new Error(out.refused)
    expect(writeSpilledBodies(dir, out.files)).toBe(true)
    return { dir, path: out.files[0]!.path }
  }

  it('writes under token-goat\'s own home, not the system temp directory, holding exactly the body', () => {
    const { dir, path: file } = spillOf('line one\nline two\n')
    expect(dir).toBe(path.join(tokenGoatHome(), 'heredoc_spill'))
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline two\n')
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('never writes through a path that already exists, and leaves what stood there alone', () => {
    const dir = heredocSpillDir()
    const out = spillQuotedHeredocs("cat > f.txt <<'EOF'\nreal body\nEOF", dir)
    if ('refused' in out) throw new Error(out.refused)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(out.files[0]!.path, 'planted')
    expect(writeSpilledBodies(dir, out.files)).toBe(false)
    expect(fs.readFileSync(out.files[0]!.path, 'utf8')).toBe('planted')
  })

  it('removes spilled bodies past their age when it writes another, and nothing else', () => {
    const first = spillOf('old body\n')
    const fresh = spillOf('fresh body\n')
    const stranger = path.join(first.dir, 'notes.txt')
    fs.writeFileSync(stranger, 'not a spill')
    const past = (Date.now() - SPILL_MAX_AGE_MS - 60_000) / 1000
    fs.utimesSync(first.path, past, past)
    fs.utimesSync(stranger, past, past)
    spillOf('third body\n')
    expect(fs.existsSync(first.path)).toBe(false)
    expect(fs.existsSync(fresh.path)).toBe(true)
    expect(fs.existsSync(stranger)).toBe(true)
  })
})
