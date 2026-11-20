import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  copilotMcpToolCache,
  copilotSkillDirectoriesEnv,
  disableBuiltinMcps,
  disabledMcpServers,
  setCopilotHostConfigClockForTesting,
  skillDirectories,
} from '../src/copilot_host_config.js'
import { clearModuleCaches } from '../src/reset.js'

let userRoot: string
let savedSkillDirectories: string | undefined
let savedMcpToolCache: string | undefined

beforeEach(() => {
  userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-host-config-'))
  savedSkillDirectories = process.env['COPILOT_SKILLS_DIRS']
  savedMcpToolCache = process.env['COPILOT_MCP_TOOL_CACHE']
  clearModuleCaches()
})

afterEach(() => {
  if (savedSkillDirectories === undefined) delete process.env['COPILOT_SKILLS_DIRS']
  else process.env['COPILOT_SKILLS_DIRS'] = savedSkillDirectories
  if (savedMcpToolCache === undefined) delete process.env['COPILOT_MCP_TOOL_CACHE']
  else process.env['COPILOT_MCP_TOOL_CACHE'] = savedMcpToolCache
  vi.restoreAllMocks()
  setCopilotHostConfigClockForTesting(null)
  fs.rmSync(userRoot, { recursive: true, force: true })
})

describe('Copilot host config', () => {
  it('caches settings, resets through the registry, and reloads after metadata changes', () => {
    // A file written a moment ago is racy and never trusted; a clock a minute on makes it an old file.
    setCopilotHostConfigClockForTesting(() => Date.now() + 60_000)
    const settingsPath = path.join(userRoot, 'settings.json')
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        skillDirectories: [' first ', 'second', 7],
        disabledMcpServers: ['server-a', ' server-b ', null],
        disableMcpServer: 'legacy-server',
        disableBuiltinMcps: true,
      }),
      'utf8',
    )
    const firstSize = fs.statSync(settingsPath).size
    const readFile = vi.spyOn(fs, 'readFileSync')

    expect(skillDirectories(userRoot)).toEqual(['first', 'second'])
    expect(disabledMcpServers(userRoot)).toEqual(new Set(['server-a', 'server-b', 'legacy-server']))
    expect(disableBuiltinMcps(userRoot)).toBe(true)
    expect(readFile).toHaveBeenCalledTimes(1)

    clearModuleCaches()
    expect(skillDirectories(userRoot)).toEqual(['first', 'second'])
    expect(readFile).toHaveBeenCalledTimes(2)

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        skillDirectories: 'a-new-skill-directory',
        disabledMcpServers: ['new-server'],
        disableMcpServer: ['new-legacy-server'],
        disableBuiltinMcps: false,
      }),
      'utf8',
    )
    expect(fs.statSync(settingsPath).size).not.toBe(firstSize)

    expect(skillDirectories(userRoot)).toEqual(['a-new-skill-directory'])
    expect(disabledMcpServers(userRoot)).toEqual(new Set(['new-server', 'new-legacy-server']))
    expect(disableBuiltinMcps(userRoot)).toBe(false)
    expect(readFile).toHaveBeenCalledTimes(3)

    process.env['COPILOT_SKILLS_DIRS'] = ' first-env , second-env '
    process.env['COPILOT_MCP_TOOL_CACHE'] = 'off'
    expect(copilotSkillDirectoriesEnv()).toBe(' first-env , second-env ')
    expect(copilotMcpToolCache()).toBe('off')
    process.env['COPILOT_MCP_TOOL_CACHE'] = 'true'
    expect(copilotMcpToolCache()).toBe('true')
  })

  it('fails open for missing and malformed settings without serving stale values', () => {
    const settingsPath = path.join(userRoot, 'settings.json')
    const expectOpen = (): void => {
      expect(skillDirectories(userRoot)).toEqual([])
      expect(disabledMcpServers(userRoot)).toEqual(new Set())
      expect(disableBuiltinMcps(userRoot)).toBe(false)
    }

    expectOpen()
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        skillDirectories: ['cached'],
        disabledMcpServers: ['cached-server'],
        disableBuiltinMcps: true,
      }),
      'utf8',
    )
    expect(skillDirectories(userRoot)).toEqual(['cached'])
    expect(disabledMcpServers(userRoot)).toEqual(new Set(['cached-server']))
    expect(disableBuiltinMcps(userRoot)).toBe(true)

    fs.writeFileSync(settingsPath, '{', 'utf8')
    expectOpen()
    fs.rmSync(settingsPath)
    expectOpen()
  })

  it('invalidates same-size settings when change metadata changes', () => {
    const settingsPath = path.join(userRoot, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ skillDirectories: ['same-size-a'] }), 'utf8')
    expect(skillDirectories(userRoot)).toEqual(['same-size-a'])

    fs.writeFileSync(settingsPath, JSON.stringify({ skillDirectories: ['same-size-b'] }), 'utf8')
    const before = fs.statSync(settingsPath)
    fs.utimesSync(settingsPath, before.atime, before.mtime)

    expect(skillDirectories(userRoot)).toEqual(['same-size-b'])
  })
})
