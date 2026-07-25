/**
 * Guard test: validates that README.md documents all CLI commands.
 *
 * This test catches drift between the CLI's actual command surface and
 * what README.md documents, preventing the manual "did we forget to add
 * the new command to README?" check from becoming a release chore.
 *
 * The test extracts:
 * 1. Real command names from the CLI manifest (via buildCommandManifest)
 * 2. Documented command references from README.md prose
 *
 * And asserts that every real top-level command (excluding subcommands
 * like `worker start` to keep the check focused on user-facing surface)
 * is mentioned somewhere in README.md.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest } from '../src/cli_commands.js'

describe('README.md coverage', () => {
  /**
   * Extract all command names mentioned in README.md as `token-goat <cmd>`.
   * Captures both fully-qualified commands (e.g., `token-goat symbol`) and
   * parameterized forms (e.g., `token-goat read "file::symbol"`).
   *
   * Returns only the base command name, lowercased and normalized.
   */
  function extractDocumentedCommands(readmePath: string): Set<string> {
    const readme = readFileSync(readmePath, 'utf-8')

    // Match `token-goat <command>` patterns in backticks or plain text.
    // Captures the command name (everything up to the first space or special char).
    const pattern = /`token-goat\s+([a-z-]+)/gi
    const documented = new Set<string>()

    let match
    while ((match = pattern.exec(readme)) !== null) {
      const cmd = match[1]!.toLowerCase()
      documented.add(cmd)
    }

    return documented
  }

  it('documents every top-level CLI command in README.md', () => {
    const readmePath = resolve(process.cwd(), 'README.md')
    const documentedCommands = extractDocumentedCommands(readmePath)

    // Get all real top-level commands (exclude subcommands like `worker start`)
    const manifest = buildCommandManifest(buildProgram())
    const realCommands = manifest.map(e => e.name.toLowerCase())

    // Find which real commands are NOT documented
    const undocumented = realCommands.filter(cmd => !documentedCommands.has(cmd))

    if (undocumented.length > 0) {
      const msg = `The following CLI commands are not mentioned in README.md:\n  ${undocumented.sort().join('\n  ')}\n\nEither add them to the CLI section table or mention them in prose with backticks (\`token-goat <cmd>\`).`
      expect.fail(msg)
    }
  })

  it('extracts documented commands correctly from README.md', () => {
    const readmePath = resolve(process.cwd(), 'README.md')
    const documented = extractDocumentedCommands(readmePath)

    // Sanity check: we should find common commands
    expect(documented.has('read')).toBe(true)
    expect(documented.has('symbol')).toBe(true)
    expect(documented.has('stats')).toBe(true)
    expect(documented.has('bash-output')).toBe(true)
  })
})
