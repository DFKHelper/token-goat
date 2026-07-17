import { describe, expect, it } from 'vitest'

import {
  isLockFile,
  isManifestFile,
  isInBuildDir,
  isGeneratedFile,
  isBuildCommand,
  getMonitoringRecallHint,
} from '../src/hints/lang_patterns.js'

// ---------------------------------------------------------------------------
// isLockFile
// ---------------------------------------------------------------------------

describe('isLockFile', () => {
  it.each([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'Gemfile.lock',
    'go.sum',
    'composer.lock',
    'mix.lock',
    'pubspec.lock',
    'Package.resolved',
  ])('recognises %s as a lock file', (name) => {
    expect(isLockFile(name)).toBe(true)
  })

  it.each([
    'package.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'index.ts',
    'README.md',
  ])('does not flag %s as a lock file', (name) => {
    expect(isLockFile(name)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isLockFile('CARGO.LOCK')).toBe(true)
    expect(isLockFile('Package-Lock.JSON')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isManifestFile
// ---------------------------------------------------------------------------

describe('isManifestFile', () => {
  it.each([
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'go.work',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'composer.json',
    'Gemfile',
    'mix.exs',
    'pubspec.yaml',
    'CMakeLists.txt',
    'Makefile',
    'project.clj',
  ])('recognises %s as a manifest file', (name) => {
    expect(isManifestFile(name)).toBe(true)
  })

  it('recognises .cabal extension files', () => {
    expect(isManifestFile('myapp.cabal')).toBe(true)
    expect(isManifestFile('Token.cabal')).toBe(true)
  })

  it.each([
    'package-lock.json',
    'yarn.lock',
    'index.ts',
    'README.md',
    'foo.toml',
  ])('does not flag %s as a manifest file', (name) => {
    expect(isManifestFile(name)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isManifestFile('PACKAGE.JSON')).toBe(true)
    expect(isManifestFile('CARGO.TOML')).toBe(true)
    expect(isManifestFile('makefile')).toBe(true)
  })

  it.each([
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.app.json',
    'jsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'webpack.config.js',
    'webpack.config.ts',
    'rollup.config.js',
    'rollup.config.ts',
    'esbuild.config.js',
    'next.config.js',
    'next.config.ts',
    'nuxt.config.ts',
  ])('recognises %s as a manifest file (TS/JS)', (name) => {
    expect(isManifestFile(name)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isInBuildDir
// ---------------------------------------------------------------------------

describe('isInBuildDir', () => {
  it.each([
    '/project/dist/index.js',
    '/project/target/release/binary',
    '/project/build/output.js',
    '/project/out/bundle.js',
    '/project/__pycache__/module.cpython-312.pyc',
    '/project/.next/static/chunks/main.js',
    '/project/.nuxt/dist/server.js',
    '/project/.output/server/index.mjs',
    '/project/.gradle/caches/modules/file.jar',
    '/project/_build/default/main.exe',
    '/project/.build/debug/Product',
    '/project/pkg/linux_amd64/binary',
    '/project/obj/Debug/net6.0/app.dll',
    'packages/core/dist/index.js',
  ])('detects %s as inside a build dir', (p) => {
    expect(isInBuildDir(p)).toBe(true)
  })

  it.each([
    '/project/src/index.ts',
    '/project/tests/foo.test.ts',
    '/project/package.json',
    '/project/README.md',
    '/project/node_modules/foo/index.js',
  ])('does not flag %s as inside a build dir', (p) => {
    expect(isInBuildDir(p)).toBe(false)
  })

  it('does not treat node_modules as a build dir (handled separately)', () => {
    expect(isInBuildDir('/project/node_modules/react/index.js')).toBe(false)
  })

  it('handles Windows-style paths', () => {
    expect(isInBuildDir('C:\\project\\dist\\bundle.js')).toBe(true)
    expect(isInBuildDir('C:\\project\\target\\release\\app.exe')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isGeneratedFile
// ---------------------------------------------------------------------------

describe('isGeneratedFile', () => {
  it.each([
    '/project/src/__pycache__/module.cpython-312.pyc',
    '/project/src/module.pyc',
    '/project/src/module.pyo',
    '/project/src/module.pyd',
    '/project/target/Main.class',
    '/project/target/lib.a',
    '/project/target/libfoo.so',
    '/project/target/libfoo.dylib',
    'C:/project/build/app.dll',
  ])('detects %s as a generated file', (p) => {
    expect(isGeneratedFile(p)).toBe(true)
  })

  it('detects .map files inside build dirs as generated', () => {
    expect(isGeneratedFile('/project/dist/index.js.map')).toBe(true)
    expect(isGeneratedFile('/project/out/bundle.js.map')).toBe(true)
  })

  it('does not flag .map files outside build dirs as generated', () => {
    expect(isGeneratedFile('/project/src/tilemap.map')).toBe(false)
  })

  it('detects .d.ts files inside build dirs as generated', () => {
    expect(isGeneratedFile('/project/dist/types/index.d.ts')).toBe(true)
    expect(isGeneratedFile('/project/out/lib.d.ts')).toBe(true)
  })

  it('does not flag .d.ts files outside build dirs as generated', () => {
    expect(isGeneratedFile('/project/src/types.d.ts')).toBe(false)
    expect(isGeneratedFile('/project/node_modules/foo/index.d.ts')).toBe(false)
  })

  it.each([
    '/project/src/index.ts',
    '/project/src/main.py',
    '/project/src/main.go',
    '/project/README.md',
  ])('does not flag %s as a generated file', (p) => {
    expect(isGeneratedFile(p)).toBe(false)
  })

  it('detects .tsbuildinfo as always-generated regardless of location', () => {
    expect(isGeneratedFile('/project/tsconfig.tsbuildinfo')).toBe(true)
    expect(isGeneratedFile('/project/src/tsconfig.tsbuildinfo')).toBe(true)
    expect(isGeneratedFile('tsconfig.tsbuildinfo')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isBuildCommand
// ---------------------------------------------------------------------------

describe('isBuildCommand', () => {
  it.each([
    // Cargo
    'cargo build',
    'cargo test',
    'cargo run',
    'cargo check',
    'cargo clippy',
    'cargo build --release',
    // Go
    'go build ./...',
    'go test ./...',
    'go run main.go',
    'go vet ./...',
    // Maven
    'mvn clean install',
    'mvn package -DskipTests',
    // Gradle
    'gradle build',
    './gradlew build',
    'gradlew test',
    // pip
    'pip install -r requirements.txt',
    'pip freeze',
    // npm audit / npm outdated — regression: isNpmAuditCommand/
    // isNpmOutdatedCommand (bash_output_cache.ts) each carry a `lockfile`
    // fingerprint, but neither ever ran outside their own unit tests because
    // no npm subcommand reached the cache-storage gate in production.
    'npm audit',
    'npm outdated',
    // Poetry
    'poetry install',
    'poetry update',
    // uv
    'uv sync',
    'uv pip install .',
    // Bundler
    'bundle install',
    'bundle update',
    // Mix
    'mix deps.get',
    'mix compile',
    'mix test',
    // dotnet
    'dotnet build',
    'dotnet test',
    'dotnet restore',
    // make / cmake
    'make',
    'make all',
    'cmake --build .',
    // Rake
    'rake',
    'rake test',
  ])('recognises "%s" as a build command', (cmd) => {
    expect(isBuildCommand(cmd)).toBe(true)
  })

  it.each([
    // TypeScript compiler
    'tsc',
    'tsc --watch',
    'tsc --noEmit',
    'tsc -p tsconfig.json',
    'npx tsc',
    'npx tsc --noEmit',
    // Vite
    'vite build',
    'vite dev',
    'vite preview',
    // Next.js
    'next build',
    'next dev',
    'next start',
    // Nuxt
    'nuxt build',
    'nuxt dev',
    // Webpack
    'webpack',
    'webpack --config webpack.config.js',
    // esbuild
    'esbuild src/index.ts --bundle',
    // Rollup
    'rollup -c',
    // Turbo
    'turbo build',
    'turbo dev',
  ])('recognises "%s" as a TS/JS build command', (cmd) => {
    expect(isBuildCommand(cmd)).toBe(true)
  })

  it.each([
    'npm install',
    'npm test',
    'git commit -m "foo"',
    'ls -la',
    'echo hello',
    'cat package.json',
    'rg "pattern" src/',
    'node index.js',
    'tsc-watch',
    'npx tsc-watch',
  ])('does not flag "%s" as a build command', (cmd) => {
    expect(isBuildCommand(cmd)).toBe(false)
  })

  it('handles leading whitespace', () => {
    expect(isBuildCommand('  cargo build')).toBe(true)
    expect(isBuildCommand('  make all')).toBe(true)
  })
})

describe('getMonitoringRecallHint', () => {
  it('returns hint for node scripts/*.mjs', () => {
    expect(getMonitoringRecallHint('node scripts/run-migration.mjs')).not.toBeNull()
  })

  it('returns hint for node src/scripts/*.js', () => {
    expect(getMonitoringRecallHint('node src/scripts/seed.js')).not.toBeNull()
  })

  it('does not fire for node with non-scripts path', () => {
    expect(getMonitoringRecallHint('node src/main.ts')).toBeNull()
  })

  it('does not fire for node scripts/*.json', () => {
    expect(getMonitoringRecallHint('node scripts/config.json')).toBeNull()
  })

  it('returns hint for npx tsc', () => {
    expect(getMonitoringRecallHint('npx tsc --noEmit')).not.toBeNull()
  })

  it('does not return hint for npx tsc-watch', () => {
    expect(getMonitoringRecallHint('npx tsc-watch')).toBeNull()
  })

  it('returns hint for powershell.exe Get-CimInstance', () => {
    expect(getMonitoringRecallHint('powershell.exe -NoProfile -Command "Get-CimInstance Win32_ComputerSystem"')).not.toBeNull()
  })

  it('returns hint for powershell Get-Process', () => {
    expect(getMonitoringRecallHint('powershell -NoProfile -Command "Get-Process | Select-Object Name, CPU"')).not.toBeNull()
  })

  it('returns hint for pwsh Get-Counter', () => {
    expect(getMonitoringRecallHint('pwsh -NonInteractive -Command Get-Counter')).not.toBeNull()
  })

  it('returns hint for pwsh.exe Get-Service', () => {
    expect(getMonitoringRecallHint('pwsh.exe -Command "Get-Service"')).not.toBeNull()
  })

  it('does not fire for powershell Set-* commands', () => {
    expect(getMonitoringRecallHint('powershell -Command "Set-Item env:FOO bar"')).toBeNull()
  })

  it('does not fire for bare powershell without -Command', () => {
    expect(getMonitoringRecallHint('powershell -NoProfile')).toBeNull()
  })

  // Regression guard: the destructive-cmdlet exclusion regex in isPsMultilineSystemQuery
  // required a literal trailing "-" after the whole alternation, but the Invoke-(?:Expression|Command)
  // and Clear-(?:Content|EventLog|Item) branches already end in their own suffix (e.g. "Invoke-Expression"),
  // so the combined pattern could only match a nonexistent "Invoke-Expression-" / "Clear-Content-" string
  // and never actually excluded those cmdlets from a multiline PS query block.
  it('excludes multiline PS blocks containing Invoke-Expression', () => {
    const cmd = 'powershell -Command "Invoke-Expression $x\nGet-Process"'
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('excludes multiline PS blocks containing Clear-Content', () => {
    const cmd = 'powershell -Command "Clear-Content log.txt\nGet-Service"'
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('still excludes multiline PS blocks containing Stop-Process', () => {
    const cmd = 'powershell -Command "Stop-Process -Name foo\nGet-Process"'
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('still returns a hint for a clean multiline Get-Process query', () => {
    const cmd = 'powershell -Command "Write-Host hi\nGet-Process\nGet-Service"'
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  // Regression guard: the vite pattern's trailing `$` anchor required the command to end
  // exactly at "vite"/"vite dev"/"vite build"/"vite preview" with nothing after, so any
  // trailing flag (e.g. `vite build --watch`) fell through and got no recall hint at all,
  // unlike every sibling framework dev-server pattern (next/nuxt/remix/astro) which are bare
  // prefix matches. Fixed with a `\b` word-boundary anchor instead, which also must not
  // collide with the separate `vitest` pattern declared later in the same array (`vite` is a
  // literal string prefix of `vitest`, and MONITORING_COMMAND_PATTERNS is first-match-wins).
  it('returns a hint for vite build with trailing flags', () => {
    expect(getMonitoringRecallHint('vite build --watch')).not.toBeNull()
  })

  it('returns a hint for bare vite with trailing flags', () => {
    expect(getMonitoringRecallHint('vite --host')).not.toBeNull()
  })

  it('matches vitest commands via the vitest pattern, not the vite pattern', () => {
    expect(getMonitoringRecallHint('vitest run')).toBe('--grep "FAIL|PASS|Error|✓|✗"')
  })
})
