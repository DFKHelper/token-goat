import { createHash } from 'node:crypto';
import { ensureDirSync } from './util.js';
import * as path from 'node:path';

import { dataDir } from './constants.js';
import { redactSecrets } from './secret_redact.js';
import Database from './sqlite_driver.js';

const SHARED_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_session_values (
  session_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_display TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_hash, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_shared_session_values_recent
  ON shared_session_values (session_hash, updated_at DESC, key_display, key_hash);

CREATE TABLE IF NOT EXISTS project_symbol_discoveries (
  project_hash TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  symbol_hash TEXT NOT NULL,
  file_display TEXT NOT NULL,
  symbol_display TEXT NOT NULL,
  summary TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_hash, file_hash, symbol_hash)
);
CREATE INDEX IF NOT EXISTS idx_project_symbol_discoveries_symbol
  ON project_symbol_discoveries (project_hash, symbol_hash, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_symbol_discoveries_recent
  ON project_symbol_discoveries (project_hash, updated_at DESC);
`;

const connections = new Map<string, Database>();

export function getSharedMemoryDb(): Database {
  const dbPath = path.resolve(dataDir(), 'shared-memory.sqlite3');
  const existing = connections.get(dbPath);
  if (existing?.open === true) return existing;

  ensureDirSync(path.dirname(dbPath));
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SHARED_MEMORY_SCHEMA);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization error.
    }
    throw error;
  }
  connections.set(dbPath, db);
  return db;
}

export function sharedMemoryDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function redactSharedMemoryText(value: string): string {
  return redactSecrets(value).text;
}
