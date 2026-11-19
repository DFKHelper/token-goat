/** Compact CLI help generation. Also holds the neighbor-contrast rows the skill and read hints render from; tests/guards/command_contrast_coverage.test.ts checks them. */

export interface ContrastRow {
  readonly command: string
  readonly useFor: string
  readonly notFor: string
  readonly neighbor: string
}

export const COMMAND_CONTRAST_ROWS: readonly ContrastRow[] = [
  { command: 'symbol', useFor: 'finding where a name is defined', notFor: 'its body once the file is known', neighbor: 'read' },
  { command: 'read', useFor: "one symbol's full body once its file is known", notFor: 'finding a name across the project', neighbor: 'symbol' },
  { command: 'search', useFor: 'a known name, heading or phrase across every channel', notFor: 'a concept described in other words', neighbor: 'semantic' },
  { command: 'semantic', useFor: 'a concept when the exact name is unknown', notFor: 'a literal name you already have', neighbor: 'search' },
  { command: 'outline', useFor: 'line ranges and docstrings to pick a read window', notFor: 'signatures alone', neighbor: 'skeleton' },
  { command: 'skeleton', useFor: 'signatures of every symbol with bodies left out', notFor: 'line ranges to read from', neighbor: 'outline' },
]

/** One rendered line for a row, without a list marker or indent. */
export function renderContrastLine(row: ContrastRow): string {
  return `use \`${row.command}\` for ${row.useFor}, not ${row.notFor} (use \`${row.neighbor}\`)`
}

export function generateCompactHelp(): string {
  const contrastLines = COMMAND_CONTRAST_ROWS.map((row) => `  ${renderContrastLine(row)}`)
  const lines = [
    'Usage: token-goat [options] [command]',
    '',
    'Surgical companion for AI coding agents that saves turns, context and tokens',
    '',
    'Options:',
    '  -v, --version                   print the token-goat version',
    '  --cwd <path>                    run as if invoked from this directory',
    '  --notice <text>                 print this line before the command\'s own output',
    '  -h, --help                      display help for command',
    '',
    'Reads: symbol, read, peek, brief, section, semantic, skeleton, outline, refs, scope,',
    '  similar, context-for, call-chain, impact, callers, dead, test-for, locate',
    '',
    'Analysis: arch, affected, blame, deps, importers, types, coverage-gaps, changed, diff, log,',
    '  exports, imports, find, grep',
    '',
    'File Formats: pdf-meta, pdf-outline, pdf-extract, pdf-locate, xlsx-sheets,',
    '  xlsx-head, xlsx-columns, xlsx-query, xlsx-range, yaml-outline, yaml-query,',
    '  json-outline, json-query, xml-outline, xml-query, html-outline, html-query,',
    '  html-lint, php-lint, docx-outline, docx-tables, docx-text, pptx-outline,',
    '  pptx-slide, pptx-text, pptx-notes',
    '',
    'Index & Search: index, map, reconcile, doctor, commands, ask, answer, pack, tokens,',
    '  search, budget, failures, todo, trace, logfold, lockdeps, manifest-sweep, dep-docs, recent, hot,',
    '  baseline, cost, coverage-report-gaps, clean-cache,',
    '  cache-audit, reclaim-index, project',
    '',
    'Checks: gate, permissions',
    '',
    'Session: stats, waste, session-outline, session-audit, session-slice,',
    '  session-summary, context-stats, bootstrap-audit, memory, hint-stats,',
    '  session-schema, mcp-audit, audit',
    '',
    'Skills: skill-body, skill-compact, skill-list, skill-size, skill-history,',
    '  skill-diff, skill-section, listing-size',
    '',
    'Compression: compress-text, retrieve, handoff-create, handoff-resolve,',
    '  compress, recall, bash-output, web-output, mcp-output, bench',
    '',
    'Config & Integration: install, uninstall, upgrade, mcp-serve, mcp-status, hook,',
    '  bridges-status, worker, hook-server, statusline, version, config, config-get,',
    '  capabilities, help',
    '',
    'Data: note, note-add, note-get, note-list, describe, sqlite-query,',
    '  sqlite-tables, sqlite-schema, csv-profile, csv-query',
    '',
    'Utils: ignores, bash-history, web-history, history, openapi-op, openapi-outline,',
    '  gdrive-sections, screenshot, fetch-image, image-meta,',
    '  image-text, image-slice, image-diff, resume, replace, insert-section, pr-slice,',
    '  sharepoint-resolve, transcript, transcript-outline, video-chapters,',
    '  write-file, zip-list, zip-read, mcp-history, compact-doc, compact-hint,',
    '  conflicts, prune-cache',
    '',
    'Tip: look up one command instead of this whole list: `token-goat help <command>`, or `token-goat commands --grep <pattern>` anchored (\'^read$\' ~700B; bare \'read\' matches descriptions too, ~7KB).',
    '',
    '  Neighbor commands (use the one that matches the job):',
    ...contrastLines,
    '',
  ]
  return lines.join('\n')
}
