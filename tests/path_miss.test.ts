/** The missing-path nudge on a failed tool call (src/path_miss.ts, reached from postToolUseFailureWithExtras for a failure tool_error_class.ts classes path_not_found). Fixtures: the failed Bash payload is FORMAT-DERIVED (tests/fixtures/claude_code_2_1_281/bash_failure.json: `ls nonexistent_dir`, scrubbed from a Claude Code 2.1.281 capture with key names unchanged); the failed Read payload is FORMAT-DERIVED (tests/fixtures/claude_code_2_1_281/read_file_missing.json: the real "File does not exist." text from a Claude Code 2.1.288 transcript in the scrubbed capture envelope); the Copilot CLI payloads are FORMAT-DERIVED from src/hook_adapters.ts copilotRun (tool_name from copilotCanonicalToolName, tool_input from toolArgs, error verbatim, no cwd key). Every other stderr string below is HAND-DERIVED from the coreutils, Python and Node wordings named beside it. Codex and VS Code have no failure event to send, so their payloads are the PostToolUse a shell result arrives as: the Codex one is FORMAT-DERIVED (tests/fixtures/PROVENANCE.tsv), the VS Code one is the VSCODE_TERMINAL constant below. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

import type { HookEvent } from '../src/hook_registry.js'
import { textPathMiss } from '../src/hooks_recovery.js'
import { postToolUseFailureWithExtras } from '../src/hooks_tool_failure.js'
import { missingPathsFromStderr } from '../src/path_miss.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude_code_2_1_281', name), 'utf8')) as Record<string, unknown>
const CAPTURED_BASH = fixture('bash_failure.json')
const CAPTURED_READ = fixture('read_file_missing.json')
// FORMAT-DERIVED: tests/fixtures/PROVENANCE.tsv row for codex_ddb33e34b/bash_post_tool_use_missing_path.json (openai/codex ddb33e34b278, codex-rs/core/src/tools/context.rs ExecCommandToolOutput::post_tool_use_response: the response is a bare string)
const CODEX_BASH = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex_ddb33e34b', 'bash_post_tool_use_missing_path.json'), 'utf8')) as Record<string, unknown>

// FORMAT-DERIVED: VS Code 1.140.0 extensions/copilot/dist/extension.js. ChatHookService.executeHook builds the envelope {timestamp, hook_event_name, session_id, cwd}; executePostToolUseHook adds {tool_name, tool_input, tool_response, tool_use_id}, where tool_response is cqi(result), the text parts of the tool result joined by newlines (a string); run_in_terminal's input keys are the ones tests/vscode_hooks.test.ts takes from the same source. The terminal text is HAND-DERIVED from the coreutils wording `ls: cannot access 'x': No such file or directory`.
const VSCODE_TERMINAL: Record<string, unknown> = {
  timestamp: '2026-10-12T00:00:00.000Z',
  hook_event_name: 'PostToolUse',
  session_id: 'vscode-session',
  tool_name: 'run_in_terminal',
  tool_input: { command: 'ls nonexistent_dir', explanation: 'list the directory', goal: 'list', mode: 'sync' },
  tool_response: "ls: cannot access 'nonexistent_dir': No such file or directory\n",
  tool_use_id: 'tu-1',
}

let project: string
let counter = 0

beforeAll(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-path-miss-')))
  writeFileSync(join(project, 'package.json'), '{"name":"miss"}\n')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'nonexistent_dirs'), { recursive: true })
  const file = join(project, 'src', 'hooks_tool_failure.ts')
  writeFileSync(file, 'export const marker = 1\n', 'utf8')
  writeFileSync(join(project, 'src', 'qqqq`rrrr.ts'), 'x\n', 'utf8')
  indexFileSync(normalizePath(file))
})

afterAll(() => rmSync(project, { recursive: true, force: true }))

function eventFor(raw: Record<string, unknown>): HookEvent {
  const toolInput = raw['tool_input'] as Record<string, unknown>
  return { eventName: 'post_tool_use_failure', toolName: raw['tool_name'] as string, toolInput, sessionId: raw['session_id'] as string, agentId: undefined, raw }
}

async function fail(base: Record<string, unknown>, over: Record<string, unknown>): Promise<string> {
  counter += 1
  const raw = { ...base, session_id: `path-miss-${process.pid}-${counter}`, cwd: project, ...over }
  const out = await postToolUseFailureWithExtras(eventFor(raw))
  return out.hookType === 'context' ? out.context : ''
}

describe('missingPathsFromStderr', () => {
  it('skips a line past the scan bound and reads one at it', () => {
    // HAND-DERIVED: the coreutils wording is 'ls: cannot access ' + quoted path + ': No such file or directory'; padding in front of it sets the line length to the bound (2048) and one past it.
    const tail = "ls: cannot access 'gone.txt': No such file or directory"
    expect(missingPathsFromStderr(`${' '.repeat(2048 - tail.length)}${tail}`)).toEqual(['gone.txt'])
    expect(missingPathsFromStderr(`x${' '.repeat(2048 - tail.length)}${tail}`)).toEqual([])
  })

  it('reads the captured ls failure', () => {
    expect(missingPathsFromStderr(CAPTURED_BASH['error'] as string)).toEqual(['nonexistent_dir'])
  })

  it.each([
    ['cat: notes.txt: No such file or directory', ['notes.txt']],
    ['bash: line 1: ./run.sh: No such file or directory', ['./run.sh']],
    ["python: can't open file '/work/app/main.py': [Errno 2] No such file or directory", ['/work/app/main.py']],
    ["Error: ENOENT: no such file or directory, open 'src/missing.js'", ['src/missing.js']],
    ["ls: cannot access 'my dir/file name.txt': No such file or directory", ['my dir/file name.txt']],
    ['cat: a.txt: No such file or directory\ncat: b.txt: No such file or directory\ncat: a.txt: No such file or directory', ['a.txt', 'b.txt']],
    ['Exit code 1\nsome other failure', []],
  ])('reads %j', (stderr, expected) => {
    expect(missingPathsFromStderr(stderr)).toEqual(expected)
  })

  it('drops a path longer than the limit', () => {
    expect(missingPathsFromStderr(`cat: ${'x'.repeat(600)}: No such file or directory`)).toEqual([])
  })
})

describe('the nudge on a failed tool call', async () => {
  it('names the file a mistyped Read path meant, from the captured Read failure', async () => {
    const out = await fail(CAPTURED_READ, { tool_input: { file_path: join(project, 'src', 'hooks_tool_failur.ts') } })
    expect(out).toContain('does not exist. Existing paths that look like it:')
    expect(out).toContain('`"src/hooks_tool_failure.ts"`')
  })

  it('names the entry beside the path from the captured Bash failure', async () => {
    const out = await fail(CAPTURED_BASH, {})
    expect(out).toContain('"nonexistent_dir" does not exist.')
    expect(out).toContain('`"nonexistent_dirs"`')
  })

  it('finds an indexed file by bare name for a Read at the wrong directory', async () => {
    const out = await fail(CAPTURED_READ, { tool_input: { file_path: join(project, 'app', 'hooks_tool_failure.ts') } })
    expect(out).toContain('`"src/hooks_tool_failure.ts"`')
  })

  it('reads the Copilot CLI path key', async () => {
    const out = await fail(CAPTURED_READ, { tool_name: 'Read', tool_input: { path: join(project, 'src', 'hooks_tool_failur.ts') } })
    expect(out).toContain('`"src/hooks_tool_failure.ts"`')
  })

  it.each([['mcp__github__get_file'], ['mcp__fs__list'], ['WebFetch'], ['Task']])('does not treat the path argument of %s as a file', async (tool) => {
    // HAND-DERIVED: the rule is that only a file tool's path key names a file; an MCP or other tool's `path` is its own business. The path is the one the Copilot case above resolves, so the only thing that differs is the tool name.
    const out = await fail(CAPTURED_READ, { tool_name: tool, tool_input: { path: join(project, 'src', 'hooks_tool_failur.ts') } })
    expect(out).not.toContain('Existing paths')
  })

  it.each([['view'], ['Edit'], ['Write'], ['str_replace_based_edit_tool']])('still reads the path of the %s file tool', async (tool) => {
    // HAND-DERIVED: these are the file tools the hosts canonicalize to, listed in FILE_TOOLS in src/path_miss.ts.
    const out = await fail(CAPTURED_READ, { tool_name: tool, tool_input: { path: join(project, 'src', 'hooks_tool_failur.ts') } })
    expect(out).toContain('`"src/hooks_tool_failure.ts"`')
  })

  it('says nothing when no existing path is close', async () => {
    expect(await fail(CAPTURED_READ, { tool_input: { file_path: join(project, 'zzqq_nothing_like_it.rs') } })).not.toContain('Existing paths')
  })

  it('leaves out a candidate whose name holds a backtick, which would close the fence', async () => {
    expect(await fail(CAPTURED_READ, { tool_input: { file_path: join(project, 'src', 'qqqq_rrrr.ts') } })).not.toContain('Existing paths')
  })

  it('says nothing for an interrupted call', async () => {
    expect(await fail(CAPTURED_BASH, { is_interrupt: true })).not.toContain('Existing paths')
    const typo = { tool_input: { file_path: join(project, 'src', 'hooks_tool_failur.ts') } }
    expect(await fail(CAPTURED_READ, typo)).toContain('Existing paths')
    expect(await fail(CAPTURED_READ, { ...typo, is_interrupt: true })).not.toContain('Existing paths')
  })

  it('answers a miss once per session, then stays quiet', async () => {
    const raw = { ...CAPTURED_READ, session_id: `path-miss-once-${process.pid}`, cwd: project, tool_input: { file_path: join(project, 'src', 'hooks_tool_failur.ts') } }
    const first = await postToolUseFailureWithExtras(eventFor(raw))
    expect(first.hookType === 'context' ? first.context : '').toContain('Existing paths that look like it')
    const second = await postToolUseFailureWithExtras(eventFor(raw))
    expect(second.hookType === 'context' ? second.context : '').not.toContain('Existing paths that look like it')
  })

  it('answers each of a command\'s missing paths, at most two', async () => {
    const error = "Exit code 1\ncat: src/hooks_tool_failur.ts: No such file or directory\ncat: packge.json: No such file or directory\ncat: nonexistent_dir: No such file or directory"
    const out = await fail(CAPTURED_BASH, { tool_input: { command: 'cat a b c' }, error })
    expect(out).toContain('`"src/hooks_tool_failure.ts"`')
    expect(out).toContain('`"package.json"`')
    expect(out).not.toContain('nonexistent_dirs')
  })

  it('stays silent when the payload has no session id to remember the answer under', async () => {
    const raw = { ...CAPTURED_READ, session_id: '', cwd: project, tool_input: { file_path: join(project, 'src', 'hooks_tool_failur.ts') } }
    const out = await postToolUseFailureWithExtras({ ...eventFor(raw), sessionId: '' })
    expect(out.hookType === 'context' ? out.context : '').not.toContain('Existing paths')
  })
})

describe('the nudge on a Codex Bash result', () => {
  const was = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  beforeAll(() => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'codex'
  })
  afterAll(() => {
    if (was === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = was
  })

  function codexEvent(over: Record<string, unknown>): HookEvent {
    counter += 1
    const raw: Record<string, unknown> = { ...CODEX_BASH, session_id: `path-miss-codex-${process.pid}-${counter}`, cwd: project, ...over }
    return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: raw['tool_input'] as Record<string, unknown>, sessionId: raw['session_id'] as string, agentId: undefined, raw }
  }

  it('names the entry beside the missing path from the bare-string tool_response', async () => {
    const out = await textPathMiss(codexEvent({}))
    expect(out.hookType).toBe('context')
    expect(out.hookType === 'context' ? out.context : '').toContain('`"nonexistent_dirs"`')
  })

  it('says nothing for output that is not a missing-path message', async () => {
    expect((await textPathMiss(codexEvent({ tool_response: 'hi\n' }))).hookType).toBe('pass')
  })

  it('says nothing for an object tool_response, which is not what Codex sends', async () => {
    expect((await textPathMiss(codexEvent({ tool_response: { stdout: '', stderr: CODEX_BASH['tool_response'] } }))).hookType).toBe('pass')
  })

  it('says nothing for a successful search whose output merely holds the phrase', async () => {
    // HAND-DERIVED: grep -r prints `file:line` matches, and a log line in the searched tree can read `open foo: No such file or directory`; the command's own words are grep, -r, the pattern and src, none of them the reported `foo`.
    const out = await textPathMiss(codexEvent({ tool_input: { command: 'grep -r "No such file or directory" src' }, tool_response: 'src/log.txt:3:open nonexistent_dirs: No such file or directory\nsrc/log.txt:4:cat: nonexistent_dir: No such file or directory\n' }))
    expect(out.hookType).toBe('pass')
  })

  it('says nothing when the reported path is an argument that exists', async () => {
    // HAND-DERIVED: `src` is a command word and a real directory (created in beforeAll), so the phrase in the output is from something else.
    const out = await textPathMiss(codexEvent({ tool_input: { command: 'cat src notes.txt' }, tool_response: 'cat: src: No such file or directory\n' }))
    expect(out.hookType).toBe('pass')
  })

  it('says nothing on another harness', async () => {
    delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    try {
      expect((await textPathMiss(codexEvent({}))).hookType).toBe('pass')
    } finally {
      process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'codex'
    }
  })
})

describe('the nudge on a VS Code terminal result', () => {
  const was = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  beforeAll(() => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
  })
  afterAll(() => {
    if (was === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = was
  })

  function vscodeEvent(over: Record<string, unknown>): HookEvent {
    counter += 1
    const raw: Record<string, unknown> = { ...VSCODE_TERMINAL, tool_name: 'Bash', session_id: `path-miss-vscode-${process.pid}-${counter}`, cwd: project, ...over }
    return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: raw['tool_input'] as Record<string, unknown>, sessionId: raw['session_id'] as string, agentId: undefined, raw }
  }

  it('names the entry beside the missing path from the text VS Code joins out of the tool result', async () => {
    const out = await textPathMiss(vscodeEvent({}))
    expect(out.hookType).toBe('context')
    expect(out.hookType === 'context' ? out.context : '').toContain('`"nonexistent_dirs"`')
  })

  it('says nothing for output that is not a missing-path message', async () => {
    expect((await textPathMiss(vscodeEvent({ tool_response: 'ok\n' }))).hookType).toBe('pass')
  })

  it('says nothing for a successful search whose output merely holds the phrase', async () => {
    // HAND-DERIVED: same reasoning as the Codex case; the reported path is not among the command's own words.
    const out = await textPathMiss(vscodeEvent({ tool_input: { command: 'grep -rn "No such file or directory" .', mode: 'sync' }, tool_response: "./log.txt:3:ls: cannot access 'nonexistent_dir': No such file or directory\n" }))
    expect(out.hookType).toBe('pass')
  })
})

describe('the built bundle', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-path-miss-e2e-'))
  const work = join(home, 'proj')
  mkdirSync(join(work, 'src'), { recursive: true })
  mkdirSync(join(work, 'nonexistent_dirs'), { recursive: true })
  writeFileSync(join(work, 'src', 'hooks_tool_failure.ts'), 'export const marker = 1\n')
  const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function hook(payload: Record<string, unknown>): string {
    const res = runBundle(['hook', 'post_tool_use_failure'], { cwd: work, env, input: JSON.stringify(payload), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    return res.stdout
  }

  it('answers the captured Claude Code Bash failure', () => {
    const out = hook({ ...CAPTURED_BASH, session_id: 'e2e-claude-bash', cwd: work })
    expect(out).toContain('does not exist. Existing paths that look like it')
    expect(out).toContain('nonexistent_dirs')
  })

  it('answers the Claude Code Read failure shape', () => {
    const out = hook({ ...CAPTURED_READ, session_id: 'e2e-claude-read', cwd: work, tool_input: { file_path: join(work, 'src', 'hooks_tool_failur.ts') } })
    expect(out).toContain('src/hooks_tool_failure.ts')
  })

  it('answers the payload the Copilot adapter canonicalizes from postToolUseFailure', () => {
    // FORMAT-DERIVED: src/hook_adapters.ts copilotRun -- tool_name from copilotCanonicalToolName('view'), tool_input from toolArgs (path), error verbatim, no cwd key.
    const out = hook({ session_id: 'e2e-copilot', tool_name: 'Read', tool_input: { path: join(work, 'src', 'hooks_tool_failur.ts') }, error: 'Path does not exist: src/hooks_tool_failur.ts' })
    expect(out).toContain('src/hooks_tool_failure.ts')
  })

  it('answers the Codex Bash result, a bare-string tool_response', () => {
    const payload = { ...CODEX_BASH, session_id: 'e2e-codex-bash', cwd: work }
    const res = runBundle(['hook', 'post_tool_use'], { cwd: work, env: { ...env, TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' }, input: JSON.stringify(payload), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('does not exist. Existing paths that look like it')
    expect(res.stdout).toContain('nonexistent_dirs')
  })

  it('answers the VS Code terminal result in the field VS Code reads from a PostToolUse', () => {
    const res = runBundle(['hook', 'post_tool_use'], { cwd: work, env: { ...env, TOKEN_GOAT_HARNESS_OVERRIDE: 'vscode' }, input: JSON.stringify({ ...VSCODE_TERMINAL, session_id: 'e2e-vscode-bash', cwd: work }), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    const out = JSON.parse(res.stdout) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    const specific = out['hookSpecificOutput'] as Record<string, unknown>
    expect(specific['hookEventName']).toBe('PostToolUse')
    expect(specific['additionalContext']).toContain('does not exist. Existing paths that look like it')
    expect(specific['additionalContext']).toContain('nonexistent_dirs')
  })

  it('says nothing to VS Code for a terminal result that printed no missing path', () => {
    const res = runBundle(['hook', 'post_tool_use'], { cwd: work, env: { ...env, TOKEN_GOAT_HARNESS_OVERRIDE: 'vscode' }, input: JSON.stringify({ ...VSCODE_TERMINAL, session_id: 'e2e-vscode-quiet', cwd: work, tool_response: 'ok\n' }), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('{}')
  })

  it('records the nudge under the path_miss hint category', () => {
    const res = runBundle(['hint-stats'], { cwd: work, env, timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/path_miss\s+0 ~[1-9]/)
  })
})
