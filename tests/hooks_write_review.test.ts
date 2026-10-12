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
const { recordFileRead, recordFileLineRange } = await import('../src/session.js')
const { recordReadShape } = await import('../src/read_shape.js')
const { postBashHandler } = await import('../src/hooks_bash_post.js')
const { isWholeFileRead } = await import('../src/served_extent.js')

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
  ])('denies %s', async (line) => {
    expect((await preWriteRewriteHandler(writeEvent(fresh(), 'const a = 1\n' + line + '\nconst b = 2\n'))).hookType).toBe('deny')
  })
})

describe('a whole-file token-goat read counts as the whole file seen', () => {
  const body = lines(200)
  const dropped = lines(200).split('\n').slice(0, 120).concat(lines(200).split('\n').slice(140)).join('\n') + 'edited\n'

  function postBash(command: string): Promise<unknown> {
    const raw = { cwd: FILES_DIR, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'served', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
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
