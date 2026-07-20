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
const CARGO_FAIL = /^test (\S+) \.\.\. FAILED/;
const CARGO_SECTION = /^---- (\S+) (?:stdout|stderr) ----$/;
const CARGO_RESULT = /^test result:/;

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
        if (/^Tests:\s/.test(s)) {
          result.statsLine = s;
        }
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

  let inBlock = false;
  let currentName = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const s = line.trimEnd();

    const m = GO_FAIL.exec(s);
    if (m) {
      if (inBlock && currentName) {
        result.blocks.push({ name: currentName, body: currentBody.join('\n') });
      }
      currentName = m[1]!;
      currentBody = [s];
      inBlock = true;
      continue;
    }

    // A bare FAIL/PASS/ok summary line (unindented) closes the block; the
    // package-summary form (real content after the token) carries the stats
    if (/^(FAIL|PASS|ok)(\s|$)/.test(s)) {
      if (/^(?:FAIL|ok)\s+\S/.test(s)) {
        result.statsLine = s;
      }
      if (inBlock) {
        result.blocks.push({ name: currentName, body: currentBody.join('\n') });
        inBlock = false;
        currentName = '';
        currentBody = [];
      }
      continue;
    }

    if (inBlock) {
      currentBody.push(s);
    }
  }

  if (inBlock && currentName) {
    result.blocks.push({ name: currentName, body: currentBody.join('\n') });
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

  // First pass: collect failing test names (in order) and their one-line
  // summaries, plus the final stats line.
  const failNames: string[] = [];
  const summaryByName = new Map<string, string>();

  for (const line of lines) {
    const s = line.trimEnd();
    const m = CARGO_FAIL.exec(s);
    if (m) {
      const name = m[1]!;
      failNames.push(name);
      summaryByName.set(name, s);
      continue;
    }
    if (CARGO_RESULT.test(s)) {
      result.statsLine = s;
    }
  }

  // Second pass: cargo's detail lives in separate `---- name stdout ----`
  // / `---- name stderr ----` sections, keyed by test name. Accumulate
  // until the next section header, a `failures:` recap, a `test result:`
  // line, or end of input closes the section.
  const detailByName = new Map<string, string[]>();
  let currentName = '';
  let currentBody: string[] = [];

  const flush = () => {
    if (currentName) {
      const existing = detailByName.get(currentName) ?? [];
      detailByName.set(currentName, existing.concat(currentBody));
    }
    currentName = '';
    currentBody = [];
  };

  for (const line of lines) {
    const s = line.trimEnd();
    const m = CARGO_SECTION.exec(s);
    if (m) {
      flush();
      currentName = m[1]!;
      continue;
    }
    if (currentName && (/^failures:/.test(s) || CARGO_RESULT.test(s))) {
      flush();
      continue;
    }
    if (currentName) {
      currentBody.push(s);
    }
  }
  flush();

  for (const name of failNames) {
    const detail = detailByName.get(name);
    const body = detail && detail.length > 0 ? detail.join('\n').trim() : summaryByName.get(name)!;
    result.blocks.push({ name, body });
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

// ───────────────────────────────────────────────────────────────────────────── Delta (--delta) ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of diffing a failure-signature snapshot from a prior run against
 * the current one. `stillFailing` is intentionally not summarized further
 * here -- callers that want a compact report show its length, not its
 * contents; this type carries the full list so a caller that wants detail
 * still can.
 */
export interface FailureDelta {
  hasBaseline: boolean;
  newlyFailing: string[];
  newlyFixed: string[];
  stillFailing: string[];
}

/**
 * Extract a stable per-failure identity list from a parsed result, for
 * diffing across runs. Block names (pytest/jest/go/cargo) are the same test
 * identity the extractors already isolate out of the runner's own failure
 * headers (e.g. pytest's `___ test_foo ___` separator, Go's `--- FAIL:
 * TestFoo`) -- none of them embed a source line number, so line-number
 * drift between two runs of the same test never registers as "a different
 * test". Falls back to summary lines when a runner has no block structure
 * (pytest's FAILED-line fallback path, and the generic/unknown runner).
 * Deduplicated, insertion order preserved.
 */
export function failureSignatures(result: FailureResult): string[] {
  const raw =
    result.blocks.length > 0
      ? result.blocks.map((b) => b.name.trim())
      : result.summaryLines.map((s) => s.trim()).filter((s) => s !== '');
  return Array.from(new Set(raw));
}

/**
 * Diff a previous failure-signature snapshot against the current run's
 * signatures.
 *
 * `prevSignatures === null` means no baseline exists yet for this
 * project/key (the first `--delta` invocation, or a wiped/corrupted state
 * file). Rather than reporting an empty, uninformative delta, everything
 * currently failing is reported as `newlyFailing` -- the first run still
 * surfaces the full failure list (useful on its own), and the caller's
 * output makes clear it's establishing a baseline rather than showing a
 * real regression set.
 */
export function computeFailureDelta(prevSignatures: string[] | null, currSignatures: string[]): FailureDelta {
  if (prevSignatures === null) {
    return { hasBaseline: false, newlyFailing: [...currSignatures], newlyFixed: [], stillFailing: [] };
  }
  const prevSet = new Set(prevSignatures);
  const currSet = new Set(currSignatures);
  return {
    hasBaseline: true,
    newlyFailing: currSignatures.filter((s) => !prevSet.has(s)),
    newlyFixed: prevSignatures.filter((s) => !currSet.has(s)),
    stillFailing: currSignatures.filter((s) => prevSet.has(s)),
  };
}

/**
 * Format a delta result as human-readable text. Still-failing tests are
 * reported as a count, not a full list -- that's the point of `--delta`: an
 * iterate-fix-rerun loop wants "did I fix what I intended, did I break
 * anything new", not a re-dump of everything already known to be failing.
 */
export function formatFailureDeltaText(delta: FailureDelta, runner: string): string {
  if (!delta.hasBaseline) {
    const lines = [
      `No baseline yet for this project/key -- showing all ${delta.newlyFailing.length} current failure(s) as new.  [${runner}]`,
    ];
    if (delta.newlyFailing.length === 0) {
      lines.push('(no failures)');
    } else {
      for (const name of delta.newlyFailing) lines.push(`+ ${name}`);
    }
    return lines.join('\n');
  }

  const lines: string[] = [];
  lines.push(`Newly failing (${delta.newlyFailing.length}):`);
  if (delta.newlyFailing.length === 0) {
    lines.push('  (none)');
  } else {
    for (const name of delta.newlyFailing) lines.push(`  + ${name}`);
  }
  lines.push('');
  lines.push(`Newly fixed (${delta.newlyFixed.length}):`);
  if (delta.newlyFixed.length === 0) {
    lines.push('  (none)');
  } else {
    for (const name of delta.newlyFixed) lines.push(`  - ${name}`);
  }
  lines.push('');
  lines.push(`Still failing (unchanged): ${delta.stillFailing.length}`);
  lines.push(
    `\n[${runner}]  ${delta.newlyFailing.length} newly failing, ${delta.newlyFixed.length} newly fixed, ${delta.stillFailing.length} still failing`
  );
  return lines.join('\n');
}

/**
 * Format a delta result as JSON. Mirrors formatFailureDeltaText's
 * "still-failing is a count, not a dump" choice -- `stillFailingCount` only,
 * not `stillFailing: string[]`, keeping the JSON and text shapes symmetric.
 */
export function formatFailureDeltaJson(delta: FailureDelta, runner: string): string {
  return JSON.stringify(
    {
      runner,
      hasBaseline: delta.hasBaseline,
      newlyFailing: delta.newlyFailing,
      newlyFixed: delta.newlyFixed,
      stillFailingCount: delta.stillFailing.length,
    },
    null,
    2
  );
}
