/**
 * Cross-invocation state for `token-goat failures --delta` -- persists the
 * failure-signature set (test names / summary lines, see
 * `failures.ts::failureSignatures`) from the last `failures` invocation for
 * a given (project, key) pair, so a later invocation can diff against it and
 * report only what changed.
 *
 * `failures` is a standalone CLI command run directly by a human/agent, not
 * a harness-fired hook, so there's no natural (sessionId, bash_id) identity
 * to key snapshots by the way hooks_bashoutput.ts does for BashOutput polls.
 * Instead this mirrors project_memory.ts's per-project persistent state:
 * keyed by project hash (from project.ts::findProject) plus an explicit
 * `key` string the caller supplies via `--key` (defaulting to 'default'), so
 * multiple independent suites in the same project (e.g. a pytest run and a
 * Jest run) can be tracked separately by passing distinct --key values
 * without clobbering each other's baseline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir } from './constants.js';
import { atomicWriteText, ensureDirSync, withFileLock } from './util.js';

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Default state key when the caller doesn't pass --key. */
export const DEFAULT_FAILURES_STATE_KEY = 'default';

/** Persisted snapshot of the failure set from the last `--delta` invocation. */
export interface FailureSnapshot {
  signatures: string[];
  runner: string;
  storedAt: number;
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `Invalid --key ${JSON.stringify(key)}: use only letters, digits, hyphens, underscores (max 80 chars)`
    );
  }
}

/**
 * Path to the persisted failure-snapshot state file for (projectHash, key).
 * Throws if `key` fails validation (same charset as project_memory.ts's
 * memory keys) -- a raw, unvalidated key would otherwise let `--key` write
 * outside the intended `projects/` directory via path separators.
 */
export function failuresStatePath(projectHash: string, key: string): string {
  validateKey(key);
  return path.join(dataDir(), 'projects', `${projectHash}_failures_${key}.json`);
}

/**
 * Read the persisted snapshot for (projectHash, key).
 * Returns null on a missing file, a read/parse error, or content that
 * doesn't match the expected shape (fail-soft: a wiped or corrupted state
 * file degrades to "no baseline yet" rather than crashing the command).
 */
export function loadFailureSnapshot(projectHash: string, key: string): FailureSnapshot | null {
  const p = failuresStatePath(projectHash, key);
  try {
    if (!fs.existsSync(p)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as { signatures?: unknown; runner?: unknown; storedAt?: unknown };
    if (!Array.isArray(obj.signatures)) return null;
    return {
      signatures: obj.signatures.filter((s): s is string => typeof s === 'string'),
      runner: typeof obj.runner === 'string' ? obj.runner : 'unknown',
      storedAt: typeof obj.storedAt === 'number' ? obj.storedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Persist `snapshot` as the last-seen failure set for (projectHash, key). */
export function saveFailureSnapshot(projectHash: string, key: string, snapshot: FailureSnapshot): void {
  const p = failuresStatePath(projectHash, key);
  const dir = path.dirname(p);
  ensureDirSync(dir);
  const content = JSON.stringify(snapshot);

  // Lock the write like project_memory.ts's setEntry: two concurrent `failures --delta`
  // invocations for the same (project, key) could otherwise race on the save. Low-frequency CLI
  // path, so fall back to an unprotected write on a failed lock acquire rather than blocking.
  const doSave = (): true => {
    atomicWriteText(p, content);
    return true;
  };
  if (withFileLock(`${p}.lock`, doSave) === undefined) doSave();
}
