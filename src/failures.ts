/**
 * Extract failing test blocks from test runner output.
 */

import { stripAnsi } from './render/ansi.js';

/**
 * A single failure block with name and body.
 */
export interface FailureBlock {
  name: string;
  body: string;
}

/**
 * Result of parsing test failures from output.
 */
export interface FailureResult {
  runner: string;
  blocks: FailureBlock[];
  summaryLines: string[];
  statsLine: string;
}

/**
 * Get count of failures.
 */
export function getFailureCount(result: FailureResult): number {
  return result.blocks.length || result.summaryLines.length;
}

// ───────────────────────────────────────────────────────────────────────────── Regexes ─────────────────────────────────────────────────────────────────────────────

const PYTEST_SECTION = /^=+ (.+?) =+$/;
const PYTEST_BLOCK_SEP = /^_+ (.+?) _+$/;
const JEST_BLOCK_START = /^\s+● /;
const GO_FAIL = /^--- FAIL:\s+(\S+)/;
const CARGO_FAIL = /^test .+ \.\.\. FAILED/;

// ───────────────────────────────────────────────────────────────────────────── Runner detection ─────────────────────────────────────────────────────────────────────────────

function detectRunner(text: string): string {
  if (text.includes('=== FAILURES ===') || text.includes('=== ERRORS ===')) {
    return 'pytest';
  }
  if (/\bFAILED\b.+::test_/.test(text) || /short test summary/i.test(text)) {
    return 'pytest';
  }
  if (/^\s+●\s/m.test(text) || /^FAIL\s+\S+\.test\b/m.test(text)) {
    return 'jest';
  }
  if (/^--- FAIL:/m.test(text)) {
    return 'go';
  }
  if (/^test .+ \.\.\. FAILED/m.test(text)) {
    return 'cargo';
  }
  return 'unknown';
}

// ───────────────────────────────────────────────────────────────────────────── Per-runner extractors ─────────────────────────────────────────────────────────────────────────────

function extractPytest(lines: string[]): FailureResult {
  const result: FailureResult = {
    runner: 'pytest',
    blocks: [],
    summaryLines: [],
    statsLine: '',
  };

  let inFailures = false;
  let inBlock = false;
  let inSummary = false;
  let currentName = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const s = line.trimEnd();

    const m = PYTEST_SECTION.exec(s);
    if (m) {
      const section = m[1]!;
      // Close any open block
      if (inBlock && currentName) {
        result.blocks.push({ name: currentName, body: currentBody.join('\n') });
        currentName = '';
        currentBody = [];
        inBlock = false;
      }

      if (section === 'FAILURES' || section === 'ERRORS') {
        inFailures = true;
        inSummary = false;
      } else if (section.includes('short test summary')) {
        inFailures = false;
        inSummary = true;
      } else if (/\d+ (failed|error)/.test(section)) {
        result.statsLine = s;
        inSummary = false;
      } else {
        inFailures = false;
        inSummary = false;
      }
      continue;
    }

    if (inSummary) {
      result.summaryLines.push(s);
      continue;
    }

    if (inFailures) {
      const bm = PYTEST_BLOCK_SEP.exec(s);
      if (bm) {
        if (inBlock && currentName) {
          result.blocks.push({ name: currentName, body: currentBody.join('\n') });
        }
        currentName = bm[1]!;
        currentBody = [];
        inBlock = true;
        continue;
      }
      if (inBlock) {
        currentBody.push(s);
      }
    }
  }

  // Flush last block
  if (inBlock && currentName) {
    result.blocks.push({ name: currentName, body: currentBody.join('\n') });
  }

  // Fallback: no section structure — collect FAILED lines
  if (result.blocks.length === 0 && result.summaryLines.length === 0) {
    for (const line of lines) {
      if (line.startsWith('FAILED ')) {
        result.summaryLines.push(line.trimEnd());
      }
    }
  }

  return result;
}

function extractJest(lines: string[]): FailureResult {
  const result: FailureResult = {
    runner: 'jest',
    blocks: [],
    summaryLines: [],
    statsLine: '',
  };

  let inBlock = false;
  let currentName = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const s = line.trimEnd();

    if (JEST_BLOCK_START.test(s)) {
      if (inBlock && currentName) {
        result.blocks.push({ name: currentName, body: currentBody.join('\n') });
      }
      currentName = s.replace(/^\s+●\s+/, '');
      currentBody = [s];
      inBlock = true;
      continue;
    }

    if (inBlock) {
      // A FAIL header or "Tests:" line closes the block
      if (/^(FAIL|PASS|Tests:|Test Suites:)\s/.test(s)) {
        result.blocks.push({ name: currentName, body: currentBody.join('\n') });
        inBlock = false;
        currentName = '';
        currentBody = [];
      } else {
        currentBody.push(s);
      }
    }

    if (/^FAIL\s/.test(s)) {
      result.summaryLines.push(s);
    }
  }

  if (inBlock && currentName) {
    result.blocks.push({ name: currentName, body: currentBody.join('\n') });
  }

  return result;
}

function extractGo(lines: string[]): FailureResult {
  const result: FailureResult = {
    runner: 'go',
    blocks: [],
    summaryLines: [],
    statsLine: '',
  };

  for (const line of lines) {
    const m = GO_FAIL.exec(line.trimEnd());
    if (m) {
      result.blocks.push({ name: m[1]!, body: line.trimEnd() });
    }
  }

  return result;
}

function extractCargo(lines: string[]): FailureResult {
  const result: FailureResult = {
    runner: 'cargo',
    blocks: [],
    summaryLines: [],
    statsLine: '',
  };

  for (const line of lines) {
    const s = line.trimEnd();
    if (CARGO_FAIL.test(s)) {
      result.blocks.push({ name: s, body: s });
    }
  }

  return result;
}

function extractGeneric(lines: string[]): FailureResult {
  const result: FailureResult = {
    runner: 'unknown',
    blocks: [],
    summaryLines: [],
    statsLine: '',
  };

  for (const line of lines) {
    const s = line.trimEnd();
    if (/\b(FAILED|FAILURE|ERROR)\b/i.test(s)) {
      result.summaryLines.push(s);
    }
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────── Public API ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse test runner output and return only the failing blocks.
 */
export function extractFailures(text: string, options?: { runner?: string }): FailureResult {
  const cleaned = stripAnsi(text);
  const lines = cleaned.split('\n');
  const detected = options?.runner ?? detectRunner(cleaned);

  if (detected === 'pytest') {
    return extractPytest(lines);
  }
  if (detected === 'jest') {
    return extractJest(lines);
  }
  if (detected === 'go') {
    return extractGo(lines);
  }
  if (detected === 'cargo') {
    return extractCargo(lines);
  }
  return extractGeneric(lines);
}

/**
 * Format failures as human-readable text.
 */
export function formatFailuresText(result: FailureResult): string {
  if (result.blocks.length === 0 && result.summaryLines.length === 0) {
    return 'No failures found.';
  }

  const parts: string[] = [];
  const sep = '─'.repeat(60);

  for (const block of result.blocks) {
    parts.push(sep, `FAIL  ${block.name}`, sep, block.body, '');
  }

  if (result.summaryLines.length > 0) {
    if (parts.length > 0) {
      parts.push(sep);
    }
    parts.push(...result.summaryLines);
  }

  if (result.statsLine) {
    parts.push(result.statsLine);
  }

  const n = getFailureCount(result);
  parts.push(`\n${n} failure(s)  [${result.runner}]`);
  return parts.join('\n');
}

/**
 * Format failures as JSON.
 */
export function formatFailuresJson(result: FailureResult): string {
  return JSON.stringify(
    {
      runner: result.runner,
      count: getFailureCount(result),
      failures: result.blocks.map((b) => ({ name: b.name, body: b.body })),
      summary: result.summaryLines,
      stats: result.statsLine,
    },
    null,
    2
  );
}
