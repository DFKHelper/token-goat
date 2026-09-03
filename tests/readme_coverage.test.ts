/**
 * Guard test: validates that the reader-facing documentation covers all CLI commands.
 *
 * This test catches drift between the CLI's actual command surface and what the docs
 * document, preventing the manual "did we forget to add the new command?" check from
 * becoming a release chore.
 *
 * The file list is the whole reader-facing set, not README.md alone. The command
 * reference moved out of the README into docs/cli.md when the README was split, and a
 * guard pinned to one filename would have gone quietly green against an empty haystack.
 * The guarantee is unchanged -- a new command has to be written down somewhere a reader
 * lands -- so the check follows the prose rather than the filename. DOC_FILES is asserted
 * to exist and to yield a large command set before the coverage check runs, because
 * "no file matched" and "every command is documented" produce the same pass otherwise.
 *
 * The test extracts:
 * 1. Real command names from the CLI manifest (via buildCommandManifest)
 * 2. Documented command references from the docs prose
 *
 * And asserts that every real top-level command (excluding subcommands
 * like `worker start` to keep the check focused on user-facing surface)
 * is mentioned somewhere in that set.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest } from '../src/cli_commands.js'

/** Every page a reader of the docs actually lands on. */
const DOC_FILES = ['README.md', 'docs/cli.md', 'docs/install.md', 'docs/security.md']

describe('documentation command coverage', () => {
  /**
   * Extract all command names mentioned across the docs as `token-goat <cmd>`.
   * Captures both fully-qualified commands (e.g., `token-goat symbol`) and
   * parameterized forms (e.g., `token-goat read "file::symbol"`).
   *
   * Returns only the base command name, lowercased and normalized.
   */
  function extractDocumentedCommands(docPaths: string[]): Set<string> {
    const documented = new Set<string>()

    for (const docPath of docPaths) {
      const text = readFileSync(resolve(process.cwd(), docPath), 'utf-8')

      // Match `token-goat <command>` patterns in backticks or plain text.
      // Captures the command name (everything up to the first space or special char).
      const pattern = /`token-goat\s+([a-z-]+)/gi

      let match
      while ((match = pattern.exec(text)) !== null) {
        const cmd = match[1]!.toLowerCase()
        documented.add(cmd)
      }
    }

    return documented
  }

  it('reads a non-empty set of doc files, so an empty haystack cannot pass as full coverage', () => {
    for (const docPath of DOC_FILES) {
      expect(existsSync(resolve(process.cwd(), docPath)), `${docPath} exists`).toBe(true)
    }

    expect(extractDocumentedCommands(DOC_FILES).size).toBeGreaterThan(50)
  })

  it('documents every top-level CLI command', () => {
    const documentedCommands = extractDocumentedCommands(DOC_FILES)

    // Get all real top-level commands (exclude subcommands like `worker start`)
    const manifest = buildCommandManifest(buildProgram())
    const realCommands = manifest.map(e => e.name.toLowerCase())

    // Find which real commands are NOT documented
    const undocumented = realCommands.filter(cmd => !documentedCommands.has(cmd))

    if (undocumented.length > 0) {
      const msg = `The following CLI commands are not mentioned in ${DOC_FILES.join(', ')}:\n  ${undocumented.sort().join('\n  ')}\n\nEither add them to the command table in docs/cli.md or mention them in prose with backticks (\`token-goat <cmd>\`).`
      expect.fail(msg)
    }
  })

  it('extracts documented commands correctly from the docs', () => {
    const documented = extractDocumentedCommands(DOC_FILES)

    // Sanity check: we should find common commands
    expect(documented.has('read')).toBe(true)
    expect(documented.has('symbol')).toBe(true)
    expect(documented.has('stats')).toBe(true)
    expect(documented.has('bash-output')).toBe(true)
  })
})
