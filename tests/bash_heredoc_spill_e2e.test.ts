// The shipped bundle's heredoc spill, run the way Claude Code on Windows would run it: the PreToolUse hook gets a 9,000-character `cat > notes.md <<'EOF'` in each permission mode, and the command it hands back in bypassPermissions is run under Git Bash as `-c` and must write the same bytes as the original run from a script file, where no command-line limit applies. HAND-DERIVED fixture: a markdown body with apostrophes, double quotes and lines that look like a terminator, the shapes the measured failing heredocs carried. The claude process is stood in for by an idle node process, whose command line the hook reads through CLAUDE_PID, as in tests/rewrite_permission_e2e.test.ts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveWindowsBash } from '../src/shell.js'
import { BUNDLE } from './helpers/bundle.js'

const BASH = process.platform === 'win32' ? resolveWindowsBash() : null

let root: string
let sessionClaude: ChildProcess | undefined

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-heredoc-e2e-'))
  fs.writeFileSync(path.join(root, 'session.js'), 'setInterval(() => {}, 1 << 30)\n')
  sessionClaude = spawn(process.execPath, [path.join(root, 'session.js'), '--resume', 'abc'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
})

afterAll(() => {
  sessionClaude?.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

interface Box {
  readonly project: string
  readonly temp: string
  readonly spillDir: string
  readonly env: NodeJS.ProcessEnv
}

function sandbox(name: string): Box {
  const base = path.join(root, name)
  const home = path.join(base, 'home')
  const project = path.join(base, 'proj')
  const temp = path.join(base, 'tmp')
  for (const d of [home, project, temp, path.join(home, 'claude')]) fs.mkdirSync(d, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKEN_GOAT_HOME: path.join(home, 'tg'),
    LOCALAPPDATA: path.join(home, 'la'),
    XDG_DATA_HOME: path.join(home, 'xd'),
    APPDATA: path.join(home, 'ad'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
    TOKEN_GOAT_OCR_ENABLED: 'false',
    TOKEN_GOAT_OFFLINE: '1',
    CLAUDE_PID: String(sessionClaude?.pid),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  }
  delete env['TOKEN_GOAT_BASH_COMPRESS']
  return { project, temp, spillDir: path.join(home, 'tg', 'heredoc_spill'), env }
}

function spilledFiles(box: Box): string[] {
  return fs.existsSync(box.spillDir) ? fs.readdirSync(box.spillDir) : []
}

function hook(box: Box, command: string, mode: string): { stdout: string; parsed: Record<string, unknown> } {
  const payload = { session_id: `heredoc-e2e-${mode}`, cwd: box.project, permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env: box.env, input: JSON.stringify(payload), encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return { stdout: res.stdout, parsed: JSON.parse(res.stdout) as Record<string, unknown> }
}

function runBash(command: string, cwd: string): void {
  const res = spawnSync(BASH as string, ['-c', command], { cwd, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
}

/** Runs `command` from a script file, the one way to hand Git Bash a command this long whole: passed as `-c` through a Windows command line it arrives cut short (measured here: a 9,000-character `cat > notes.md <<'EOF'` wrote 8,069 of its 8,932 body bytes and exited 0). */
function runBashScript(command: string, cwd: string): void {
  const script = path.join(cwd, '..', path.basename(cwd) + '.sh')
  fs.writeFileSync(script, command + '\n')
  const res = spawnSync(BASH as string, [script.replace(/\\/g, '/')], { cwd, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
}

function document(chars: number): { command: string; body: string } {
  const head = "cat > notes.md <<'EOF'\n"
  const tail = 'EOF\nwc -c notes.md'
  const lines = ["It's the agent's note, with \"double\" quotes and an apostrophe or two.\n", 'EOF;\n', ' EOF\n', 'A plain line that pads the document toward the length the measurement names.\n']
  let body = '# Notes\n'
  for (let i = 0; head.length + body.length + tail.length < chars; i++) body += lines[i % lines.length]
  return { command: head + body + tail, body }
}

describe.skipIf(BASH === null)('a long heredoc through the shipped hook on Windows', () => {
  it('bypassPermissions approves a rewrite whose run under Git Bash writes the same bytes as the original', () => {
    const box = sandbox('bypass')
    const { command, body } = document(9_000)
    expect(command.length).toBeGreaterThanOrEqual(9_000)
    const out = hook(box, command, 'bypassPermissions')
    const hso = out.parsed['hookSpecificOutput'] as { permissionDecision?: string; updatedInput?: { command?: string } } | undefined
    expect(hso?.permissionDecision, out.stdout.slice(0, 400)).toBe('allow')
    const rewritten = hso?.updatedInput?.command ?? ''
    const m = /^cat > notes\.md < '([^']+)'\nwc -c notes\.md$/.exec(rewritten)
    expect(m, rewritten).not.toBeNull()
    expect(rewritten.length).toBeLessThan(300)
    // Under token-goat's own home, never the system temp directory, holding exactly the body.
    const file = m![1]!
    expect(path.normalize(path.dirname(file))).toBe(path.normalize(box.spillDir))
    expect(fs.readFileSync(file)).toEqual(Buffer.from(body, 'utf8'))
    expect(fs.readdirSync(box.temp)).toEqual([])
    // The same command spilled again gets a file of its own, so one spill never truncates another's.
    const again = (hook(box, command, 'bypassPermissions').parsed['hookSpecificOutput'] as { updatedInput?: { command?: string } } | undefined)?.updatedInput?.command ?? ''
    expect(again).not.toBe(rewritten)
    expect(spilledFiles(box)).toHaveLength(2)

    const viaOriginal = path.join(box.project, 'original')
    const viaRewrite = path.join(box.project, 'rewritten')
    fs.mkdirSync(viaOriginal)
    fs.mkdirSync(viaRewrite)
    runBashScript(command, viaOriginal)
    runBash(rewritten, viaRewrite)
    const expected = fs.readFileSync(path.join(viaOriginal, 'notes.md'))
    expect(expected).toEqual(Buffer.from(body, 'utf8'))
    expect(fs.readFileSync(path.join(viaRewrite, 'notes.md'))).toEqual(expected)
  })

  it('default mode, where the rewrite would go to a prompt that cannot show the moved body, refuses instead and writes nothing', () => {
    const box = sandbox('default')
    const out = hook(box, document(9_000).command, 'default')
    expect(out.parsed['decision']).toBe('block')
    expect(String(out.parsed['reason'])).toContain('permission prompt')
    expect(spilledFiles(box)).toEqual([])
  })

  it('bypassPermissions refuses a heredoc whose body holds a credential, and writes nothing', () => {
    const box = sandbox('secret')
    const { command } = document(9_000)
    const out = hook(box, command.replace('# Notes\n', '# Notes\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'), 'bypassPermissions')
    expect(out.parsed['decision']).toBe('block')
    expect(String(out.parsed['reason'])).toContain('credential')
    expect(spilledFiles(box)).toEqual([])
  })

  it('auto mode, which never takes a rewrite, refuses the command with the reason and what to do', () => {
    const out = hook(sandbox('auto'), document(9_000).command, 'auto')
    expect(out.parsed['decision']).toBe('block')
    expect(String(out.parsed['reason'])).toContain('unexpected EOF while looking for matching')
    expect(String(out.parsed['reason'])).toContain('Write tool')
  })
})
