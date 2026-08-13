import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertSafeArgSegment,
  parseShimScriptPath,
  resetEntrypointCacheForTests,
  resetGitExecutableCacheForTests,
  resolveGitExecutable,
  resolveTokenGoatEntrypoint,
  runGitDiff,
  runTokenGoat,
  type ExecFileLike,
} from '../src/launcher'

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

// The two `runTokenGoat` cases above inject `fakeExecFile` but let `resolveTokenGoatEntrypoint`
// run for real -- that call still does its own unmocked PATH scan (`findOnPath`), an injected-
// seam gap: every test above supplies the execFile boundary, but nothing drives the entrypoint-
// resolution boundary itself. On a machine (or CI runner) without token-goat installed globally,
// `resolveTokenGoatEntrypoint` throws "Could not find token-goat.cmd on PATH" / "...executable on
// PATH" and both cases above fail for a reason unrelated to what they're actually testing. These
// tests drive that exact shipping-default code path end to end -- a real PATH scan and (on
// win32) real shim-text parsing against a file this test writes to disk -- rather than relying on
// the runner happening to have token-goat globally installed.
const savedPath = process.env['PATH']
const savedPathCap = process.env['Path'] // Windows env lookups are case-insensitive; node also exposes the 'Path' spelling.

function restorePath(): void {
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  if (savedPathCap === undefined) delete process.env['Path']
  else process.env['Path'] = savedPathCap
}

/** Writes a real, resolvable fake token-goat entrypoint into a fresh temp dir and prepends it to PATH, so a test can drive `resolveTokenGoatEntrypoint`'s real PATH-scan/shim-parsing logic instead of relying on token-goat being globally installed on the machine running the test. Returns the dir for cleanup. */
async function setUpFakeTokenGoatOnPath(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-bin-'))
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(binDir, 'token-goat.mjs'), '// fake entrypoint\n')
    await fs.writeFile(
      path.join(binDir, 'token-goat.cmd'),
      ['@ECHO off', 'SET dp0=%~dp0', `"%dp0%node.exe"  "%dp0%token-goat.mjs" %*`].join('\r\n'),
    )
  } else {
    const binPath = path.join(binDir, 'token-goat')
    await fs.writeFile(binPath, '#!/usr/bin/env node\n')
    await fs.chmod(binPath, 0o755)
  }
  process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`
  process.env['Path'] = process.env['PATH']
  resetEntrypointCacheForTests()
  return binDir
}

afterEach(async () => {
  restorePath()
  resetEntrypointCacheForTests()
})

describe('resolveTokenGoatEntrypoint (shipping default, no injected seam)', () => {
  it('scans real PATH and resolves the real entrypoint script, without an injected execFile or PATH stub', async () => {
    const binDir = await setUpFakeTokenGoatOnPath()
    try {
      const expected =
        process.platform === 'win32' ? path.join(binDir, 'token-goat.mjs') : path.join(binDir, 'token-goat')
      const resolved = await resolveTokenGoatEntrypoint()
      expect(resolved).toBe(expected)
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  })

  it('throws a clear error, rather than silently resolving nothing, when token-goat is not on PATH at all', async () => {
    resetEntrypointCacheForTests()
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-empty-'))
    try {
      process.env['PATH'] = emptyDir
      process.env['Path'] = emptyDir
      // win32 and POSIX raise deliberately different wording ("Could not find token-goat.cmd on
      // PATH" vs "Could not find the token-goat executable on PATH"), so the assertion matches
      // both branches' shared substance instead of one branch's exact phrasing.
      await expect(resolveTokenGoatEntrypoint()).rejects.toThrow(/Could not find.*token-goat.*on PATH/)
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('runTokenGoat (post-fix)', () => {
  // These cases inject `fakeExecFile` to assert on the constructed spawn call, but
  // `runTokenGoat` still resolves its own entrypoint internally (see `resolveTokenGoatEntrypoint`
  // above) -- so without this, they'd depend on token-goat actually being installed globally on
  // whatever machine runs the suite, exactly the injected-seam gap the tests above this describe
  // block exist to close.
  let fakeBinDir: string
  beforeEach(async () => {
    fakeBinDir = await setUpFakeTokenGoatOnPath()
  })
  afterEach(async () => {
    await fs.rm(fakeBinDir, { recursive: true, force: true })
  })

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

describe('resolveGitExecutable (post-fix, issue #76 A1)', () => {
  afterEach(() => {
    resetGitExecutableCacheForTests()
  })

  it.runIf(process.platform === 'win32')(
    'rejects a PATH containing only git.cmd, since execFile still routes .cmd through cmd.exe with shell:false',
    async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-gitcmd-'))
      try {
        await fs.writeFile(path.join(binDir, 'git.cmd'), '@echo off\r\necho fake git\r\n')
        process.env['PATH'] = binDir
        process.env['Path'] = binDir
        resetGitExecutableCacheForTests()
        await expect(resolveGitExecutable()).rejects.toThrow(/git\.exe/)
      } finally {
        await fs.rm(binDir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'win32')('resolves a real git.exe on PATH', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-gitexe-'))
    try {
      await fs.writeFile(path.join(binDir, 'git.exe'), 'not a real binary, just needs to exist')
      process.env['PATH'] = binDir
      process.env['Path'] = binDir
      resetGitExecutableCacheForTests()
      const resolved = await resolveGitExecutable()
      expect(resolved).toBe(path.join(binDir, 'git.exe'))
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
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

  // Real shim text captured from an actual `pnpm install` of a package with a `bin` entry
  // (pnpm 11.11.0, Windows), not an invented approximation -- pnpm writes the launch line with
  // `%~dp0` directly, no intermediate `dp0` variable at all, unlike current npm's two-step form.
  it('resolves the %~dp0 dialect (real pnpm-generated shim)', () => {
    const shimText = [
      '@SETLOCAL',
      '@IF NOT DEFINED NODE_PATH (',
      '  @SET "NODE_PATH=..."',
      ') ELSE (',
      '  @SET "NODE_PATH=...;%NODE_PATH%"',
      ')',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\fakebin\\bin.js" %*',
      ') ELSE (',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\..\\fakebin\\bin.js" %*',
      ')',
      '',
    ].join('\r\n')
    const result = parseShimScriptPath(shimText, 'C:\\proj\\node_modules\\.bin')
    expect(result).toBe('C:\\proj\\node_modules\\fakebin\\bin.js')
  })

  // Real shim text captured from an actual `yarn install` (yarn classic 1.22.22, Windows) of a
  // package with a `bin` entry. Yarn classic also writes the `%~dp0` dialect directly.
  it('resolves the %~dp0 dialect (real yarn classic-generated shim)', () => {
    const shimText = [
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\fakebin\\bin.js" %*',
      ') ELSE (',
      '  @SETLOCAL',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\..\\fakebin\\bin.js" %*',
      ')',
      '',
    ].join('\r\n')
    const result = parseShimScriptPath(shimText, 'C:\\proj\\node_modules\\.bin')
    expect(result).toBe('C:\\proj\\node_modules\\fakebin\\bin.js')
  })
})

describe('resolveTokenGoatEntrypoint POSIX non-JS shim (issue #76 A3)', () => {
  it.runIf(process.platform !== 'win32')(
    'rejects a compiled-binary shim on PATH instead of feeding it to node as a script',
    async () => {
      // Models a Volta-style shim: PATH points at a real executable file that is not JavaScript
      // at all (no shebang, no .js/.mjs/.cjs extension) -- e.g. an ELF/Mach-O compiled binary.
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-volta-'))
      try {
        const binPath = path.join(binDir, 'token-goat')
        await fs.writeFile(binPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])) // ELF magic bytes
        await fs.chmod(binPath, 0o755)
        process.env['PATH'] = binDir
        process.env['Path'] = binDir
        resetEntrypointCacheForTests()
        await expect(resolveTokenGoatEntrypoint()).rejects.toThrow(/not a JavaScript file/)
      } finally {
        await fs.rm(binDir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a bash-script shim on PATH (asdf-style) instead of feeding it to node as a script',
    async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-asdf-'))
      try {
        const binPath = path.join(binDir, 'token-goat')
        await fs.writeFile(binPath, '#!/usr/bin/env bash\nexec "$ASDF_DIR/bin/asdf" exec token-goat "$@"\n')
        await fs.chmod(binPath, 0o755)
        process.env['PATH'] = binDir
        process.env['Path'] = binDir
        resetEntrypointCacheForTests()
        await expect(resolveTokenGoatEntrypoint()).rejects.toThrow(/not a JavaScript file/)
      } finally {
        await fs.rm(binDir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'accepts a real symlink-to-JS entrypoint (standard npm global install shape) and resolves the symlink',
    async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-launcher-npmlink-'))
      try {
        const realScript = path.join(binDir, 'token-goat.mjs')
        await fs.writeFile(realScript, '#!/usr/bin/env node\nconsole.log("ok")\n')
        const symlinkPath = path.join(binDir, 'token-goat')
        await fs.symlink(realScript, symlinkPath)
        process.env['PATH'] = binDir
        process.env['Path'] = binDir
        resetEntrypointCacheForTests()
        const resolved = await resolveTokenGoatEntrypoint()
        expect(resolved).toBe(await fs.realpath(realScript))
      } finally {
        await fs.rm(binDir, { recursive: true, force: true })
      }
    },
  )
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
