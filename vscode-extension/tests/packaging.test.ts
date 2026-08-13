/**
 * Guard the one packaging rule that no other gate can see.
 *
 * `vsce` supports two mutually exclusive ways of choosing what goes into a VSIX: a `files`
 * allowlist in package.json, or a `.vscodeignore` denylist. Given both, it does not merge them or
 * prefer one -- it refuses to package at all ("VSCE does not support combining both strategies").
 *
 * That happened here: `files` had been in package.json since the extension was introduced, and a
 * later change added `.vscodeignore` alongside it. Every gate stayed green -- lint, four
 * typechecks, three test suites -- because none of them packages the extension, so the only
 * symptom was that the VSIX could no longer be built at all, discoverable only by running `vsce`.
 *
 * Only `vsce package` rejects the combination. `vsce ls` accepts it and exits 0, listing the files
 * the allowlist selects -- so a lighter "list what would ship" check reports success on a tree that
 * cannot actually be packaged, and is not a substitute for this.
 *
 * These cases are cheap string checks rather than an actual `vsce package` run on purpose: they
 * need no network, no packaging step, and no VS Code, so they can live in the normal suite.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

const extensionRoot = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
  files?: string[]
}

describe('VSIX packaging inputs', () => {
  it('declares exactly one of the two mutually exclusive packaging strategies', () => {
    const hasIgnoreFile = fs.existsSync(path.join(extensionRoot, '.vscodeignore'))
    const hasFilesField = Array.isArray(manifest.files) && manifest.files.length > 0

    expect(
      hasIgnoreFile && hasFilesField,
      'vscode-extension has both a .vscodeignore and a package.json "files" allowlist. vsce refuses to package when both are present, so the VSIX cannot be built. Keep one -- the "files" allowlist is the stricter of the two, since a new file dropped at the extension root ships by default under a denylist and does not under an allowlist.',
    ).toBe(false)

    expect(
      hasIgnoreFile || hasFilesField,
      'vscode-extension declares neither a "files" allowlist nor a .vscodeignore, so a VSIX would ship the entire directory including src/, tests/ and node_modules/.',
    ).toBe(true)
  })

  it('ships the compiled output and the icon, which the manifest references', () => {
    // An allowlist that drops out/** produces a VSIX that installs and then fails to activate,
    // and one that drops icon.png fails validation against the manifest's own icon field.
    expect(manifest.files).toContain('out/**')
    expect(manifest.files).toContain('icon.png')
  })
})
