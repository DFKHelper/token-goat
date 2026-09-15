import { requireNonNegativeInt } from './cli.js'
import {
  runCsvProfile,
  runCsvQuery,
  runHtmlLint,
  runHtmlOutline,
  runHtmlQuery,
  runJsonOutline,
  runJsonQuery,
  runOpenApiOp,
  runOpenApiOutline,
  runXmlOutline,
  runXmlQuery,
  runYamlOutline,
  runYamlQuery,
  runZipList,
  runZipRead,
} from './read_commands.js'

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

export function cmdJsonOutline(file: string, opts: { json?: boolean }): void {
  process.exitCode = runJsonOutline({ file, ...opts })
}

export function cmdJsonQuery(file: string, jsonPath: string, opts: { head?: string; json?: boolean }): void {
  process.exitCode = runJsonQuery({ file, path: jsonPath, ...opts })
}

export function cmdYamlOutline(file: string, opts: { json?: boolean }): void {
  process.exitCode = runYamlOutline({ file, ...opts })
}

export function cmdYamlQuery(file: string, yamlPath: string, opts: { head?: string; json?: boolean }): void {
  process.exitCode = runYamlQuery({ file, path: yamlPath, ...opts })
}

export function cmdXmlOutline(file: string, opts: { json?: boolean; maxDepth?: string }): void {
  process.exitCode = runXmlOutline({
    file,
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.maxDepth !== undefined ? { maxDepth: requireNonNegativeInt('--max-depth', opts.maxDepth) } : {}),
  })
}

export function cmdXmlQuery(file: string, xmlPath: string, opts: { head?: string; json?: boolean }): void {
  process.exitCode = runXmlQuery({ file, path: xmlPath, ...opts })
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
