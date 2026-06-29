// Tests for the build-tool filter family (Batch E): make/cmake/gradle/maven/ant/bazel/meson/msbuild/dotnet/sbt/javac/cargo/go/nx/lerna/turbo/webpack

import { describe, expect, it } from 'vitest'
import {
  MakeFilter,
  CmakeFilter,
  GradleFilter,
  MavenFilter,
  AntFilter,
  BazelFilter,
  MesonFilter,
  MSBuildFilter,
  DotnetFilter,
  SbtFilter,
  JavacFilter,
  CargoFilter,
  GoFilter,
  NxFilter,
  LernaFilter,
  TurboFilter,
  WebpackFilter,
  BUILD_FILTERS,
} from '../src/tool_filters/build.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: { apply: (...args: unknown[]) => { text: string } },
  stdout: string,
  stderr: string,
  exitCode: number,
  argv: string[],
): string {
  return filter.apply(stdout, stderr, exitCode, argv).text
}

// ---------------------------------------------------------------------------
// Dispatch ordering
// ---------------------------------------------------------------------------

describe('BUILD_FILTERS dispatch ordering', () => {
  it('goTestFilter (Batch A) still wins for go test', () => {
    // GoFilter excludes 'test' subcommand; goTestFilter must win
    const f = selectFilter(['go', 'test', './...'])
    expect(f?.name).toBe('go-test')
  })

  it('GoFilter matches go build', () => {
    const f = selectFilter(['go', 'build', './...'])
    expect(f?.name).toBe('go')
  })

  it('CargoFilter matches cargo build', () => {
    const f = selectFilter(['cargo', 'build'])
    expect(f?.name).toBe('cargo')
  })

  it('CargoFilter matches cargo test', () => {
    const f = selectFilter(['cargo', 'test'])
    expect(f?.name).toBe('cargo')
  })
})

// ---------------------------------------------------------------------------
// MakeFilter
// ---------------------------------------------------------------------------

describe('MakeFilter', () => {
  const f = new MakeFilter()

  it('matches make', () => expect(f.matches(['make'])).toBe(true))
  it('matches gmake', () => expect(f.matches(['gmake', 'all'])).toBe(true))
  it('matches ninja', () => expect(f.matches(['ninja'])).toBe(true))
  it('matches configure script', () => expect(f.matches(['./configure'])).toBe(true))
  it('does not match gcc', () => expect(f.matches(['gcc', 'foo.c'])).toBe(false))

  it('drops make recursion markers', () => {
    const out = "make[1]: Entering directory '/build/foo'\ncc -c foo.c\nmake[1]: Leaving directory '/build/foo'\n"
    const result = apply(f, out, '', 0, ['make'])
    // Raw directory lines should be gone; only the note about them may remain
    expect(result).not.toContain("make[1]: Entering directory '/build/foo'")
    expect(result).not.toContain("make[1]: Leaving directory '/build/foo'")
  })

  it('keeps error lines', () => {
    const out = "make[1]: Entering directory '/tmp'\nfoo.c:5:3: error: use of undeclared identifier 'x'\nmake[1]: Leaving directory '/tmp'\n"
    const result = apply(f, out, '', 1, ['make'])
    expect(result).toContain("error: use of undeclared identifier")
  })

  it('drops [N%] building progress lines', () => {
    const out = Array.from({ length: 30 }, (_, i) => `[${i + 1}%] Building CXX object CMakeFiles/foo.cpp.o`).join('\n') + '\n'
    const result = apply(f, out, '', 0, ['make'])
    expect(result).not.toContain('[1%] Building')
  })

  it('dispatches go build from make binary list', () => {
    const out = 'go: downloading github.com/stretchr/testify v1.8.0\n# main.go\nmain.go:5:3: undefined: foo\n'
    const result = apply(f, out, '', 1, ['go', 'build', './...'])
    // The raw download line is gone; only the note may reference "go: downloading"
    expect(result).not.toContain('go: downloading github.com')
    expect(result).toContain('undefined: foo')
  })

  it('drops configure checking probe lines', () => {
    const out = 'checking for gcc... yes\nchecking whether gcc accepts -g... yes\nconfigure: creating ./config.status\n'
    const result = apply(f, out, '', 0, ['./configure'])
    expect(result).not.toContain('checking for gcc')
    expect(result).not.toContain('checking whether')
  })
})

// ---------------------------------------------------------------------------
// CmakeFilter
// ---------------------------------------------------------------------------

describe('CmakeFilter', () => {
  const f = new CmakeFilter()

  it('matches cmake', () => expect(f.matches(['cmake', '..'])).toBe(true))
  it('matches ctest', () => expect(f.matches(['ctest'])).toBe(true))
  it('does not match make', () => expect(f.matches(['make'])).toBe(false))

  it('collapses [N%] Building lines', () => {
    const out = Array.from({ length: 20 }, (_, i) => `[${i + 1}%] Building CXX foo_${i}.cpp.o`).join('\n') + '\n'
    const result = apply(f, out, '', 0, ['cmake', '--build', '.'])
    expect(result).not.toContain('[1%] Building')
    expect(result).toContain('collapsed 20')
  })

  it('keeps Linking lines', () => {
    const out = '[50%] Building CXX foo.cpp.o\n[100%] Linking CXX executable myapp\n'
    const result = apply(f, out, '', 0, ['cmake', '--build', '.'])
    expect(result).toContain('[100%] Linking')
    // The [50%] Building line is suppressed; only its note referencing it may remain
    expect(result).not.toContain('[50%] Building CXX foo.cpp.o\n')
  })

  it('collapses -- Found package lines', () => {
    const out = Array.from({ length: 10 }, (_, i) => `-- Found LibFoo${i}: /usr/lib`).join('\n') + '\n-- Configuring done\n'
    const result = apply(f, out, '', 0, ['cmake', '..'])
    expect(result).not.toContain('Found LibFoo0')
    expect(result).toContain('collapsed 10')
    expect(result).toContain('Configuring done')
  })

  it('routes ctest to ctest compressor', () => {
    const out = '    1/10 Test #1: foo ... Passed  0.05 sec\n    2/10 Test #2: bar ... ***Failed  0.1 sec\n50% tests passed, 1 tests failed out of 2\n'
    const result = apply(f, out, '', 1, ['ctest'])
    expect(result).not.toContain('Test #1: foo')
    expect(result).toContain('***Failed')
    expect(result).toContain('50% tests passed')
  })
})

// ---------------------------------------------------------------------------
// GradleFilter
// ---------------------------------------------------------------------------

describe('GradleFilter', () => {
  const f = new GradleFilter()

  it('matches gradle build', () => expect(f.matches(['gradle', 'build'])).toBe(true))
  it('matches ./gradlew build', () => expect(f.matches(['./gradlew', 'build'])).toBe(true))
  it('matches camelCase subcommand bootJar', () => expect(f.matches(['./gradlew', 'bootJar'])).toBe(true))
  it('does not match unrelated subcommand', () => expect(f.matches(['gradle', 'unknownTask'])).toBe(false))

  it('keeps BUILD SUCCESSFUL', () => {
    const out = '> Task :compileJava\n> Task :classes\nBUILD SUCCESSFUL in 2s\n'
    const result = apply(f, out, '', 0, ['gradle', 'build'])
    expect(result).toContain('BUILD SUCCESSFUL')
    expect(result).not.toContain('> Task :compileJava\n')
  })

  it('keeps BUILD FAILED and error lines', () => {
    const out = '> Task :test FAILED\nerror: unmapped property\nBUILD FAILED in 3s\n'
    const result = apply(f, out, '', 1, ['gradle', 'test'])
    expect(result).toContain('BUILD FAILED')
    expect(result).toContain('error: unmapped property')
    expect(result).toContain('> Task :test FAILED')
  })

  it('drops task progress without FAILED', () => {
    const out = '> Task :compileJava\n> Task :test FAILED\nBUILD FAILED\n'
    const result = apply(f, out, '', 1, ['gradle', 'build'])
    expect(result).not.toContain('> Task :compileJava\n')
  })

  it('drops download lines', () => {
    const out = 'Downloading https://services.gradle.org/distributions/gradle.zip\nBUILD SUCCESSFUL in 5s\n'
    const result = apply(f, out, '', 0, ['gradle', 'build'])
    expect(result).not.toContain('Downloading https://')
  })
})

// ---------------------------------------------------------------------------
// MavenFilter
// ---------------------------------------------------------------------------

describe('MavenFilter', () => {
  const f = new MavenFilter()

  it('matches mvn', () => expect(f.matches(['mvn', 'test'])).toBe(true))
  it('matches mvnw', () => expect(f.matches(['./mvnw', 'package'])).toBe(true))
  it('does not match gradle', () => expect(f.matches(['gradle'])).toBe(false))

  it('keeps [INFO] BUILD SUCCESS', () => {
    const out = '[INFO] BUILD SUCCESS\n'
    const result = apply(f, out, '', 0, ['mvn', 'test'])
    expect(result).toContain('BUILD SUCCESS')
  })

  it('drops download lines in test run', () => {
    const out = '[INFO] Downloading: https://repo1.maven.org/foo.jar\n[INFO] Tests run: 5, Failures: 0\n[INFO] BUILD SUCCESS\n'
    const result = apply(f, out, '', 0, ['mvn', 'test'])
    expect(result).not.toContain('Downloading:')
    expect(result).toContain('Tests run:')
  })

  it('on failure: extracts ERROR lines', () => {
    const out = '[INFO] Compiling\n[ERROR] Failed to execute: NullPointerException\n[INFO] BUILD FAILURE\n'
    const result = apply(f, out, '', 1, ['mvn', 'package'])
    expect(result).toContain('[ERROR] Failed to execute')
  })
})

// ---------------------------------------------------------------------------
// AntFilter
// ---------------------------------------------------------------------------

describe('AntFilter', () => {
  const f = new AntFilter()

  it('matches ant', () => expect(f.matches(['ant', 'compile'])).toBe(true))
  it('does not match gradle', () => expect(f.matches(['gradle'])).toBe(false))

  it('collapses echo/mkdir/copy tasks', () => {
    const out = '    [echo] message1\n    [echo] message2\n    [mkdir] Created dir: target\n    [copy] Copying 5 files\nBUILD SUCCESSFUL\n'
    const result = apply(f, out, '', 0, ['ant'])
    expect(result).not.toContain('[echo] message1')
    expect(result).toContain('BUILD SUCCESSFUL')
    expect(result).toContain('×')
  })

  it('keeps javac error lines', () => {
    const out = '    [javac] error: cannot find symbol\nBUILD FAILED\n'
    const result = apply(f, out, '', 1, ['ant'])
    expect(result).toContain('[javac] error: cannot find symbol')
    expect(result).toContain('BUILD FAILED')
  })
})

// ---------------------------------------------------------------------------
// BazelFilter
// ---------------------------------------------------------------------------

describe('BazelFilter', () => {
  const f = new BazelFilter()

  it('matches bazel', () => expect(f.matches(['bazel', 'build', '//...'])).toBe(true))
  it('matches bazelisk', () => expect(f.matches(['bazelisk', 'test'])).toBe(true))

  it('collapses INFO: From Compiling', () => {
    const out = Array.from({ length: 15 }, (_, i) => `INFO: From Compiling src/foo_${i}.cc:`).join('\n') + '\nINFO: Build completed successfully\n'
    const result = apply(f, out, '', 0, ['bazel', 'build'])
    expect(result).not.toContain('INFO: From Compiling src/foo_0.cc')
    expect(result).toContain('collapsed 15')
    expect(result).toContain('Build completed successfully')
  })

  it('keeps FAILED test targets', () => {
    const out = '  PASSED: //foo:test (3s)\n  FAILED: //bar:test (2s)\nElapsed time: 10.5s\n'
    const result = apply(f, out, '', 1, ['bazel', 'test'])
    expect(result).toContain('FAILED: //bar:test')
    expect(result).not.toContain('PASSED: //foo')
    expect(result).toContain('collapsed 1 PASSED')
  })
})

// ---------------------------------------------------------------------------
// MesonFilter
// ---------------------------------------------------------------------------

describe('MesonFilter', () => {
  const f = new MesonFilter()

  it('matches meson', () => expect(f.matches(['meson', 'setup', 'builddir'])).toBe(true))
  it('does not match make', () => expect(f.matches(['make'])).toBe(false))

  it('keeps project metadata', () => {
    const out = 'The Meson build system\nVersion: 1.3.0\nProject name: myproject\nProject version: 2.0\nBuild targets in project: 3\n'
    const result = apply(f, out, '', 0, ['meson', 'setup', 'builddir'])
    expect(result).toContain('The Meson build system')
    expect(result).toContain('Project name: myproject')
  })

  it('collapses [N/M] Compiling progress lines', () => {
    const out = Array.from({ length: 50 }, (_, i) => `[${i + 1}/50] Compiling C++ file src/foo_${i}.cpp`).join('\n') + '\n'
    const result = apply(f, out, '', 0, ['meson', 'compile', '-C', 'builddir'])
    expect(result).not.toContain('[1/50] Compiling')
    expect(result).toContain('collapsed 50')
  })

  it('keeps [N/M] Linking lines', () => {
    const out = '[48/50] Compiling C++ foo.cpp\n[50/50] Linking target myapp\n'
    const result = apply(f, out, '', 0, ['meson', 'compile', '-C', 'builddir'])
    expect(result).toContain('[50/50] Linking')
  })

  it('drops dependency probe lines', () => {
    const out = "Dependency zlib found: YES 1.2.11\nDependency libpng found: NO\nProject name: myproject\n"
    const result = apply(f, out, '', 0, ['meson', 'setup', 'builddir'])
    expect(result).not.toContain('Dependency zlib')
    expect(result).toContain('collapsed')
  })

  it('passthrough on non-zero exit (errorPassthrough=true)', () => {
    const out = 'meson.build:5:0: ERROR: Dependency "openssl" not found\n'
    const result = apply(f, out, '', 1, ['meson', 'setup', 'builddir'])
    expect(result).toContain('ERROR: Dependency "openssl" not found')
  })
})

// ---------------------------------------------------------------------------
// MSBuildFilter
// ---------------------------------------------------------------------------

describe('MSBuildFilter', () => {
  const f = new MSBuildFilter()

  it('matches msbuild', () => expect(f.matches(['msbuild', 'solution.sln'])).toBe(true))
  it('matches msbuild.exe', () => expect(f.matches(['C:/Program Files/msbuild.exe'])).toBe(true))
  it('does not match cmake', () => expect(f.matches(['cmake'])).toBe(false))

  it('keeps error lines', () => {
    const out = 'foo.cs(10,5): error CS0103: name does not exist\nBuild succeeded.\n'
    const result = apply(f, out, '', 1, ['msbuild'])
    expect(result).toContain('error CS0103')
  })

  it('deduplicates warnings by code', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `foo.cs(${i},1): warning CS0649: field unused`)
    const out = lines.join('\n') + '\n'
    const result = apply(f, out, '', 0, ['msbuild'])
    // Only first occurrence of CS0649 is kept
    const warningMatches = result.match(/warning CS0649/g) ?? []
    expect(warningMatches.length).toBe(1)
    expect(result).toContain('collapsed 4 duplicate warning')
  })

  it('collapses Copy task lines', () => {
    const out = '  Copy\n  Copy\n  Copy\n  CopyFilesToOutputDirectory\nBuild succeeded.\n'
    const result = apply(f, out, '', 0, ['msbuild'])
    expect(result).not.toContain('  Copy\n  Copy')
    expect(result).toContain('collapsed')
  })
})

// ---------------------------------------------------------------------------
// DotnetFilter
// ---------------------------------------------------------------------------

describe('DotnetFilter', () => {
  const f = new DotnetFilter()

  it('matches dotnet', () => expect(f.matches(['dotnet', 'build'])).toBe(true))
  it('does not match dotnet-script', () => expect(f.matches(['dotnet-script'])).toBe(false))

  it('drops restore progress lines', () => {
    const out = 'Restoring packages for /src/foo.csproj\nInstalling Microsoft.Extensions.Logging 7.0.0\nRestore succeeded.\n'
    const result = apply(f, out, '', 0, ['dotnet', 'restore'])
    expect(result).not.toContain('Restoring packages')
    expect(result).not.toContain('Installing Microsoft')
  })

  it('collapses passed tests', () => {
    const out = Array.from({ length: 20 }, (_, i) => `  Passed Test_${i}`).join('\n') + '\nTest Run Successful.\n'
    const result = apply(f, out, '', 0, ['dotnet', 'test'])
    expect(result).not.toContain('  Passed Test_0')
    expect(result).toContain('Test Run Successful')
  })

  it('keeps failed test blocks', () => {
    const out = '  Failed TestFoo\n    Expected: 1\n    But was: 2\nTest Run Failed.\n'
    const result = apply(f, out, '', 1, ['dotnet', 'test'])
    expect(result).toContain('Failed TestFoo')
    expect(result).toContain('Expected: 1')
  })

  it('collapses "Build succeeded." repetitions to last', () => {
    const out = 'Build succeeded.\nBuild succeeded.\nBuild succeeded.\n'
    const result = apply(f, out, '', 0, ['dotnet', 'build'])
    const matches = result.match(/Build succeeded\./g) ?? []
    expect(matches.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SbtFilter
// ---------------------------------------------------------------------------

describe('SbtFilter', () => {
  const f = new SbtFilter()

  it('matches sbt', () => expect(f.matches(['sbt', 'compile'])).toBe(true))
  it('does not match gradle', () => expect(f.matches(['gradle'])).toBe(false))

  it('collapses [info] loading noise', () => {
    const out = Array.from({ length: 20 }, (_, i) => `[info] Loading project definition from /tmp/build${i}`).join('\n') + '\n[info] Compiling 3 Scala sources\n'
    const result = apply(f, out, '', 0, ['sbt', 'compile'])
    expect(result).not.toContain('Loading project definition')
    expect(result).toContain('[info] Compiling 3 Scala sources')
    expect(result).toContain('collapsed 20')
  })

  it('keeps [error] lines', () => {
    const out = '[error] /src/Foo.scala:5:3: not found: value x\n[success] Total time: 2 s\n'
    const result = apply(f, out, '', 1, ['sbt', 'compile'])
    expect(result).toContain('[error] /src/Foo.scala')
  })

  it('collapses verbose passing test lines', () => {
    const out = Array.from({ length: 10 }, (_, i) => `[info]   - test ${i} should work`).join('\n') + '\n[info] Tests: succeeded 10, failed 0\n'
    const result = apply(f, out, '', 0, ['sbt', 'test'])
    expect(result).not.toContain('- test 0 should work')
    expect(result).toContain('Tests: succeeded')
  })

  it('limits [warn] lines per category', () => {
    // same warning repeated 10 times
    const out = Array.from({ length: 10 }, () => '[warn] deprecation warning: use new API').join('\n') + '\n'
    const result = apply(f, out, '', 0, ['sbt', 'compile'])
    const matches = result.match(/deprecation warning/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(5)
    expect(result).toContain('collapsed')
  })
})

// ---------------------------------------------------------------------------
// JavacFilter
// ---------------------------------------------------------------------------

describe('JavacFilter', () => {
  const f = new JavacFilter()

  it('matches javac', () => expect(f.matches(['javac', 'Foo.java'])).toBe(true))
  it('does not match java', () => expect(f.matches(['java', '-jar', 'foo.jar'])).toBe(false))

  it('collapses Note: unchecked warnings', () => {
    const out = Array.from({ length: 5 }, (_, i) => `Note: Foo${i}.java uses unchecked or unsafe operations.`).join('\n') + '\n'
    const result = apply(f, out, '', 0, ['javac', 'Foo.java'])
    expect(result).not.toContain('Note: Foo0.java')
    expect(result).toContain('collapsed 5')
  })

  it('keeps error diagnostic blocks', () => {
    const out = 'Foo.java:10: error: cannot find symbol\n    bar();\n    ^\n1 error\n'
    const result = apply(f, out, '', 1, ['javac', 'Foo.java'])
    expect(result).toContain('error: cannot find symbol')
    expect(result).toContain('    bar();')
    expect(result).toContain('    ^')
    expect(result).toContain('1 error')
  })

  it('drops Note: Recompile summary', () => {
    const out = 'Note: Foo.java uses unchecked operations.\nNote: Recompile with -Xlint:unchecked for details.\n'
    const result = apply(f, out, '', 0, ['javac', 'Foo.java'])
    expect(result).not.toContain('Recompile with')
  })
})

// ---------------------------------------------------------------------------
// CargoFilter
// ---------------------------------------------------------------------------

describe('CargoFilter', () => {
  const f = new CargoFilter()

  it('matches cargo build', () => expect(f.matches(['cargo', 'build'])).toBe(true))
  it('matches cargo test', () => expect(f.matches(['cargo', 'test'])).toBe(true))
  it('matches cargo clippy', () => expect(f.matches(['cargo', 'clippy'])).toBe(true))
  it('does not match cargo wrong binary', () => expect(f.matches(['go', 'build'])).toBe(false))

  it('collapses many Compiling lines', () => {
    const stderr = Array.from({ length: 20 }, (_, i) => `   Compiling crate-${i} v0.1.0`).join('\n') + '\n    Finished dev in 5s\n'
    const result = apply(f, '', stderr, 0, ['cargo', 'build'])
    expect(result).not.toContain('Compiling crate-0')
    expect(result).toContain('[compiling 20 crates')
  })

  it('keeps short compile list verbatim', () => {
    const stderr = '   Compiling foo v0.1.0\n   Compiling bar v0.1.0\n    Finished dev in 1s\n'
    const result = apply(f, '', stderr, 0, ['cargo', 'build'])
    expect(result).toContain('Compiling foo')
    expect(result).toContain('Compiling bar')
  })

  it('keeps error diagnostics', () => {
    const stderr = 'error[E0308]: mismatched types\n  --> src/lib.rs:5:9\n'
    const result = apply(f, '', stderr, 1, ['cargo', 'build'])
    expect(result).toContain('error[E0308]')
  })

  it('drops Downloading/Downloaded progress', () => {
    const stderr = '   Downloaded serde v1.0.197\n   Downloading tokio v1.36.0\n   Compiling my-project v0.1.0\n    Finished dev in 3s\n'
    const result = apply(f, '', stderr, 0, ['cargo', 'build'])
    expect(result).not.toContain('Downloaded serde')
    expect(result).not.toContain('Downloading tokio')
    expect(result).toContain('Compiling my-project')
  })

  it('cargo test: injects [N tests passed] summary', () => {
    const stdout = 'running 5 tests\ntest foo::test1 ... ok\ntest foo::test2 ... ok\ntest foo::test3 ... ok\ntest result: ok. 3 passed; 0 failed\n'
    const result = apply(f, stdout, '', 0, ['cargo', 'test'])
    expect(result).toContain('[3 tests passed]')
    expect(result).not.toContain('test foo::test1 ... ok')
  })

  it('cargo test: keeps FAILED test lines', () => {
    const stdout = 'running 2 tests\ntest bar::test1 ... ok\ntest bar::test2 ... FAILED\ntest result: FAILED. 1 passed; 1 failed\n'
    const result = apply(f, stdout, '', 1, ['cargo', 'test'])
    expect(result).toContain('test bar::test2 ... FAILED')
    expect(result).not.toContain('test bar::test1 ... ok')
  })

  it('significant compression on large cargo build', () => {
    const stderrLines = [
      ...Array.from({ length: 30 }, (_, i) => `   Downloaded crate-${i} v1.0.0`),
      ...Array.from({ length: 30 }, (_, i) => `   Compiling crate-${i} v1.0.0`),
      '    Finished dev [unoptimized + debuginfo] target(s) in 45.0s',
    ]
    const stderr = stderrLines.join('\n')
    const result = apply(f, '', stderr, 0, ['cargo', 'build'])
    expect(result.length).toBeLessThan(stderr.length * 0.5)
  })
})

// ---------------------------------------------------------------------------
// GoFilter
// ---------------------------------------------------------------------------

describe('GoFilter', () => {
  const f = new GoFilter()

  it('matches go build', () => expect(f.matches(['go', 'build', './...'])).toBe(true))
  it('matches go get', () => expect(f.matches(['go', 'get', 'github.com/foo/bar'])).toBe(true))
  it('matches go mod', () => expect(f.matches(['go', 'mod', 'tidy'])).toBe(true))
  it('does NOT match go test', () => expect(f.matches(['go', 'test', './...'])).toBe(false))
  it('does not match cargo', () => expect(f.matches(['cargo', 'build'])).toBe(false))

  it('drops # pkg/path header lines on go build', () => {
    const stderr = '# main\nmain.go:5:3: undefined: foo\n'
    const result = apply(f, '', stderr, 1, ['go', 'build', './...'])
    expect(result).not.toContain('# main\n')
    expect(result).toContain('undefined: foo')
  })

  it('collapses go: downloading lines', () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `go: downloading github.com/foo/bar-${i} v1.0.0`).join('\n') + '\n'
    const result = apply(f, stdout, '', 0, ['go', 'get', 'github.com/foo/...'])
    expect(result).not.toContain('go: downloading github.com')
    expect(result).toContain('collapsed 20')
  })

  it('drops go: vet progress lines', () => {
    const stdout = 'go: vet ./...\n'
    const result = apply(f, stdout, '', 0, ['go', 'vet', './...'])
    expect(result).not.toContain('go: vet')
  })
})

// ---------------------------------------------------------------------------
// NxFilter
// ---------------------------------------------------------------------------

describe('NxFilter', () => {
  const f = new NxFilter()

  it('matches nx run', () => expect(f.matches(['nx', 'run', 'app:build'])).toBe(true))
  it('matches npx nx run', () => expect(f.matches(['npx', 'nx', 'run', 'app:build'])).toBe(true))
  it('matches pnpx nx', () => expect(f.matches(['pnpx', 'nx', 'build'])).toBe(true))
  it('does not match npx without nx', () => expect(f.matches(['npx', 'jest'])).toBe(false))

  it('collapses cache-hit lines', () => {
    const out = '> nx run app:build  [existing outputs match the cache, left as is]\ncache hit\nNX   Successfully ran target build\n'
    const result = apply(f, out, '', 0, ['nx', 'run', 'app:build'])
    expect(result).not.toContain('existing outputs match')
    expect(result).toContain('Successfully ran target build')
  })

  it('keeps summary lines', () => {
    const out = 'NX   Successfully ran target build for 3 projects\n'
    const result = apply(f, out, '', 0, ['nx', 'run-many', '--target=build'])
    expect(result).toContain('Successfully ran target build')
  })
})

// ---------------------------------------------------------------------------
// LernaFilter
// ---------------------------------------------------------------------------

describe('LernaFilter', () => {
  const f = new LernaFilter()

  it('matches lerna', () => expect(f.matches(['lerna', 'run', 'build'])).toBe(true))
  it('does not match npm', () => expect(f.matches(['npm'])).toBe(false))

  it('drops verbose and notice lines', () => {
    const out = 'lerna verb lifecycle @foo/bar~preinstall\nlerna notice cli v7.0.0\nlerna success done\n'
    const result = apply(f, out, '', 0, ['lerna', 'run', 'build'])
    expect(result).not.toContain('verb lifecycle')
    expect(result).not.toContain('notice cli')
    expect(result).toContain('lerna success done')
  })

  it('samples first 5 ran-npm-script lines and notes overflow', () => {
    const out = Array.from({ length: 10 }, (_, i) => `lerna info run Ran npm script 'build' in '@scope/pkg${i}'`).join('\n') + '\nlerna success done\n'
    const result = apply(f, out, '', 0, ['lerna', 'run', 'build'])
    // Should contain note about extra
    expect(result).toContain('…and 5 more')
    // And should NOT contain all 10 ran lines
    const matches = result.match(/Ran npm script/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// TurboFilter
// ---------------------------------------------------------------------------

describe('TurboFilter', () => {
  const f = new TurboFilter()

  it('matches turbo', () => expect(f.matches(['turbo', 'run', 'build'])).toBe(true))
  it('matches npx turbo', () => expect(f.matches(['npx', 'turbo', 'run', 'build'])).toBe(true))
  it('does not match npx jest', () => expect(f.matches(['npx', 'jest'])).toBe(false))

  it('collapses cache-hit tasks', () => {
    const out = '• Packages in scope: all\n• Running build\napp:build  cache hit, replaying logs e1a2b3c4\nTasks:    1 successful, 0 failed\n'
    const result = apply(f, out, '', 0, ['turbo', 'run', 'build'])
    expect(result).not.toContain('cache hit, replaying')
    expect(result).toContain('Tasks:    1 successful')
    expect(result).toContain('collapsed 1 cache-hit task')
  })

  it('keeps summary and scope lines', () => {
    const out = '• Packages in scope: app, lib\n• Running test\nTasks:    2 successful, 0 failed\nTime:    3.5s\n'
    const result = apply(f, out, '', 0, ['turbo', 'run', 'test'])
    expect(result).toContain('Packages in scope')
    expect(result).toContain('Tasks:    2 successful')
  })
})

// ---------------------------------------------------------------------------
// WebpackFilter
// ---------------------------------------------------------------------------

describe('WebpackFilter', () => {
  const f = new WebpackFilter()

  it('matches webpack', () => expect(f.matches(['webpack'])).toBe(true))
  it('matches webpack-cli', () => expect(f.matches(['webpack-cli', '--config', 'webpack.config.js'])).toBe(true))
  it('matches vite build', () => expect(f.matches(['vite', 'build'])).toBe(true))
  it('does NOT match vite serve', () => expect(f.matches(['vite', 'serve'])).toBe(false))
  it('matches npx webpack', () => expect(f.matches(['npx', 'webpack', '--mode', 'production'])).toBe(true))
  it('matches esbuild', () => expect(f.matches(['esbuild', 'src/index.ts'])).toBe(true))

  it('collapses node_modules module lines in webpack output', () => {
    const out = './node_modules/ path section\n  ./node_modules/lodash/lodash.js 531 KiB [built]\n  ./node_modules/react/index.js 100 KiB\n  + 100 modules\nHash: abc123\n'
    const result = apply(f, out, '', 0, ['webpack'])
    expect(result).not.toContain('./node_modules/lodash')
    expect(result).toContain('Hash: abc123')
  })

  it('collapses Vite progress lines', () => {
    const out = 'vite v5.0.0 building for production...\ntransforming (100) src/components/Foo.vue\nrendering chunks (50) src/App.vue\ncomputing gzip size (100)\ndist/index.html  0.45 kB\n'
    const result = apply(f, out, '', 0, ['vite', 'build'])
    expect(result).not.toContain('transforming (100)')
    expect(result).not.toContain('rendering chunks')
    expect(result).toContain('dist/index.html')
    expect(result).toContain('collapsed')
  })
})

// ---------------------------------------------------------------------------
// BUILD_FILTERS completeness
// ---------------------------------------------------------------------------

describe('BUILD_FILTERS registry', () => {
  it('has 17 entries', () => {
    expect(BUILD_FILTERS).toHaveLength(17)
  })

  it('includes all expected filter names', () => {
    const names = new Set(BUILD_FILTERS.map(f => f.name))
    const expected = [
      'cargo', 'go', 'make', 'cmake', 'gradle', 'maven', 'ant', 'bazel',
      'meson', 'msbuild', 'dotnet', 'sbt', 'javac', 'nx', 'lerna', 'turbo', 'webpack',
    ]
    for (const name of expected) {
      expect(names.has(name), `missing filter: ${name}`).toBe(true)
    }
  })

  it('selectFilter resolves make', () => {
    const f = selectFilter(['make', 'all'])
    expect(f?.name).toBe('make')
  })

  it('selectFilter resolves cmake', () => {
    const f = selectFilter(['cmake', '--build', '.'])
    expect(f?.name).toBe('cmake')
  })

  it('selectFilter resolves gradle', () => {
    const f = selectFilter(['./gradlew', 'build'])
    expect(f?.name).toBe('gradle')
  })

  it('selectFilter resolves cargo', () => {
    const f = selectFilter(['cargo', 'build'])
    expect(f?.name).toBe('cargo')
  })

  it('selectFilter resolves webpack', () => {
    const f = selectFilter(['webpack', '--mode', 'production'])
    expect(f?.name).toBe('webpack')
  })
})
