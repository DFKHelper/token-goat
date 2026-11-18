/** Guard: no text token-goat ships to a model may name an MCP tool as one to call unless the default `tools/list` holds it. The default list hides most tools to save context on every turn, and a hidden tool that some shipped sentence still names is a silent break: at 2.9.31 review found the VS Code and Visual Studio instruction blocks sending the model to a hidden `retrieve_text` and a read note sending it to a hidden `grep`, and nothing failed. It scans the rendered gate, the Visual Studio block, the canonical skill, every non-comment line of src/, and the MCP note rewrites. Provenance: HAND-DERIVED. The phrasings are the ones the real texts use ("Call the MCP tool `retrieve_text`" in src/bridges/vscode_install.ts, 'the "grep" tool again' from src/mcp_client_text.ts), pinned by the calibration cases below rather than read off the matcher. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildGuidanceBody, skillDescriptionLine } from '../../src/bridges/guidance_block.js'
import { buildVisualStudioGuidanceBlock } from '../../src/bridges/visualstudio_install.js'
import { CANONICAL_SKILL_MD } from '../../src/canonical_skill.js'
import { answeringMcpToolCall, mcpFriendlyText } from '../../src/mcp_client_text.js'
import { ALL_MCP_TOOLS } from '../helpers/mcp_all_tools.js'
import { pinnedPopulation } from './population.js'

const { DEFAULT_MCP_TOOLS } = await import('../../src/mcp_server.js')

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))
const SCANNED_EXTENSIONS = new Set(['.ts', '.md', '.cjs', '.mjs'])
/** A little under the 525 files of those kinds under src/ when this guard was written; a walk that returns far fewer has stopped scanning. */
const FLOOR = 500

/** Every tool the default list leaves out. */
const HIDDEN_TOOLS: readonly string[] = ALL_MCP_TOOLS.filter((t) => !DEFAULT_MCP_TOOLS.includes(t))

/** The phrasings that name a tool as one to call, for the given tool names; case-sensitive so Claude Code's own Grep and Read tools are not caught. */
function namingPatterns(tools: readonly string[]): RegExp[] {
  const alt = tools.join('|')
  return [
    new RegExp(`MCP tools? (?:named |called )?[\`"']?(?:${alt})\\b`),
    new RegExp(`[\`"'](?:${alt})[\`"'] (?:MCP )?tool\\b`),
    new RegExp(`\\bthe (?:${alt}) (?:MCP )?tool\\b`),
    new RegExp(`\\b(?:${alt}) MCP tool\\b`),
  ]
}

/** The matched phrases in `text` that name one of `tools` as a tool to call. */
function toolsNamed(text: string, tools: readonly string[]): string[] {
  if (tools.length === 0) return []
  const found: string[] = []
  for (const pattern of namingPatterns(tools)) {
    for (const line of text.split('\n')) {
      const m = pattern.exec(line)
      if (m !== null) found.push(m[0])
    }
  }
  return found
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

describe('shipped text names only the default MCP tools as tools to call', () => {
  it('has tools to guard, and the matcher catches the real phrasings', () => {
    // Calibration: with no hidden tools, or a matcher that matches nothing, every case below passes on nothing.
    expect(HIDDEN_TOOLS.length, 'the default list holds every tool; there is nothing hidden to guard').toBeGreaterThan(0)
    expect(toolsNamed('Call the MCP tool `retrieve_text` with that id', ['retrieve_text'])).not.toEqual([])
    expect(toolsNamed('use the "grep" tool again with a more specific parameter', ['grep'])).not.toEqual([])
    expect(toolsNamed('read the map tool output', ['map'])).not.toEqual([])
    expect(toolsNamed('the skeleton MCP tool', ['skeleton'])).not.toEqual([])
    // And it leaves alone the CLI commands and the host's own tools that share these names.
    expect(toolsNamed('run `map --compact`, or token-goat grep "x" f; Claude Code\'s Grep tool', ['map', 'grep'])).toEqual([])
  })

  it('pins the hidden set, so a tool moved into or out of the default is a decision made here', () => {
    expect([...HIDDEN_TOOLS].sort()).toEqual(['brief', 'changed', 'compress_text', 'exports', 'grep', 'handoff_create', 'handoff_resolve', 'imports', 'index_status', 'map', 'skeleton'])
  })

  it('finds no hidden tool named in the rendered gate, skill description, Visual Studio block or canonical skill', () => {
    const rendered: Record<string, string> = {
      'gate body (Claude clause)': buildGuidanceBody("Claude Code's own Read, Grep, and Glob preference rules"),
      'gate body (no gdrive)': buildGuidanceBody('the host read tools', { gdrive: false }),
      'skill description line': skillDescriptionLine(true),
      'Visual Studio block (shared file)': buildVisualStudioGuidanceBlock(true),
      'Visual Studio block (own file)': buildVisualStudioGuidanceBlock(false),
      'canonical skill': CANONICAL_SKILL_MD,
    }
    for (const [label, text] of Object.entries(rendered)) {
      expect(text.length, `${label} rendered empty`).toBeGreaterThan(0)
      expect(toolsNamed(text, HIDDEN_TOOLS), `${label} names a tool the default tools/list hides; list it in DEFAULT_MCP_TOOLS or reword`).toEqual([])
    }
  })

  it('finds no hidden tool named on any code line of src/, which covers the VS Code and Visual Studio instruction texts', () => {
    const files = pinnedPopulation({ what: 'src files scanned for tool names', items: walk(SRC_DIR).map((p) => path.relative(SRC_DIR, p).split(path.sep).join('/')), floor: FLOOR, mustInclude: ['mcp_client_text.ts', 'bridges/vscode_install.ts', 'bridges/visualstudio_install.ts', 'read_commands.ts'] })
    const offences: string[] = []
    for (const file of files) {
      for (const phrase of toolsNamed(codeLines(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')), HIDDEN_TOOLS)) {
        offences.push(`${file}: ${phrase}`)
      }
    }
    expect(offences, 'shipped text names a tool the default tools/list hides').toEqual([])
  })

  it('never rewrites a note into a call to a tool the server does not list', () => {
    for (const tool of HIDDEN_TOOLS) {
      const note = answeringMcpToolCall(() => mcpFriendlyText(`narrow it: token-goat ${tool} "pat"`), new Set(DEFAULT_MCP_TOOLS))
      expect(toolsNamed(note, HIDDEN_TOOLS), `the note for ${tool} still names it: ${note}`).toEqual([])
    }
    // And it is not a blanket refusal: a listed tool is still named, so the rewrite keeps doing its job.
    const kept = answeringMcpToolCall(() => mcpFriendlyText('retry: token-goat symbol "name"'), new Set(DEFAULT_MCP_TOOLS))
    expect(kept).toContain('the "symbol" tool again')
  })
})
