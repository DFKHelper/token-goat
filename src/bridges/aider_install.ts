import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { removeFileInScope, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { buildGuidanceBlock } from './guidance_block.js'
import { assertProjectScopeTarget, withInstallScope } from './project_scope_guard.js'

export const AIDER_CONVENTIONS_BEGIN = '<!-- token-goat-aider-begin -->'
export const AIDER_CONVENTIONS_END = '<!-- token-goat-aider-end -->'

export interface AiderScopeOptions {
  readonly project?: boolean
  readonly user?: boolean
  readonly projectRoot?: string
}

export interface AiderInstallResult {
  readonly conventionsPath: string
  readonly alreadyInstalled: boolean
  readonly scope: 'project' | 'user'
}

export function resolveScope(options: AiderScopeOptions = {}): 'project' | 'user' {
  if (options.user === true || options.project === false) return 'user'
  if (options.project === true) return 'project'
  const root = options.projectRoot ?? process.cwd()
  if (
    fs.existsSync(path.join(root, '.aider.conf.yml')) ||
    fs.existsSync(path.join(root, '.aider.conventions.md')) ||
    fs.existsSync(path.join(root, 'CONVENTIONS.md'))
  ) {
    return 'project'
  }
  return 'user'
}

export function aiderProjectConventionsPath(projectRoot: string = process.cwd()): string {
  const customMd = path.join(projectRoot, '.aider.conventions.md')
  if (fs.existsSync(customMd)) return customMd
  return path.join(projectRoot, 'CONVENTIONS.md')
}

export function aiderUserConventionsPath(): string {
  return path.join(os.homedir(), '.aider.conventions.md')
}

export function aiderConventionsPath(options: AiderScopeOptions = {}): string {
  const scope = resolveScope(options)
  const root = options.projectRoot ?? process.cwd()
  return scope === 'project' ? aiderProjectConventionsPath(root) : aiderUserConventionsPath()
}

export function buildAiderGuidanceBlock(): string {
  return buildGuidanceBlock({
    beginMarker: AIDER_CONVENTIONS_BEGIN,
    endMarker: AIDER_CONVENTIONS_END,
    fallbackToolClause: "Aider's own file-reading, repomap, and chat commands",
  })
}

function installAiderScoped(options: AiderScopeOptions = {}): AiderInstallResult {
  const scope = resolveScope(options)
  const root = options.projectRoot ?? process.cwd()
  const conventionsPath = scope === 'project' ? aiderProjectConventionsPath(root) : aiderUserConventionsPath()

  if (scope === 'project') {
    assertProjectScopeTarget(conventionsPath, root)
  }

  const alreadyInstalled = isAiderInstalled(options)
  if (!alreadyInstalled) {
    upsertDelimitedBlock(conventionsPath, AIDER_CONVENTIONS_BEGIN, AIDER_CONVENTIONS_END, buildAiderGuidanceBlock())
  }

  return {
    conventionsPath,
    alreadyInstalled,
    scope,
  }
}

export function installAider(options: AiderScopeOptions = {}): AiderInstallResult {
  const scope = resolveScope(options)
  if (scope === 'project') {
    const root = options.projectRoot ?? process.cwd()
    return withInstallScope(root, () => installAiderScoped(options))
  }
  return installAiderScoped(options)
}

function uninstallAiderScoped(options: AiderScopeOptions = {}): boolean {
  const scope = resolveScope(options)
  const root = options.projectRoot ?? process.cwd()
  const conventionsPath = scope === 'project' ? aiderProjectConventionsPath(root) : aiderUserConventionsPath()

  if (scope === 'project') {
    assertProjectScopeTarget(conventionsPath, root)
  }

  if (!fs.existsSync(conventionsPath)) return false
  const removed = stripDelimitedBlock(conventionsPath, AIDER_CONVENTIONS_BEGIN, AIDER_CONVENTIONS_END)
  if (!removed) return false

  try {
    if (fs.existsSync(conventionsPath) && fs.readFileSync(conventionsPath, 'utf8').trim().length === 0) {
      removeFileInScope(conventionsPath)
    }
  } catch {
    // Ignore cleanup error
  }
  return true
}

export function uninstallAider(options: AiderScopeOptions = {}): boolean {
  const scope = resolveScope(options)
  if (scope === 'project') {
    const root = options.projectRoot ?? process.cwd()
    return withInstallScope(root, () => uninstallAiderScoped(options))
  }
  return uninstallAiderScoped(options)
}

export function isAiderInstalled(options: AiderScopeOptions = {}): boolean {
  const scope = resolveScope(options)
  const root = options.projectRoot ?? process.cwd()
  const conventionsPath = scope === 'project' ? aiderProjectConventionsPath(root) : aiderUserConventionsPath()

  if (!fs.existsSync(conventionsPath)) return false
  try {
    const raw = fs.readFileSync(conventionsPath, 'utf8')
    return raw.includes(AIDER_CONVENTIONS_BEGIN)
  } catch {
    return false
  }
}
