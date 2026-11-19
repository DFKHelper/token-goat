import fs from 'node:fs'
import path from 'node:path'

import { copilotCliUserRoot } from './copilot_home.js'
import { registerReset } from './reset.js'

interface CachedSettings {
  settingsPath: string
  mtimeMs: number
  size: number
  ctimeMs: number
  ino: number
  dev: number
  settings: Record<string, unknown>
}

let cachedSettings: CachedSettings | null = null

function readSettings(userRoot: string = copilotCliUserRoot()): Record<string, unknown> {
  const settingsPath = path.resolve(userRoot, 'settings.json')
  try {
    const stat = fs.statSync(settingsPath)
    if (!stat.isFile()) {
      discardCachedSettings(settingsPath)
      return {}
    }
    if (
      cachedSettings?.settingsPath === settingsPath &&
      cachedSettings.mtimeMs === stat.mtimeMs &&
      cachedSettings.size === stat.size &&
      cachedSettings.ctimeMs === stat.ctimeMs &&
      cachedSettings.ino === stat.ino &&
      cachedSettings.dev === stat.dev
    ) {
      return cachedSettings.settings
    }

    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      discardCachedSettings(settingsPath)
      return {}
    }
    const settings = parsed as Record<string, unknown>
    cachedSettings = {
      settingsPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      dev: stat.dev,
      settings,
    }
    return settings
  } catch {
    discardCachedSettings(settingsPath)
    return {}
  }
}

function discardCachedSettings(settingsPath: string): void {
  if (cachedSettings?.settingsPath === settingsPath) cachedSettings = null
}

function resetCopilotHostConfigCache(): void {
  cachedSettings = null
}

function stringEntries(value: unknown): string[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? stringEntries(value) : []
}

registerReset(resetCopilotHostConfigCache)

/** Custom skill directories from Copilot's settings.json, as non-empty trimmed paths. */
export function skillDirectories(userRoot: string = copilotCliUserRoot()): string[] {
  return stringEntries(readSettings(userRoot)['skillDirectories'])
}

/** User-disabled MCP servers, including Copilot CLI's single-server setting. */
export function disabledMcpServers(userRoot: string = copilotCliUserRoot()): Set<string> {
  const settings = readSettings(userRoot)
  return new Set([
    ...stringList(settings['disabledMcpServers']),
    ...stringEntries(settings['disableMcpServer']),
  ])
}

export interface CopilotMcpSettings {
  readonly disabledServers: Set<string>
  readonly disableBuiltin: boolean
}

/** One settings snapshot for MCP filtering; callers do not mix separate reads. */
export function mcpSettings(userRoot: string = copilotCliUserRoot()): CopilotMcpSettings {
  const settings = readSettings(userRoot)
  return {
    disabledServers: new Set([
      ...stringList(settings['disabledMcpServers']),
      ...stringEntries(settings['disableMcpServer']),
    ]),
    disableBuiltin: settings['disableBuiltinMcps'] === true,
  }
}

/** Whether Copilot's bundled MCP servers are disabled in settings.json. */
export function disableBuiltinMcps(userRoot: string = copilotCliUserRoot()): boolean {
  return readSettings(userRoot)['disableBuiltinMcps'] === true
}

/** The live COPILOT_SKILLS_DIRS override; environment changes are observed on the next call. */
export function copilotSkillDirectoriesEnv(): string | undefined {
  return process.env['COPILOT_SKILLS_DIRS']
}

/** The live COPILOT_MCP_TOOL_CACHE value; environment changes are observed on the next call. */
export function copilotMcpToolCache(): string | undefined {
  return process.env['COPILOT_MCP_TOOL_CACHE']
}
