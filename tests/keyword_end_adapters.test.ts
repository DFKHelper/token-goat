/**
 * Unit tests for the Fortran, Pascal (with Delphi forms), MATLAB/Octave and CMake adapters: every declaration form each reads, exact spans and parents, nothing out of strings or comments, the imports each emits, and the content routing that decides when a `.m` is MATLAB and a `.pp` is Pascal. Every adapter also gets a pathological 50 KB line that must scan inside the shared pathological-scan budget.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { expectFast, LINE_50K } from './helpers/pathological_scan.js'
import { extractCmake } from '../src/languages/cmake.js'
import { extractFortran } from '../src/languages/fortran.js'
import { extractMatlab, isMatlabSource } from '../src/languages/matlab.js'
import { extractObjc, isObjcSource } from '../src/languages/objc.js'
import { extractPascal, isPascalSource } from '../src/languages/pascal.js'
import { parseFile } from '../src/parser.js'
import { detectLanguage, detectLanguageOfFile, type SymbolEntry } from '../src/parser_types.js'
import { extractImports, importsExtensionFor } from '../src/read_commands.js'

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


describe('Fortran adapter', () => {
  it('reads the free-form fixture: module, derived type, contained procedures and the program, skipping the abstract interface body', () => {
    const r = extractFortran(fixture('Sample.f90'), 'Sample.f90')
    expect(shape(r)).toEqual([
      'module my_mod 2-54',
      'type t_pair 11-16 my_mod',
      'subroutine print_matrix 27-36 my_mod',
      'function vector_norm 38-44 my_mod',
      'subroutine show_pair 46-52 my_mod',
      'program use_mod 56-62',
    ])
    expect(imports(r)).toEqual(['my_mod'])
  })

  it('reads the fixed-form fixture: a bare END closes each unit, a column-6 continuation joins the name, and a labeled DO has no END DO to miscount', () => {
    expect(shape(extractFortran(fixture('Sample.f'), 'Sample.f'))).toEqual(['program MAIN 2-5', 'subroutine FILL 7-18', 'function TWICE 19-22'])
  })

  it('reads an all-indented free-form file that carries a fixed-form extension, rather than indexing nothing', () => {
    // HAND-DERIVED: the free-form signals here are a `::` declaration and a trailing `&` continuation (https://fortran-lang.org/learn/quickstart/organising_code/). Every line is indented, so nothing sits in column 1 -- which used to be accepted as proof of fixed form. The file then read as all continuation lines, nothing was ever flushed, and it indexed to zero symbols with no error at all.
    const src = [
      '  module shapes',
      '    implicit none',
      '    integer :: counter',
      '  contains',
      '    subroutine bump(by)',
      '      integer, intent(in) :: by',
      '      counter = counter + &',
      '        by',
      '    end subroutine bump',
      '  end module shapes',
    ].join('\n')
    const names = extractFortran(src, 'shapes.f').symbols.map((s) => s.name)
    expect(names).toContain('shapes')
    expect(names).toContain('bump')
  })

  // FORMAT-DERIVED: https://fortran-lang.org/learn/quickstart/organising_code/ and the IBM XL Fortran language reference (https://www.ibm.com/docs/en/xl-fortran-aix/16.1.0?topic=attributes-abstract-interfacefortran-2003) for submodules, separate module procedures, BLOCK DATA, generic interfaces and SELECT TYPE; keywords in mixed case since Fortran ignores case.
  const FORMS = [
    'SUBMODULE (Geometry) GeometryImpl',
    'CONTAINS',
    '  MODULE PROCEDURE area_square',
    '    area_square = 1.0',
    '  END PROCEDURE area_square',
    '  Module Function perimeter(s) Result(p)',
    '    p = 4 * s',
    '  End Function perimeter',
    'END SUBMODULE GeometryImpl',
    'Block Data Init',
    '  Common /c/ k',
    'End Block Data Init',
    'Interface Operator (+)',
    '  Module Procedure add_points',
    'End Interface',
    'Interface Swap',
    '  Subroutine swap_int(a, b)',
    '    Integer :: a, b',
    '  End Subroutine',
    'End Interface Swap',
    'Type(Point) Function Make(x)',
    '  Type(Point) :: Make',
    '  Select Type (x)',
    '  Type Is (Integer)',
    '  End Select',
    'End Function Make',
    'pure real(kind=8) function Area_Circle(r) result(a)',
    '  real(8), intent(in) :: r',
    '  a = 3.14d0 * r * r',
    'endfunction',
  ].join('\n')

  it('reads submodules, separate module procedures, BLOCK DATA, named interfaces, derived-type functions and prefixed headers in any case', () => {
    expect(shape(extractFortran(FORMS, 'forms.f90'))).toEqual([
      'submodule GeometryImpl 1-9',
      'procedure area_square 3-5 GeometryImpl',
      'function perimeter 6-8 GeometryImpl',
      'block_data Init 10-12',
      'interface Swap 16-20',
      'function Make 21-26',
      'function Area_Circle 27-30',
    ])
  })

  it('never reads a symbol out of a comment, a string or a TYPE(x) declaration, and keeps END IF and END DO off the unit stack', () => {
    const src = [
      '! subroutine commented(x)',
      'subroutine real_one(x)',
      "  character(len=*), parameter :: s = 'function in_string(y)'",
      '  type(t_pair) :: p',
      '  if (x > 0) then',
      '    do i = 1, 3',
      '      print *, "end subroutine"',
      '    end do',
      '  end if',
      'end subroutine real_one',
    ].join('\n')
    expect(shape(extractFortran(src, 'c.f90'))).toEqual(['subroutine real_one 2-10'])
  })

  it('reads fixed form in tab format and ignores everything past column 72, and treats a .f with code in column 1 as free form', () => {
    const tab = ['\tSUBROUTINE TABBED', '\t1(A)', '\tEND'].join('\n')
    expect(shape(extractFortran(tab, 'tab.f'))).toEqual(['subroutine TABBED 1-3'])
    const seq = [`${'      SUBROUTINE SEQ'.padEnd(72)}X0000010`, '      END'].join('\n')
    expect(shape(extractFortran(seq, 'seq.for'))).toEqual(['subroutine SEQ 1-2'])
    expect(shape(extractFortran('subroutine free(x)\nend subroutine\n', 'free.f'))).toEqual(['subroutine free 1-2'])
  })

  it('lists USE modules, INCLUDE files and #include lines', () => {
    const src = ['#include "defs.h"', 'module m', '  use, intrinsic :: iso_c_binding', '  use shared_mod, only: x', "  include 'mpif.h'", 'end module m'].join('\n')
    expect(imports(extractFortran(src, 'i.F90'))).toEqual(['defs.h', 'iso_c_binding', 'shared_mod', 'mpif.h'])
    expect(extractImports(fixture('Sample.f90'), '.f90')).toEqual(['my_mod'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['subroutine '.repeat(LINE_50K / 11), '&'.repeat(LINE_50K), "'".repeat(LINE_50K), '('.repeat(LINE_50K), 'end '.repeat(LINE_50K / 4), 'type, '.repeat(LINE_50K / 6)]) {
      expectFast(() => extractFortran(line, 'p.f90'), 'fortran free form')
      expectFast(() => extractFortran(`      ${line}`, 'p.f'), 'fortran fixed form')
    }
    expectFast(() => extractFortran('x = 1 + &\n'.repeat(LINE_50K / 10), 'p.f90'), 'fortran long continuation')
  })
})

describe('Pascal adapter', () => {
  it('reads the unit fixture: classes, records and enums, implementations under their class, and nested routines', () => {
    const r = extractPascal(fixture('Sample.pas'), 'Sample.pas')
    expect(shape(r)).toEqual([
      'unit Shapes 2-79',
      'enum TColor 9-9',
      'class TClassA 11-21',
      'property Name 20-20 TClassA',
      'class TClassB 22-24',
      'method Extra 23-23 TClassB',
      'class EShapeError 25-25',
      'record TPoint 26-28',
      'constructor Create 37-41 TClassA',
      'destructor Destroy 43-47 TClassA',
      'method DoSomething 49-61 TClassA',
      'method Describe 63-72 TClassA',
      'function Pad 65-68 Describe',
      'procedure DoSomething 74-77',
    ])
    expect(imports(r)).toEqual(['SysUtils', 'Classes'])
  })

  it('reads a package with its requires and contains lists (the CAPTURE .dpk)', () => {
    const r = extractPascal(fixture('Sample.dpk'), 'BoldIB.dpk')
    expect(shape(r)).toEqual(['package BoldIB 3-23'])
    expect(imports(r)).toEqual(['vcl', 'vcldb', 'ibxpress', 'DesignIDE', 'Bold', 'BoldDatabaseAdapterIB', 'BoldIBDatabaseAction', 'BoldIBInterfaces', 'BoldPersistenceHandleIB', 'BoldPersistenceHandleIBReg'])
  })

  // FORMAT-DERIVED: https://www.freepascal.org/docs-html/ref/refse35.html (class declarations), https://www.freepascal.org/docs-html/ref/refse112.html (unit layout); keywords in upper case since Pascal ignores case.
  const MIXED = [
    'UNIT MixedCase;',
    'INTERFACE',
    'TYPE',
    '  IShape = INTERFACE(IInterface)',
    "    ['{8F3B1A2C-0000-4000-8000-000000000001}']",
    '    FUNCTION Area: Double;',
    '  END;',
    '  TList<T> = CLASS',
    '  STRICT PRIVATE',
    '    FItems: ARRAY OF T;',
    '  PUBLIC',
    '    TYPE',
    '      TEnumerator = CLASS',
    '        FUNCTION MoveNext: Boolean;',
    '      END;',
    '    PROCEDURE Add(CONST Item: T);',
    '    PROPERTY Items[Index: Integer]: T READ Get; DEFAULT;',
    '  END;',
    '  TStrHelper = RECORD HELPER FOR string',
    '    FUNCTION Upper: string;',
    '  END;',
    'IMPLEMENTATION',
    'PROCEDURE TList<T>.Add(CONST Item: T);',
    'BEGIN',
    'END;',
    'END.',
  ].join('\n')

  it('reads interfaces, generic classes with nested types, helpers and default properties in upper case', () => {
    expect(shape(extractPascal(MIXED, 'MixedCase.pas'))).toEqual([
      'unit MixedCase 1-26',
      'interface IShape 4-7',
      'method Area 6-6 IShape',
      'class TList 8-18',
      'class TEnumerator 13-15 TList',
      'method MoveNext 14-14 TEnumerator',
      'property Items 17-17 TList',
      'record TStrHelper 19-21',
      'method Upper 20-20 TStrHelper',
      'method Add 23-25 TList',
    ])
  })

  it('reads a program with nested routines and an asm block, and skips forward, external and procedural-type declarations', () => {
    const src = [
      'program Hello;',
      'type TProc = procedure(X: Integer) of object;',
      'var P: procedure;',
      'procedure Ext; external \'lib.dll\';',
      'procedure Fwd; forward;',
      'procedure Outer;',
      '  procedure Inner;',
      '  begin',
      '    asm',
      '      nop',
      '    end;',
      '  end;',
      'begin',
      '  Inner;',
      'end;',
      'procedure Fwd;',
      'begin',
      "  WriteLn('procedure Fake;'); { procedure Hidden; }",
      'end;',
      'begin',
      '  Outer;',
      'end.',
    ].join('\n')
    expect(shape(extractPascal(src, 'Hello.dpr'))).toEqual(['program Hello 1-22', 'procedure Outer 6-15', 'procedure Inner 7-12 Outer', 'procedure Fwd 16-19'])
  })

  // FORMAT-DERIVED: https://jean-lopes.github.io/dfm-to-json/ (the DFM grammar: object, inherited and inline components, item collections closed by end>).
  it('reads a text-form .dfm into nested components and skips a binary one', () => {
    const dfm = [
      'object Form1: TForm1',
      '  Left = 0',
      "  Caption = 'object Fake: TFake'",
      '  object Panel1: TPanel',
      '    Items = <',
      '      item',
      "        Caption = 'end'",
      '      end>',
      '    inherited Button1: TButton',
      '    end',
      '  end',
      'end',
    ].join('\n')
    expect(shape(extractPascal(dfm, 'Form1.dfm'))).toEqual(['component Form1 1-12', 'component Panel1 4-11 Form1', 'component Button1 9-10 Panel1'])
    // FORMAT-DERIVED: https://is4code.blogspot.com/2022/03/delphi-form-data-tpf0-binary-format.html (binary forms open with the TPF0 signature).
    expect(extractPascal(`TPF0${String.fromCharCode(7)}TForm1${String.fromCharCode(5)}Form1`, 'Bin.dfm').symbols).toEqual([])
    expect(extractPascal(`${String.fromCharCode(0xfffd)}\n object Form1: TForm1\nend`, 'Res.dfm').symbols).toEqual([])
  })

  it('routes a .pp to Pascal only on a unit, program or library header, so a Puppet manifest stays unknown', () => {
    expect(isPascalSource('{$mode objfpc}\n(* header *)\nunit Foo;\ninterface\nend.')).toBe(true)
    expect(isPascalSource('// c\nprogram Bar(input, output);\nbegin end.')).toBe(true)
    // FORMAT-DERIVED: https://www.puppet.com/docs/puppet/7/lang_classes.html (a class definition in a .pp manifest).
    expect(isPascalSource("# Manages Apache\nclass apache (String $version = 'latest') {\n  package { 'httpd': ensure => $version }\n}\n")).toBe(false)
    expect(isPascalSource('node default {\n  include apache\n}\n')).toBe(false)
  })

  it('lists uses clauses through extractImports for .pas and a Pascal .pp, and nothing for a Puppet .pp', () => {
    expect(extractImports(fixture('Sample.pas'), '.pas')).toEqual(['SysUtils', 'Classes'])
    expect(extractImports('unit Foo;\ninterface\nuses Bar in \'bar.pp\', Baz;\nimplementation\nend.\n', '.pp')).toEqual(['Bar', 'Baz'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['{'.repeat(LINE_50K), '(*'.repeat(LINE_50K / 2), "'".repeat(LINE_50K), 'procedure a;'.repeat(LINE_50K / 12), 'begin '.repeat(LINE_50K / 6), 'type a = class '.repeat(LINE_50K / 15), 'record '.repeat(LINE_50K / 7), 'type a<'.repeat(LINE_50K / 7), '#'.repeat(LINE_50K)]) {
      expectFast(() => extractPascal(line, 'p.pas'), 'pascal')
      expectFast(() => extractPascal(line, 'p.dfm'), 'dfm')
    }
  })
})

describe('MATLAB adapter', () => {
  it('reads the classdef fixture: properties, events and methods under the class, with no end-as-index or comment-block confusion', () => {
    const r = extractMatlab(fixture('Sample_classdef.m'), 'Motor.m')
    expect(shape(r)).toEqual([
      'class Motor 2-33',
      'property SpeedRange 4-4 Motor',
      'property Speed 7-7 Motor',
      'event SpeedChanged 10-10 Motor',
      'method Motor 13-15 Motor',
      'method startMotor 16-23 Motor',
      'method stopMotor 28-31 Motor',
    ])
  })

  it('reads the CAPTURE function file: three functions, each to its own end', () => {
    expect(shape(extractMatlab(fixture('matlab_isolate_axes.m'), 'isolate_axes.m'))).toEqual(['function isolate_axes 30-185', 'function allchildren 187-193', 'function allancestors 195-204'])
  })

  // FORMAT-DERIVED: https://www.mathworks.com/help/matlab/ref/function.html (end is optional unless a file has nested functions; x(end) indexes), https://www.mathworks.com/help/matlab/ref/classdef.html (enumeration blocks).
  it('runs each function of an endless-function file to the next function, and an end index never closes a block', () => {
    const src = ['function y = outer(x)', 'if x > 0', '  y = x(end);', 'end', 'y = helper(y);', '', 'function z = helper(w)', "z = {w{end}, 'end'};"].join('\n')
    expect(shape(extractMatlab(src, 'outer.m'))).toEqual(['function outer 1-5', 'function helper 7-8'])
  })

  it('nests a nested function under its parent, and reads enumeration members and an arguments block', () => {
    const nested = ['function parent', '  x = 5;', '  nestedfx', '  function nestedfx', '    disp(x(end))', '  end', 'end'].join('\n')
    expect(shape(extractMatlab(nested, 'parent.m'))).toEqual(['function parent 1-7', 'function nestedfx 4-6 parent'])
    const enumeration = ['classdef WeekDays', '  enumeration', '    Monday, Tuesday', '    Friday', '  end', 'end'].join('\n')
    expect(shape(extractMatlab(enumeration, 'WeekDays.m'))).toEqual(['class WeekDays 1-6', 'enum_member Monday 3-3 WeekDays', 'enum_member Tuesday 3-3 WeekDays', 'enum_member Friday 4-4 WeekDays'])
    const args = ['function r = f(x)', '  arguments', '    x (1,1) double', '  end', '  r = x;', 'end'].join('\n')
    expect(shape(extractMatlab(args, 'f.m'))).toEqual(['function f 1-6'])
  })

  // FORMAT-DERIVED: https://docs.octave.org/latest/Single-Line-Comments.html, https://docs.octave.org/latest/Block-Comments.html, https://docs.octave.org/latest/Defining-Functions.html (endfunction).
  it('reads Octave: # and #{ #} comments, endfunction, do-until, and a transpose next to a string', () => {
    const src = ['1;', '# function fake1(x)', '#{', 'function fake2', '#}', 'function r = count_up(n)', "  r = n'; s = 'function fake3';", '  do', '    r++;', '  until (r >= n)', 'endfunction'].join('\n')
    expect(shape(extractMatlab(src, 'count_up.m'))).toEqual(['function count_up 6-11'])
  })

  it('lists import statements', () => {
    expect(imports(extractMatlab('function f\nimport matlab.io.*\nimport pkg.Thing\nend\n', 'f.m'))).toEqual(['matlab.io.*', 'pkg.Thing'])
    expect(extractImports('function f\nimport pkg.Thing\nend\n', '.m')).toEqual(['pkg.Thing'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['function '.repeat(LINE_50K / 9), '['.repeat(LINE_50K), "'".repeat(LINE_50K), '.'.repeat(LINE_50K), 'if '.repeat(LINE_50K / 3), 'end '.repeat(LINE_50K / 4), 'a'.repeat(LINE_50K), 'x(end)'.repeat(LINE_50K / 6)]) {
      expectFast(() => extractMatlab(line, 'p.m'), 'matlab')
    }
    expectFast(() => isMatlabSource('function '.repeat(LINE_50K / 9)), 'matlab sniff')
  })
})

describe('CMake adapter', () => {
  it('reads the fixture: project, function, macro and the literal targets, and nothing from comments, strings or bracket arguments', () => {
    const r = extractCmake(fixture('Sample.cmake'), 'CMakeLists.txt')
    expect(shape(r)).toEqual([
      'project Tutorial 3-3',
      'function add_tutorial_test 14-17',
      'macro Print_Args 19-21',
      'target MathFunctions 23-23',
      'target Tutorial 24-26',
      'target docs 27-30',
    ])
    expect(imports(r)).toEqual(['CTest', 'Threads', 'MathFunctions'])
  })

  // FORMAT-DERIVED: https://cmake.org/cmake/help/latest/manual/cmake-language.7.html (command names are case-insensitive), https://cmake.org/cmake/help/latest/command/function.html (endfunction may repeat the name).
  it('nests functions in any case, closes each at its own end command, and reads a quoted target name', () => {
    const src = ['Function(Outer)', '  function(inner)', '  endfunction(inner)', 'EndFunction(Outer)', 'add_executable("quoted name" main.c)', 'add_custom_target(${T})', 'set(X "add_library(fake)")'].join('\n')
    expect(shape(extractCmake(src, 'a.cmake'))).toEqual(['function Outer 1-4', 'function inner 2-3 Outer', 'target quoted name 5-5'])
  })

  it('reads CMakeLists.txt imports through extractImports with the .cmake adapter', () => {
    expect(importsExtensionFor('CMakeLists.txt')).toBe('.cmake')
    expect(importsExtensionFor('notes.txt')).toBe('.txt')
    expect(extractImports(fixture('Sample.cmake'), importsExtensionFor('proj/CMakeLists.txt'))).toEqual(['CTest', 'Threads', 'MathFunctions'])
  })

  it('scans a pathological 50 KB line fast', () => {
    for (const line of ['#[['.repeat(LINE_50K / 3), '#[='.repeat(LINE_50K / 3), 'function('.repeat(LINE_50K / 9), '"'.repeat(LINE_50K), '('.repeat(LINE_50K), '[=['.repeat(LINE_50K / 3), 'a('.repeat(LINE_50K / 2), 'a '.repeat(LINE_50K / 2), '\\'.repeat(LINE_50K)]) {
      expectFast(() => extractCmake(line, 'p.cmake'), 'cmake')
    }
  })
})

describe('language detection and collision routing through the real entry points', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-keyword-routing-'))
    tmpDirs.push(dir)
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return file
  }

  it('maps the Fortran, Pascal and CMake extensions and leaves .fpp, .inc, .pp and other .txt files unknown by path', () => {
    const cases: Array<[string, string]> = [
      ['a.f', 'fortran'], ['a.for', 'fortran'], ['a.f77', 'fortran'], ['a.F90', 'fortran'], ['a.f95', 'fortran'], ['a.f03', 'fortran'], ['a.f08', 'fortran'],
      ['a.pas', 'pascal'], ['a.dpr', 'pascal'], ['a.dpk', 'pascal'], ['a.lpr', 'pascal'], ['a.dfm', 'pascal'],
      ['a.cmake', 'cmake'], ['CMakeLists.txt', 'cmake'], ['sub/cmakelists.txt', 'cmake'],
      ['a.fpp', 'unknown'], ['a.inc', 'unknown'], ['a.pp', 'unknown'], ['a.m', 'unknown'], ['notes.txt', 'unknown'],
    ]
    for (const [p, lang] of cases) expect(detectLanguage(p), p).toBe(lang)
  })

  it('indexes an Objective-C .m exactly as before, a MATLAB .m as matlab, and leaves a Mathematica .m unknown with no symbols', async () => {
    const objcSource = fixture('Sample.m')
    const objcFile = tmpFile('AFSecurityPolicy.m', objcSource)
    const objc = await parseFile(objcFile)
    expect(objc.language).toBe('objc')
    expect(objc.symbols).toEqual(extractObjc(objcSource, objcFile).symbols)

    const matlabFile = tmpFile('isolate_axes.m', fixture('matlab_isolate_axes.m'))
    expect(detectLanguageOfFile(matlabFile)).toBe('matlab')
    const matlab = await parseFile(matlabFile)
    expect(matlab.language).toBe('matlab')
    expect(matlab.symbols.map((s) => s.name)).toEqual(['isolate_axes', 'allchildren', 'allancestors'])

    const mathematica = fixture('mathematica_package.m')
    expect(isObjcSource(mathematica)).toBe(false)
    expect(isMatlabSource(mathematica)).toBe(false)
    const mathFile = tmpFile('Collatz.m', mathematica)
    expect(detectLanguageOfFile(mathFile)).toBe('unknown')
    const parsed = await parseFile(mathFile)
    expect(parsed.language).toBe('unknown')
    expect(parsed.symbols).toEqual([])
    expect(extractImports(mathematica, '.m')).toEqual([])
  })

  it('needs an import target before an #import line makes a .m Objective-C, so an Octave comment stays MATLAB', () => {
    expect(isObjcSource('#import <Foundation/Foundation.h>\n')).toBe(true)
    expect(isObjcSource('#import "AFSecurityPolicy.h"\n')).toBe(true)
    const octave = '# import the data before plotting\nfunction plot_it(x)\n  plot(x)\nend\n'
    expect(isObjcSource(octave)).toBe(false)
    expect(isMatlabSource(octave)).toBe(true)
  })

  it('keeps a MATLAB script with no function or classdef, and a Mercury module, unknown', () => {
    expect(isMatlabSource('% plot a sine wave\nx = 0:0.1:2*pi;\nplot(x, sin(x))\n')).toBe(false)
    // FORMAT-DERIVED: https://mercurylang.org/information/doc-release/mercury_ref/An-example-module.html (a Mercury .m source opens with `:- module name.` and `%` comments).
    expect(isMatlabSource('% A hello world program.\n:- module hello.\n:- interface.\n:- import_module io.\n:- pred main(io::di, io::uo) is det.\n')).toBe(false)
  })

  // FORMAT-DERIVED: https://www.mathworks.com/help/matlab/ref/classdef.html (a class of only an enumeration block has no function line at all).
  it('indexes a classdef .m with no function line as matlab', async () => {
    const file = tmpFile('WeekDays.m', ['classdef WeekDays', '  enumeration', '    Monday, Tuesday', '    Friday', '  end', 'end', ''].join('\n'))
    expect(detectLanguageOfFile(file)).toBe('matlab')
    expect((await parseFile(file)).symbols.map((s) => s.name)).toEqual(['WeekDays', 'Monday', 'Tuesday', 'Friday'])
  })

  it('indexes a Pascal .pp as pascal and leaves a Puppet .pp unknown with no symbols', async () => {
    const pas = await parseFile(tmpFile('shapes.pp', fixture('Sample.pas')))
    expect(pas.language).toBe('pascal')
    expect(pas.symbols.map((s) => s.name)).toContain('TClassA')
    const puppetFile = tmpFile('init.pp', "class apache (String $version = 'latest') {\n  package { 'httpd': ensure => $version }\n}\n")
    expect(detectLanguageOfFile(puppetFile)).toBe('unknown')
    const puppet = await parseFile(puppetFile)
    expect(puppet.language).toBe('unknown')
    expect(puppet.symbols).toEqual([])
  })
})
