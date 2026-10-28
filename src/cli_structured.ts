import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import { requireNonNegativeInt, requirePositiveInt } from './cli.js'
import { formatCommandError } from './command_error.js'
import { runCsvProfile, runCsvQuery, runHtmlLint, runHtmlOutline, runHtmlQuery, runJsonOutline, runJsonQuery, runOpenApiOp, runOpenApiOutline, runXmlOutline, runXmlQuery, runYamlOutline, runYamlQuery } from './read_structured_data.js'
import { runZipList, runZipRead } from './read_inspect.js'
import { detectLanguage } from './parser_types.js'
import { spawnOwned } from './process_tree.js'
import { collectWalkIndexFiles } from './walk_index.js'

export const PHP_LINT_CONFIG = { executable: 'php', defaultJobs: 4, maxJobs: 8 } as const

export function cmdCsvQuery(
  file: string,
  opts: { columns?: string; where?: string[]; head?: string; json?: boolean; delimiter?: string; header?: boolean },
): void {
  const { header, ...rest } = opts
  process.exitCode = runCsvQuery({ file, ...rest, ...(header === false ? { noHeader: true } : {}) })
}

export function cmdCsvProfile(file: string, opts: { delimiter?: string; header?: boolean }): void {
  const { header, ...rest } = opts
  process.exitCode = runCsvProfile({ file, ...rest, ...(header === false ? { noHeader: true } : {}) })
}

export function cmdJsonOutline(file: string, opts: { json?: boolean; filter?: string }): void {
  process.exitCode = runJsonOutline({ file, ...opts })
}

export function cmdJsonQuery(file: string, jsonPath: string, opts: { head?: string; json?: boolean }): void {
  process.exitCode = runJsonQuery({ file, path: jsonPath, ...opts })
}

export function cmdYamlOutline(file: string, opts: { json?: boolean; filter?: string }): void {
  process.exitCode = runYamlOutline({ file, ...opts })
}

export function cmdYamlQuery(file: string, yamlPath: string, opts: { head?: string; json?: boolean }): void {
  process.exitCode = runYamlQuery({ file, path: yamlPath, ...opts })
}

export function cmdXmlOutline(file: string, opts: { json?: boolean; maxDepth?: string; depth?: string }): void {
  const depthStr = opts.depth ?? opts.maxDepth
  process.exitCode = runXmlOutline({
    file,
    ...(opts.json === true ? { json: true } : {}),
    ...(depthStr !== undefined ? { maxDepth: requireNonNegativeInt('--max-depth', depthStr) } : {}),
  })
}

export function cmdXmlQuery(
  file: string,
  pathOrOpts?:
    | string
    | {
        head?: string
        json?: boolean
        xpath?: string
        withLines?: boolean
        decodeEmbeddedXml?: boolean
      },
  optsMaybe?: {
    head?: string
    json?: boolean
    xpath?: string
    withLines?: boolean
    decodeEmbeddedXml?: boolean
  },
): void {
  let xmlPath: string | undefined
  let opts: {
    head?: string
    json?: boolean
    xpath?: string
    withLines?: boolean
    decodeEmbeddedXml?: boolean
  } = {}

  if (typeof pathOrOpts === 'string') {
    xmlPath = pathOrOpts
    opts = optsMaybe ?? {}
  } else if (typeof pathOrOpts === 'object' && pathOrOpts !== null) {
    opts = pathOrOpts
  } else if (typeof optsMaybe === 'object' && optsMaybe !== null) {
    opts = optsMaybe
  }

  process.exitCode = runXmlQuery({
    file,
    ...(xmlPath !== undefined ? { path: xmlPath } : {}),
    ...(opts.xpath !== undefined ? { xpath: opts.xpath } : {}),
    ...(opts.head !== undefined ? { head: opts.head } : {}),
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.withLines === true ? { withLines: true } : {}),
    ...(opts.decodeEmbeddedXml === true ? { decodeEmbeddedXml: true } : {}),
  })
}

export function cmdHtmlOutline(file: string, opts: { json?: boolean }): void {
  process.exitCode = runHtmlOutline({ file, ...opts })
}

export function cmdHtmlQuery(
  file: string,
  selector: string,
  opts: { head?: string; json?: boolean; text?: boolean; attr?: string },
): void {
  process.exitCode = runHtmlQuery({ file, selector, ...opts })
}

export function cmdHtmlLint(file: string, opts: { json?: boolean; strict?: boolean }): void {
  process.exitCode = runHtmlLint({ file, ...opts })
}

interface PhpLintProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  errorCode?: string
}

interface PhpLintFileResult extends PhpLintProcessResult {
  file: string
}

interface PhpLintRunResult {
  files: string[]
  results: PhpLintFileResult[]
  exitCode: number
  runtimeMissing: boolean
}

type PhpLintProcessRunner = (executable: string, args: string[]) => Promise<PhpLintProcessResult>

interface PhpLintOptions {
  php?: string
  jobs?: string
  cwd?: string
  runProcess?: PhpLintProcessRunner
}

function runPhpLintProcess(executable: string, args: string[]): Promise<PhpLintProcessResult> {
  return new Promise((resolveResult) => {
    let owned: ReturnType<typeof spawnOwned>
    try {
      owned = spawnOwned(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolveResult({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const { child } = owned
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: PhpLintProcessResult): void => {
      if (settled) return
      settled = true
      resolveResult(result)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return
      finish({
        exitCode: -1,
        stdout,
        stderr,
        error: error.message,
        ...(error.code === undefined ? {} : { errorCode: error.code }),
      })
    })
    child.once('close', (code, signal) => {
      finish({
        exitCode: code ?? -1,
        stdout,
        stderr,
        ...(code === null ? { error: `php -l ended from signal ${signal ?? 'unknown'}` } : {}),
      })
    })
  })
}

export async function runPhpLint(paths: string[], opts: PhpLintOptions = {}): Promise<PhpLintRunResult> {
  const php = opts.php ?? PHP_LINT_CONFIG.executable
  if (php.trim() === '') throw new Error('--php must name a PHP executable')
  const jobs = opts.jobs === undefined ? PHP_LINT_CONFIG.defaultJobs : requirePositiveInt('--jobs', opts.jobs)
  if (jobs > PHP_LINT_CONFIG.maxJobs) throw new Error(`--jobs must be at most ${PHP_LINT_CONFIG.maxJobs}, got: ${opts.jobs}`)

  const roots = paths.length > 0 ? paths : [opts.cwd ?? process.cwd()]
  const files = new Set<string>()
  for (const root of roots) {
    if (root.trim() === '') throw new Error('PHP lint paths must not be empty')
    const absoluteRoot = resolve(root)
    let rootStats: ReturnType<typeof statSync>
    try {
      rootStats = statSync(absoluteRoot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot access PHP lint path ${JSON.stringify(absoluteRoot)}: ${message}`, { cause: error })
    }
    if (rootStats.isFile()) {
      if (detectLanguage(absoluteRoot) === 'php') files.add(absoluteRoot)
      continue
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`PHP lint path is not a directory or regular file: ${JSON.stringify(absoluteRoot)}`)
    }

    for (const file of collectWalkIndexFiles(absoluteRoot)) {
      if (detectLanguage(file) === 'php') files.add(file)
    }
  }

  const orderedFiles = [...files].sort()
  const runner = opts.runProcess ?? runPhpLintProcess
  const results: Array<PhpLintFileResult | undefined> = new Array(orderedFiles.length)
  let nextFile = 0
  let runtimeMissing = false
  const worker = async (): Promise<void> => {
    while (!runtimeMissing) {
      const index = nextFile
      nextFile += 1
      const file = orderedFiles[index]
      if (file === undefined) return

      let outcome: PhpLintProcessResult
      try {
        outcome = await runner(php, ['-l', file])
      } catch (error) {
        outcome = {
          exitCode: -1,
          stdout: '',
          stderr: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      results[index] = { file, ...outcome }
      if (outcome.errorCode === 'ENOENT') runtimeMissing = true
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, orderedFiles.length) }, () => worker()))
  const completed = results.filter((result): result is PhpLintFileResult => result !== undefined)
  const exitCode =
    !runtimeMissing && completed.length === orderedFiles.length && completed.every((result) => result.exitCode === 0) ? 0 : 1
  return { files: orderedFiles, results: completed, exitCode, runtimeMissing }
}

export async function cmdPhpLint(paths: string[] = [], opts: PhpLintOptions = {}): Promise<void> {
  const php = opts.php ?? PHP_LINT_CONFIG.executable
  let result: PhpLintRunResult
  try {
    result = await runPhpLint(paths, { ...opts, php })
  } catch (error) {
    console.error(formatCommandError(error))
    process.exitCode = 1
    return
  }

  if (result.runtimeMissing) {
    console.error(
      formatCommandError(
        new Error(`[php-lint] PHP runtime unavailable: ${JSON.stringify(php)}. Install PHP or pass --php <executable>.`),
      ),
    )
    process.exitCode = 1
    return
  }
  if (result.files.length === 0) {
    console.log('[php-lint] No PHP files found.')
    process.exitCode = 0
    return
  }
  let failures = 0
  let diagnostics = 0
  for (const check of result.results) {
    const stdoutDiagnostics = check.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => !/^No syntax errors detected(?: in .*)?$/.test(line))
      .join('\n')
    const detail = [check.stderr.trim(), stdoutDiagnostics].filter(Boolean).join('\n')
    if (check.exitCode === 0) {
      if (detail) {
        diagnostics += 1
        console.error(formatCommandError(new Error(`[php-lint] ${check.file}: ${detail}`)))
      }
      continue
    }
    failures += 1
    const failureDetail = detail || check.error || `php -l exited with code ${check.exitCode}`
    console.error(formatCommandError(new Error(`[php-lint] ${check.file}: ${failureDetail}`)))
  }
  const passed = result.results.length - failures
  const diagnosticSummary = diagnostics > 0 ? `, ${diagnostics} with diagnostics` : ''
  console.log(`[php-lint] Checked ${result.files.length} PHP files with ${php}: ${passed} passed, ${failures} failed${diagnosticSummary}.`)
  if (failures > 0) {
    console.error(formatCommandError(new Error(`[php-lint] ${failures} PHP file(s) failed syntax validation.`)))
    process.exitCode = 1
    return
  }
  process.exitCode = 0
}

export function cmdOpenApiOutline(file: string, opts: { json?: boolean }): void {
  process.exitCode = runOpenApiOutline({ file, ...opts })
}

export function cmdOpenApiOp(file: string, operation: string, opts: { json?: boolean }): void {
  process.exitCode = runOpenApiOp({ file, operation, ...opts })
}

export async function cmdZipList(file: string, opts: { json?: boolean }): Promise<void> {
  process.exitCode = await runZipList({ file, ...opts })
}

export async function cmdZipRead(file: string, entry: string, opts: { json?: boolean }): Promise<void> {
  process.exitCode = await runZipRead({ file, entry, ...opts })
}
