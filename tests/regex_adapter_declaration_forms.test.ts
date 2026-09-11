/**
 * Declaration forms the regex-based (non-tree-sitter) language adapters used to miss, driven through
 * the real `parseFile` dispatch so the extension routing is exercised along with the extractor.
 *
 * Every fixture is HAND-DERIVED from the language's own reference (cited per case), written
 * independently of the extractor. Each case pairs the new names with a must-not-drop list of names
 * the adapter already extracted, and a must-not-appear list of declaration-shaped text inside a
 * string, heredoc, or comment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFile } from '../src/parser.js'
import type { SymbolEntry } from '../src/parser_types.js'

const dir = mkdtempSync(join(tmpdir(), 'tg-decl-forms-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function symbolsOf(fileName: string, content: string): Promise<SymbolEntry[]> {
  const p = join(dir, fileName)
  writeFileSync(p, content)
  const r = await parseFile(p)
  return r.symbols
}

function find(symbols: readonly SymbolEntry[], name: string, kind: string): SymbolEntry | undefined {
  return symbols.find((s) => s.name === name && s.kind === kind)
}

describe('Elixir: defmacrop, defguard, defguardp, defdelegate, defimpl, defexception', () => {
  // HAND-DERIVED from the Elixir Kernel docs: defmacrop/2, defguard/1, defguardp/1, defdelegate/2, defimpl/3, defexception/1.
  const src = `defmodule MyApp.Worker do
  @moduledoc """
  defguard fake_guard_heredoc(x) when x
  defimpl FakeImpl, for: Heredoc do
  """
  def pub(a), do: a
  defp priv(a) do
    a
  end
  defmacro mac(x), do: x
  defmacrop macp(x), do: x
  defguard is_even(v) when rem(v, 2) == 0
  defguardp is_odd(v) when rem(v, 2) == 1
  defdelegate reverse(list), to: Enum
  # defguard fake_comment_guard(x) when x
end
defprotocol Size do
  def size(data)
end
defimpl Size, for: Map do
  def size(m), do: map_size(m)
end
defmodule Outer do
  defimpl String.Chars do
    def to_string(_), do: "x"
  end
  def after_impl, do: 1
end
defmodule MyError do
  defexception message: "x"
end
`

  it('indexes the four Kernel callable forms under their module', async () => {
    const syms = await symbolsOf('worker.ex', src)
    for (const name of ['macp', 'is_even', 'is_odd', 'reverse']) {
      expect(find(syms, name, 'function')?.parent, name).toBe('MyApp.Worker')
    }
    for (const name of ['pub', 'priv', 'mac']) {
      expect(find(syms, name, 'function')?.parent, name).toBe('MyApp.Worker')
    }
  })

  it('indexes defimpl as the module it compiles to and parents its defs to it', async () => {
    const syms = await symbolsOf('impl.ex', src)
    const impl = find(syms, 'Size.Map', 'impl')
    expect(impl?.lineStart).toBe(20)
    expect(impl?.lineEnd).toBe(22)
    expect(syms.filter((s) => s.name === 'size').map((s) => s.parent).sort()).toEqual(['Size', 'Size.Map'])
    expect(find(syms, 'String.Chars.Outer', 'impl')?.parent).toBe('')
    expect(find(syms, 'to_string', 'function')?.parent).toBe('String.Chars.Outer')
    expect(find(syms, 'after_impl', 'function')?.parent).toBe('Outer')
    expect(find(syms, '__struct__', 'var')?.parent).toBe('MyError')
  })

  it('keeps heredoc and comment text out of the index', async () => {
    const names = (await symbolsOf('fakes.ex', src)).map((s) => s.name)
    expect(names.length).toBeGreaterThanOrEqual(15)
    for (const fake of ['fake_guard_heredoc', 'FakeImpl.Heredoc', 'FakeImpl', 'fake_comment_guard']) {
      expect(names).not.toContain(fake)
    }
  })
})

describe('Zig: test declarations', () => {
  // HAND-DERIVED from the Zig Language Reference, "Zig Test", "Doctests" and "Multiline String Literals".
  const src = `const std = @import("std");
pub fn main() void {}
pub const Point = struct {
    x: i32,
    pub fn init() Point {
        return .{ .x = 0 };
    }
    test "member test" {}
};
const ml =
    \\\\test "fake_ml_test" {}
;
// test "fake_comment_test" {}
test "adds numbers" {
    try std.testing.expect(1 + 1 == 2);
}
test namedTest {}
`

  it('indexes string-named and identifier-named tests, at top level and as a container member', async () => {
    const syms = await symbolsOf('t.zig', src)
    const adds = find(syms, 'adds numbers', 'test')
    expect(adds?.lineStart).toBe(14)
    expect(adds?.lineEnd).toBe(16)
    expect(find(syms, 'namedTest', 'test')?.parent).toBe('')
    expect(find(syms, 'member test', 'test')?.parent).toBe('Point')
    for (const [name, kind] of [['main', 'function'], ['Point', 'struct'], ['init', 'function'], ['ml', 'const']] as const) {
      expect(find(syms, name, kind), name).toBeDefined()
    }
    const names = syms.map((s) => s.name)
    expect(names).not.toContain('fake_ml_test')
    expect(names).not.toContain('fake_comment_test')
  })
})

describe('Terraform: check, ephemeral, import, moved, removed blocks', () => {
  // HAND-DERIVED from the Terraform language docs: Checks, Ephemeral resources, Import blocks, Refactoring (moved), Removing resources (removed).
  const src = `resource "aws_s3_bucket" "b" {}
locals {
  doc = <<EOT
check "fake_heredoc_check" {
moved {
EOT
}
# check "fake_comment_check" {}
check "health" {
  assert {
    condition     = true
    error_message = "x"
  }
}
import {
  to = aws_s3_bucket.b
  id = "b"
}
moved {
  from = aws_s3_bucket.a
  to   = aws_s3_bucket.b
}
removed {
  from = aws_s3_bucket.old
}
ephemeral "random_password" "db" {
  length = 16
}
`

  it('indexes each block with its Terraform address and its full brace span', async () => {
    const syms = await symbolsOf('main.tf', src)
    const expected: ReadonlyArray<[string, string, number, number]> = [
      ['check.health', 'tf_check', 9, 14],
      ['import', 'tf_import', 15, 18],
      ['moved', 'tf_moved', 19, 22],
      ['removed', 'tf_removed', 23, 25],
      ['ephemeral.random_password.db', 'tf_ephemeral', 26, 28],
    ]
    for (const [name, kind, start, end] of expected) {
      const s = find(syms, name, kind)
      expect(s ? [s.lineStart, s.lineEnd] : null, name).toEqual([start, end])
    }
    expect(find(syms, 'aws_s3_bucket.b', 'tf_resource')).toBeDefined()
    expect(find(syms, 'locals', 'tf_locals')).toBeDefined()
    expect(syms.filter((s) => s.kind === 'tf_moved')).toHaveLength(1)
    expect(syms.map((s) => s.name)).not.toContain('check.fake_heredoc_check')
    expect(syms.map((s) => s.name)).not.toContain('check.fake_comment_check')
  })
})

describe('SQL: UNLOGGED and GLOBAL TEMPORARY tables, OR ALTER, PROC, SEQUENCE', () => {
  // HAND-DERIVED from the PostgreSQL 16 reference (CREATE TABLE, CREATE SEQUENCE) and the SQL Server reference (CREATE PROCEDURE: `CREATE [ OR ALTER ] { PROC | PROCEDURE }`).
  const src = `CREATE TABLE users (id int);
CREATE UNLOGGED TABLE unlogged_t (a int);
CREATE GLOBAL TEMPORARY TABLE gtt (a int);
CREATE OR REPLACE TABLE bq_t (a int);
CREATE SEQUENCE seq1;
CREATE UNLOGGED SEQUENCE IF NOT EXISTS useq;
CREATE OR ALTER PROCEDURE dbo.usp_alter AS SELECT 1;
CREATE PROC dbo.usp_short AS SELECT 1;
CREATE OR ALTER VIEW dbo.v_alter AS SELECT 1;
CREATE PROCEDURE do_it() LANGUAGE sql AS $$ SELECT 1 $$;
SELECT 'CREATE PROC fake_proc_str AS SELECT 1';
-- CREATE SEQUENCE fake_seq_comment;
CREATE PROCESSOR not_a_proc;
`

  it('indexes each form and keeps string, comment and near-miss keywords out', async () => {
    const syms = await symbolsOf('schema.sql', src)
    const expected: ReadonlyArray<[string, string]> = [
      ['users', 'sql_table'], ['unlogged_t', 'sql_table'], ['gtt', 'sql_table'], ['bq_t', 'sql_table'],
      ['seq1', 'sql_sequence'], ['useq', 'sql_sequence'],
      ['dbo.usp_alter', 'sql_procedure'], ['dbo.usp_short', 'sql_procedure'], ['do_it', 'sql_procedure'],
      ['dbo.v_alter', 'sql_view'],
    ]
    for (const [name, kind] of expected) expect(find(syms, name, kind), name).toBeDefined()
    const names = syms.map((s) => s.name)
    for (const fake of ['fake_proc_str', 'fake_seq_comment', 'not_a_proc', 'SOR']) expect(names).not.toContain(fake)
  })
})

describe('PowerShell: workflow and configuration', () => {
  // HAND-DERIVED from the PowerShell docs: about_Workflows, about_Configurations (DSC), about_Quoting_Rules (here-strings).
  const src = `function Get-Thing { param($a) }
filter Only-Even { if ($_ % 2 -eq 0) { $_ } }
Configuration MyConfig {
    Node localhost {
        File f { DestinationPath = 'c:\\x' }
    }
}
workflow Run-Flow {
    Get-Process
}
$s = @"
workflow fake_wf_herestring {}
"@
# configuration fake_cfg_comment {}
`

  it('indexes both as named commands with their brace spans', async () => {
    const syms = await symbolsOf('dsc.ps1', src)
    const cfg = find(syms, 'MyConfig', 'function')
    expect(cfg ? [cfg.lineStart, cfg.lineEnd] : null).toEqual([3, 7])
    const wf = find(syms, 'Run-Flow', 'function')
    expect(wf ? [wf.lineStart, wf.lineEnd] : null).toEqual([8, 10])
    expect(find(syms, 'Get-Thing', 'function')).toBeDefined()
    expect(find(syms, 'Only-Even', 'function')).toBeDefined()
    const names = syms.map((s) => s.name)
    for (const fake of ['fake_wf_herestring', 'fake_cfg_comment', 'localhost', 'f']) expect(names).not.toContain(fake)
  })
})

describe('R: <<-, setGeneric, setRefClass, R6Class', () => {
  // HAND-DERIVED from the R Language Definition ("Assignment"), the methods package docs (setGeneric, setRefClass) and the R6 package docs (R6Class).
  const src = `arrow <- function(x) x
dbl <<- function() 1
setGeneric("greet", function(obj) standardGeneric("greet"))
Account <- R6::R6Class("Account", public = list(deposit = function(x) x))
Plain <- R6Class(
  public = list(x = 1)
)
Person <- setRefClass("Person", fields = list(name = "character"))
setClass("Shape", representation("VIRTUAL"))
# FakeR6 <- R6Class()
msg <- 'FakeStr <- R6Class()'
  Indented <- R6Class()
`

  it('indexes each form under the name code calls it by', async () => {
    const syms = await symbolsOf('classes.R', src)
    expect(find(syms, 'dbl', 'function')?.lineStart).toBe(2)
    expect(find(syms, 'greet', 'function')?.lineStart).toBe(3)
    expect(find(syms, 'Account', 'class')?.lineStart).toBe(4)
    const plain = find(syms, 'Plain', 'class')
    expect(plain ? [plain.lineStart, plain.lineEnd] : null).toEqual([5, 7])
    expect(find(syms, 'Person', 'class')?.lineStart).toBe(8)
    expect(find(syms, 'arrow', 'function')).toBeDefined()
    expect(find(syms, 'Shape', 'class')).toBeDefined()
    const names = syms.map((s) => s.name)
    for (const fake of ['FakeR6', 'FakeStr', 'Indented', 'msg']) expect(names).not.toContain(fake)
  })
})
