/** Build an isolated legacy variant with the original ordinary fallback parser. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'vitest'

export function buildLegacyStartupOwner(root: string): string {
  const source = join(process.cwd(), 'native', 'tg-hook')
  const fixture = join(root, 'legacy-crate')
  mkdirSync(fixture)
  for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml']) {
    copyFileSync(join(source, name), join(fixture, name))
  }
  cpSync(join(source, 'src'), join(fixture, 'src'), { recursive: true })
  const main = join(fixture, 'src', 'main.rs')
  let text = readFileSync(main, 'utf8')
  const dispatch = '        #[cfg(windows)]\n        Some("--session-start-owner-v1") => startup_owner::run(&raw[1..]),\n'
  const route = '    if hook.call.as_ref().is_some_and(startup_entry::is_startup) {\n        return startup_entry::run(hook.fallback, main_start);\n    }\n'
  expect(text).toContain(dispatch)
  expect(text).toContain(route)
  text = text.replace(dispatch, '').replace(route, '')
    .replace('mod startup_entry;\n', '')
    .replace('#[cfg(windows)]\nmod startup_owner;\n', '')
    .replace('#[cfg(windows)]\nmod startup_process;\n', '')
  // Do not change parse_hook_args, run_hook's ordinary EOF path, or fallback.rs.
  expect(text).toContain('let split = args.iter().position(|a| a == "--")?;')
  writeFileSync(main, text)
  const result = spawnSync('cargo', ['build', '--locked', '--offline', '--manifest-path', join(fixture, 'Cargo.toml')], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  })
  expect(result.status, result.error?.message ?? result.stderr).toBe(0)
  return join(fixture, 'target', 'debug', 'tg-hook.exe')
}
