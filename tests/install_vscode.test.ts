import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { installVscode, uninstallVscode } from '../src/bridges/vscode_install.js'

describe('VS Code project-local install', () => {
  it('merges servers and guidance without replacing unrelated content', () => {
    const project = fs.mkdtempSync(path.join(process.cwd(), '.tg-vscode-test-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.mkdirSync(path.join(project, '.github'), { recursive: true })
      fs.writeFileSync(path.join(project, '.vscode', 'mcp.json'), JSON.stringify({ other: true, servers: { other: { type: 'stdio' } } }))
      fs.writeFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'user guidance\n')
      installVscode(project)
      const config = JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')) as Record<string, unknown>
      expect(config['other']).toBe(true)
      expect((config['servers'] as Record<string, unknown>)['other']).toEqual({ type: 'stdio' })
      expect((config['servers'] as Record<string, unknown>)['token-goat']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist', 'token-goat.mjs'), 'mcp-serve'],
      })
      const guidance = fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')
      expect(guidance).toContain('user guidance')
      expect(guidance).toContain('servers root key')
      expect(guidance).toContain('does not intercept')
      expect(installVscode(project).alreadyInstalled).toBe(true)
      expect(uninstallVscode(project)).toBe(true)
      const after = JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')) as Record<string, unknown>
      expect((after['servers'] as Record<string, unknown>)['other']).toEqual({ type: 'stdio' })
      expect((after['servers'] as Record<string, unknown>)['token-goat']).toBeUndefined()
      expect(fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')).toBe('user guidance\n')
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('fails clearly on malformed JSON', () => {
    const project = fs.mkdtempSync(path.join(process.cwd(), '.tg-vscode-malformed-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(path.join(project, '.vscode', 'mcp.json'), '{not json')
      expect(() => installVscode(project)).toThrow(/malformed VS Code MCP JSON/)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('preserves valid JSONC comments and trailing commas', () => {
    const project = fs.mkdtempSync(path.join(process.cwd(), '.tg-vscode-jsonc-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(
        path.join(project, '.vscode', 'mcp.json'),
        '// user comment\n{\n  "servers": {\n    "other": { "type": "stdio" },\n  },\n}\n',
      )
      installVscode(project)
      const config = fs.readFileSync(path.join(project, '.vscode', 'mcp.json'), 'utf8')
      expect(config).toContain('// user comment')
      expect(config).toContain('"other"')
      expect(config).toContain('"type": "stdio"')
      expect(config).toContain('"token-goat"')
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('does not overwrite an unrelated server using the token-goat name', () => {
    const project = fs.mkdtempSync(path.join(process.cwd(), '.tg-vscode-conflict-'))
    try {
      fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
      fs.writeFileSync(
        path.join(project, '.vscode', 'mcp.json'),
        JSON.stringify({ servers: { 'token-goat': { type: 'http', url: 'http://example.test/mcp' } } }),
      )
      expect(() => installVscode(project)).toThrow(/non-token-goat-managed server/)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
