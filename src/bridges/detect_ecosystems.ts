import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveOnPath } from '../process_util.js';

export interface EcosystemDetectionItem {
  readonly id: string;
  readonly name: string;
  readonly flag: string;
  readonly detected: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface DetectedEcosystems {
  readonly projectRoot: string;
  readonly items: ReadonlyArray<EcosystemDetectionItem>;
  readonly detectedFlags: ReadonlyArray<string>;
}

export interface DetectOptions {
  readonly projectRoot?: string;
  readonly env?: Record<string, string | undefined>;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Detects developer ecosystems and agent harnesses present in the current workspace or environment.
 */
export function detectEcosystems(options: DetectOptions = {}): DetectedEcosystems {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const home = os.homedir();

  const items: EcosystemDetectionItem[] = [];

  // 1. VS Code
  const vsCodeReasons: string[] = [];
  if (exists(path.join(projectRoot, '.vscode'))) vsCodeReasons.push('Workspace contains .vscode directory');
  if (resolveOnPath('code') || resolveOnPath('code-insiders')) vsCodeReasons.push('code executable found on PATH');
  if (env['VSCODE_PID'] || env['VSCODE_INJECTION']) vsCodeReasons.push('Running inside VS Code session');
  items.push({
    id: 'vscode',
    name: 'VS Code',
    flag: '--vscode',
    detected: vsCodeReasons.length > 0,
    reasons: vsCodeReasons,
  });

  // 2. Copilot CLI
  const copilotReasons: string[] = [];
  if (exists(path.join(projectRoot, '.github', 'hooks'))) copilotReasons.push('Workspace contains .github/hooks');
  if (resolveOnPath('copilot')) copilotReasons.push('copilot CLI binary found on PATH');
  if (resolveOnPath('gh')) copilotReasons.push('GitHub CLI found on PATH');
  items.push({
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    flag: '--copilot',
    detected: copilotReasons.length > 0,
    reasons: copilotReasons,
  });

  // 3. Visual Studio Enterprise / Professional
  const vsReasons: string[] = [];
  if (exists(path.join(projectRoot, '.vs'))) vsReasons.push('Workspace contains .vs directory');
  if (env['VSINSTALLDIR']) vsReasons.push('Visual Studio installation environment active');
  if (resolveOnPath('devenv')) vsReasons.push('devenv executable found on PATH');
  items.push({
    id: 'visualstudio',
    name: 'Visual Studio',
    flag: '--visualstudio',
    detected: vsReasons.length > 0,
    reasons: vsReasons,
  });

  // 4. JetBrains Suite
  const jbReasons: string[] = [];
  if (exists(path.join(projectRoot, '.idea'))) jbReasons.push('Workspace contains .idea directory');
  const jbBins = ['idea', 'pycharm', 'webstorm', 'rider', 'goland', 'clion', 'rubymine', 'phpstorm'];
  for (const b of jbBins) {
    if (resolveOnPath(b)) {
      jbReasons.push(`JetBrains ${b} binary found on PATH`);
      break;
    }
  }
  if (env['JETBRAINS_INTELLIJ'] || env['IDEA_INITIAL_DIRECTORY']) jbReasons.push('JetBrains environment active');
  items.push({
    id: 'jetbrains',
    name: 'JetBrains Suite',
    flag: '--jetbrains',
    detected: jbReasons.length > 0,
    reasons: jbReasons,
  });

  // 5. Neovim
  const nvimReasons: string[] = [];
  if (resolveOnPath('nvim')) nvimReasons.push('nvim binary found on PATH');
  if (exists(path.join(projectRoot, 'init.lua')) || exists(path.join(projectRoot, 'init.vim'))) nvimReasons.push('Neovim configuration file in workspace');
  if (exists(path.join(projectRoot, '.nvim')) || exists(path.join(projectRoot, '.vim'))) nvimReasons.push('Neovim workspace directory detected');
  if (exists(path.join(home, '.config', 'nvim')) || exists(path.join(home, 'AppData', 'Local', 'nvim'))) nvimReasons.push('User Neovim configuration directory detected');
  if (env['NVIM']) nvimReasons.push('Active Neovim terminal session');
  items.push({
    id: 'neovim',
    name: 'Neovim',
    flag: '--neovim',
    detected: nvimReasons.length > 0,
    reasons: nvimReasons,
  });

  // 6. Cursor
  const cursorReasons: string[] = [];
  if (exists(path.join(projectRoot, '.cursor')) || exists(path.join(projectRoot, '.cursorrules'))) cursorReasons.push('Workspace contains Cursor config');
  if (resolveOnPath('cursor')) cursorReasons.push('cursor binary found on PATH');
  items.push({
    id: 'cursor',
    name: 'Cursor',
    flag: '--cursor',
    detected: cursorReasons.length > 0,
    reasons: cursorReasons,
  });

  // 7. Codex
  const codexReasons: string[] = [];
  if (exists(path.join(projectRoot, '.codex'))) codexReasons.push('Workspace contains .codex directory');
  if (resolveOnPath('codex')) codexReasons.push('codex binary found on PATH');
  items.push({
    id: 'codex',
    name: 'Codex',
    flag: '--codex',
    detected: codexReasons.length > 0,
    reasons: codexReasons,
  });

  // 8. Claude Code
  const claudeReasons: string[] = [];
  if (exists(path.join(projectRoot, '.claude')) || exists(path.join(projectRoot, 'CLAUDE.md'))) claudeReasons.push('Workspace contains Claude config / CLAUDE.md');
  if (resolveOnPath('claude')) claudeReasons.push('claude binary found on PATH');
  items.push({
    id: 'claudecode',
    name: 'Claude Code',
    flag: '--user',
    detected: claudeReasons.length > 0,
    reasons: claudeReasons,
  });

  // 9. Zed
  const zedReasons: string[] = [];
  if (exists(path.join(projectRoot, '.zed'))) zedReasons.push('Workspace contains .zed directory');
  if (resolveOnPath('zed')) zedReasons.push('zed binary found on PATH');
  items.push({
    id: 'zed',
    name: 'Zed',
    flag: '--zed',
    detected: zedReasons.length > 0,
    reasons: zedReasons,
  });

  // 10. OpenCode
  const opencodeReasons: string[] = [];
  if (resolveOnPath('opencode')) opencodeReasons.push('opencode binary found on PATH');
  items.push({
    id: 'opencode',
    name: 'OpenCode',
    flag: '--opencode',
    detected: opencodeReasons.length > 0,
    reasons: opencodeReasons,
  });

  // 11. Gemini CLI
  const geminiReasons: string[] = [];
  if (resolveOnPath('gemini')) geminiReasons.push('gemini binary found on PATH');
  items.push({
    id: 'gemini',
    name: 'Gemini CLI',
    flag: '--gemini',
    detected: geminiReasons.length > 0,
    reasons: geminiReasons,
  });

  const detectedFlags = items.filter((item) => item.detected).map((item) => item.flag);

  return {
    projectRoot,
    items,
    detectedFlags,
  };
}
