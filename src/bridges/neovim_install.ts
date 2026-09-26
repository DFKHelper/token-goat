import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteText, backupFile, ensureDirSync, removeFileInScope } from '../util.js';
import { withInstallScope } from './project_scope_guard.js';

export const NEOVIM_GUIDANCE_BEGIN = '-- [[ TOKEN_GOAT_NEOVIM_BEGIN ]]';
export const NEOVIM_GUIDANCE_END = '-- [[ TOKEN_GOAT_NEOVIM_END ]]';

export interface NeovimScopeOptions {
  readonly project?: boolean;
  readonly projectRoot?: string;
}

export interface NeovimInstallResult {
  readonly configPath: string;
  readonly alreadyInstalled: boolean;
  readonly scope: 'project' | 'user';
}

function resolveScope(options: NeovimScopeOptions = {}): 'project' | 'user' {
  if (options.project === true) return 'project';
  const root = options.projectRoot ?? process.cwd();
  if (fs.existsSync(path.join(root, '.nvim')) || fs.existsSync(path.join(root, 'init.lua'))) return 'project';
  return 'user';
}

export function neovimProjectConfigPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, '.nvim', 'token-goat.lua');
}

export function neovimUserConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'nvim', 'after', 'plugin', 'token-goat.lua');
  }
  return path.join(home, '.config', 'nvim', 'after', 'plugin', 'token-goat.lua');
}

export function isNeovimInstalled(options: NeovimScopeOptions = {}): boolean {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const cfgPath = scope === 'project' ? neovimProjectConfigPath(root) : neovimUserConfigPath();
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return raw.includes('TOKEN_GOAT_NEOVIM_BEGIN');
  } catch {
    return false;
  }
}

export function buildNeovimLuaModule(): string {
  return [
    NEOVIM_GUIDANCE_BEGIN,
    '-- token-goat integration for Neovim (Avante.nvim, CopilotChat, CodeCompanion)',
    'local M = {}',
    '',
    'M.search = function(query)',
    '  local cmd = string.format("token-goat search %s --json", vim.fn.shellescape(query))',
    '  local output = vim.fn.system(cmd)',
    '  return vim.fn.json_decode(output)',
    'end',
    '',
    'M.symbol = function(name)',
    '  local cmd = string.format("token-goat symbol %s", vim.fn.shellescape(name))',
    '  return vim.fn.system(cmd)',
    'end',
    '',
    'M.read_symbol = function(spec)',
    '  local cmd = string.format("token-goat read %s", vim.fn.shellescape(spec))',
    '  return vim.fn.system(cmd)',
    'end',
    '',
    '-- Register token-goat user commands in Neovim',
    'if vim.api and vim.api.nvim_create_user_command then',
    '  vim.api.nvim_create_user_command("TokenGoatSearch", function(opts)',
    '    local res = M.search(opts.args)',
    '    if res and res.results then',
    '      vim.notify(string.format("Found %d results for %s", #res.results, opts.args), vim.log.levels.INFO)',
    '    end',
    '  end, { nargs = 1 })',
    'end',
    '',
    'return M',
    NEOVIM_GUIDANCE_END,
  ].join('\n');
}

function installNeovimScoped(options: NeovimScopeOptions = {}): NeovimInstallResult {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const cfgPath = scope === 'project' ? neovimProjectConfigPath(root) : neovimUserConfigPath();

  const cfgDir = path.dirname(cfgPath);
  ensureDirSync(cfgDir);

  let alreadyInstalled = false;
  if (fs.existsSync(cfgPath)) {
    backupFile(cfgPath);
    const existing = fs.readFileSync(cfgPath, 'utf8');
    if (existing.includes(NEOVIM_GUIDANCE_BEGIN)) {
      alreadyInstalled = true;
    }
  }

  const content = buildNeovimLuaModule();
  atomicWriteText(cfgPath, `${content}\n`);

  return {
    configPath: cfgPath,
    alreadyInstalled,
    scope,
  };
}

export function installNeovim(options: NeovimScopeOptions = {}): NeovimInstallResult {
  const scope = resolveScope(options);
  if (scope === 'project') {
    const root = options.projectRoot ?? process.cwd();
    return withInstallScope(root, () => installNeovimScoped(options));
  }
  return installNeovimScoped(options);
}

export function uninstallNeovim(options: NeovimScopeOptions = {}): boolean {
  const scope = resolveScope(options);
  const root = options.projectRoot ?? process.cwd();
  const cfgPath = scope === 'project' ? neovimProjectConfigPath(root) : neovimUserConfigPath();

  if (!fs.existsSync(cfgPath)) return false;

  try {
    backupFile(cfgPath);
    removeFileInScope(cfgPath);
    return true;
  } catch {
    return false;
  }
}
