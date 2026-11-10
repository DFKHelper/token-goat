import * as fs from 'node:fs'
import * as path from 'node:path'
import { SKIP_DIRS } from './baseline.js'
import { displaySafeJson, displaySafeText } from './paths.js'
import { findLockfile, parseLockFile, type DepEntry } from './text_commands.js'

const MAX_WALK_DEPTH = 32
const MAX_WALK_DIRECTORIES = 50_000
// limit: 32 levels and 50,000 directories; revisit-when a real service monorepo exceeds either cap.
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number]

export interface ManifestSweepQuery {
  root?: string
  packageName?: string
}

export interface ManifestSweepOptions extends ManifestSweepQuery {
  output?: 'text' | 'json'
}

export interface ManifestSweepDependency {
  name: string
  range: string
  section: DependencySection
}

export interface ManifestSweepCoordinate {
  name: string
  version: string
  kind: DepEntry['kind']
}

export interface ManifestSweepLockfile {
  path: string
  format: string
  packageCount: number
  coordinates: ManifestSweepCoordinate[]
}

export interface ManifestSweepEntry {
  path: string
  name: string | null
  version: string | null
  dependencies: ManifestSweepDependency[]
  lockfiles: ManifestSweepLockfile[]
}

export interface ManifestSweepReport {
  root: string
  packageFilter: string | null
  scannedManifests: number
  summary: {
    manifests: number
    declaredDependencies: number
    lockfiles: number
    resolvedCoordinates: number
  }
  manifests: ManifestSweepEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function readManifest(filePath: string): {
  name: string | null
  version: string | null
  dependencies: ManifestSweepDependency[]
} {
  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to read package manifest ${displaySafeText(filePath)}: ${displaySafeText(detail)}`,
      { cause: error },
    )
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(contents) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid package manifest ${displaySafeText(filePath)}: ${displaySafeText(detail)}`, { cause: error })
  }
  if (!isRecord(manifest)) throw new Error(`Invalid package manifest ${displaySafeText(filePath)}: expected an object`)

  const optionalString = (key: 'name' | 'version'): string | null => {
    const value = manifest[key]
    if (value === undefined) return null
    if (typeof value !== 'string') {
      throw new Error(`Invalid package manifest ${displaySafeText(filePath)}: ${key} must be a string`)
    }
    return value
  }

  const dependencies: ManifestSweepDependency[] = []
  for (const section of DEPENDENCY_SECTIONS) {
    const values = manifest[section]
    if (values === undefined) continue
    if (!isRecord(values)) {
      throw new Error(`Invalid package manifest ${displaySafeText(filePath)}: ${section} must be an object`)
    }
    for (const [name, range] of Object.entries(values)) {
      if (typeof range !== 'string') {
        throw new Error(`Invalid package manifest ${displaySafeText(filePath)}: ${section}.${displaySafeText(name)} must be a string`)
      }
      dependencies.push({ name, range, section })
    }
  }

  dependencies.sort((left, right) => compareText(left.name, right.name) || compareText(left.section, right.section))
  return { name: optionalString('name'), version: optionalString('version'), dependencies }
}

function manifestPaths(root: string): string[] {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  const manifests: string[] = []
  let visitedDirectories = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    visitedDirectories += 1
    if (visitedDirectories > MAX_WALK_DIRECTORIES) {
      throw new Error(`Manifest sweep exceeded its ${MAX_WALK_DIRECTORIES}-directory limit; narrow the root path`)
    }

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Unable to scan directory ${displaySafeText(current.directory)}: ${displaySafeText(detail)}`,
        { cause: error },
      )
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'package.json') manifests.push(path.join(current.directory, entry.name))
    }

    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .sort((left, right) => compareText(left.name, right.name))
    if (current.depth >= MAX_WALK_DEPTH) {
      if (children.length > 0) {
        throw new Error(`Manifest sweep exceeded its ${MAX_WALK_DEPTH}-level depth limit; narrow the root path`)
      }
      continue
    }

    for (const entry of children) {
      pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
    }
  }

  return manifests.sort(compareText)
}

interface LockfileReportsOptions {
  root: string
  directory: string
  declaredNames: ReadonlySet<string>
  packageName?: string
}

function lockfileReports(options: LockfileReportsOptions): ManifestSweepLockfile[] {
  const { root, directory, declaredNames, packageName } = options
  const found = findLockfile(directory)
  if (found === null) return []

  return [found.file, ...found.others]
    .sort(compareText)
    .map((filePath) => {
      let parsed: ReturnType<typeof parseLockFile>
      try {
        parsed = parseLockFile(filePath)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Unable to inspect lockfile ${displaySafeText(filePath)}: ${displaySafeText(detail)}`,
          { cause: error },
        )
      }

      const coordinates = parsed.deps
        .filter((dependency) => {
          if (packageName !== undefined) return dependency.name === packageName
          return dependency.kind === 'direct' || (dependency.kind === 'unknown' && declaredNames.has(dependency.name))
        })
        .map(({ name, version, kind }) => ({ name, version, kind }))
        .sort(
          (left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.version, right.version) ||
            compareText(left.kind, right.kind),
        )

      return {
        path: path.relative(root, filePath).split(path.sep).join('/'),
        format: parsed.format,
        packageCount: parsed.deps.length,
        coordinates,
      }
    })
}

export function collectManifestSweep(options: ManifestSweepQuery = {}): ManifestSweepReport {
  const root = path.resolve(options.root ?? process.cwd())
  const rootStat = fs.statSync(root, { throwIfNoEntry: false })
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new Error(`Manifest sweep root is not a directory: ${displaySafeText(root)}`)
  }
  if (options.packageName !== undefined && options.packageName.trim().length === 0) {
    throw new Error('Manifest sweep package filter must not be empty')
  }

  const foundManifests = manifestPaths(root)
  const manifests: ManifestSweepEntry[] = []
  for (const filePath of foundManifests) {
    const parsedManifest = readManifest(filePath)
    const directory = path.dirname(filePath)
    const declaredNames = new Set(parsedManifest.dependencies.map((dependency) => dependency.name))
    const dependencies =
      options.packageName === undefined
        ? parsedManifest.dependencies
        : parsedManifest.dependencies.filter((dependency) => dependency.name === options.packageName)
    const lockfiles = lockfileReports({
      root,
      directory,
      declaredNames,
      ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
    })
    if (
      options.packageName !== undefined &&
      dependencies.length === 0 &&
      !lockfiles.some((lockfile) => lockfile.coordinates.length > 0)
    ) {
      continue
    }

    manifests.push({
      path: path.relative(root, filePath).split(path.sep).join('/'),
      name: parsedManifest.name,
      version: parsedManifest.version,
      dependencies,
      lockfiles:
        options.packageName === undefined || dependencies.length > 0
          ? lockfiles
          : lockfiles.filter((lockfile) => lockfile.coordinates.length > 0),
    })
  }

  const summary = {
    manifests: manifests.length,
    declaredDependencies: manifests.reduce((total, manifest) => total + manifest.dependencies.length, 0),
    lockfiles: manifests.reduce((total, manifest) => total + manifest.lockfiles.length, 0),
    resolvedCoordinates: manifests.reduce(
      (total, manifest) => total + manifest.lockfiles.reduce((count, lockfile) => count + lockfile.coordinates.length, 0),
      0,
    ),
  }

  return {
    root,
    packageFilter: options.packageName ?? null,
    scannedManifests: foundManifests.length,
    summary,
    manifests,
  }
}

export function cmdManifestSweep(options: ManifestSweepOptions = {}): void {
  const report = collectManifestSweep(options)
  if (options.output === 'json') {
    process.stdout.write(displaySafeJson(report) + '\n')
    return
  }

  const lines = [
    `Root: ${displaySafeText(report.root)}`,
    `Manifests: ${report.summary.manifests} of ${report.scannedManifests}; lockfiles: ${report.summary.lockfiles}; declared dependencies: ${report.summary.declaredDependencies}; resolved coordinates: ${report.summary.resolvedCoordinates}`,
  ]
  if (report.packageFilter !== null && report.manifests.length === 0) {
    lines.push(`No manifests declare or lock ${displaySafeText(report.packageFilter)}.`)
  } else if (report.manifests.length === 0) {
    lines.push('No package.json manifests found.')
  }

  for (const manifest of report.manifests) {
    const identity = [manifest.name, manifest.version].filter((value): value is string => value !== null)
    lines.push(`${displaySafeText(manifest.path)}${identity.length > 0 ? ` (${identity.map(displaySafeText).join('@')})` : ''}`)
    const dependencies = manifest.dependencies
      .map((dependency) => `${displaySafeText(dependency.name)}@${displaySafeText(dependency.range)} [${dependency.section}]`)
      .join(', ')
    lines.push(`  declared: ${dependencies || '(none)'}`)
    if (manifest.lockfiles.length === 0) lines.push('  lockfiles: none')
    for (const lockfile of manifest.lockfiles) {
      const coordinates = lockfile.coordinates
        .map(
          (coordinate) =>
            `${displaySafeText(coordinate.name)}@${displaySafeText(coordinate.version)} [${coordinate.kind}]`,
        )
        .join(', ')
      lines.push(
        `  lock: ${displaySafeText(lockfile.path)} (${displaySafeText(lockfile.format)}; ${lockfile.packageCount} packages)${coordinates ? `: ${coordinates}` : ''}`,
      )
    }
  }

  process.stdout.write(lines.join('\n') + '\n')
}
