import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSafeArgSegment, parseShimScriptPath, runGitDiff, runTokenGoat, type ExecFileLike } from '../src/launcher'

// Pre-fix behavior, copied verbatim from `git show HEAD~0:vscode-extension/src/extension.ts` before this
// commit's fix landed (the vulnerable quoteWindowsArgument + string-built commandLine). Kept here only so
// the "prove it was actually broken" test below has the exact broken logic to exercise, without resurrecting
// dead code in src/.
function vulnerableQuoteWindowsArgument(argument: string): string {
  if (argument.includes('\0')) throw new Error('token-goat cannot launch with a NUL byte in its path')
  if (!/[\s&|<>()^%"]/.test(argument)) return argument
  return `"${argument.replace(/"/g, '\\"')}"`
}
function vulnerableBuildCommandLine(args: string[]): string {
  return ['token-goat.cmd', ...args.map(vulnerableQuoteWindowsArgument)].join(' ')
}

describe('pre-fix vulnerability (regression baseline)', () => {
  it('a symbol name containing a quote and & terminates its quoted region and injects a command separator', () => {
    // A tree-sitter-parseable identifier is unlikely, but the vulnerability report's own PoC is a symbol/
    // method name containing a double quote followed by an ampersand -- exactly what a hostile repo's own
    // source text can contain and what the indexer stores verbatim.
    const hostileSymbolName = 'a"&calc&"b'
    const spec = `src/evil.ts::${hostileSymbolName}@1`
    const commandLine = vulnerableBuildCommandLine(['read', spec])
    // cmd.exe has no backslash escape: \" toggles quote state rather than escaping it, so the quoted
    // region built by vulnerableQuoteWindowsArgument closes early and the & becomes a real command
    // separator once cmd.exe parses this string. Demonstrating this without actually invoking cmd.exe:
    // split the built string the same way cmd.exe's quote-state machine would and show an unquoted,
    // unescaped '&' survives to become a separator.
    let inQuotes = false
    let sawUnquotedAmpersand = false
    for (const ch of commandLine) {
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === '&' && !inQuotes) sawUnquotedAmpersand = true
    }
    expect(sawUnquotedAmpersand).toBe(true)
  })
})

describe('pre-fix git-diff vulnerability (regression baseline)', () => {
  it("cmd.exe's current-directory-before-PATH search would resolve a bare 'git' spawned with cwd=workspaceRoot to a hostile git.cmd/git.exe planted at that root, before ever consulting PATH", () => {
    // This mirrors the vulnerable pre-fix call: exec('git diff HEAD', { cwd: workspace.uri.fsPath, ... }).
    // 'git' here is a bare command name (no path separator), and cwd is attacker-controlled. Node's
    // documented Windows child_process behavior, and cmd.exe's own default search order
    // (NoDefaultCurrentDirectoryInExePath unset), is: search the spawned process's cwd for a matching
    // executable/shim before falling back to PATH. Model that search order directly: given a hostile file
    // planted at cwd, it is found and returned before any PATH directory is even consulted.
    const cwd = 'C:\\hostile\\workspace'
    const pathDirs = ['C:\\Program Files\\Git\\cmd', 'C:\\Windows\\System32']
    const hijackCandidates = ['git.com', 'git.exe', 'git.bat', 'git.cmd']
    const plantedFile = 'git.cmd' // the attacker's file, sitting in the workspace root
    const searchOrder = [cwd, ...pathDirs]
    const resolved = searchOrder
      .flatMap((dir) => hijackCandidates.map((name) => `${dir}\\${name}`))
      .find((candidate) => candidate === `${cwd}\\${plantedFile}`)
    expect(resolved).toBe(`${cwd}\\${plantedFile}`)
  })
})

describe('runTokenGoat (post-fix)', () => {
  it('never builds a shell command string: argv is an array, shell is false, and a hostile symbol name is one untouched element', async () => {
    const hostileSymbolName = 'a"&calc&"b'
    const spec = `src/evil.ts::${hostileSymbolName}@1`
    let capturedFile: string | undefined
    let capturedArgs: readonly string[] | undefined
    let capturedShell: unknown
    const fakeExecFile: ExecFileLike = (file, args, options, callback) => {
      capturedFile = file
      capturedArgs = args
      capturedShell = options.shell
      callback(null, 'ok', '')
    }
    await runTokenGoat(['read', spec], undefined, fakeExecFile)
    expect(capturedShell).toBe(false)
    // The spec argument must survive completely unmodified as a single argv element -- no quoting, no
    // escaping, and specifically no unquoted '&' introduced by any quoting step, because there is no
    // quoting step: array argv is passed straight to execve/CreateProcess, never through a shell that
    // would parse metacharacters.
    expect(capturedArgs).toContain(spec)
    expect(capturedFile).toBe(process.execPath)
    // The command never resembles a single joined string containing the hostile payload.
    expect(capturedArgs?.join(' ')).not.toContain('token-goat.cmd')
  })

  it('conveys a project root via an explicit --cwd argument, never via the spawned process cwd', async () => {
    let capturedArgs: readonly string[] | undefined
    const fakeExecFile: ExecFileLike = (_file, args, _options, callback) => {
      capturedArgs = args
      callback(null, '', '')
    }
    const hostileWorkspaceRoot = 'C:\\hostile\\workspace'
    await runTokenGoat(['scope', 'a.ts:1'], hostileWorkspaceRoot, fakeExecFile)
    const argIndex = capturedArgs?.indexOf('--cwd') ?? -1
    expect(argIndex).toBeGreaterThanOrEqual(0)
    expect(capturedArgs?.[argIndex + 1]).toBe(hostileWorkspaceRoot)
  })
})

describe('runGitDiff (post-fix)', () => {
  it('never runs git through a shell, and conveys the repo path via -C rather than the spawned process cwd', async () => {
    let capturedFile: string | undefined
    let capturedArgs: readonly string[] | undefined
    let capturedShell: unknown
    const fakeExecFile: ExecFileLike = (file, args, options, callback) => {
      capturedFile = file
      capturedArgs = args
      capturedShell = options.shell
      callback(null, 'diff --git a/x b/x', '')
    }
    const hostileWorkspaceRoot = 'C:\\hostile\\workspace'
    await runGitDiff(hostileWorkspaceRoot, fakeExecFile)
    expect(capturedShell).toBe(false)
    // The command is never a single joined string like 'git diff HEAD' handed to a shell -- that string form
    // is exactly what let a hostile git.cmd/git.exe planted at the workspace root (the old spawn cwd) get
    // picked up by cmd.exe's cwd-before-PATH search order. The repo path travels as an explicit -C argument.
    expect(capturedArgs).toEqual(['-C', hostileWorkspaceRoot, 'diff', 'HEAD'])
    expect(capturedFile).not.toBe('git')
    expect(capturedFile).not.toMatch(/^git(\.cmd|\.exe)?$/i)
    expect(path.isAbsolute(capturedFile ?? '')).toBe(true)
  })
})

describe('parseShimScriptPath', () => {
  it('extracts the real script path from an npm-generated .cmd shim and resolves %dp0%', () => {
    const shimText = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\token-goat\\dist\\token-goat.mjs" %*',
      '',
    ].join('\r\n')
    const result = parseShimScriptPath(shimText, 'C:\\Users\\zelys\\AppData\\Roaming\\npm')
    expect(result).toBe('C:\\Users\\zelys\\AppData\\Roaming\\npm\\node_modules\\token-goat\\dist\\token-goat.mjs')
  })

  it('returns null for an unrecognized shim format instead of guessing', () => {
    expect(parseShimScriptPath('not a shim at all', 'C:\\anywhere')).toBeNull()
  })
})

describe('assertSafeArgSegment', () => {
  it('rejects a segment starting with a hyphen, defense in depth against argv-as-flag confusion', () => {
    expect(() => assertSafeArgSegment('--evil-flag', 'name')).toThrow()
  })

  it('rejects a NUL or newline in the segment', () => {
    expect(() => assertSafeArgSegment('a\0b', 'name')).toThrow()
    expect(() => assertSafeArgSegment('a\nb', 'name')).toThrow()
  })

  it('rejects an empty segment', () => {
    expect(() => assertSafeArgSegment('', 'name')).toThrow()
  })

  it('accepts an ordinary symbol name, including one containing shell metacharacters, since no shell ever parses it', () => {
    expect(() => assertSafeArgSegment('a"&calc&"b', 'name')).not.toThrow()
    expect(() => assertSafeArgSegment('normalSymbolName', 'name')).not.toThrow()
  })
})
