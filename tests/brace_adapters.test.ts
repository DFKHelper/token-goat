/**
 * Unit tests for the Objective-C, Groovy, Perl, Solidity, Thrift and shader (GLSL, HLSL, WGSL, Metal) adapters: every declaration form each reads, exact spans and parents, nothing out of strings or comments, the imports each emits, and the content routing that decides when a `.m`, `.h`, `.pl` or `.t` changes language. Every adapter also gets a pathological 50 KB line that must scan in under 100 ms.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractGroovy } from '../src/languages/groovy.js'
import { extractObjc, isObjcHeader, isObjcSource } from '../src/languages/objc.js'
import { extractPerl, isPerlSource, isPrologSource } from '../src/languages/perl.js'
import { extractCShader, extractWgsl } from '../src/languages/shader.js'
import { extractSolidity } from '../src/languages/solidity.js'
import { extractThrift } from '../src/languages/thrift.js'
import { parseFile, parseSourceSymbolsTreeSitterOnly } from '../src/parser.js'
import { detectLanguage, detectLanguageOfFile, refineLanguageByContent, type SymbolEntry } from '../src/parser_types.js'
import { extractImports } from '../src/read_commands.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

interface Result {
  readonly symbols: readonly SymbolEntry[]
  readonly imports: ReadonlyArray<{ readonly target: string }>
}

function shape(r: Result): string[] {
  return r.symbols.map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd} ${s.parent}`.trimEnd())
}

function imports(r: Result): string[] {
  return r.imports.map((i) => i.target)
}

/** The adapter must finish one pathological input in under 100 ms. */
function expectFast(run: () => unknown, label: string): void {
  run()
  const t0 = performance.now()
  run()
  expect(performance.now() - t0, label).toBeLessThan(100)
}

const LINE_50K = 50_000

describe('Objective-C adapter', () => {
  it('reads the fixture: C functions, the class extension, the implementation and every method by selector', () => {
    const r = extractObjc(fixture('Sample.m'), 'Sample.m')
    expect(shape(r)).toEqual([
      'function AFSecKeyGetData 28-41',
      'function AFSecKeyIsEqualToKey 44-50',
      'function AFPublicKeyForCertificate 52-85',
      'function AFServerTrustIsValid 87-99',
      'function AFCertificateTrustChainForServerTrust 101-111',
      'function AFPublicKeyTrustChainForServerTrust 113-146',
      'extension AFSecurityPolicy 150-153',
      'property SSLPinningMode 151-151 AFSecurityPolicy',
      'property pinnedPublicKeys 152-152 AFSecurityPolicy',
      'implementation AFSecurityPolicy 155-342',
      'method certificatesInBundle: 157-167 AFSecurityPolicy',
      'method defaultPolicy 169-174 AFSecurityPolicy',
      'method policyWithPinningMode: 176-179 AFSecurityPolicy',
      'method policyWithPinningMode:withPinnedCertificates: 181-188 AFSecurityPolicy',
      'method init 190-199 AFSecurityPolicy',
      'method setPinnedCertificates: 201-217 AFSecurityPolicy',
      'method evaluateServerTrust:forDomain: 221-294 AFSecurityPolicy',
      'method keyPathsForValuesAffectingPinnedPublicKeys 298-300 AFSecurityPolicy',
      'method supportsSecureCoding 304-306 AFSecurityPolicy',
      'method initWithCoder: 308-321 AFSecurityPolicy',
      'method encodeWithCoder: 323-328 AFSecurityPolicy',
      'method copyWithZone: 332-340 AFSecurityPolicy',
    ])
    expect(imports(r)).toEqual(['AFSecurityPolicy.h', 'AssertMacros.h'])
  })

  it('reads the header fixture: the NS_ENUM, the interface to its @end, properties and method declarations', () => {
    const r = extractObjc(fixture('Sample_objc.h'), 'AFSecurityPolicy.h')
    expect(shape(r)).toEqual([
      'enum AFSSLPinningMode 26-30',
      'interface AFSecurityPolicy 40-135',
      'property SSLPinningMode 45-45 AFSecurityPolicy',
      'property pinnedCertificates 54-54 AFSecurityPolicy',
      'property allowInvalidCertificates 59-59 AFSecurityPolicy',
      'property validatesDomainName 64-64 AFSecurityPolicy',
      'method certificatesInBundle: 75-75 AFSecurityPolicy',
      'method defaultPolicy 86-86 AFSecurityPolicy',
      'method policyWithPinningMode: 103-103 AFSecurityPolicy',
      'method policyWithPinningMode:withPinnedCertificates: 116-116 AFSecurityPolicy',
      'method evaluateServerTrust:forDomain: 132-133 AFSecurityPolicy',
    ])
  })

  it('reads interface, category, extension, protocol and implementation blocks, and nothing from comments or strings', () => {
    // FORMAT-DERIVED: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/DefiningClasses/DefiningClasses.html , https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/CustomizingExistingClasses/CustomizingExistingClasses.html , https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/WorkingwithProtocols/WorkingwithProtocols.html
    const src = [
      '#import "XYZPerson.h"',
      '@import Foundation;',
      '// - (void)ghost; @interface Ghost : NSObject',
      '/* @implementation Ghost',
      '@end */',
      '@interface XYZPerson : NSObject',
      '@property NSString *firstName;',
      '- (void)sayHello;',
      '@end',
      '@interface XYZPerson (XYZPersonNameDisplayAdditions)',
      '- (NSString *)lastNameFirstNameString;',
      '@end',
      '@interface XYZPerson ()',
      '@property NSObject *extraProperty;',
      '@end',
      '@protocol XYZPieChartViewDataSource',
      '- (NSUInteger)numberOfSegments;',
      '- (CGFloat)sizeOfSegmentAtIndex:(NSUInteger)segmentIndex;',
      '@end',
      '@implementation XYZPerson',
      '- (void)sayHello {',
      '    NSLog(@"@interface Fake : NSObject {");',
      '}',
      '@end',
    ].join('\n')
    const r = extractObjc(src, 'XYZPerson.m')
    expect(shape(r)).toEqual([
      'interface XYZPerson 6-9',
      'property firstName 7-7 XYZPerson',
      'method sayHello 8-8 XYZPerson',
      'category XYZPerson 10-12',
      'method lastNameFirstNameString 11-11 XYZPerson',
      'extension XYZPerson 13-15',
      'property extraProperty 14-14 XYZPerson',
      'protocol XYZPieChartViewDataSource 16-19',
      'method numberOfSegments 17-17 XYZPieChartViewDataSource',
      'method sizeOfSegmentAtIndex: 18-18 XYZPieChartViewDataSource',
      'implementation XYZPerson 20-24',
      'method sayHello 21-23 XYZPerson',
    ])
    expect(imports(r)).toEqual(['XYZPerson.h', 'Foundation'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['@interface '.repeat(LINE_50K / 11), '- ('.repeat(LINE_50K / 3), '{'.repeat(LINE_50K), '('.repeat(LINE_50K), '"'.repeat(LINE_50K), 'a '.repeat(LINE_50K / 2)]) {
      expectFast(() => extractObjc(line, 'p.m'), 'objc')
    }
  })
})

describe('Groovy adapter', () => {
  it('reads the Spock fixture: each spec class and its string-named feature methods', () => {
    const r = extractGroovy(fixture('Sample.groovy'), 'Sample.groovy')
    expect(shape(r).slice(0, 6)).toEqual([
      'class EmptyStackSpec 20-45',
      'method size 23-25 EmptyStackSpec',
      'method pop 27-30 EmptyStackSpec',
      'method peek 32-35 EmptyStackSpec',
      'method push 37-44 EmptyStackSpec',
      'class StackWithOneElementSpec 47-84',
    ])
    expect(r.symbols.filter((s) => s.kind === 'class').map((s) => s.name)).toEqual(['EmptyStackSpec', 'StackWithOneElementSpec', 'StackWithThreeElementsSpec'])
    expect(imports(r)).toEqual(['spock.lang.Specification'])
  })

  it('reads each Jenkinsfile stage', () => {
    expect(shape(extractGroovy(fixture('Jenkinsfile.sample'), 'Jenkinsfile'))).toEqual(['stage local 11-19', 'stage global 20-24'])
  })

  it('reads classes, constructors, methods, interfaces and traits, and nothing from strings or comments', () => {
    // FORMAT-DERIVED: https://groovy-lang.org/objectorientation.html (class Person, increaseAge, interface Greeter, trait FlyingAbility), https://groovy-lang.org/structure.html (import static), https://groovy-lang.org/syntax.html (triple-single-quoted strings).
    const src = [
      'package demo',
      'import groovy.transform.CompileStatic',
      'import static java.lang.Boolean.FALSE',
      'class Person {',
      '    String name',
      '    Integer age',
      '    Person(String name, Integer age) {',
      '        this.name = name',
      '        this.age = age',
      '    }',
      '    def increaseAge(Integer years) {',
      '        def s = "class Fake { void ghost() {"',
      '        // void ghost() {',
      '        this.age += years',
      '    }',
      '}',
      'interface Greeter {',
      '    void greet(String name)',
      '}',
      'trait FlyingAbility {',
      '    String fly() { "I\'m flying!" }',
      '}',
      "def text = '''",
      'class Hidden {',
      "'''",
    ].join('\n')
    const r = extractGroovy(src, 'Person.groovy')
    expect(shape(r)).toEqual([
      'class Person 4-16',
      'constructor Person 7-10 Person',
      'method increaseAge 11-15 Person',
      'interface Greeter 17-19',
      'method greet 18-18 Greeter',
      'trait FlyingAbility 20-22',
      'method fly 21-21 FlyingAbility',
    ])
    expect(imports(r)).toEqual(['groovy.transform.CompileStatic', 'java.lang.Boolean.FALSE'])
  })

  it('reads Gradle task registrations, and a registration with no block ends on its own line', () => {
    // FORMAT-DERIVED: https://docs.gradle.org/current/userguide/more_about_tasks.html
    const src = [
      "tasks.register('hello') {",
      '    doLast {',
      "        println 'hello'",
      '    }',
      '}',
      'tasks.register("tasksAll", TaskReportTask) {',
      '    group = myBuildGroup',
      '}',
      "tasks.register('myCopy', Copy)",
      "tasks.named('myCopy') {",
      "    from 'resources'",
      '}',
    ].join('\n')
    expect(shape(extractGroovy(src, 'build.gradle'))).toEqual(['task hello 1-5', 'task tasksAll 6-8', 'task myCopy 9-9'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['class '.repeat(LINE_50K / 6), "stage('".repeat(LINE_50K / 7), 'def "'.repeat(LINE_50K / 5), "'''".repeat(LINE_50K / 3), '{'.repeat(LINE_50K), 'a('.repeat(LINE_50K / 2)]) {
      expectFast(() => extractGroovy(line, 'p.groovy'), 'groovy')
    }
  })
})

describe('Perl adapter', () => {
  it('reads the Demo::Paths fixture: the package to its end and each sub to its closing brace, past the POD between them', () => {
    const r = extractPerl(fixture('Sample.pm'), 'Sample.pm')
    expect(shape(r)).toEqual([
      'package Demo::Paths 22-138',
      'sub split_path 48-66 Demo::Paths',
      'sub base_name 77-81 Demo::Paths',
      'sub dir_name 91-99 Demo::Paths',
      'sub normalize_sep 107-114 Demo::Paths',
      'sub set_separator 122-132 Demo::Paths',
    ])
  })

  it('reads packages and subs, skips forward declarations, and reads nothing from comments, strings, heredocs, POD or past __END__', () => {
    // FORMAT-DERIVED: https://perldoc.perl.org/perlsub (sub max, sub NAME;), https://perldoc.perl.org/perlmod (package, sub Some_package::foo, __END__), https://perldoc.perl.org/perlop (<<~EOT), https://perldoc.perl.org/perlpod (=head1, =cut)
    const src = [
      'package Counter;',
      'use strict;',
      'use List::Util qw(sum);',
      'require Carp;',
      'sub NAME;',
      'sub tally {',
      '    my $total = 0;',
      '    foreach my $item (@_) {',
      '        $total += $item;',
      '    }',
      '    return $total;',
      '}',
      '# sub ghost { }',
      'my $s = "sub fake { }";',
      'my $doc = <<~EOT;',
      '    sub heredoc_fake {',
      '    EOT',
      '=head1 NAME',
      '',
      'sub pod_fake {',
      '',
      '=cut',
      'sub Some_package::foo { return 1 }',
      'package Counter::Inner;',
      'sub inner { 1 }',
      '__END__',
      'sub after_end { }',
    ].join('\n')
    const r = extractPerl(src, 'Counter.pm')
    expect(shape(r)).toEqual([
      'package Counter 1-23',
      'sub tally 6-12 Counter',
      'sub foo 23-23 Some_package',
      'package Counter::Inner 24-25',
      'sub inner 25-25 Counter::Inner',
    ])
    expect(imports(r)).toEqual(['List::Util', 'Carp'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['sub '.repeat(LINE_50K / 4), '<<'.repeat(LINE_50K / 2), 'q{'.repeat(LINE_50K / 2), '#'.repeat(LINE_50K), '"'.repeat(LINE_50K), 'package '.repeat(LINE_50K / 8)]) {
      expectFast(() => extractPerl(line, 'p.pm'), 'perl')
    }
  })
})

describe('Solidity adapter', () => {
  it('reads the Ownable fixture: the contract and every member under it', () => {
    const r = extractSolidity(fixture('Sample.sol'), 'Sample.sol')
    expect(shape(r)).toEqual([
      'contract Ownable 21-101',
      'error OwnableUnauthorizedAccount 27-27 Ownable',
      'error OwnableInvalidOwner 32-32 Ownable',
      'event OwnershipTransferred 34-34 Ownable',
      'constructor constructor 39-44 Ownable',
      'modifier onlyOwner 49-52 Ownable',
      'function owner 57-59 Ownable',
      'function _checkOwner 64-68 Ownable',
      'function renounceOwnership 77-79 Ownable',
      'function transferOwnership 85-90 Ownable',
      'function _transferOwnership 96-100 Ownable',
    ])
    expect(imports(r)).toEqual(['../utils/Context.sol'])
  })

  it('reads every declaration form, and nothing from comments or strings', () => {
    // FORMAT-DERIVED: https://docs.soliditylang.org/en/latest/structure-of-a-contract.html , https://docs.soliditylang.org/en/latest/layout-of-source-files.html , https://docs.soliditylang.org/en/latest/contracts.html (interface, library, receive, fallback), https://docs.soliditylang.org/en/latest/types.html (user-defined value type). Identifiers are invented: only the declaration forms come from the docs.
    const src = [
      'pragma solidity >=0.4.0 <0.9.0;',
      'import "filename";',
      'import * as symbolName from "filename";',
      'import {symbol1 as alias, symbol2} from "filename";',
      'type Fixed128x9 is uint256;',
      'error InsufficientBalance(uint requested, uint available);',
      'function doubled(uint x) pure returns (uint) {',
      '    return x * 2;',
      '}',
      'contract Escrow {',
      '    enum Stage { Opened, Held, Closed }',
      '    struct Ballot {',
      '        uint weight;',
      '    }',
      '    event BidRaised(address bidder, uint amount);',
      '    // function ghost() public {',
      '    string s = "contract Fake {";',
      '    modifier onlyVendor() {',
      '        _;',
      '    }',
      '    receive() external payable {',
      '    }',
      '    fallback() external {',
      '    }',
      '}',
      'interface Coupon {',
      '    function transfer(address recipient, uint amount) external;',
      '}',
      'library Bag {',
      '}',
    ].join('\n')
    const r = extractSolidity(src, 'Escrow.sol')
    expect(shape(r)).toEqual([
      'type Fixed128x9 5-5',
      'error InsufficientBalance 6-6',
      'function doubled 7-9',
      'contract Escrow 10-25',
      'enum Stage 11-11 Escrow',
      'struct Ballot 12-14 Escrow',
      'event BidRaised 15-15 Escrow',
      'modifier onlyVendor 18-20 Escrow',
      'function receive 21-22 Escrow',
      'function fallback 23-24 Escrow',
      'interface Coupon 26-28',
      'function transfer 27-27 Coupon',
      'library Bag 29-30',
    ])
    expect(imports(r)).toEqual(['filename', 'filename', 'filename'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['contract '.repeat(LINE_50K / 9), 'function '.repeat(LINE_50K / 9), '{'.repeat(LINE_50K), '"'.repeat(LINE_50K), '/*'.repeat(LINE_50K / 2)]) {
      expectFast(() => extractSolidity(line, 'p.sol'), 'solidity')
    }
  })
})

describe('Thrift adapter', () => {
  it('reads the tutorial fixture: typedef, consts, enum, struct, exception, and the service with its methods', () => {
    const r = extractThrift(fixture('Sample.thrift'), 'Sample.thrift')
    expect(shape(r)).toEqual([
      'typedef MyInteger 81-81',
      'const INT32CONSTANT 87-87',
      'const MAPCONSTANT 88-88',
      'enum Operation 113-118',
      'struct Work 129-134',
      'exception InvalidOperation 139-142',
      'service Calculator 148-170',
      'method ping 157-157 Calculator',
      'method add 159-159 Calculator',
      'method calculate 161-161 Calculator',
      'method zip 168-168 Calculator',
    ])
    expect(imports(r)).toEqual(['shared.thrift'])
  })

  it('reads nothing from any of the three comment forms or a string', () => {
    // FORMAT-DERIVED: https://thrift.apache.org/docs/idl (Const, Struct, comments)
    const src = ['# struct Ghost {', '// service Ghost {', '/* union Ghost {', '*/', 'const string GREETING = "struct Fake {"', 'union Choice {', '  1: i32 a', '}'].join('\n')
    expect(shape(extractThrift(src, 'x.thrift'))).toEqual(['const GREETING 5-5', 'union Choice 6-8'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['struct '.repeat(LINE_50K / 7), '#'.repeat(LINE_50K), '{'.repeat(LINE_50K), '"'.repeat(LINE_50K), 'a('.repeat(LINE_50K / 2)]) {
      expectFast(() => extractThrift(line, 'p.thrift'), 'thrift')
    }
  })
})

describe('shader adapters', () => {
  it('reads the GLSL fixture: structs and each function once, skipping the prototypes above main', () => {
    expect(shape(extractCShader(fixture('Sample.frag'), 'Sample.frag'))).toEqual([
      'struct SurfaceProps 5-9',
      'struct BeamSource 11-16',
      'struct GlowSource 18-26',
      'struct ConeSource 28-39',
      'function main 58-69',
      'function ShadeBeam 72-82',
      'function ShadeGlow 85-97',
      'function ShadeCone 100-115',
    ])
  })

  it('reads a GLSL uniform block', () => {
    // FORMAT-DERIVED: section 4.3.9 of https://registry.khronos.org/OpenGL/specs/gl/GLSLangSpec.4.60.html
    const src = ['uniform Transform {', '    mat4 ModelViewMatrix;', '    mat4 ModelViewProjectionMatrix;', '    uniform mat3 NormalMatrix;      // allowed restatement of qualifier', '    float Deformation;', '};'].join('\n')
    expect(shape(extractCShader(src, 'a.vert'))).toEqual(['block Transform 1-6'])
  })

  it('reads the HLSL fixture: cbuffer, struct, and functions with semantics', () => {
    expect(shape(extractCShader(fixture('Sample.hlsl'), 'Sample.hlsl'))).toEqual(['cbuffer SceneConstantBuffer 13-17', 'struct PSInput 19-23', 'function VSMain 25-33', 'function PSMain 35-38'])
  })

  it('reads an HLSL cbuffer with packoffset members, and the #include target', () => {
    // FORMAT-DERIVED: https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-constants , https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-appendix-pre-include
    const src = ['#include "common.hlsli"', 'cbuffer MyBuffer : register(b3)', '{', '    float4 Element1 : packoffset(c0);', '    float1 Element2 : packoffset(c1);', '    float1 Element3 : packoffset(c1.y);', '}'].join('\n')
    const r = extractCShader(src, 'a.hlsl')
    expect(shape(r)).toEqual(['cbuffer MyBuffer 2-7'])
    expect(imports(r)).toEqual(['common.hlsli'])
  })

  it('reads the Metal fixture, including an entry point whose parameters run over three lines', () => {
    expect(shape(extractCShader(fixture('Sample.metal'), 'Sample.metal'))).toEqual(['struct Vertex 6-10', 'struct Uniforms 12-15', 'function vertex_project 18-27', 'function fragment_flatcolor 29-32'])
  })

  it('reads the WGSL fixture: module-scope override, var, const, structs and the entry point', () => {
    expect(shape(extractWgsl(fixture('Sample.wgsl'), 'Sample.wgsl'))).toEqual([
      'override shadowDepthTextureSize 2-2',
      'struct Scene 4-8',
      'var scene 10-10',
      'var shadowMap 11-11',
      'var shadowSampler 12-12',
      'struct FragmentInput 14-18',
      'const albedo 20-20',
      'const ambientFactor 21-21',
      'function main 24-45',
    ])
  })

  it('reads nothing from a nested WGSL block comment', () => {
    // FORMAT-DERIVED: "Block comments can be nested", section 3.4 of https://www.w3.org/TR/WGSL/
    const src = ['/* outer /* inner */', 'fn ghost() {}', '*/', 'fn real() {', '}'].join('\n')
    expect(shape(extractWgsl(src, 'a.wgsl'))).toEqual(['function real 4-5'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['struct '.repeat(LINE_50K / 7), 'layout('.repeat(LINE_50K / 7), '{'.repeat(LINE_50K), '('.repeat(LINE_50K), 'a '.repeat(LINE_50K / 2), '#'.repeat(LINE_50K)]) {
      expectFast(() => extractCShader(line, 'p.glsl'), 'c-shader')
    }
    for (const line of ['/*'.repeat(LINE_50K / 2), 'var<'.repeat(LINE_50K / 4), '@a '.repeat(LINE_50K / 3), 'fn '.repeat(LINE_50K / 3)]) {
      expectFast(() => extractWgsl(line, 'p.wgsl'), 'wgsl')
    }
  })
})

describe('extension mapping and imports', () => {
  it('maps every new extension in any case, and leaves .m, .t and .fx to content or unmapped', () => {
    const cases: Array<[string, string]> = [
      ['a.mm', 'objc'], ['a.groovy', 'groovy'], ['A.GVY', 'groovy'], ['build.gradle', 'groovy'], ['Jenkinsfile', 'groovy'],
      ['a.pl', 'perl'], ['A.PM', 'perl'], ['a.sol', 'solidity'], ['a.thrift', 'thrift'],
      ['a.glsl', 'glsl'], ['a.vert', 'glsl'], ['a.frag', 'glsl'], ['a.comp', 'glsl'], ['a.geom', 'glsl'], ['a.tesc', 'glsl'], ['a.tese', 'glsl'],
      ['a.hlsl', 'hlsl'], ['a.hlsli', 'hlsl'], ['a.wgsl', 'wgsl'], ['a.metal', 'metal'],
      ['a.m', 'unknown'], ['a.t', 'unknown'], ['a.fx', 'unknown'], ['a.h', 'c'],
    ]
    for (const [p, lang] of cases) expect(detectLanguage(p), p).toBe(lang)
  })

  it('lists the imports of each language through extractImports, and none from a same-extension file of the other language', () => {
    expect(extractImports(fixture('Sample.m'), '.m')).toEqual(['AFSecurityPolicy.h', 'AssertMacros.h'])
    expect(extractImports(fixture('Sample.groovy'), '.groovy')).toEqual(['spock.lang.Specification'])
    expect(extractImports(fixture('Sample.sol'), '.sol')).toEqual(['../utils/Context.sol'])
    expect(extractImports(fixture('Sample.thrift'), '.thrift')).toEqual(['shared.thrift'])
    expect(extractImports('use strict;\nuse List::Util qw(max);\n', '.pm')).toEqual(['List::Util'])
    // The other language's file keeps the generic fallback it had before these rows existed; each value was read off HEAD's extractImports.
    expect(extractImports(fixture('mathematica_package.m'), '.m')).toEqual([])
    expect(extractImports(fixture('prolog_pairs.pl'), '.pl')).toEqual(['in source and binary forms, with or without'])
    expect(extractImports(fixture('sample.c'), '.h')).toEqual(['stdio.h'])
  })
})

describe('collision routing through the real entry points', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-brace-routing-'))
    tmpDirs.push(dir)
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return file
  }

  it('indexes an Objective-C .m as objc, a MATLAB .m as matlab, and leaves a Mathematica .m unknown with no symbols', async () => {
    const objc = await parseFile(tmpFile('AFSecurityPolicy.m', fixture('Sample.m')))
    expect(objc.language).toBe('objc')
    expect(objc.symbols.map((s) => s.name)).toContain('evaluateServerTrust:forDomain:')
    const matlab = fixture('matlab_isolate_axes.m')
    expect(isObjcSource(matlab)).toBe(false)
    const matlabFile = tmpFile('isolate_axes.m', matlab)
    expect(detectLanguageOfFile(matlabFile)).toBe('matlab')
    const matlabParsed = await parseFile(matlabFile)
    expect(matlabParsed.language).toBe('matlab')
    expect(matlabParsed.symbols.map((s) => s.name)).toEqual(['isolate_axes', 'allchildren', 'allancestors'])
    const file = tmpFile('Collatz.m', fixture('mathematica_package.m'))
    expect(detectLanguageOfFile(file)).toBe('unknown')
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('unknown')
    expect(parsed.symbols).toEqual([])
  })

  it('keeps a C header on the C extractor, byte-for-byte the same output, and takes an @interface header for objc', async () => {
    const c = fixture('sample.c')
    const file = tmpFile('sample.h', c)
    expect(isObjcHeader(c)).toBe(false)
    expect(detectLanguageOfFile(file)).toBe('c')
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('c')
    const expected = parseSourceSymbolsTreeSitterOnly(c, file, 'c')
    expect(expected?.length).toBeGreaterThan(0)
    expect(parsed.symbols).toEqual(expected)
    const header = await parseFile(tmpFile('AFSecurityPolicy.h', fixture('Sample_objc.h')))
    expect(header.language).toBe('objc')
    expect(header.symbols.map((s) => s.name)).toContain('AFSecurityPolicy')
  })

  it('never takes any other .h in the repo fixtures for objc', () => {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.toLowerCase().endsWith('.h') && e.name !== 'Sample_objc.h') found.push(p)
      }
    }
    walk(path.join(process.cwd(), 'tests', 'fixtures'))
    for (const f of found) expect(detectLanguageOfFile(f), f).toBe('c')
  })

  it('leaves a Prolog .pl unknown with no symbols, and indexes a Perl .pl as perl', async () => {
    const prolog = fixture('prolog_pairs.pl')
    expect(isPrologSource(prolog)).toBe(true)
    const file = tmpFile('pairs.pl', prolog)
    expect(detectLanguageOfFile(file)).toBe('unknown')
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('unknown')
    expect(parsed.symbols).toEqual([])
    const perl = fixture('Sample.pm')
    expect(isPrologSource(perl)).toBe(false)
    const plFile = tmpFile('Paths.pl', perl)
    expect(detectLanguageOfFile(plFile)).toBe('perl')
    const pl = await parseFile(plFile)
    expect(pl.language).toBe('perl')
    expect(pl.symbols.map((s) => s.name)).toEqual(extractPerl(perl, plFile).symbols.map((s) => s.name))
    expect(pl.symbols.map((s) => s.name)).toContain('split_path')
  })

  it('takes a .t for perl only on a Perl marker', () => {
    // FORMAT-DERIVED: https://perldoc.perl.org/perlsub (a named sub), https://perldoc.perl.org/functions/package
    const perlTest = 'use strict;\nuse warnings;\nsub helper { 1 }\n'
    expect(isPerlSource(perlTest)).toBe(true)
    expect(refineLanguageByContent('t/basic.t', 'unknown', perlTest)).toBe('perl')
    expect(refineLanguageByContent('t/basic.t', 'unknown', 'hello world\n')).toBe('unknown')
    expect(refineLanguageByContent('t/basic.t', 'unknown', 'package Foo;\n')).toBe('perl')
  })
})
