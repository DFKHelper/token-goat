import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copilotMcpConfigPath, installCopilotMcpServer, uninstallCopilotMcpServer } from '../src/bridges/copilot_mcp_install.js'
import { installCursor, uninstallCursor } from '../src/bridges/cursor_install.js'
import { installVscode, uninstallVscode, vscodeMcpPath } from '../src/bridges/vscode_install.js'
import { installZed, uninstallZed, zedSettingsPath } from '../src/bridges/zed_install.js'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'COPILOT_HOME'] as const
const saved: Record<string, string | undefined> = {}
let dir: string

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-keep-empty-servers-'))
  for (const k of ENV_KEYS) process.env[k] = dir
  process.env['COPILOT_HOME'] = path.join(dir, 'copilot')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// Provenance: HAND-DERIVED. The inputs are the user's own settings from the bug report (a theme comment, an empty server object holding a comment, an unrelated key); the expectation is the same bytes back after install then uninstall, which needs no implementation to compute.
const ZED = '{\n  "theme": "One Dark", // my theme\n  "context_servers": {\n    // add servers here\n  },\n  "vim_mode": true\n}\n'
const CURSOR = '{\n  "editor.fontSize": 14, // keep this note\n  "mcpServers": {\n    // servers go here\n  }\n}\n'

describe('uninstall hands back a pre-existing empty server object', () => {
  it('Zed: context_servers, its comment and the theme comment survive', () => {
    seed(zedSettingsPath(), ZED)
    installZed()
    uninstallZed()
    expect(fs.readFileSync(zedSettingsPath(), 'utf8')).toBe(ZED)
  })

  it('Cursor: mcpServers and both comments survive', () => {
    const mcp = path.join(dir, '.cursor', 'mcp.json')
    seed(mcp, CURSOR)
    installCursor()
    uninstallCursor()
    expect(fs.readFileSync(mcp, 'utf8')).toBe(CURSOR)
  })

  it('Copilot CLI: an empty mcpServers object survives', () => {
    const text = '{\n  "mcpServers": {}\n}\n'
    seed(copilotMcpConfigPath(), text)
    installCopilotMcpServer()
    uninstallCopilotMcpServer()
    expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8')).toBe(text)
  })

  it('VS Code project: an empty servers object with a comment survives', () => {
    const projectRoot = path.join(dir, 'proj')
    const text = '{\n  // my servers\n  "servers": {}\n}\n'
    seed(vscodeMcpPath({ project: true, projectRoot }), text)
    installVscode({ project: true, projectRoot })
    uninstallVscode({ project: true, projectRoot })
    expect(fs.readFileSync(vscodeMcpPath({ project: true, projectRoot }), 'utf8')).toBe(text)
  })

  it('still drops the root key, and deletes the file, when install created both', () => {
    installZed()
    uninstallZed()
    expect(fs.existsSync(zedSettingsPath())).toBe(false)
    const mcp = path.join(dir, '.cursor', 'mcp.json')
    installCursor()
    uninstallCursor()
    expect(fs.existsSync(mcp)).toBe(false)
  })

  it('drops a root key install added to a file the user already had', () => {
    const text = '{\n  "vim_mode": true\n}\n'
    seed(zedSettingsPath(), text)
    installZed()
    uninstallZed()
    expect(fs.readFileSync(zedSettingsPath(), 'utf8')).toBe(text)
  })
})
