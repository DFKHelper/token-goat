// Whether an anchored note's symbol still has the body it had when the note was set. Read-time, against the index the worker's reindex keeps current, so the worker never has to write the notes file. Callers load this module lazily and hand anchorStatus to project_memory.ts as its AnchorStatusOf, which keeps the index reader off every hook's eager import path.

import * as fs from 'node:fs';
import { globalDbPath } from './constants.js';
import { computeSymbolFingerprint, symbolNamesInFile } from './notes.js';
import { resolveIndexPath } from './paths.js';
import type { AnchorStatus, NoteAnchor } from './project_memory.js';

/** Compare the anchored symbol's indexed body under `root` against the hash recorded when the note was set. */
export function anchorStatus(root: string, anchor: NoteAnchor, dbPath: string = globalDbPath()): AnchorStatus {
  try {
    const abs = resolveIndexPath(anchor.file, root);
    if (!fs.existsSync(abs)) return 'gone';
    const now = computeSymbolFingerprint(abs, anchor.symbol, dbPath);
    if (now !== null) return now === anchor.sha ? 'current' : 'changed';
    // No row for the symbol. That means it is gone only when the file has rows at all; a file the index has not reached yet says nothing about it.
    return symbolNamesInFile(abs, dbPath).length > 0 ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}
