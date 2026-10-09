import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { cloneByteSize, dependencyRelative, withClonePaths } from './helpers/junction_paths.js'

// HAND-DERIVED: the inputs are the two spellings esbuild produces for one package, read off a built chunk in a worktree whose node_modules is a junction (`// ../../Projects/token-goat/node_modules/commander/lib/command.js`) and off an ordinary clone (`// node_modules/commander/lib/command.js`).
describe('junction-independent dependency paths', () => {
  it('reduces a junctioned metafile key to the form an ordinary clone gives', () => {
    expect(dependencyRelative('../../Projects/token-goat/node_modules/commander/lib/command.js')).toBe('node_modules/commander/lib/command.js')
    expect(dependencyRelative('node_modules/commander/lib/command.js')).toBe('node_modules/commander/lib/command.js')
  })

  it('keeps the innermost node_modules when packages nest', () => {
    expect(dependencyRelative('../../x/node_modules/a/node_modules/b/index.js')).toBe('node_modules/b/index.js')
  })

  it('leaves a path with no node_modules alone', () => {
    expect(dependencyRelative('src/cli.ts')).toBe('src/cli.ts')
  })

  it('rewrites a junctioned module marker and a CommonJS wrapper key to the clone spelling', () => {
    const junctioned = '// ../../Projects/token-goat/node_modules/commander/lib/command.js\nvar require_command = __commonJS({\n  "../../Projects/token-goat/node_modules/commander/lib/command.js"(exports) {}\n});\n'
    const clone = '// node_modules/commander/lib/command.js\nvar require_command = __commonJS({\n  "node_modules/commander/lib/command.js"(exports) {}\n});\n'
    expect(withClonePaths(junctioned)).toBe(clone)
  })

  it('does not touch text that already has the clone spelling or only mentions node_modules', () => {
    const text = '// node_modules/commander/lib/command.js\nconst note = "skip node_modules/ and ../src"\n'
    expect(withClonePaths(text)).toBe(text)
  })

  it('makes the byte count of one build the same in both layouts', () => {
    const body = 'var a = 1;\n'
    const junctioned = `// ../../deeper/than/usual/node_modules/pkg/index.js\n${body}`
    const clone = `// node_modules/pkg/index.js\n${body}`
    expect(Buffer.byteLength(withClonePaths(junctioned))).toBe(Buffer.byteLength(clone))
  })

  it('sizes a built file on disk in the clone spelling, counting multibyte text in bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-junction-size-'))
    try {
      const file = path.join(dir, 'chunk.mjs')
      fs.writeFileSync(file, '// ../../a/node_modules/pkg/index.js\nvar s = "é";\n')
      // 29 bytes of marker line, then `var s = "é";` (12 characters, one of them two bytes in UTF-8) and its newline.
      expect(cloneByteSize(file)).toBe(29 + 14)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
