import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('extract_entities script', () => {
  const scriptPath = resolve(__dirname, '../scripts/extract_entities.py');
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(resolve(tmpdir(), 'entity-extractor-'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function fixture(name: string, content: string): string {
    const path = resolve(sandbox, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  function run(input: string, args: string[] = []): string {
    return execFileSync('python', [scriptPath, input, ...args], { encoding: 'utf8' });
  }

  it('extracts activities from json and text files', () => {
    const tmpJson = resolve(sandbox, 'entities.json');
    try {
      const data = [
        { page: 1, text: 'Activity 1: Setup database\nActivity 2: Configure router' },
        { page: 2, text: 'Activity 3: Write tests\nSome random noise' },
      ];
      writeFileSync(tmpJson, JSON.stringify(data), 'utf8');

      const stdout = execFileSync('python', [scriptPath, tmpJson, '--type', 'activities', '--format', 'json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].id).toBe(1);
      expect(parsed[0].content).toContain('Setup database');
      expect(parsed[1].id).toBe(2);
      expect(parsed[2].id).toBe(3);
    } finally {
      if (existsSync(tmpJson)) {
        unlinkSync(tmpJson);
      }
    }
  });

  it('extracts comments and tasks from code and style files', () => {
    const tmpTs = resolve(sandbox, 'code.ts');
    try {
      const tsCode = `
// Task 1: Initialize server
const port = 3000;
/* Task 2: Bind listener */
app.listen(port);
`;
      writeFileSync(tmpTs, tsCode, 'utf8');

      const stdout = execFileSync('python', [scriptPath, tmpTs, '--type', 'tasks', '--format', 'json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe(1);
      expect(parsed[0].content).toContain('Initialize server');
      expect(parsed[1].id).toBe(2);
      expect(parsed[1].content).toContain('Bind listener');
    } finally {
      if (existsSync(tmpTs)) {
        unlinkSync(tmpTs);
      }
    }
  });

  it('runs process_activities backward-compatible wrapper', () => {
    const procScript = resolve(__dirname, '../scripts/process_activities.py');
    const tmpJson = resolve(sandbox, 'activities.json');
    const tmpOut = resolve(sandbox, 'activity-output.json');
    try {
      const data = [{ page: 1, text: 'Activity 1: Complete setup\nActivity 2: Run verification' }];
      writeFileSync(tmpJson, JSON.stringify(data), 'utf8');

      const stdout = execFileSync('python', [procScript, tmpJson, tmpOut, '--inspect'], {
        encoding: 'utf8',
      });
      expect(stdout).toContain('Activities detected (1-250): 2');
      expect(stdout).toContain('Complete setup');
    } finally {
      if (existsSync(tmpJson)) unlinkSync(tmpJson);
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
    }
  });

  it.each(['txt', 'ts', 'py', 'css', 'rst', 'adoc'])('tracks physical lines and normalizes %s content', (extension) => {
    const input = fixture(`input.${extension}`, '\nActivity 1: Clean\u0000  up\ttext\n  wrapped   content\n\nActivity 2: Finish\n');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      id: 1, content: 'Clean up text wrapped content', line_start: 2, line_end: 3,
    });
    expect(entities[1]).toMatchObject({ id: 2, line_start: 5, line_end: 5 });
  });

  it('keeps exact comment locations and source order', () => {
    const input = fixture('comments.ts', '// Task 1: First\nconst ignored = 1;\n/* Task 2: Second\n * wrapped */\n');
    const entities = JSON.parse(run(input, ['--type', 'tasks', '--comments-only', '--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({ id: 1, content: 'First', line_start: 1, line_end: 1 });
    expect(entities[1]).toMatchObject({ id: 2, line_start: 3, line_end: 4 });
    expect(entities[1].content).not.toContain('ignored');
  });

  it('deduplicates normalized id/content pairs but keeps distinct content and ids', () => {
    const input = fixture('duplicates.json', JSON.stringify([
      { unit: 'First', text: 'Activity 1: Same  text' },
      { unit: 'Overlap', text: 'Activity 1: Same\n text' },
      { text: 'Activity 1: Different' },
      { text: 'Activity 2: Same text' },
    ]));
    expect(JSON.parse(run(input, ['--format', 'json']))).toHaveLength(4);
    const entities = JSON.parse(run(input, ['--format', 'json', '--dedup']));
    expect(entities).toHaveLength(3);
    expect(entities[0]).toMatchObject({ id: 1, content: 'Same text', unit: 'First' });
    expect(entities[1]).toMatchObject({ id: 1, content: 'Different' });
    expect(entities[2]).toMatchObject({ id: 2, content: 'Same text' });
  });

  it.each(['jsonl', 'csv'])('exports native %s to stdout and infers file extensions', (format) => {
    const input = fixture('export.txt', 'Activity 1: Say "hello", café\nActivity 2: Finish\n');
    const stdout = run(input, ['--format', format]);
    const output = resolve(sandbox, `entities.${format}`);
    run(input, ['--out', output]);
    expect(readFileSync(output, 'utf8')).toBe(stdout);
    const explicit = resolve(sandbox, 'explicit.out');
    run(input, ['--out', explicit, '--format', format]);
    expect(readFileSync(explicit, 'utf8')).toBe(stdout);
    if (format === 'jsonl') {
      const rows = stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 1, content: 'Say "hello", café', line_start: 1 });
    } else {
      expect(stdout.split('\n')[0]).toBe('source,unit,id,content,line_start,line_end,metadata');
      const parsed = execFileSync('python', [
        '-X', 'utf8', '-c', 'import csv,json,sys; print(json.dumps(list(csv.DictReader(sys.stdin))))',
      ], { input: stdout, encoding: 'utf8' });
      const rows = JSON.parse(parsed);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: '1', content: 'Say "hello", café', line_start: '1', line_end: '1' });
      expect(JSON.parse(rows[0].metadata)).toMatchObject({ page: 1 });
    }
  });

  it('preserves the legacy JSON envelope and located chunks', () => {
    const input = fixture('input.txt', 'Activity 1: Setup\n');
    const output = resolve(sandbox, 'output.json');
    run(input, ['--out', output, '--dump-chunks']);
    const payload = JSON.parse(readFileSync(output, 'utf8'));
    expect(payload.summary).toMatchObject({ total_entities: 1, total_units: 1 });
    expect(payload.chunks[0]).toMatchObject({ line_start: 1, line_end: 1 });
    expect(payload.entities[0]).toMatchObject({ id: 1, line_start: 1, line_end: 1 });
  });

  it.each(['md', 'markdown', 'mdx'])('chunks %s headings, tables and lists with heading paths', (extension) => {
    const input = fixture(`guide.${extension}`, [
      '# Guide', '## Setup', '- 1. Prepare workspace', '* 2: Install dependencies',
      '### Checks', '| ID | Description |', '| --- | --- |',
      '| 3 | Activity verify, carefully |', '| 4 | Activity finish |',
      '## Deploy', 'Activity 5: Publish', '',
    ].join('\n'));
    const output = resolve(sandbox, 'guide.json');
    run(input, ['--out', output, '--dump-chunks']);
    const { entities, chunks } = JSON.parse(readFileSync(output, 'utf8'));
    expect(entities.map((entity: { id: number }) => entity.id)).toEqual([1, 2, 3, 4, 5]);
    expect(entities[0]).toMatchObject({
      content: 'Prepare workspace', unit: 'Guide > Setup', line_start: 3, line_end: 3,
      metadata: { heading: 'Guide > Setup' },
    });
    expect(entities[2]).toMatchObject({
      content: 'Activity verify, carefully', line_start: 8, line_end: 8,
      metadata: { heading: 'Guide > Setup > Checks' },
    });
    expect(entities[4]).toMatchObject({
      content: 'Publish', unit: 'Guide > Deploy', line_start: 11, line_end: 11,
    });
    expect(chunks.map((chunk: { unit: string }) => chunk.unit)).toEqual([
      'Guide', 'Guide > Setup', 'Guide > Setup > Checks', 'Guide > Deploy',
    ]);
    expect(chunks[1]).toMatchObject({ line_start: 2, line_end: 4 });
  });

  it('does not treat fenced Markdown headings as section boundaries', () => {
    const input = fixture('fences.md', '# Guide\n```sh\n# not a heading\n```\nActivity 1: Finish\n');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities[0]).toMatchObject({ unit: 'Guide', id: 1, line_start: 5 });
  });

  it.each([
    ['yaml', 'activities:\n  - Activity 1: Configure\n'],
    ['yml', '# Activity 1: Configure\n'],
    ['toml', '# Activity 1: Configure\n'],
    ['toml', 'description = "Activity 1: Configure"\n'],
    ['yml', 'description: "Activity 1: Configure"\n'],
    ['xml', '<activities>\n<activity>Activity 1: Configure</activity>\n</activities>\n'],
    ['html', '<main>\n<p>Activity 1: Configure</p>\n</main>\n'],
  ])('extracts entities from %s config/doc content', (extension, content) => {
    const input = fixture(`config.${extension}`, content);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      id: 1, content: 'Configure', line_start: extension === 'yml' || extension === 'toml' ? 1 : 2,
    });
  });

  it('tracks CSV record spans, including quoted multiline fields and empty records', () => {
    const input = fixture('rows.csv', 'id,description\n\n1,"Activity 1: First\nwrapped"\n2,Activity 2: Second\n');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({ id: 1, line_start: 3, line_end: 4 });
    expect(entities[1]).toMatchObject({ id: 2, line_start: 5, line_end: 5 });
  });

  it.each(['json', 'jsonl'])('tracks original %s records rather than decoded string lines', (extension) => {
    const content = extension === 'json'
      ? '[\n  {"text":"Activity 1: First\\nwrapped"},\n  {"text":"Activity 2: Second"}\n]\n'
      : '\n{"text":"Activity 1: First\\nwrapped"}\n{"text":"Activity 2: Second"}\n';
    const input = fixture(`records.${extension}`, content);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities[0]).toMatchObject({ id: 1, line_start: 2, line_end: 2 });
    expect(entities[1]).toMatchObject({ id: 2, line_start: 3, line_end: 3 });
  });

  it('keeps complete entities across text chunk boundaries', () => {
    const input = fixture('large.txt', [
      ...Array.from({ length: 98 }, () => 'preamble'), 'Activity 1: Begin',
      'continuation one', 'continuation two', 'Activity 2: End', '',
    ].join('\n'));
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      content: 'Begin continuation one continuation two', line_start: 99, line_end: 101,
      unit: 'Lines 99-101', metadata: { start_line: 99, end_line: 101 },
    });
    expect(entities[1]).toMatchObject({ id: 2, line_start: 102, line_end: 102 });
  });

  it('streams line-based readers without whole-file reads or eager list loading', () => {
    const program = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(resolve(__dirname, '../scripts'))})`,
      'from pathlib import Path',
      'from unittest.mock import patch',
      'from extract_entities import iter_document, iter_entities',
      'for filename in sys.argv[1:]:',
      '  with patch.object(Path, "read_text", side_effect=AssertionError("whole-file read")):',
      '    chunks = iter_document(filename)',
      '    assert iter(chunks) is chunks, "reader must be lazy"',
      '    entities = iter_entities(chunks)',
      '    assert next(entities)["id"] == 1, filename',
      'print("streaming verified")',
    ].join('\n');
    const inputs = ['txt', 'ts', 'csv', 'jsonl'].map(extension =>
      fixture(`stream.${extension}`, extension === 'jsonl'
        ? '{"text":"Activity 1: First"}\n{"text":"Activity 2: Next"}\n'
        : 'Activity 1: First\nActivity 2: Next\n'));
    expect(execFileSync('python', ['-c', program, ...inputs], { encoding: 'utf8' })).toContain('streaming verified');
  });

  it('retains custom patterns and block comments across chunk boundaries', () => {
    const preamble = Array.from({ length: 98 }, () => 'ignored').join('\n');
    const input = fixture('boundary.ts', `${preamble}\n/* Task 1: Begin\ncontinued\nstill here */\n// Task 2: End\n`);
    const entities = JSON.parse(run(input, ['--type', 'tasks', '--comments-only', '--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      content: 'Begin continued still here', line_start: 99, line_end: 101,
    });
    const custom = fixture('custom.txt', `${preamble}\nItem 1: Begin\ncontinued\nmore\nItem 2: End\n`);
    const customEntities = JSON.parse(run(custom, [
      '--pattern', 'Item (\\d+): (.+?)(?=\\nItem |\\Z)', '--format', 'json',
    ]));
    expect(customEntities).toHaveLength(2);
    expect(customEntities[0]).toMatchObject({ id: 1, content: 'Begin continued more', line_start: 99 });
  });

  it('bounds chunks for a long single line without truncating an entity', () => {
    const input = fixture('long.txt', `Activity 1: ${'x'.repeat(150000)}\nActivity 2: End\n`);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0].content).toBe('x'.repeat(150000));
    expect(entities[0]).toMatchObject({ line_start: 1, line_end: 1 });
    expect(entities[1]).toMatchObject({ line_start: 2, line_end: 2 });
  });

  it('locates multiline JSON pages and preserves explicit units', () => {
    const input = fixture('pages.json', '{\n "note": "pages",\n "pages": [\n  {\n   "unit": "Section A",\n   "text": "Activity 1: First"\n  }\n ]\n}\n');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities[0]).toMatchObject({ unit: 'Section A', id: 1, line_start: 4, line_end: 7 });
  });

  it('propagates locations and dedup through the compatibility wrapper', () => {
    const input = fixture('wrapper.txt', 'Activity 1: Same\nActivity 1: Same\n');
    const output = resolve(sandbox, 'wrapper.json');
    const stdout = execFileSync('python', [
      resolve(__dirname, '../scripts/process_activities.py'), input, output, '--dedup',
    ], { encoding: 'utf8' });
    expect(stdout).toContain('Activities detected (1-250): 1');
    expect(JSON.parse(readFileSync(output, 'utf8'))[0]).toMatchObject({ line_start: 1, line_end: 2 });
  });

  it('refuses to overwrite its input and leaves the source untouched', () => {
    const original = 'Activity 1: Preserve\n';
    const input = fixture('source.txt', original);
    expect(() => run(input, ['--out', input])).toThrow();
    expect(readFileSync(input, 'utf8')).toBe(original);
  });

  it('refuses a hard-linked output before opening or changing the input', () => {
    const original = 'Activity 1: Preserve original\n';
    const input = fixture('original.txt', original);
    const output = resolve(sandbox, 'hardlink.json');
    linkSync(input, output);
    expect(() => run(input, ['--out', output])).toThrow();
    expect(readFileSync(input, 'utf8')).toBe(original);
  });

  it('retains an unmatched multiline custom-pattern prefix across batches', () => {
    const input = fixture('multiline.txt', `${'ignore\n'.repeat(99)}Item 1\nContent: First\nItem 2\nContent: Second\n`);
    const entities = JSON.parse(run(input, ['--pattern', 'Item (\\d+)\\nContent: ([^\\n]+)', '--format', 'json']));
    expect(entities.map((entity: { id: number }) => entity.id)).toEqual([1, 2]);
    expect(entities[0]).toMatchObject({ content: 'First', line_start: 100, line_end: 101 });
  });

  it('handles a comment terminator split across the character limit', () => {
    const input = fixture('split.ts', `/* Task 1: First\n${'x'.repeat(65535)}*/\nconst s=1;\nTask 2: not a comment\n`);
    const entities = JSON.parse(run(input, ['--type', 'tasks', '--comments-only', '--format', 'json']));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ id: 1, line_start: 1, line_end: 2 });
    expect(entities[0].content).not.toContain('not a comment');
    expect(entities[0].content).not.toContain('const');
  });

  it('distinguishes repeated Markdown sections at a batch boundary', () => {
    const input = fixture('repeated.md', `# Section\n${'ignore\n'.repeat(98)}Activity 1: First\n# Section\nActivity 2: Second\n`);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({ content: 'First', line_start: 100, line_end: 100 });
    expect(entities[1]).toMatchObject({ content: 'Second', line_start: 102 });
  });

  it.each(['md', 'markdown', 'mdx'])('supports Setext %s headings with original line spans', (extension) => {
    const input = fixture(`setext.${extension}`, 'Guide\n=====\nActivity 1: First\n\nDeploy\n------\nActivity 2: Second\n');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities[0]).toMatchObject({ content: 'First', unit: 'Guide', line_start: 3, line_end: 3 });
    expect(entities[1]).toMatchObject({ content: 'Second', unit: 'Guide > Deploy', line_start: 7 });
  });

  it.each(['xml', 'html', 'mdx'])('preserves element boundaries without inventing physical lines in %s', (extension) => {
    const input = fixture(`elements.${extension}`, '<items><item>Activity 1: First</item><item>Activity 2: Second</item></items>');
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({ id: 1, content: 'First', line_start: 1, line_end: 1 });
    expect(entities[1]).toMatchObject({ id: 2, content: 'Second', line_start: 1, line_end: 1 });
  });

  it('supports package imports and module-mode CLI invocation', () => {
    const input = fixture('module.txt', 'Activity 1: Module mode\n');
    const entities = JSON.parse(execFileSync('python', [
      '-m', 'scripts.extract_entities', input, '--format', 'json',
    ], { encoding: 'utf8', cwd: resolve(__dirname, '..') }));
    expect(entities[0]).toMatchObject({ id: 1, content: 'Module mode' });
    const imported = execFileSync('python', [
      '-c', 'from scripts.extract_entities import load_document; from scripts.process_activities import extract_activities; print("imports verified")',
    ], { encoding: 'utf8', cwd: resolve(__dirname, '..') });
    expect(imported).toContain('imports verified');
  });

  it('refuses an over-limit unmatched custom prefix instead of silently losing candidates', () => {
    const input = fixture('unmatched.txt', 'no match\n'.repeat(10000));
    expect(() => run(input, [
      '--pattern', 'Item (\\d+)\\nContent: ([^\\n]+)', '--format', 'json',
    ])).toThrow(/65,536-character streaming prefix/);
  });

  it.each(['xml', 'html', 'mdx'])('retains %s entities after tags split across character batches', (extension) => {
    const input = fixture(`tag.${extension}`, `<item attr="${'x'.repeat(65536)}">Activity 1: First</item>`);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ id: 1, content: 'First', line_start: 1, line_end: 1 });
  });

  it.each([['# C#', 'C#'], ['# C# ##', 'C#'], ['# Topic ###', 'Topic']])('preserves literal hash suffixes in %s', (heading, title) => {
    const input = fixture('hash.md', `${heading}\nActivity 1: Compile\n`);
    const entities = JSON.parse(run(input, ['--format', 'json']));
    expect(entities[0]).toMatchObject({ unit: title, metadata: { heading: title }, line_start: 2 });
  });
});
