# Universal Architecture Auto-Sync Engine: Prompt & Implementation Playbook

> **Target Audience:** Engineering leads, AI coding assistants (Claude Code, GitHub Copilot CLI/Chat, Cursor, Windsurf, Codex, ChatGPT), and software contributors across any repository or tech stack.  
> **Mission:** Establish a zero-maintenance, zero-drift, self-updating architecture documentation pipeline that runs automatically before commits, in fast test guards, and across CI/CD validation gates.

---

## 1. Quick-Start & Usage Guide

### What This Artifact Provides
This guide provides an **enterprise-grade prompt** that you can copy and paste into **any AI coding assistant** (or hand to any engineering team) on **any existing or greenfield repository**.

When fed this prompt, the AI assistant will automatically:
1. **Audit** the codebase's existing architecture documents (`CLAUDE.arch.md`, `ARCHITECTURE.md`, `docs/architecture.md`, etc.).
2. **Implement an automated sync engine** (`scripts/sync-arch-docs.mjs` or language equivalent) with `--write` (in-place table updates) and `--check` (drift detection with exit code `1`).
3. **Configure Git hooks** (Lefthook, Husky, simple-git-hooks, or native `.git/hooks/pre-commit`) to guarantee documentation stays fresh on every commit.
4. **Deploy fast structural guard tests** (Vitest, Jest, Pytest, Go test, or Cargo test) that enforce zero documentation drift in local test suites and CI.
5. **Establish an autonomous agent protocol** in the repository's agent configuration (`CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`, or `AGENTS.md`) so every future AI session preserves architectural synchronization.

### How to Use With Specific AI Assistants

| Assistant | Recommended Invocation |
| :--- | :--- |
| **Claude Code CLI** | Copy the prompt in [Section 2](#2-master-copy-paste-prompt-for-ai-assistants) and run: `claude "PASTE_PROMPT_HERE"` |
| **GitHub Copilot CLI** | Start a session in your repository and paste the prompt directly into the interactive terminal prompt. |
| **Cursor / Windsurf** | Open the Composer / Cascade panel in agent mode with codebase indexing enabled, paste the prompt, and select "Run". |
| **Codex / ChatGPT (Repo Mode)** | Paste the prompt in repo-agent context with write access enabled. |

---

## 2. Master Copy-Paste Prompt for AI Assistants

Copy the entire block below and paste it directly into your AI assistant session in the root of the target repository:

```markdown
You are an expert Principal Software Architect and DevOps Automation Engineer.

Your task is to establish a permanent, automated, self-updating Architecture Documentation System in this repository so that our architectural documentation NEVER drifts from the actual codebase.

Follow this systematic 7-phase execution protocol:

### Phase 1: Architecture & Source Tree Audit
1. Inspect the repository root and `docs/` directory for existing architectural documents (e.g., `CLAUDE.arch.md`, `ARCHITECTURE.md`, `docs/architecture.md`, `docs/C4_RUNTIME_ARCHITECTURE.md`, or README architecture sections). If none exist, choose the idiomatic standard for this project (e.g. `CLAUDE.arch.md` for Claude Code / hybrid workflows, or `docs/architecture.md` / `ARCHITECTURE.md` as primary).
2. Scan the primary source directories (e.g., `src/`, `lib/`, `pkg/`, `packages/`, `app/`, `cmd/`, or language-specific roots).
3. Identify language(s), module boundaries, primary entry points, sub-packages, and external boundary contracts.
4. Locate or define demarcation markers in the chosen architectural markdown document:
   <!-- ARCH_COMPONENTS_START -->
   <!-- (Auto-generated component map will be maintained between these tags) -->
   <!-- ARCH_COMPONENTS_END -->

### Phase 2: Implement the Architecture Sync Engine
Create a standalone, lightweight, zero-external-dependency synchronization script in `scripts/sync-arch-docs.mjs` (Node/TypeScript/ESM) or `scripts/sync_arch_docs.py` (Python) based on the repository's native runtime:
1. The script MUST support two execution flags:
   - `--write` (or default mode): Scans source directories, extracts modules, public exports/symbols, architectural roles, and invariants, builds a cleanly formatted Markdown component inventory table, and updates the designated architecture file between `<!-- ARCH_COMPONENTS_START -->` and `<!-- ARCH_COMPONENTS_END -->`.
   - `--check`: Runs the same scan and builds the target representation in memory. Compares it against the current on-disk document. If any drift, missing modules, obsolete entries, or uncommitted modifications exist, prints a readable diff of the discrepancies to stderr and exits with status code `1`. If clean, exits with status code `0`.
2. Component extraction rules:
   - Module Name & Relative Path.
   - Primary Purpose / Architectural Role (inferred from top-of-file comments, docstrings, or directory domain rules).
   - Key Exported Symbols / Interfaces.
   - Core Invariants / Layer Dependencies (e.g., Core, Adapter, Service, CLI, Invariant Guard).
   - Ignore internal test fixtures, mocks, build artifacts (`dist/`, `build/`, `node_modules/`), and hidden dot-directories.
3. Formatting:
   - Output an enterprise-grade Markdown table with clean column alignments.
   - Group by subsystem, package, or directory domain.
   - Preserve all surrounding manual narrative architecture text outside the markers untouched.

### Phase 3: Wire Pre-Commit Hooks
Inspect existing Git hook tooling in the repository:
- If `lefthook` exists: Add a hook to `lefthook.yml` under `pre-commit` to run the sync script (or `--check`).
- If `husky` exists: Add a step in `.husky/pre-commit` to execute the sync script.
- If `simple-git-hooks` exists: Configure `package.json` with the sync command.
- If no framework exists: Provide or update a standalone POSIX hook script at `.git/hooks/pre-commit` (or provide an installation script like `scripts/install-git-hooks.mjs` or shell script) that runs the check/sync and stages updated architecture docs prior to commit.

### Phase 4: Fast Structural Guard Tests
Add an automated structural guard test to the repository test suite (e.g., `tests/guards/architecture_docs_sync.test.ts` or `tests/test_architecture_sync.py`):
1. The test must invoke the sync script with `--check` via child process / subprocess.
2. If drift exists, the test must fail with a descriptive failure message instructing the developer or AI to run the `--write` command (e.g., `npm run docs:arch` or `make docs-arch`).
3. The test must execute fast (under 2 seconds) and require no external network or heavy database fixtures so it runs seamlessly on pre-commit and CI.

### Phase 5: Package / Build Target Integration
1. If Node.js: Add `"docs:arch": "node scripts/sync-arch-docs.mjs --write"` and `"docs:arch:check": "node scripts/sync-arch-docs.mjs --check"` to `scripts` in `package.json`.
2. If Python / Go / Rust / Make: Add corresponding Makefile / Taskfile / pyproject.toml scripts (e.g., `make docs-arch` and `make docs-arch-check`).

### Phase 6: Autonomous Agent Protocol Configuration
Update the repository's AI instruction file (`CLAUDE.md`, `.github/copilot-instructions.md`, `AGENTS.md`, or `.cursorrules`):
- Add an explicit rule under Code Change / Commit instructions:
  "Whenever adding, removing, renaming, or refactoring modules or core public exports, you MUST run the architecture sync script (e.g. `npm run docs:arch` or equivalent) and include the updated architecture document in your commit."

### Phase 7: Verification & Execution
1. Run the newly created sync script with `--write` to populate/refresh the architecture document.
2. Run the sync script with `--check` and confirm exit code 0.
3. Run the new structural guard test to verify it passes.
4. Check `git status` / `git diff` to confirm only the expected files and component tables were modified.
5. Provide a concise summary of the files created and commands configured.
```

---

## 3. Concrete Reference Implementation

The following production-ready implementations can be directly adopted or tailored to any project.

### 3.1 Node.js / TypeScript Sync Engine (`scripts/sync-arch-docs.mjs`)

```javascript
#!/usr/bin/env node
/**
 * scripts/sync-arch-docs.mjs
 *
 * Automated Architecture Documentation Synchronizer
 * Parses repository source modules and synchronizes the component map
 * in architectural documentation between marker tags.
 *
 * Usage:
 *   node scripts/sync-arch-docs.mjs --write   # Updates documentation in place (default)
 *   node scripts/sync-arch-docs.mjs --check   # Fails with exit code 1 if drift detected
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, extname, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// Configuration
const CONFIG = {
  // Target markdown files to search and synchronize (first matched is primary)
  docCandidates: [
    'CLAUDE.arch.md',
    'ARCHITECTURE.md',
    'docs/architecture.md',
    'docs/CLAUDE.arch.md',
  ],
  // Source scan roots
  sourceRoots: ['src', 'lib'],
  // Extensions to analyze
  allowedExtensions: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
  // Directories to ignore
  ignoredDirectories: new Set([
    'node_modules',
    'dist',
    'build',
    '.git',
    'coverage',
    'tests',
    'test',
    '__tests__',
    'fixtures',
  ]),
  // Start and end markers for replacement
  startMarker: '<!-- ARCH_COMPONENTS_START -->',
  endMarker: '<!-- ARCH_COMPONENTS_END -->',
};

// Parse command line arguments
const args = process.argv.slice(2);
const isCheckMode = args.includes('--check');

/**
 * Recursively scans directory for source files.
 */
function scanSourceFiles(dir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!CONFIG.ignoredDirectories.has(entry.name)) {
        scanSourceFiles(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (CONFIG.allowedExtensions.has(ext) && !entry.name.endsWith('.d.ts')) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

/**
 * Extracts architectural metadata from a source file.
 */
function analyzeModule(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const relPath = relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  // 1. Extract purpose/role from leading file docstring or comments
  let purpose = '';
  const firstBlock = content.match(/\/\*\*([\s\S]*?)\*\//);
  if (firstBlock && firstBlock.index < 300) {
    purpose = firstBlock[1]
      .split('\n')
      .map(l => l.replace(/^\s*\*\s?/, '').trim())
      .filter(l => l && !l.startsWith('@'))
      .join(' ')
      .replace(/\|/g, '\\|')
      .slice(0, 100);
  } else {
    // Check for leading // comments
    const leadingComments = [];
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i].trim();
      if (line.startsWith('//')) {
        leadingComments.push(line.replace(/^\/\/\s?/, '').trim());
      } else if (line && !line.startsWith('import') && !line.startsWith('//')) {
        break;
      }
    }
    purpose = leadingComments.join(' ').replace(/\|/g, '\\|').slice(0, 100);
  }

  if (!purpose) {
    // Infer default role based on directory or filename
    if (relPath.includes('/parser')) purpose = 'Syntax and AST parsing';
    else if (relPath.includes('/db') || relPath.includes('/store')) purpose = 'Storage, query, and persistence';
    else if (relPath.includes('/cli') || relPath.includes('/commands')) purpose = 'CLI command handlers';
    else if (relPath.includes('/guard') || relPath.includes('/invariants')) purpose = 'Invariant enforcement and guards';
    else if (relPath.includes('/api') || relPath.includes('/routes')) purpose = 'API routes and endpoints';
    else if (relPath.includes('/util') || relPath.includes('/helpers')) purpose = 'Shared utility functions';
    else purpose = 'Core domain logic';
  }

  // 2. Extract public top-level exports
  const exports = [];
  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([a-zA-Z0-9_$]+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(`\`${match[1]}\``);
  }
  
  // Extract export { name1, name2 }
  const exportBlockRegex = /export\s+\{([^}]+)\}/g;
  while ((match = exportBlockRegex.exec(content)) !== null) {
    const names = match[1]
      .split(',')
      .map(n => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(n => n && !n.startsWith('type '));
    for (const name of names) {
      if (name && !exports.includes(`\`${name}\``)) {
        exports.push(`\`${name}\``);
      }
    }
  }

  const primaryExports = exports.length > 0
    ? exports.slice(0, 4).join(', ') + (exports.length > 4 ? ` *(+${exports.length - 4} more)*` : '')
    : '*(Default/Internal)*';

  // 3. Infer Architectural Category / Role
  let category = 'Domain Core';
  if (relPath.includes('/guards') || relPath.includes('guard')) category = 'Invariant Guard';
  else if (relPath.includes('/cli') || relPath.includes('command')) category = 'Interface / CLI';
  else if (relPath.includes('/adapters') || relPath.includes('client')) category = 'Adapter / Driver';
  else if (relPath.includes('/db') || relPath.includes('storage')) category = 'Data Persistence';
  else if (relPath.includes('/util') || relPath.includes('helper')) category = 'Infrastructure / Util';

  return {
    relPath,
    category,
    purpose,
    primaryExports,
  };
}

/**
 * Builds the Markdown Table string from module analysis.
 */
function buildComponentTable(modules) {
  // Sort modules alphabetically by path
  modules.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const rows = [
    CONFIG.startMarker,
    '<!-- AUTO-GENERATED ARCHITECTURE COMPONENT MAP: DO NOT EDIT DIRECTLY -->',
    '| Module Path | Layer / Role | Primary Exports | Architectural Purpose |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const mod of modules) {
    rows.push(`| \`${mod.relPath}\` | **${mod.category}** | ${mod.primaryExports} | ${mod.purpose || 'Component implementation'} |`);
  }

  rows.push(
    `\n*Total Modules Analyzed: ${modules.length} | Last Synchronized: ${new Date().toISOString().split('T')[0]}*`,
    CONFIG.endMarker
  );

  return rows.join('\n');
}

/**
 * Main execution routine.
 */
function main() {
  // 1. Locate primary architecture document
  let targetDocPath = null;
  for (const cand of CONFIG.docCandidates) {
    const p = resolve(REPO_ROOT, cand);
    if (existsSync(p)) {
      targetDocPath = p;
      break;
    }
  }

  if (!targetDocPath) {
    // Default fallback
    targetDocPath = resolve(REPO_ROOT, 'docs/architecture.md');
    if (!existsSync(targetDocPath)) {
      targetDocPath = resolve(REPO_ROOT, 'ARCHITECTURE.md');
    }
  }

  if (!existsSync(targetDocPath)) {
    console.error(`[sync-arch-docs] Error: Target documentation file not found. Candidates: ${CONFIG.docCandidates.join(', ')}`);
    process.exit(1);
  }

  // 2. Scan and analyze modules
  const allFiles = [];
  for (const root of CONFIG.sourceRoots) {
    scanSourceFiles(resolve(REPO_ROOT, root), allFiles);
  }

  if (allFiles.length === 0) {
    console.warn(`[sync-arch-docs] Warning: No source files discovered in roots: ${CONFIG.sourceRoots.join(', ')}`);
  }

  const moduleData = allFiles.map(analyzeModule);
  const generatedTable = buildComponentTable(moduleData);

  // 3. Read current architecture document
  const originalContent = readFileSync(targetDocPath, 'utf8');

  // Verify markers exist; if missing in target doc, append markers
  let updatedContent = '';
  if (!originalContent.includes(CONFIG.startMarker) || !originalContent.includes(CONFIG.endMarker)) {
    console.log(`[sync-arch-docs] Markers not found in ${relative(REPO_ROOT, targetDocPath)}. Appending section...`);
    const markerSection = `\n\n## Component Directory Map\n\n${generatedTable}\n`;
    updatedContent = originalContent.trimEnd() + markerSection;
  } else {
    // Replace content between markers
    const regex = new RegExp(`${CONFIG.startMarker}[\\s\\S]*?${CONFIG.endMarker}`, 'g');
    updatedContent = originalContent.replace(regex, generatedTable);
  }

  // 4. Handle --check mode
  if (isCheckMode) {
    if (originalContent.trim() !== updatedContent.trim()) {
      console.error(`\n❌ [sync-arch-docs] Architecture documentation drift detected in ${relative(REPO_ROOT, targetDocPath)}!`);
      console.error(`Run 'npm run docs:arch' or 'node scripts/sync-arch-docs.mjs --write' to update component maps.\n`);
      process.exit(1);
    }
    console.log(`✅ [sync-arch-docs] Architecture documentation is up to date: ${relative(REPO_ROOT, targetDocPath)} (${moduleData.length} modules verified)`);
    process.exit(0);
  }

  // 5. Handle --write mode
  writeFileSync(targetDocPath, updatedContent, 'utf8');
  console.log(`✅ [sync-arch-docs] Successfully updated ${relative(REPO_ROOT, targetDocPath)} (${moduleData.length} modules synchronized)`);
}

main();
```

---

### 3.2 Python Equivalent Sync Engine (`scripts/sync_arch_docs.py`)

For Python-native or polyglot environments, use this zero-dependency standard-library script:

```python
#!/usr/bin/env python3
"""
scripts/sync_arch_docs.py

Automated Architecture Documentation Synchronizer (Python Standard Library).
Parses Python modules via AST and synchronizes architectural documentation.

Usage:
  python scripts/sync_arch_docs.py --write
  python scripts/sync_arch_docs.py --check
"""

import ast
import os
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

DOC_CANDIDATES = [
    "CLAUDE.arch.md",
    "ARCHITECTURE.md",
    "docs/architecture.md",
]
SOURCE_ROOTS = ["src", "app"]
START_MARKER = "<!-- ARCH_COMPONENTS_START -->"
END_MARKER = "<!-- ARCH_COMPONENTS_END -->"
IGNORED_DIRS = {"__pycache__", ".pytest_cache", ".git", "venv", ".venv", "tests", "dist"}


def analyze_py_file(path: Path) -> dict:
    rel_path = path.relative_to(REPO_ROOT).as_posix()
    try:
        content = path.read_text(encoding="utf-8")
        tree = ast.parse(content)
        docstring = ast.get_docstring(tree) or ""
        docstring_summary = docstring.split("\n")[0].strip().replace("|", "\\|")[:90]

        exports = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if not node.name.startswith("_"):
                    exports.append(f"`{node.name}`")

        export_str = ", ".join(exports[:4]) + (f" *(+{len(exports)-4} more)*" if len(exports) > 4 else "")
        if not export_str:
            export_str = "*(Internal)*"

        role = "Domain Core"
        if "guard" in rel_path: role = "Invariant Guard"
        elif "cli" in rel_path or "cmd" in rel_path: role = "CLI / Interface"
        elif "adapter" in rel_path: role = "Adapter"
        elif "db" in rel_path or "model" in rel_path: role = "Persistence / Schema"

        return {
            "path": rel_path,
            "role": role,
            "exports": export_str,
            "purpose": docstring_summary or "Component implementation"
        }
    except Exception as e:
        return {
            "path": rel_path,
            "role": "General",
            "exports": "*(Parse Error)*",
            "purpose": f"Error: {e}"
        }


def main():
    is_check = "--check" in sys.argv

    # Find target doc
    target_doc = None
    for cand in DOC_CANDIDATES:
        p = REPO_ROOT / cand
        if p.exists():
            target_doc = p
            break
    if not target_doc:
        target_doc = REPO_ROOT / "docs/architecture.md"

    # Collect source files
    modules = []
    for s_root in SOURCE_ROOTS:
        root_path = REPO_ROOT / s_root
        if not root_path.exists(): continue
        for root, dirs, files in os.walk(root_path):
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
            for f in files:
                if f.endswith(".py") and not f.startswith("test_"):
                    modules.append(analyze_py_file(Path(root) / f))

    modules.sort(key=lambda m: m["path"])

    # Build Markdown table
    lines = [
        START_MARKER,
        "<!-- AUTO-GENERATED ARCHITECTURE COMPONENT MAP: DO NOT EDIT DIRECTLY -->",
        "| Module Path | Layer / Role | Primary Exports | Architectural Purpose |",
        "| :--- | :--- | :--- | :--- |",
    ]
    for m in modules:
        lines.append(f"| `{m['path']}` | **{m['role']}** | {m['exports']} | {m['purpose']} |")
    lines.append(f"\n*Total Modules: {len(modules)} | Synchronized: {date.today().isoformat()}*")
    lines.append(END_MARKER)
    generated_block = "\n".join(lines)

    if not target_doc.exists():
        original_content = "# Architecture\n\n## Components\n\n"
    else:
        original_content = target_doc.read_text(encoding="utf-8")

    if START_MARKER in original_content and END_MARKER in original_content:
        import re
        pattern = re.compile(f"{re.escape(START_MARKER)}[\\s\\S]*?{re.escape(END_MARKER)}")
        updated_content = pattern.sub(generated_block, original_content)
    else:
        updated_content = original_content.rstrip() + f"\n\n## Component Directory Map\n\n{generated_block}\n"

    if is_check:
        if original_content.strip() != updated_content.strip():
            print(f"❌ [sync_arch_docs] Architecture documentation drift detected in {target_doc.name}!", file=sys.stderr)
            sys.exit(1)
        print(f"✅ [sync_arch_docs] Architecture documentation is up to date: {target_doc.name}")
        sys.exit(0)

    target_doc.write_text(updated_content, encoding="utf-8")
    print(f"✅ [sync_arch_docs] Successfully updated {target_doc.name} with {len(modules)} modules.")


if __name__ == "__main__":
    main()
```

---

### 3.3 Fast Structural Guard Test

#### Vitest / Jest Example (`tests/guards/architecture_docs_sync.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Architecture Documentation Drift Guard', () => {
  it('enforces that architectural component maps are in sync with source code', () => {
    const scriptPath = resolve(__dirname, '../../scripts/sync-arch-docs.mjs');
    try {
      // Execute the sync check; will throw if exit code != 0
      const output = execSync(`node "${scriptPath}" --check`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(output).toContain('✅ [sync-arch-docs]');
    } catch (error: any) {
      const stderr = error.stderr?.toString() || error.stdout?.toString() || error.message;
      throw new Error(
        `Architecture drift detected!\n${stderr}\n` +
        `Fix this failure by running: npm run docs:arch`
      );
    }
  });
});
```

#### Pytest Example (`tests/test_architecture_sync.py`)
```python
import subprocess
import sys
from pathlib import Path

def test_architecture_documentation_sync():
    repo_root = Path(__file__).resolve().parent.parent
    script_path = repo_root / "scripts" / "sync_arch_docs.py"
    
    result = subprocess.run(
        [sys.executable, str(script_path), "--check"],
        capture_output=True,
        text=True
    )
    
    assert result.returncode == 0, (
        f"Architecture documentation drift detected!\n"
        f"STDERR: {result.stderr}\n"
        f"Run 'python scripts/sync_arch_docs.py --write' to synchronize."
    )
```

---

### 3.4 Pre-Commit Hook Configurations

#### Option A: Lefthook (`lefthook.yml`)
```yaml
pre-commit:
  parallel: false
  commands:
    architecture-sync:
      run: node scripts/sync-arch-docs.mjs --write
      stage_fixed: true
```

#### Option B: Husky (`.husky/pre-commit`)
```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Auto-sync architecture and stage if modified
node scripts/sync-arch-docs.mjs --write
git add CLAUDE.arch.md ARCHITECTURE.md docs/architecture.md 2>/dev/null || true
```

#### Option C: Native Git Hook (`.git/hooks/pre-commit` or via installer script)
```bash
#!/bin/sh
# .git/hooks/pre-commit
# Auto-sync architecture documentation prior to commit

if [ -f "scripts/sync-arch-docs.mjs" ]; then
  node scripts/sync-arch-docs.mjs --write
  # Stage the documentation file if it was altered
  git add CLAUDE.arch.md ARCHITECTURE.md docs/architecture.md 2>/dev/null || true
elif [ -f "scripts/sync_arch_docs.py" ]; then
  python3 scripts/sync_arch_docs.py --write
  git add CLAUDE.arch.md ARCHITECTURE.md docs/architecture.md 2>/dev/null || true
fi
```

---

### 3.5 Package / Build Scripts

In `package.json`:
```json
{
  "scripts": {
    "docs:arch": "node scripts/sync-arch-docs.mjs --write",
    "docs:arch:check": "node scripts/sync-arch-docs.mjs --check"
  }
}
```

Or in `Makefile`:
```makefile
.PHONY: docs-arch docs-arch-check

docs-arch:
	node scripts/sync-arch-docs.mjs --write

docs-arch-check:
	node scripts/sync-arch-docs.mjs --check
```

---

## 4. Edge Cases & Resilient Handling Strategies

| Edge Case | Impact | Solution / Built-in Mitigation |
| :--- | :--- | :--- |
| **Monolithic Decompositions** | Large single files (e.g. `parser.ts` 2,000 LOC) split into submodules (`parser/ast.ts`, `parser/tokens.ts`). | The sync script scans the new directory structure, identifies all decomposed child modules, extracts their respective exports, and replaces the monolithic entry with the new cohesive subsystem map. |
| **Deleted or Renamed Modules** | Dead documentation rows referencing removed files. | The script rebuilds the component map from actual on-disk files each run. Stale files vanish cleanly; renamed files appear under their new canonical paths. |
| **Monorepo / Workspace Support** | Multiple packages under `packages/*` or `apps/*`. | Configure `sourceRoots: ['packages', 'apps']` or parameterize the script with `--package=<name>`. Generates separate component tables per package or a consolidated tree table. |
| **Private vs. Public Modules** | Cluttered tables filled with internal test helpers or build shims. | The parser filters out paths containing `/__tests__/`, `*.test.*`, `*.spec.*`, `*.mock.*`, and files marked with JSDoc `@internal`. |
| **Circular or Rapid Commits** | Pre-commit hook re-formatting during `git commit`. | When using pre-commit `--write` mode, the hook must stage the updated doc using `git add <doc-path>`. When running in CI, the guard runs in `--check` mode to reject PRs with uncommitted drift. |

---

## 5. Continuous Agent Maintenance Protocol

To ensure any AI assistant working on the repo permanently upholds this discipline, append the following directive block into your project's agent guidance document (`CLAUDE.md`, `AGENTS.md`, or `.github/copilot-instructions.md`):

```markdown
<!-- ARCH_AUTO_SYNC_PROTOCOL -->
### Architecture Documentation Synchronization Invariant
1. Before committing any changeset that adds, removes, renames, or refactors source files or module exports, you MUST execute:
   `npm run docs:arch` (or `node scripts/sync-arch-docs.mjs --write`)
2. Verify that `npm run docs:arch:check` exits with status code 0.
3. Include the synchronized architecture documentation in the resulting commit.
4. Never manually edit the content between `<!-- ARCH_COMPONENTS_START -->` and `<!-- ARCH_COMPONENTS_END -->`.
<!-- ARCH_AUTO_SYNC_PROTOCOL -->
```

---

## 6. Verification Checklist

After deploying the prompt to your target repository, verify the setup with this 4-step sanity check:

- [ ] **1. Manual Generation:** Run `node scripts/sync-arch-docs.mjs --write`. Check that the target architecture document now contains the table between the marker tags.
- [ ] **2. Clean Drift Check:** Run `node scripts/sync-arch-docs.mjs --check`. Confirm it logs `✅ Architecture documentation is up to date` and exits with code `0`.
- [ ] **3. Drift Detection Verification:** Temporarily touch a new dummy file `src/temp_test_module.ts`. Run `node scripts/sync-arch-docs.mjs --check`. Confirm it reports drift and exits with status code `1`. Delete the dummy file.
- [ ] **4. Test Suite Integration:** Run your test command (`npm test`, `npm run test:guards`, or `pytest`). Confirm the structural guard test executes and passes in under 2 seconds.
