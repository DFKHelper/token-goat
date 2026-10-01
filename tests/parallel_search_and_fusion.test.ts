import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fuseChannelHits, DEFAULT_RRF_K } from '../src/search/rrf.js';
import type { ChannelHit, SearchChannel } from '../src/search/types.js';
import { detectEcosystems } from '../src/bridges/detect_ecosystems.js';
import { installJetbrains } from '../src/bridges/jetbrains_install.js';
import { uninstallNeovim } from '../src/bridges/neovim_install.js';

describe('Parallel Search & RRF Fusion', () => {
  it('reconciles overlapping line ranges across different channels into a single consensus result', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();

    // Symbol channel: function parseData spanning lines 100-130
    hitsMap.set('symbol', [
      {
        channel: 'symbol',
        filePath: 'src/parser.ts',
        name: 'parseData',
        kind: 'function',
        lineStart: 100,
        lineEnd: 130,
        preview: 'export function parseData(input: string)',
        rank: 1,
      },
    ]);

    // Text channel: match inside parseData at line 115
    hitsMap.set('text', [
      {
        channel: 'text',
        filePath: 'src/parser.ts',
        lineStart: 115,
        lineEnd: 115,
        preview: 'const parsed = JSON.parse(input);',
        rank: 1,
      },
    ]);

    // Semantic channel: conceptual match over lines 98-125
    hitsMap.set('semantic', [
      {
        channel: 'semantic',
        filePath: 'src/parser.ts',
        lineStart: 98,
        lineEnd: 125,
        preview: 'parse data function implementation',
        rank: 2,
      },
    ]);

    const fused = fuseChannelHits(hitsMap, { limit: 10 });
    expect(fused.length).toBe(1);
    const top = fused[0]!;
    expect(top.filePath).toBe('src/parser.ts');
    expect(top.name).toBe('parseData');
    expect(top.channels).toContain('symbol');
    expect(top.channels).toContain('text');
    expect(top.channels).toContain('semantic');
    // Consensus score is strictly higher than any single channel score
    const singleChannelScore = 1 / (DEFAULT_RRF_K + 1);
    expect(top.score).toBeGreaterThan(singleChannelScore * 2);
  });

  it('prevents single-channel score inflation when multiple hits occur in the same channel', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();

    // 5 text hits within the same function
    hitsMap.set('text', [
      { channel: 'text', filePath: 'src/foo.ts', lineStart: 10, lineEnd: 10, preview: 'line 10', rank: 1 },
      { channel: 'text', filePath: 'src/foo.ts', lineStart: 12, lineEnd: 12, preview: 'line 12', rank: 2 },
      { channel: 'text', filePath: 'src/foo.ts', lineStart: 15, lineEnd: 15, preview: 'line 15', rank: 3 },
    ]);

    const fused = fuseChannelHits(hitsMap, { limit: 10 });
    expect(fused.length).toBe(1);
    // Score must be 1 / (DEFAULT_RRF_K + 1), not sum of ranks 1, 2, and 3
    const expectedScore = Number((1 / (DEFAULT_RRF_K + 1)).toFixed(6));
    expect(fused[0]!.score).toBe(expectedScore);
    expect(fused[0]!.channels).toEqual(['text']);
  });

  it('respects limit: 0 and returns an empty list', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('symbol', [
      { channel: 'symbol', filePath: 'src/a.ts', lineStart: 1, lineEnd: 5, preview: 'fn', rank: 1 },
    ]);

    const fused = fuseChannelHits(hitsMap, { limit: 0 });
    expect(fused).toEqual([]);
  });

  it('sorts deterministically with tie-breakers on identical scores', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('text', [
      { channel: 'text', filePath: 'src/z.ts', lineStart: 10, lineEnd: 10, preview: 'z', rank: 1 },
      { channel: 'text', filePath: 'src/a.ts', lineStart: 10, lineEnd: 10, preview: 'a', rank: 1 },
      { channel: 'text', filePath: 'src/m.ts', lineStart: 10, lineEnd: 10, preview: 'm', rank: 1 },
    ]);

    const fused = fuseChannelHits(hitsMap, { limit: 10 });
    expect(fused.map((f) => f.filePath)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('guarantees channel order-independence during hit clustering and fusion', () => {
    const mapOrder1 = new Map<SearchChannel, ChannelHit[]>();
    mapOrder1.set('symbol', [{ channel: 'symbol', filePath: 'src/f.ts', name: 'calc', lineStart: 10, lineEnd: 20, preview: 'calc', rank: 1 }]);
    mapOrder1.set('text', [{ channel: 'text', filePath: 'src/f.ts', lineStart: 15, lineEnd: 15, preview: 'calc body', rank: 2 }]);
    mapOrder1.set('heading', [{ channel: 'heading', filePath: 'src/f.ts', name: 'calc', lineStart: 10, lineEnd: 10, preview: '# calc', rank: 1 }]);

    const mapOrder2 = new Map<SearchChannel, ChannelHit[]>();
    mapOrder2.set('text', [{ channel: 'text', filePath: 'src/f.ts', lineStart: 15, lineEnd: 15, preview: 'calc body', rank: 2 }]);
    mapOrder2.set('heading', [{ channel: 'heading', filePath: 'src/f.ts', name: 'calc', lineStart: 10, lineEnd: 10, preview: '# calc', rank: 1 }]);
    mapOrder2.set('symbol', [{ channel: 'symbol', filePath: 'src/f.ts', name: 'calc', lineStart: 10, lineEnd: 20, preview: 'calc', rank: 1 }]);

    const res1 = fuseChannelHits(mapOrder1);
    const res2 = fuseChannelHits(mapOrder2);

    expect(res1.length).toBe(res2.length);
    expect(res1[0]!.score).toBe(res2[0]!.score);
    expect([...res1[0]!.channels].sort()).toEqual([...res2[0]!.channels].sort());
  });

  it('does not falsely merge distinct named symbols even if adjacent', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('symbol', [
      { channel: 'symbol', filePath: 'src/f.ts', name: 'foo', lineStart: 10, lineEnd: 15, preview: 'foo', rank: 1 },
      { channel: 'symbol', filePath: 'src/f.ts', name: 'bar', lineStart: 16, lineEnd: 20, preview: 'bar', rank: 1 },
    ]);

    const fused = fuseChannelHits(hitsMap);
    expect(fused.length).toBe(2);
    expect(fused.map((f) => f.name).sort()).toEqual(['bar', 'foo']);
  });

  // Provenance: HAND-DERIVED line numbers chosen from the acceptance scenarios (CHANGELOG '### Fixed' headings, src/cli.ts:763-1378 buildProgram with a match at 923), not from the matcher.
  it('keeps same-name hits 900 lines apart as separate results', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('heading', [
      { channel: 'heading', filePath: 'CHANGELOG.md', name: 'Fixed', lineStart: 77, lineEnd: 90, preview: '### Fixed', rank: 1 },
      { channel: 'heading', filePath: 'CHANGELOG.md', name: 'Fixed', lineStart: 977, lineEnd: 1030, preview: '### Fixed', rank: 2 },
    ]);
    const fused = fuseChannelHits(hitsMap);
    expect(fused.length).toBe(2);
    expect(fused.map((f) => f.lineStart).sort((a, b) => a - b)).toEqual([77, 977]);
    expect(Math.max(...fused.map((f) => f.lineEnd - f.lineStart))).toBeLessThan(100);
  });

  it('reports the matched text line when it falls inside a much larger symbol range', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('symbol', [
      { channel: 'symbol', filePath: 'src/cli.ts', name: 'buildProgram', kind: 'function', lineStart: 763, lineEnd: 1378, preview: 'function buildProgram', rank: 1 },
    ]);
    hitsMap.set('text', [
      { channel: 'text', filePath: 'src/cli.ts', lineStart: 923, lineEnd: 923, preview: "command('section')", rank: 1 },
    ]);
    const fused = fuseChannelHits(hitsMap);
    expect(fused.length).toBe(1);
    expect(fused[0]!.lineStart).toBe(763);
    expect(fused[0]!.lineEnd).toBe(1378);
    expect(fused[0]!.matchLine).toBe(923);
    expect(fused[0]!.matchPreview).toBe("command('section')");
  });

  it('still fuses same-name hits 5 lines apart', () => {
    const hitsMap = new Map<SearchChannel, ChannelHit[]>();
    hitsMap.set('symbol', [{ channel: 'symbol', filePath: 'src/a.ts', name: 'calc', lineStart: 10, lineEnd: 20, preview: 'calc', rank: 1 }]);
    hitsMap.set('heading', [{ channel: 'heading', filePath: 'src/a.ts', name: 'calc', lineStart: 25, lineEnd: 26, preview: 'calc', rank: 1 }]);
    const fused = fuseChannelHits(hitsMap);
    expect(fused.length).toBe(1);
    expect(fused[0]!.lineStart).toBe(10);
    expect(fused[0]!.lineEnd).toBe(26);
  });

  it('stops growing an unnamed cluster at the span cap', () => {
    const hits: ChannelHit[] = [];
    for (let i = 0; i < 80; i++) {
      hits.push({ channel: 'text', filePath: 'src/long.ts', lineStart: 1 + i * 5, lineEnd: 1 + i * 5, preview: 'x' + i, rank: i + 1 });
    }
    const fused = fuseChannelHits(new Map([['text', hits]]), { limit: 100 });
    expect(fused.length).toBeGreaterThan(1);
    for (const f of fused) expect(f.lineEnd - f.lineStart + 1).toBeLessThanOrEqual(200);
  });
});

describe('Bridge Installers & Ecosystem Detection Safety', () => {
  it('detectEcosystems identifies presence accurately based on workspace files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-detect-test-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.vscode'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.idea'), { recursive: true });

      const detected = detectEcosystems({ projectRoot: tempDir });
      const detectedIds = detected.items.filter((item) => item.detected).map((item) => item.id);

      expect(detectedIds).toContain('vscode');
      expect(detectedIds).toContain('jetbrains');
      expect(detectedIds).not.toContain('neovim');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uninstallNeovim refuses to remove unmanaged lua configuration', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nvim-test-'));
    try {
      const nvimDir = path.join(tempDir, '.nvim');
      fs.mkdirSync(nvimDir, { recursive: true });
      const customLua = path.join(nvimDir, 'token-goat.lua');
      fs.writeFileSync(customLua, '-- Custom user lua file without token-goat marker\nprint("hello")\n');

      const uninstalled = uninstallNeovim({ project: true, projectRoot: tempDir });
      expect(uninstalled).toBe(false);
      expect(fs.existsSync(customLua)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installJetbrains refuses to overwrite malformed JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jb-test-'));
    try {
      const ideaDir = path.join(tempDir, '.idea');
      fs.mkdirSync(ideaDir, { recursive: true });
      const mcpJson = path.join(ideaDir, 'mcp.json');
      fs.writeFileSync(mcpJson, '{ this is not valid json }');

      expect(() => {
        installJetbrains({ project: true, projectRoot: tempDir });
      }).toThrow(/invalid JSON/);

      // Verify the malformed file was not overwritten
      expect(fs.readFileSync(mcpJson, 'utf8')).toBe('{ this is not valid json }');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installJetbrains registers mcp-serve command with bundledCliPath', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jb-clean-'));
    try {
      const res = installJetbrains({ project: true, projectRoot: tempDir });
      expect(fs.existsSync(res.mcpPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(res.mcpPath, 'utf8'));
      const tgServer = parsed.mcpServers['token-goat'];
      expect(tgServer.command).toBe(process.execPath);
      expect(tgServer.args.length).toBe(2);
      expect(tgServer.args[1]).toBe('mcp-serve');
      expect(tgServer.args[0]).toMatch(/token-goat/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
