/** Regression tests for the second review round of the pre-write guards (placeholder lines, blind drop, sibling copy): one test per finding, each paired with a mutation proof in the commit that added it. Fixture provenance is named at each test. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-rev-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { preWriteRewriteHandler } = await import('../src/hooks_write.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')
const { normalizePayload } = await import('../src/hooks_cli.js')
const { normalizePath } = await import('../src/paths.js')
const { recordFileRead, recordFileLineRange, getFileLineRanges, recordBashStartCwd } = await import('../src/session.js')
const { recordReadShape } = await import('../src/read_shape.js')
const { postBashHandler } = await import('../src/hooks_bash_post.js')
const { isWholeFileRead, servedExtents } = await import('../src/served_extent.js')
const { removedLineIndexes, MAX_DIFF_SPAN } = await import('../src/write_guards.js')
const { trimToBudget } = await import('../src/overflow_guard.js')

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-rev-files-'))

function writeEvent(filePath: string, content: string, cwd?: string): HookEvent {
  return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Write', toolInput: { file_path: filePath, content }, sessionId: 'test', ...(cwd === undefined ? {} : { raw: { cwd } }) })
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
}

beforeEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

let counter = 0
const fresh = (ext = 'ts'): string => path.join(FILES_DIR, `r${++counter}.${ext}`)

describe('the "shown once" mark is keyed on the text, not only the marker', () => {
  // HAND-DERIVED: two different bodies carrying the same marker line.
  it('refuses a second, different text that carries the same marker, and lets a verbatim repeat through', async () => {
    const target = fresh()
    const first = 'const a = 1\n// ... existing code ...\n'
    const second = 'const b = 2\n// ... existing code ...\n'
    expect((await preWriteRewriteHandler(writeEvent(target, first))).hookType).toBe('deny')
    expect((await preWriteRewriteHandler(writeEvent(target, second))).hookType).toBe('deny')
    expect((await preWriteRewriteHandler(writeEvent(target, second))).hookType).toBe('pass')
  })
})

describe('a subject alone is prose; a qualifier or an ellipsis makes it a marker', () => {
  // HAND-DERIVED: each line is ordinary commentary that names the subject without saying anything was left out.
  it.each(['// existing code', '// Remaining code', '/* remaining content */', '# existing code', '// ...', '...', '/* ... */'])('passes %s', async (line) => {
    expect((await preWriteRewriteHandler(writeEvent(fresh(), 'const a = 1\n' + line + '\nconst b = 2\n'))).hookType).toBe('pass')
  })

  // HAND-DERIVED: each line says the text was left out, with or without an ellipsis.
  it.each([
    '/* rest of file unchanged */',
    '// rest of the file is unchanged',
    '// existing code remains the same',
    '# remaining code omitted',
    '// ... same as before',
    '// ... 40 more lines omitted',
    '# ... truncated',
    '// rest of file here',
    '// rest of the code goes here',
    '// remaining code below',
    '// remaining content above',
    '// rest of implementation',
    '// ... other methods unchanged',
    '// ... other ...',
  ])('denies %s', async (line) => {
    expect((await preWriteRewriteHandler(writeEvent(fresh(), 'const a = 1\n' + line + '\nconst b = 2\n'))).hookType).toBe('deny')
  })
})

describe('a whole-file token-goat read counts as the whole file seen', () => {
  const body = lines(200)
  const dropped = lines(200).split('\n').slice(0, 120).concat(lines(200).split('\n').slice(140)).join('\n') + 'edited\n'

  // FORMAT-DERIVED: the Claude Code Bash tool_response envelope (stdout, stderr, interrupted, isImage, noOutputExpected, plus persistedOutputPath when the harness stored a long result), as in tests/fixtures/harness_hook_payloads.ts and read by extractToolResponseField in src/hooks_common.ts.
  function postBash(command: string, response: Record<string, unknown> = {}): Promise<unknown> {
    const raw = { cwd: FILES_DIR, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'served', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...response } }
    return postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'test', raw }))
  }

  function seed(): string {
    const target = fresh()
    fs.writeFileSync(target, body)
    recordFileRead(target, false)
    recordFileLineRange(target, 1, 100)
    recordReadShape('test', normalizePath(target), 'partial')
    return target
  }

  it('lets the Write through after a bare `token-goat read file`', async () => {
    const target = seed()
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).toBe('deny')
    await postBash(`token-goat read "${normalizePath(target)}"`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped + 'again\n'))).hookType).not.toBe('deny')
  })

  it.each(['| head -5', '--grep value', '--head 5', '@150-170', '::alpha'])('does not count a read narrowed by %s', async (tail) => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}"${tail.startsWith('@') || tail.startsWith('::') ? '' : ' '}${tail}`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).toBe('deny')
  })

  // FORMAT-DERIVED: trimToBudget in src/overflow_guard.ts is the producer of the cap note; its own output over a budget the text exceeds is the fixture, so the marker cannot drift from what the hook looks for. The persisted path is any non-empty string, which is all the harness field's presence means here.
  const CAPPED = trimToBudget(lines(5000), 100)

  it('does not count a persisted whole-file read, which the model saw only as a preview', async () => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}"`, { persistedOutputPath: path.join(DATA_DIR, 'persisted.txt') })
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).toBe('deny')
  })

  it('does not count a whole-file read the cap cut short', async () => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}"`, { stdout: CAPPED })
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).toBe('deny')
  })

  it('counts a ranged read over the dropped lines, but not when it was persisted or capped', async () => {
    const ranged = (t: string): string => `token-goat read "${normalizePath(t)}@101-200"`
    const clean = seed()
    await postBash(ranged(clean))
    expect((await preWriteRewriteHandler(writeEvent(clean, dropped))).hookType).not.toBe('deny')
    const persisted = seed()
    await postBash(ranged(persisted), { persistedOutputPath: path.join(DATA_DIR, 'persisted.txt') })
    expect((await preWriteRewriteHandler(writeEvent(persisted, dropped))).hookType).toBe('deny')
    const capped = seed()
    await postBash(ranged(capped), { stdout: CAPPED })
    expect((await preWriteRewriteHandler(writeEvent(capped, dropped))).hookType).toBe('deny')
  })

  // HAND-DERIVED: a ranged or line-range read whose output goes through a pipe, a redirect or a second command shows the model less than the range (or none of it), so the lines it names were not seen.
  it.each(['| head -20', '| tail -3', '> /dev/null', '>> out.txt', '2> err.txt', '< in.txt', '; echo done', '&& echo done', '& wait'])('does not count a ranged read followed by %s', async (tail) => {
    for (const spec of ['@101-200', '::101-200']) {
      const target = seed()
      await postBash(`token-goat read "${normalizePath(target)}${spec}" ${tail}`)
      expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType, `${spec} ${tail}`).toBe('deny')
    }
  })

  // HAND-DERIVED: a stderr-only redirect hides nothing the model sees on stdout, and agents on PowerShell hosts append `2>&1` to nearly every command; the spelling of each follows the shell that writes it (`2>/dev/null` sh, `2>$null` PowerShell, `2>&1` both).
  it.each(['2>/dev/null', '2>&1', '2>$null', '2> /dev/null', '2>&1 2>/dev/null'])('counts a ranged read followed only by the stderr redirect %s', async (tail) => {
    for (const spec of ['@101-200', '::101-200']) {
      const target = seed()
      await postBash(`token-goat read "${normalizePath(target)}${spec}" ${tail}`)
      expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType, `${spec} ${tail}`).not.toBe('deny')
    }
  })

  // HAND-DERIVED: each tail still sends stdout somewhere else or runs something after the read, so the lines were not all seen.
  it.each(['>/dev/null', '1>/dev/null', '> /dev/null 2>&1', '&>/dev/null', '2>&1 | head -5', '2>&1; echo done', '2>&1 && echo done', '2>&1 &', '2>/dev/null > out.txt', '2>>err.txt'])('does not count a ranged read followed by %s', async (tail) => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}@101-200" ${tail}`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType, tail).toBe('deny')
  })

  it('counts a ranged read whose quoted path holds an operator character', async () => {
    const target = fresh().replace('.ts', ';x.ts')
    fs.writeFileSync(target, body)
    recordFileRead(target, false)
    recordFileLineRange(target, 1, 100)
    recordReadShape('test', normalizePath(target), 'partial')
    await postBash(`token-goat read "${normalizePath(target)}@101-200"`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).not.toBe('deny')
  })

  // HAND-DERIVED: the two prefix shapes a model writes ahead of a read; resolveBashCall strips them before the ledger sees the command.
  it.each(['cd . && token-goat read', 'X=0 token-goat read'])('counts a whole-file read behind the prefix %s', async (prefix) => {
    const target = seed()
    await postBash(`${prefix} "${normalizePath(target)}"`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).not.toBe('deny')
  })

  // HAND-DERIVED: export statements with plain NAME=value words, the shape a model writes to set an environment ahead of a read; stripCommandPrefix peels them like a cd.
  it.each(['export X=0; token-goat read', 'export X=0 Y=1 && token-goat read', "export X='a b'; export Y=\"c\"; token-goat read"])('counts a whole-file read behind the statement %s', async (prefix) => {
    const target = seed()
    await postBash(`${prefix} "${normalizePath(target)}"`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).not.toBe('deny')
  })

  // HAND-DERIVED: exports that expand or substitute something are not plain NAME=value, so the command is left whole, the read is not recorded, and the Write is still refused.
  it.each(['export X=$(cmd); token-goat read', 'export X=`cmd`; token-goat read', 'export X=$HOME; token-goat read', 'export X="$(cmd)"; token-goat read'])('leaves a read behind %s unrecorded', async (prefix) => {
    const target = seed()
    await postBash(`${prefix} "${normalizePath(target)}"`)
    expect((await preWriteRewriteHandler(writeEvent(target, dropped))).hookType).toBe('deny')
  })

  // HAND-DERIVED: the classifier alone, on the command shapes that must and must not count.
  it('classifies the command shapes', () => {
    expect(isWholeFileRead('read', 'a.ts', 'a.ts', 'token-goat read a.ts')).toBe(true)
    expect(isWholeFileRead('read', 'a.ts', 'a.ts', 'tg read "a b.ts"')).toBe(true)
    expect(isWholeFileRead('read', 'a.ts', 'a.ts', 'token-goat read a.ts | head')).toBe(false)
    expect(isWholeFileRead('read', 'a.ts', 'a.ts', 'token-goat read a.ts --tail 3')).toBe(false)
    expect(isWholeFileRead('section', 'a.md::X', 'a.md', 'token-goat section a.md::X')).toBe(false)
  })
})

describe('an existing file too large to diff still gets the placeholder check', () => {
  it('denies a placeholder written over an oversize file, and passes a directory target', async () => {
    const big = fresh()
    fs.writeFileSync(big, 'a\n'.repeat(2_200_000))
    expect(fs.statSync(big).size).toBeGreaterThan(4 * 1024 * 1024)
    expect((await preWriteRewriteHandler(writeEvent(big, 'const a = 1\n// ... existing code ...\n'))).hookType).toBe('deny')
    const dir = path.join(FILES_DIR, 'a-directory')
    fs.mkdirSync(dir, { recursive: true })
    expect((await preWriteRewriteHandler(writeEvent(dir, 'const a = 1\n// ... existing code ...\n'))).hookType).toBe('pass')
  })
})

describe('the sibling-copy series directories are read below the project root', () => {
  function project(...parts: string[]): { root: string; dir: string } {
    const root = path.join(fs.mkdtempSync(path.join(FILES_DIR, 'proj-')), ...parts)
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    return { root, dir: root }
  }
  const body = lines(50)
  const copy = lines(49) + 'changed last line\n'

  it('still advises when the whole project sits under a v2 or fixtures directory', async () => {
    for (const above of ['v2', 'fixtures']) {
      const { root } = project(above, 'app')
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'src', 'solver.py'), body)
      expect((await preWriteRewriteHandler(writeEvent(path.join(root, 'src', 'solver_v2.py'), copy, root))).hookType).toBe('context')
    }
  })

  it('stays silent for a file in a migrations directory below the root', async () => {
    const { root } = project('app')
    fs.mkdirSync(path.join(root, 'db', 'migrations', 'sql'), { recursive: true })
    fs.writeFileSync(path.join(root, 'db', 'migrations', 'sql', 'solver.py'), body)
    expect((await preWriteRewriteHandler(writeEvent(path.join(root, 'db', 'migrations', 'sql', 'solver_v2.py'), copy, root))).hookType).toBe('pass')
  })
})

describe('the sibling-copy exclusions with no project root', () => {
  // HAND-DERIVED: a hook payload without a cwd gives no root to measure from, so a series directory anywhere in the file's path excludes it.
  it('stays silent for a file whose migrations directory is above its own directory', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(FILES_DIR, 'noroot-')), 'db', 'migrations', 'sql')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'solver.py'), lines(50))
    expect((await preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), lines(49) + 'changed last line\n'))).hookType).toBe('pass')
  })
})

describe('VS Code edit tools are checked, except the one whose contract is partial code', () => {
  // FORMAT-DERIVED: VS Code 1.137.0 resources/app/extensions/copilot/dist/extension.js, the shapes pinned in tests/hooks_cli.test.ts (vscode harness): apply_patch {input, explanation}, multi_replace_string_in_file {explanation, replacements[{filePath, oldString, newString}]}, insert_edit_into_file {explanation, filePath, code}.
  const ws = fs.mkdtempSync(path.join(FILES_DIR, 'ws-'))
  const file = path.join(ws, 'a.ts')
  const other = path.join(ws, 'b.ts')
  const marker = '// ... existing code ...'

  function vscode(tool: string, input: Record<string, unknown>): HookEvent {
    const wire = { cwd: ws, tool_name: tool, tool_input: input } as Record<string, unknown>
    const normalized = normalizePayload(wire, 'vscode') as Record<string, unknown>
    return makeHookEvent({ eventName: 'pre_tool_use', toolName: normalized['tool_name'] as string, toolInput: normalized['tool_input'] as Record<string, unknown>, sessionId: 'test', raw: normalized })
  }

  beforeEach(() => {
    fs.writeFileSync(file, 'a\nb\n')
    fs.writeFileSync(other, 'c\nd\n')
  })

  it('reads the patch of apply_patch from its `input` key', async () => {
    const patch = (added: string): string => `*** Begin Patch\n*** Update File: ${file}\n@@\n-b\n+${added}\n*** End Patch\n`
    expect((await preWriteRewriteHandler(vscode('apply_patch', { explanation: 'x', input: patch(marker) }))).hookType).toBe('deny')
    expect((await preWriteRewriteHandler(vscode('apply_patch', { explanation: 'x', input: patch('c') }))).hookType).toBe('pass')
  })

  it('checks every replacement of multi_replace_string_in_file against the file it names', async () => {
    const replacements = [{ filePath: file, oldString: 'a', newString: 'A' }, { filePath: other, oldString: 'd', newString: marker }]
    expect((await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements }))).hookType).toBe('deny')
    const clean = [{ filePath: file, oldString: 'a', newString: 'A' }, { filePath: other, oldString: 'd', newString: 'D' }]
    expect((await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements: clean }))).hookType).toBe('pass')
  })

  // HAND-DERIVED: replacement lists built here; the request shape is the multi_replace_string_in_file one cited above.
  it('reports every flagged replacement in one deny, and lets the identical retry through', async () => {
    const replacements = [
      { filePath: file, oldString: 'a', newString: '// ... existing code ...' },
      { filePath: other, oldString: 'd', newString: '# rest of file unchanged' },
      { filePath: file, oldString: 'b', newString: '/* ... same as before */' },
    ]
    const first = await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements }))
    expect(first.hookType).toBe('deny')
    const message = (first as { message: string }).message
    expect(message).toContain('3 placeholder lines')
    expect(message).toContain('existing code')
    expect(message).toContain('rest of file unchanged')
    expect(message).toContain('same as before')
    expect((await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements }))).hookType).toBe('pass')
  })

  it('counts the flagged replacements past the quoted few', async () => {
    const replacements = Array.from({ length: 6 }, (_, i) => ({ filePath: file, oldString: 'a', newString: `// ... existing code ${i} lines omitted ...` }))
    const message = ((await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements }))) as { message: string }).message
    expect(message).toContain('6 placeholder lines')
    expect(message).toContain('and 3 more')
  })

  // HAND-DERIVED: a list of one replacement per distinct file; the cap on examined files is MAX_EDIT_FILES_CHECKED (20) in src/write_guard_hooks.ts.
  it('reads no more than the capped number of distinct files for a hostile replacement list', async () => {
    const replacements = Array.from({ length: 60 }, (_, i) => ({ filePath: path.join(ws, `many${i}.ts`), oldString: 'a', newString: `// ... omitted ${i} ...` }))
    const message = ((await preWriteRewriteHandler(vscode('multi_replace_string_in_file', { explanation: 'x', replacements }))) as { message: string }).message
    expect(message).toContain('20 placeholder lines')
  })

  it('checks replace_string_in_file through its camelCase keys', async () => {
    expect((await preWriteRewriteHandler(vscode('replace_string_in_file', { filePath: file, oldString: 'b', newString: marker }))).hookType).toBe('deny')
  })

  it('leaves insert_edit_into_file alone, since its code carries existing-code markers by contract', async () => {
    expect((await preWriteRewriteHandler(vscode('insert_edit_into_file', { explanation: 'x', filePath: file, code: marker + '\nconst y = 2' }))).hookType).toBe('pass')
  })
})

describe('line endings', () => {
  // HAND-DERIVED. Characterization test: pins that a marker a CRLF file already holds is not reported as new; splitLines and the guard's trim() each strip the CR, so no single line removal turns it red.
  it('characterization: a marker the CRLF file already holds is the file own content', async () => {
    const target = fresh()
    fs.writeFileSync(target, 'a\r\n// ... existing code ...\r\nb\r\n')
    expect((await preWriteRewriteHandler(writeEvent(target, 'a\r\n// ... existing code ...\r\nb changed\r\n'))).hookType).toBe('pass')
  })
})

describe('a read that ran elsewhere or printed less than the lines is not recorded as seen (final review round)', () => {
  const body = lines(200)
  const dropped = body.split('\n').slice(0, 120).concat(body.split('\n').slice(140)).join('\n') + 'edited\n'
  const project = path.join(FILES_DIR, 'proj-r6')
  const other = path.join(FILES_DIR, 'other-r6')
  const target = path.join(project, 'src', 'a.ts')

  // FORMAT-DERIVED: the Claude Code Bash tool_response envelope as in tests/fixtures/harness_hook_payloads.ts; the hook starts in `project`, which is the cwd the event reports.
  function postBash(command: string, toolUseId?: string): Promise<unknown> {
    const raw = { cwd: project, tool_name: 'Bash', tool_input: { command }, ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }), tool_response: { stdout: 'served', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
    return postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'test', raw }))
  }

  function seed(): void {
    for (const dir of [project, other]) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), body)
    }
    recordFileRead(target, false)
    recordFileLineRange(target, 1, 100)
    recordReadShape('test', normalizePath(target), 'partial')
  }

  const denied = async (): Promise<boolean> => (await preWriteRewriteHandler(writeEvent(target, dropped))).hookType === 'deny'

  it('control: a plain relative range read clears the Write', async () => {
    seed()
    expect(await denied()).toBe(true)
    await postBash('token-goat read src/a.ts@101-200')
    expect(await denied()).toBe(false)
  })

  // HAND-DERIVED: `env -C DIR cmd` and `env --chdir=DIR cmd` run cmd in DIR (coreutils env), so `src/a.ts` is DIR/src/a.ts, not a file of the hook's directory; `pushd` moves the shell the same way.
  it.each([
    `env -C ${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env -C ${normalizePath(other)} FOO=1 token-goat read src/a.ts@101-200`,
    `env --chdir=${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env --chdir ${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env --ch=${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env --chd ${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env -iC ${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `env -C${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `FOO=1 env -C ${normalizePath(other)} token-goat read src/a.ts@101-200`,
    `cd src && env -C ${normalizePath(other)} token-goat read a.ts@101-200`,
    `pushd ${normalizePath(other)} && token-goat read src/a.ts@101-200`,
    `pushd ${normalizePath(other)}; token-goat read src/a.ts@101-200`,
    `(pushd ${normalizePath(other)} && token-goat read src/a.ts@101-200)`,
    `cd ${normalizePath(project)} && pushd ${normalizePath(other)} && token-goat read src/a.ts@101-200`,
  ])('records nothing for %s', async (command) => {
    seed()
    await postBash(command)
    expect(await denied()).toBe(true)
  })

  // HAND-DERIVED: a `cd` that wraps the whole command resolves the path against that directory, so a read behind it is recorded against the file it read; an env that only sets or unsets variables does not move the read.
  it.each([`cd ${normalizePath(path.join(project, 'src'))} && token-goat read a.ts@101-200`, '(cd src && token-goat read a.ts@101-200)', 'env -u X FOO=1 token-goat read src/a.ts@101-200', 'env -i token-goat read src/a.ts@101-200'])('still records %s', async (command) => {
    seed()
    await postBash(command)
    expect(await denied()).toBe(false)
  })

  // HAND-DERIVED: `cd missing` fails and `cd -` returns to a directory the hook cannot name, so the path the hook resolves is one no file sits at.
  it.each(['cd missing; token-goat read src/a.ts@101-200', 'cd - && token-goat read src/a.ts@101-200', 'cd missing && token-goat read src/a.ts@101-200', 'cd $NOWHERE && token-goat read src/a.ts@101-200'])('records no path that does not exist for %s', async (command) => {
    seed()
    // The pre hook held the directory the call started in, so the post hook resolves the cd prefix from it alone and has no cwd fallback to land on the real file.
    recordBashStartCwd('toolu_r6_missing', project)
    await postBash(command, 'toolu_r6_missing')
    expect(getFileLineRanges(path.join(project, 'missing', 'src', 'a.ts')).length).toBe(0)
    expect(getFileLineRanges(path.join(project, '-', 'src', 'a.ts')).length).toBe(0)
    expect(getFileLineRanges(path.join(project, '$NOWHERE', 'src', 'a.ts')).length).toBe(0)
  })

  // FORMAT-DERIVED: the Codex PostToolUse payload of tests/fixtures/harness_hook_payloads.ts (tool_name Bash, tool_response a plain string), run through the same normalizePayload step the hook entry applies; the ledger must read it as it reads Claude Code's.
  it('records a Codex Bash read in the ledger, and not one behind env -C', async () => {
    seed()
    const post = (command: string): Promise<unknown> => {
      const wire = { cwd: project, tool_name: 'Bash', tool_use_id: 'call_4', tool_input: { command }, tool_response: 'served\n' }
      const normalized = normalizePayload(wire, 'codex') as Record<string, unknown>
      return postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: normalized['tool_name'] as string, toolInput: normalized['tool_input'] as Record<string, unknown>, sessionId: 'test', raw: normalized }))
    }
    await post(`env -C ${normalizePath(other)} token-goat read src/a.ts@101-200`)
    expect(await denied()).toBe(true)
    await post('env FOO=1 token-goat read src/a.ts@101-200')
    expect(await denied()).toBe(false)
  })

  // FORMAT-DERIVED: the Copilot CLI input as src/bridges/copilot_cli.ts hands it to the hook once it has built its canonical payload (session_id, cwd, tool_name through resolveCanonicalToolName, tool_input, and tool_response set from toolResult.textResultForLlm, a string; the camelCase wire of schemas/copilot_cli.hooks.json never reaches normalizePayload), and the VS Code PostToolUse envelope (hook_event_name, session_id, cwd, tool_name run_in_terminal, tool_input.command, tool_use_id) of the 'VS Code read_file' case in tests/fixtures/harness_hook_payloads.ts, whose tool-name map is VSCODE_TOOL_NAME_MAP in src/hooks_cli.ts. Both run through the normalizePayload step the hook entry applies.
  const HOST_WIRES: ReadonlyArray<readonly [string, 'copilot_cli' | 'vscode', (command: string, toolUseId: string) => Record<string, unknown>]> = [
    ['Copilot CLI', 'copilot_cli', (command) => ({ session_id: 'test', cwd: project, tool_name: 'Bash', tool_input: { command }, tool_response: 'served\n' })],
    ['VS Code', 'vscode', (command, toolUseId) => ({ timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PostToolUse', session_id: 'test', cwd: project, tool_name: 'run_in_terminal', tool_input: { command }, tool_use_id: toolUseId, tool_response: 'served\n' })],
  ]

  describe.each(HOST_WIRES)('on a %s payload', (_label, harness, wire) => {
    const post = (command: string, toolUseId = 'tu-host'): Promise<unknown> => {
      const normalized = normalizePayload(wire(command, toolUseId), harness) as Record<string, unknown>
      return postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: normalized['tool_name'] as string, toolInput: normalized['tool_input'] as Record<string, unknown>, sessionId: 'test', raw: normalized }))
    }

    it('control: a plain range read is recorded', async () => {
      seed()
      await post('token-goat read src/a.ts@101-200')
      expect(await denied()).toBe(false)
    })

    it.each([`env -C ${normalizePath(other)} token-goat read src/a.ts@101-200`, 'token-goat read src/a.ts@101-200 --help'])('records nothing for %s', async (command) => {
      seed()
      await post(command)
      expect(await denied()).toBe(true)
    })

    // HAND-DERIVED: the pre hook held the directory the call started in, so the post hook resolves the `cd` prefix from it alone; the path a failed `cd` would name is one no file sits at.
    it.each(['cd missing && token-goat read src/a.ts@101-200', 'cd - && token-goat read src/a.ts@101-200'])('records no path that does not exist for %s', async (command) => {
      seed()
      recordBashStartCwd('tu-host-cd', project)
      await post(command, 'tu-host-cd')
      expect(getFileLineRanges(path.join(project, 'missing', 'src', 'a.ts')).length).toBe(0)
      expect(getFileLineRanges(path.join(project, '-', 'src', 'a.ts')).length).toBe(0)
    })
  })

  // HAND-DERIVED: each flag below stops the body being printed in full (usage text, JSON, a heading list, a cut, statistics), read off the option lists of `read` and `section` in src/cli.ts; `-j` and `-h` are the short spellings.
  it.each(['--help', '-h', '--json', '-j', '--stats', '--list', '--grep x', '--head 5', '--max-lines 5', '--tail 5'])('does not count a ranged read followed by %s', async (flag) => {
    seed()
    const spec = normalizePath(target) + '@101-200'
    expect(await servedExtents('read', spec, `token-goat read "${spec}"`, project)).toEqual([{ filePath: normalizePath(target), start: 101, end: 200 }])
    expect(await servedExtents('read', spec, `token-goat read "${spec}" ${flag}`, project)).toEqual([])
    await postBash(`token-goat read src/a.ts@101-200 ${flag}`)
    expect(await denied()).toBe(true)
  })
})

describe('removedLineIndexes keeps its answer without the full table', () => {
  // HAND-DERIVED: a reference longest-common-subsequence walk written here, with the full table and the same tie rule (prefer dropping a new line over an old one), compared on seeded random inputs over a small alphabet so ties are common.
  function reference(oldAll: string[], newAll: string[]): number[] {
    let head = 0
    while (head < oldAll.length && head < newAll.length && oldAll[head] === newAll[head]) head++
    let tail = 0
    while (tail < oldAll.length - head && tail < newAll.length - head && oldAll[oldAll.length - 1 - tail] === newAll[newAll.length - 1 - tail]) tail++
    const a = oldAll.slice(head, oldAll.length - tail)
    const b = newAll.slice(head, newAll.length - tail)
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!)
    const out: number[] = []
    let i = a.length
    let j = b.length
    while (i > 0) {
      if (j > 0 && a[i - 1] === b[j - 1]) {
        i--
        j--
      } else if (j > 0 && t[i]![j - 1]! >= t[i - 1]![j]!) j--
      else {
        out.push(i - 1)
        i--
      }
    }
    return out.reverse().map((i) => i + head)
  }

  it('matches the full-table walk on random inputs', () => {
    let seedState = 12345
    const next = (): number => (seedState = (seedState * 1103515245 + 12345) & 0x7fffffff)
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: next() % 40 }, () => String.fromCharCode(97 + (next() % 4)))
      const b = Array.from({ length: next() % 40 }, () => String.fromCharCode(97 + (next() % 4)))
      expect(removedLineIndexes(a, b), `${a.join('')} -> ${b.join('')}`).toEqual(reference(a, b))
    }
  })

  // Counts the bytes of every Uint8Array and Uint16Array built with a length while the call runs; the module reads these globals when it allocates.
  function allocatedBytes(run: () => number[]): { removed: number[]; bytes: number } {
    let bytes = 0
    const originals = { u8: globalThis.Uint8Array, u16: globalThis.Uint16Array }
    class CountU8 extends originals.u8 {
      constructor(length: number) {
        super(length)
        bytes += length
      }
    }
    class CountU16 extends originals.u16 {
      constructor(length: number) {
        super(length)
        bytes += length * 2
      }
    }
    Object.assign(globalThis, { Uint8Array: CountU8, Uint16Array: CountU16 })
    try {
      return { removed: run(), bytes }
    } finally {
      Object.assign(globalThis, { Uint8Array: originals.u8, Uint16Array: originals.u16 })
    }
  }

  it('allocates under 1 MB of typed arrays for two files at the span bound that share only a few lines', () => {
    const a = Array.from({ length: MAX_DIFF_SPAN }, (_, i) => (i % 97 === 0 ? 'shared' : `old ${i}`))
    const b = Array.from({ length: MAX_DIFF_SPAN }, (_, i) => (i % 89 === 0 ? 'shared' : `new ${i}`))
    const { removed, bytes } = allocatedBytes(() => removedLineIndexes(a, b))
    expect(removed.length).toBeGreaterThan(MAX_DIFF_SPAN * 0.9)
    expect(removed.length).toBeLessThan(MAX_DIFF_SPAN)
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThan(1024 * 1024)
  })

  // HAND-DERIVED: past the bound nothing is compared, so every old line between the shared head and tail is reported removed (the answer that can only add a refusal, never drop one), and no table is built.
  it('past the span bound reports every old line between the shared head and tail as removed, without a table', () => {
    const a = ['head', ...Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => `old ${i}`), 'tail']
    const b = ['head', ...Array.from({ length: 5 }, (_, i) => `new ${i}`), 'tail']
    const { removed, bytes } = allocatedBytes(() => removedLineIndexes(a, b))
    expect(removed).toEqual(Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => i + 1))
    expect(bytes).toBe(0)
  })

  it('still refuses a Write that drops unseen lines from a file longer than the span bound', async () => {
    const big = path.join(FILES_DIR, 'big-span.ts')
    const oldText = lines(3 * MAX_DIFF_SPAN)
    fs.writeFileSync(big, oldText)
    recordFileRead(big, false)
    recordFileLineRange(big, 1, 100)
    recordReadShape('test', normalizePath(big), 'partial')
    const kept = oldText.split('\n')
    const newText = kept.slice(0, 100).concat(kept.slice(2 * MAX_DIFF_SPAN)).join('\n') + 'edited\n'
    expect((await preWriteRewriteHandler(writeEvent(big, newText))).hookType).toBe('deny')
  })
})
