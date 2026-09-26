/** `npm run dev` runs src/main.ts under tsx, which evaluates each source module in real ESM order, so a module that reads a binding at load time from a module in its own import cycle throws "Cannot access ... before initialization" there. The bundle hides it: esbuild turns every top-level const into a var and orders chunk code its own way, so the same read yields the value or undefined depending on chunk order and never throws. read_spec.ts read FIND_SCAN_LIMIT from read_commands.ts at load time, and read_commands.ts imports read_spec.ts, so every dev-mode command died on startup. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tgIsolatedEnv } from './helpers/bundle.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

describe('dev entry', () => {
  it('loads the CLI from src/main.ts under tsx, the way npm run dev does', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dev-entry-'))
    try {
      const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
      // --version still loads cli.ts and everything it imports: main.ts imports cli.js only after the resident-server offer declines, and no server exists under an isolated data dir.
      const res = spawnSync(process.execPath, tsxProcessArgs(path.join('src', 'main.ts'), '--version'), {
        cwd: ROOT,
        env: tgIsolatedEnv(base, { TOKEN_GOAT_HOME: base, APPDATA: base, XDG_CONFIG_HOME: base, CLAUDE_CONFIG_DIR: base }),
        encoding: 'utf8',
        timeout: 110_000,
      })
      expect(res.stderr).not.toMatch(/before initialization/)
      expect(res.status).toBe(0)
      expect(res.stdout.trim()).toBe(version)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)
})
