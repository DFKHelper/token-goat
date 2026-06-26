import { describe, expect, it } from 'vitest'

import {
  isLockFile,
  isManifestFile,
  isInBuildDir,
  isGeneratedFile,
  isBuildCommand,
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
    'npm install',
    'npm test',
    'git commit -m "foo"',
    'ls -la',
    'echo hello',
    'cat package.json',
    'rg "pattern" src/',
    'node index.js',
  ])('does not flag "%s" as a build command', (cmd) => {
    expect(isBuildCommand(cmd)).toBe(false)
  })

  it('handles leading whitespace', () => {
    expect(isBuildCommand('  cargo build')).toBe(true)
    expect(isBuildCommand('  make all')).toBe(true)
  })
})
