import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { extractCsharp } from '../src/languages/csharp.js'
import { indexFileSync } from '../src/parser.js'
import { closeDb, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'

describe('C# Reference Extraction', () => {
  it('extracts constructor instantiations (new Type)', () => {
    const code = [
      'namespace Demo;',
      'public class Worker {',
      '    public void Run() {',
      '        var client = new ApiClient("https://api.example.com");',
      '        var options = new RequestOptions { Timeout = 30 };',
      '    }',
      '}',
    ].join('\n')

    const { symbols, refs } = extractCsharp(code, 'Worker.cs')
    expect(symbols.map(s => s.name)).toContain('Run')

    const refNames = refs.map(r => r.name)
    expect(refNames).toContain('ApiClient')
    expect(refNames).toContain('RequestOptions')

    const clientRef = refs.find(r => r.name === 'ApiClient')
    expect(clientRef).toBeDefined()
    expect(clientRef?.filePath).toBe('Worker.cs')
    expect(clientRef?.line).toBe(4)
    expect(clientRef?.context).toBe('Run')

    const optRef = refs.find(r => r.name === 'RequestOptions')
    expect(optRef).toBeDefined()
    expect(optRef?.context).toBe('Run')
  })

  it('extracts method calls and member invocations with enclosing caller context', () => {
    const code = [
      'namespace Realm;',
      'public class TokenService {',
      '    private readonly ITokenProvider _provider;',
      '    public async Task<string> GetTokenAsync(string user) {',
      '        ValidateUser(user);',
      '        var token = await _provider.GenerateTokenAsync(user);',
      '        Logger.LogInfo("Generated token");',
      '        return token;',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'TokenService.cs')
    const refNames = refs.map(r => r.name)

    expect(refNames).toContain('ValidateUser')
    expect(refNames).toContain('GenerateTokenAsync')
    expect(refNames).toContain('LogInfo')

    const genTokenRef = refs.find(r => r.name === 'GenerateTokenAsync')
    expect(genTokenRef?.context).toBe('GetTokenAsync')
  })

  it('ignores keywords and control flow constructs', () => {
    const code = [
      'public class Filter {',
      '    public void Process(int val) {',
      '        if (val > 0) {',
      '            while (val > 10) {',
      '                val--;',
      '            }',
      '            switch (val) {',
      '                case 1:',
      '                    break;',
      '            }',
      '        }',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'Filter.cs')
    const refNames = refs.map(r => r.name)
    expect(refNames).not.toContain('if')
    expect(refNames).not.toContain('while')
    expect(refNames).not.toContain('switch')
    expect(refNames).not.toContain('for')
    expect(refNames).not.toContain('catch')
  })

  it('does not extract identifiers inside comments or string literals', () => {
    const code = [
      'public class Safe {',
      '    public void Exec() {',
      '        // FakeCall("commented");',
      '        /* MultiLineCall(); */',
      '        var s = "CallInString()";',
      '        var raw = """',
      '            AnotherCall();',
      '            """;',
      '        RealCall();',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'Safe.cs')
    const refNames = refs.map(r => r.name)

    expect(refNames).toContain('RealCall')
    expect(refNames).not.toContain('FakeCall')
    expect(refNames).not.toContain('MultiLineCall')
    expect(refNames).not.toContain('CallInString')
    expect(refNames).not.toContain('AnotherCall')
  })

  it('wires into indexFileSync and stores refs in database', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cs-refs-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const csFile = path.join(tmpDir, 'Consumer.cs')
    const code = [
      'namespace App;',
      'public class Consumer {',
      '    public void Consume() {',
      '        var p = new Producer();',
      '        p.Produce();',
      '    }',
      '}',
    ].join('\n')
    fs.writeFileSync(csFile, code)

    indexFileSync(csFile, dbPath)

    const db = getDb(dbPath)
    const storedRefs = db.prepare('SELECT name, line, context FROM refs WHERE file_path = ?').all(normalizePath(csFile)) as Array<{ name: string; line: number; context: string }>
    const refNames = storedRefs.map(r => r.name)

    expect(refNames).toContain('Producer')
    expect(refNames).toContain('Produce')

    const produceRef = storedRefs.find(r => r.name === 'Produce')
    expect(produceRef?.context).toBe('Consume')

    closeDb(dbPath)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('handles scaling on very long identifiers without super-linear backtracking', () => {
    const longIdent = 'x'.repeat(128_000)
    const code = [
      'public class Scaler {',
      `    public void Run() { var ${longIdent} = 1; RealCall(); }`,
      '}',
    ].join('\n')

    const t0 = Date.now()
    const { refs } = extractCsharp(code, 'Scaler.cs')
    const elapsed = Date.now() - t0

    expect(refs.map(r => r.name)).toContain('RealCall')
    expect(elapsed).toBeLessThan(500)
  })

  it('extracts recursive calls on the same line and single-character callees', () => {
    const code = [
      'public class MathUtil {',
      '    public int Factorial(int n) => n <= 1 ? 1 : n * Factorial(n - 1);',
      '    public void Calc() { X(); }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'MathUtil.cs')
    const refNames = refs.map(r => r.name)
    expect(refNames).toContain('Factorial')
    expect(refNames).toContain('X')
  })

  it('extracts qualified constructor initializers and multiline calls', () => {
    const code = [
      'public class Builder {',
      '    public void Build() {',
      '        var client = new Demo.Client { Timeout = 1 };',
      '        DoSomething',
      '            (1, 2);',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'Builder.cs')
    const refNames = refs.map(r => r.name)
    expect(refNames).toContain('Client')
    expect(refNames).toContain('DoSomething')
  })

  it('extracts calls inside interpolated verbatim and raw strings', () => {
    const code = [
      'public class Formatter {',
      '    public void Format() {',
      '        var msg = $@"prefix {Target()} suffix";',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'Formatter.cs')
    expect(refs.map(r => r.name)).toContain('Target')
  })

  it('maintains proper member context in Allman-style method bodies', () => {
    const code = [
      'public class AllmanWorker',
      '{',
      '    public void AllmanMethod()',
      '    {',
      '        CallInside();',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'AllmanWorker.cs')
    const callRef = refs.find(r => r.name === 'CallInside')
    expect(callRef).toBeDefined()
    expect(callRef?.context).toBe('AllmanMethod')
  })

  it('reports column pointing to callee rather than generic arguments', () => {
    const code = [
      'public class Gen {',
      '    public void Run() {',
      '        Target<Target>();',
      '    }',
      '}',
    ].join('\n')

    const { refs } = extractCsharp(code, 'Gen.cs')
    const targetRef = refs.find(r => r.name === 'Target')
    expect(targetRef).toBeDefined()
    expect(targetRef?.col).toBe(8)
  })
})
