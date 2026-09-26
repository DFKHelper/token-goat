import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteText, backupFile, ensureDirSync, removeFileInScope } from '../util.js';
import { writeJsonSettings } from '../util_config.js';
import { withInstallScope } from './project_scope_guard.js';

export const JETBRAINS_GUIDANCE_BEGIN = '<!-- TOKEN_GOAT_JETBRAINS_BEGIN -->';
export const JETBRAINS_GUIDANCE_END = '<!-- TOKEN_GOAT_JETBRAINS_END -->';

export interface JetbrainsScopeOptions {
  readonly project?: boolean;
  readonly projectRoot?: string;
}

export interface JetbrainsInstallResult {
  readonly mcpPath: string;
  readonly instructionsPath: string;
  readonly alreadyInstalled: boolean;
  readonly scope: 'project' | 'user';
}

function resolveScope(options: JetbrainsScopeOptions = {}): 'project' | 'user' {
  if (options.project === true) return 'project';
  const root = options.projectRoot ?? process.cwd();
  if (fs.existsSync(path.join(root, '.idea'))) return 'project';
  return 'user';
}

export function jetbrainsProjectMcpPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, '.idea', 'mcp.json');
}

export function jetbrainsUserMcpPath(): string {
  return path.join(os.homedir(), '.config', 'JetBrains', 'mcp.json');
}

export function jetbrainsInstructionsPath(scope: 'project' | 'user', projectRoot: string = process.cwd()): string {
  if (scope === 'project') {
    return path.join(projectRoot, '.idea', 'copilot-instructions.md');
  }
  return path.join(os.homedir(), '.config', 'JetBrains', 'copilot-instructions.md');
}

export function isJetbrainsInstalled(options: JetbrainsScopeOptions = {}): boolean {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const mcpPath = scope === 'project' ? jetbrainsProjectMcpPath(root) : jetbrainsUserMcpPath();
  if (!fs.existsSync(mcpPath)) return false;
  try {
    const raw = fs.readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed.mcpServers?.['token-goat']);
  } catch {
    return false;
  }
}

export function buildJetbrainsGuidanceBlock(): string {
  return [
    JETBRAINS_GUIDANCE_BEGIN,
    '## token-goat: JetBrains Suite & Copilot Integration',
    'Before reading or searching full files, run token-goat commands to reduce token burn:',
    '- `token-goat symbol <name>`: Resolve definitions without loading whole files.',
    '- `token-goat read "file::symbol"`: Read only the targeted function or class.',
    '- `token-goat section "file::Heading"`: Extract targeted documentation or sections.',
    '- `token-goat search <query>`: Run parallel multi-angle search across symbols, headings, and text.',
    '- `token-goat outline <file>`: Inspect structure before reading full content.',
    JETBRAINS_GUIDANCE_END,
  ].join('\n');
}

function installJetbrainsScoped(options: JetbrainsScopeOptions = {}): JetbrainsInstallResult {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const mcpPath = scope === 'project' ? jetbrainsProjectMcpPath(root) : jetbrainsUserMcpPath();
  const instrPath = jetbrainsInstructionsPath(scope, root);

  const mcpDir = path.dirname(mcpPath);
  ensureDirSync(mcpDir);

  let alreadyInstalled = false;
  let currentConfig: Record<string, unknown> = {};

  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf8');
      currentConfig = JSON.parse(raw);
      const existingServers = currentConfig['mcpServers'] as Record<string, unknown> | undefined;
      if (existingServers?.['token-goat']) {
        alreadyInstalled = true;
      }
    } catch {
      currentConfig = {};
    }
  }

  // Register token-goat MCP server for JetBrains
  const mcpServers = (currentConfig['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  mcpServers['token-goat'] = {
    command: process.execPath,
    args: ['mcp-serve'],
    env: {
      TOKEN_GOAT_HARNESS_OVERRIDE: 'jetbrains',
    },
  };

  writeJsonSettings(mcpPath, { ...currentConfig, mcpServers });

  // Update or write JetBrains Copilot instructions
  const instrDir = path.dirname(instrPath);
  ensureDirSync(instrDir);

  const guidanceBlock = buildJetbrainsGuidanceBlock();
  let instrContent = '';
  if (fs.existsSync(instrPath)) {
    backupFile(instrPath);
    instrContent = fs.readFileSync(instrPath, 'utf8');
  }

  if (instrContent.includes(JETBRAINS_GUIDANCE_BEGIN)) {
    const regex = new RegExp(`${JETBRAINS_GUIDANCE_BEGIN}[\\s\\S]*?${JETBRAINS_GUIDANCE_END}`, 'g');
    instrContent = instrContent.replace(regex, guidanceBlock);
  } else {
    instrContent = instrContent ? `${instrContent.trimEnd()}\n\n${guidanceBlock}\n` : `${guidanceBlock}\n`;
  }

  atomicWriteText(instrPath, instrContent);

  return {
    mcpPath,
    instructionsPath: instrPath,
    alreadyInstalled,
    scope,
  };
}

export function installJetbrains(options: JetbrainsScopeOptions = {}): JetbrainsInstallResult {
  const scope = resolveScope(options);
  if (scope === 'project') {
    const root = options.projectRoot ?? process.cwd();
    return withInstallScope(root, () => installJetbrainsScoped(options));
  }
  return installJetbrainsScoped(options);
}

export function uninstallJetbrains(options: JetbrainsScopeOptions = {}): boolean {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const mcpPath = scope === 'project' ? jetbrainsProjectMcpPath(root) : jetbrainsUserMcpPath();
  const instrPath = jetbrainsInstructionsPath(scope, root);

  let uninstalled = false;

  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.mcpServers?.['token-goat']) {
        delete parsed.mcpServers['token-goat'];
        backupFile(mcpPath);
        writeJsonSettings(mcpPath, parsed);
        uninstalled = true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (fs.existsSync(instrPath)) {
    try {
      const raw = fs.readFileSync(instrPath, 'utf8');
      if (raw.includes(JETBRAINS_GUIDANCE_BEGIN)) {
        backupFile(instrPath);
        const regex = new RegExp(`\\n?${JETBRAINS_GUIDANCE_BEGIN}[\\s\\S]*?${JETBRAINS_GUIDANCE_END}\\n?`, 'g');
        const updated = raw.replace(regex, '\n').trimEnd();
        if (updated) {
          atomicWriteText(instrPath, `${updated}\n`);
        } else {
          removeFileInScope(instrPath);
        }
        uninstalled = true;
      }
    } catch {
      // Ignore file errors
    }
  }

  return uninstalled;
}
