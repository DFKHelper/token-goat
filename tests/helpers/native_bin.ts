/** The native hook client the test run built: tests/setup/build-bundle.ts runs scripts/build-native.mjs once, before any test file, under the real home, and passes the binary's path (or why the build failed) to the workers through the environment. Fails rather than skips where the build failed: CI installs the pinned toolchain on every platform. */
import * as fs from 'node:fs'

export function buildNative(): string {
  const bin = process.env['TG_TEST_NATIVE_BIN']
  if (bin === undefined) throw new Error(process.env['TG_TEST_NATIVE_BUILD_ERROR'] ?? 'no native build outcome: tests/setup/build-bundle.ts (vitest globalSetup) did not run')
  if (!fs.existsSync(bin)) throw new Error(`the native hook client built for this run is gone: ${bin}`)
  return bin
}
