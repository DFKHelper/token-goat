import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import Database from '../src/sqlite_driver.js';
import {
  clearSharedSessionValues,
  deleteSharedSessionValue,
  getSharedSessionValue,
  listSharedSessionValues,
  setSharedSessionValue,
} from '../src/session_store.js';
import {
  clearAll,
  clearSymbolDiscoveries,
  deleteSymbolDiscovery,
  findSymbolDiscoveries,
  getSymbolDiscovery,
  listSymbolDiscoveries,
  recordSymbolDiscovery,
  searchSymbolDiscoveries,
} from '../src/project_memory.js';
import { getSharedMemoryDb, sharedMemoryDigest } from '../src/shared_memory_db.js';

describe('shared memory registry', () => {
  const sessionIds: string[] = [];
  const projectHashes: string[] = [];

  const createSessionId = (): string => {
    const value = `shared-memory-${randomUUID()}`;
    sessionIds.push(value);
    return value;
  };

  const createProjectHash = (): string => {
    const value = `shared-project-${randomUUID()}`;
    projectHashes.push(value);
    return value;
  };

  afterEach(() => {
    for (const sessionId of sessionIds.splice(0)) clearSharedSessionValues(sessionId);
    for (const projectHash of projectHashes.splice(0)) clearSymbolDiscoveries(projectHash);
  });

  it('shares values between a parent session and agent-salted children, but not other sessions', () => {
    const sessionId = createSessionId();
    const firstAgent = `${sessionId}:agent:agent-one`;
    const nestedAgent = `${firstAgent}:agent:agent-two`;
    const otherSession = createSessionId();

    const entry = setSharedSessionValue(firstAgent, 'architecture.database', 'Use SQLite WAL.');

    expect(getSharedSessionValue(sessionId, 'architecture.database')).toEqual(entry);
    expect(getSharedSessionValue(nestedAgent, 'architecture.database')).toEqual(entry);
    expect(getSharedSessionValue(otherSession, 'architecture.database')).toBeNull();
  });

  it('upserts values, filters lists by prefix, and supports deletion and clearing', () => {
    const sessionId = createSessionId();
    const apiKey = 'architecture.api.shape';
    const dependencyKey = 'dependencies.sqlite';

    setSharedSessionValue(sessionId, apiKey, 'First shape.');
    const updated = setSharedSessionValue(sessionId, apiKey, 'Updated shape.');
    setSharedSessionValue(sessionId, dependencyKey, 'better-sqlite3');

    expect(getSharedSessionValue(sessionId, apiKey)).toEqual(updated);
    expect(listSharedSessionValues(sessionId, { prefix: 'architecture.' })).toHaveLength(1);
    expect(listSharedSessionValues(sessionId, { prefix: '' })).toHaveLength(2);
    expect(listSharedSessionValues(sessionId, { prefix: 'architecture.' })[0]).toMatchObject({
      key: apiKey,
      value: 'Updated shape.',
    });
    expect(listSharedSessionValues(sessionId, { limit: 1 })).toHaveLength(1);
    expect(deleteSharedSessionValue(sessionId, apiKey)).toBe(true);
    expect(deleteSharedSessionValue(sessionId, apiKey)).toBe(false);
    expect(clearSharedSessionValues(sessionId)).toBe(1);
    expect(listSharedSessionValues(sessionId)).toEqual([]);
  });

  it('shares committed values across independent SQLite connections', () => {
    const sessionId = createSessionId();
    const key = 'architecture.storage';
    setSharedSessionValue(sessionId, key, 'written through the registry');

    const secondConnection = new Database(getSharedMemoryDb().name);
    try {
      const row = secondConnection.prepare(`
        SELECT value
        FROM shared_session_values
        WHERE session_hash = ? AND key_hash = ?
      `).get(sharedMemoryDigest(sessionId), sharedMemoryDigest(key)) as { value: string } | undefined;
      expect(row?.value).toBe('written through the registry');

      secondConnection.prepare(`
        UPDATE shared_session_values
        SET value = ?
        WHERE session_hash = ? AND key_hash = ?
      `).run('written through another connection', sharedMemoryDigest(sessionId), sharedMemoryDigest(key));
      expect(getSharedSessionValue(sessionId, key)?.value).toBe('written through another connection');
    } finally {
      secondConnection.close();
    }
  });

  it('redacts both key labels and values before persisting session context', () => {
    const sessionId = createSessionId();
    const secret = `ghp_${'a'.repeat(36)}`;
    const key = `api.${secret}`;
    const entry = setSharedSessionValue(sessionId, key, `Token: ${secret}`);

    expect(entry.key).not.toContain(secret);
    expect(entry.value).not.toContain(secret);

    const row = getSharedMemoryDb().prepare(`
      SELECT key_display, value
      FROM shared_session_values
      WHERE session_hash = ? AND key_hash = ?
    `).get(sharedMemoryDigest(sessionId), sharedMemoryDigest(key)) as { key_display: string; value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('records, normalizes, searches, and updates project symbol discoveries', () => {
    const projectHash = createProjectHash();
    const first = recordSymbolDiscovery(projectHash, {
      file: 'src\\db.ts',
      symbol: 'getDb',
      summary: 'Opens or reuses a SQLite connection.',
      dependencies: ['better-sqlite3', 'src/sqlite_driver.ts'],
    });

    expect(first.file).toBe('src/db.ts');
    expect(getSymbolDiscovery(projectHash, 'src/db.ts', 'getDb')).toEqual(first);
    expect(findSymbolDiscoveries(projectHash, 'getDb')).toEqual([first]);
    expect(searchSymbolDiscoveries(projectHash, 'sqlite connection')).toEqual([first]);

    const updated = recordSymbolDiscovery(projectHash, {
      file: 'src/db.ts',
      symbol: 'getDb',
      summary: 'Caches initialized SQLite connections by path.',
      dependencies: ['src/sqlite_driver.ts'],
    });
    expect(listSymbolDiscoveries(projectHash)).toEqual([updated]);
    expect(findSymbolDiscoveries(projectHash, 'getDb')).toHaveLength(1);
  });

  it('redacts symbol metadata and isolates records by project', () => {
    const projectHash = createProjectHash();
    const otherProject = createProjectHash();
    const secret = `ghp_${'b'.repeat(36)}`;

    const discovery = recordSymbolDiscovery(projectHash, {
      file: `src/${secret}.ts`,
      symbol: `lookup_${secret}`,
      summary: `API token ${secret}`,
      dependencies: [`package:${secret}`],
    });
    recordSymbolDiscovery(otherProject, {
      file: 'src/client.ts',
      symbol: 'lookup',
      summary: 'A separate project finding.',
    });

    expect(discovery.file).not.toContain(secret);
    expect(discovery.symbol).not.toContain(secret);
    expect(discovery.summary).not.toContain(secret);
    expect(discovery.dependencies.join(' ')).not.toContain(secret);

    const row = getSharedMemoryDb().prepare(`
      SELECT file_display, symbol_display, summary, dependencies_json
      FROM project_symbol_discoveries
      WHERE project_hash = ?
    `).get(sharedMemoryDigest(projectHash)) as Record<string, string> | undefined;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(searchSymbolDiscoveries(projectHash, 'lookup')).toEqual([discovery]);
    expect(searchSymbolDiscoveries(otherProject, 'lookup')).toHaveLength(1);
  });

  it('supports exact deletion and clears project discoveries with project memory', () => {
    const projectHash = createProjectHash();
    const otherProject = createProjectHash();
    const discovery = recordSymbolDiscovery(projectHash, {
      file: 'src/client.ts',
      symbol: 'fetchUser',
      summary: 'Calls the user API.',
    });
    recordSymbolDiscovery(otherProject, {
      file: 'src/client.ts',
      symbol: 'fetchUser',
      summary: 'Calls a different user API.',
    });

    expect(deleteSymbolDiscovery(projectHash, discovery.file, discovery.symbol)).toBe(true);
    expect(deleteSymbolDiscovery(projectHash, discovery.file, discovery.symbol)).toBe(false);
    recordSymbolDiscovery(projectHash, {
      file: 'src/client.ts',
      symbol: 'fetchUser',
      summary: 'Calls the user API.',
    });

    clearAll(projectHash);

    expect(getSymbolDiscovery(projectHash, 'src/client.ts', 'fetchUser')).toBeNull();
    expect(getSymbolDiscovery(otherProject, 'src/client.ts', 'fetchUser')).not.toBeNull();
  });

  it('rejects invalid bounded inputs and safely handles SQL-shaped keys', () => {
    const sessionId = createSessionId();
    const projectHash = createProjectHash();
    const sqlShapedKey = "name'); DROP TABLE shared_session_values;--";

    setSharedSessionValue(sessionId, sqlShapedKey, 'still stored');
    expect(getSharedSessionValue(sessionId, sqlShapedKey)?.value).toBe('still stored');
    expect(() => getSharedSessionValue(':agent:missing-parent', 'key')).toThrow();
    expect(() => setSharedSessionValue(sessionId, '  ', 'value')).toThrow();
    expect(() => setSharedSessionValue(sessionId, 'large', 'x'.repeat(32_001))).toThrow();
    expect(() => listSharedSessionValues(sessionId, { limit: 0 })).toThrow();

    expect(() => recordSymbolDiscovery(projectHash, {
      file: '../outside.ts',
      symbol: 'readFile',
      summary: 'Invalid path.',
    })).toThrow();
    expect(() => searchSymbolDiscoveries(projectHash, '')).toThrow();
    expect(() => listSymbolDiscoveries(projectHash, 0)).toThrow();
    expect(getSharedMemoryDb().prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', 'shared_session_values')).toBeDefined();
  });
});
