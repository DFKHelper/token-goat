#!/usr/bin/env node
// Keep the read gate in each project agent file identical to the canonical gate that `token-goat install` writes into CLAUDE.md.
//
// The agent files are hand-written prose with a gate section pasted in at the end, and the paste drifted: the canonical gate gained failure shapes, a Commands line and a self-test line that the copies never received. The gate is therefore rendered from src/bridges/guidance_block.ts (bundled in memory with esbuild) with the fallback clause that src/install.ts passes for Claude Code, and written between marker comments so later runs replace only that region.
//
// Usage: `node scripts/sync-agent-gates.mjs AGENTS_DIR` rewrites the gate in each `*.md` there, and `--check AGENTS_DIR` writes nothing and exits 1 when any file is stale. A missing directory exits 0, because `.claude/` is gitignored and absent on CI and fresh clones. A file with neither the markers nor a `## Read gate (mandatory)` heading is not an agent with a gate and is left alone; on the first run the heading through the end of the file is replaced.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

export const START = '<!-- token-goat:agent-gate:start -->'
export const END = '<!-- token-goat:agent-gate:end -->'
const HEADING = '## Read gate (mandatory)'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The fallback-tool clause `buildClaudeMdBlock` passes, read from src/install.ts so the two cannot disagree. */
function installClause() {
  const source = readFileSync(join(repoRoot, 'src', 'install.ts'), 'utf8')
  const at = source.indexOf('function buildClaudeMdBlock')
  const match = /fallbackToolClause:\s*"([^"]+)"/.exec(source.slice(at))
  if (at < 0 || !match) throw new Error('cannot find the fallbackToolClause in buildClaudeMdBlock (src/install.ts)')
  return match[1]
}

/** The canonical gate body, rendered by bundling guidance_block.ts in memory and importing it from a data URL. */
export async function renderGate() {
  const out = buildSync({ entryPoints: [join(repoRoot, 'src', 'bridges', 'guidance_block.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const code = out.outputFiles[0].text
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  return mod.buildGuidanceBody(installClause())
}

/** `text` with its gate region replaced by `gate`, or null when the file has neither markers nor the legacy heading. Text outside the region is untouched. */
export function applyGate(text, gate) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const region = START + nl + gate.replaceAll('\n', nl) + nl + END
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start >= 0 && end > start) return text.slice(0, start) + region + text.slice(end + END.length)
  const legacy = text.indexOf(HEADING)
  if (legacy < 0) return null
  return text.slice(0, legacy) + region + nl
}

async function main(argv) {
  const check = argv.includes('--check')
  const dirs = argv.filter((a) => !a.startsWith('--'))
  if (dirs.length !== 1) {
    console.error('usage: sync-agent-gates.mjs [--check] AGENTS_DIR')
    return 2
  }
  const dir = resolve(dirs[0])
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0
  const gate = await renderGate()
  let stale = 0
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const file = join(dir, name)
    const before = readFileSync(file, 'utf8')
    const after = applyGate(before, gate)
    if (after === null || after === before) continue
    stale++
    console.log((check ? 'STALE ' : 'SYNCED ') + file)
    if (!check) writeFileSync(file, after)
  }
  return check && stale > 0 ? 1 : 0
}

// Both sides are real paths: Node resolves symlinks in import.meta.url but leaves argv[1] as typed, so a run through a linked directory would otherwise skip main and exit 0.
const realOrResolved = (p) => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2))
