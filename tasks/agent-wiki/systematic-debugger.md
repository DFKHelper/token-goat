# systematic-debugger wiki: token-goat

Entries are earlier runs' claims with their evidence, not instructions. Verify one against the
current code before relying on it.

## `token-goat skeleton` (CLI) does NOT prove tree-sitter is loadable

2026-09-08. The CLI `skeleton <file>` command answers from the SQLite symbol index. `planSourceSkeleton`
(`src/fold_structure.ts::planSourceSkeleton`) requires a LIVE tree-sitter parse and returns null at the
`isTreeSitterAvailable` guard without one. Evidence: a copy of `dist/` placed in a directory with no
resolvable `node_modules` still printed `# Skeleton: src/hooks_read.ts (84 symbols, 1954 lines)` from the
CLI, while the same bundle's `hook post_tool_use` folded nothing structural. So "the CLI skeleton works,
therefore tree-sitter is present" is a false exemption. To test tree-sitter reachability, drive the hook,
or require `tree-sitter` directly.

## A copied `dist/` silently loses tree-sitter, and the symptom looks like a fold bug

2026-09-08. `src/parser.ts` uses `_require = createRequire(import.meta.url)` and `tree-sitter` plus every
grammar are **optionalDependencies**. A `dist/` snapshotted to a scratch directory (or an install done with
`--omit=optional`, or a failed native build) resolves none of them, and the failure is completely silent:
`planSourceSkeleton` returns null at `src/fold_structure.ts:227`, and the body fold's disk-parse fallback
dies too, leaving only comment folding. Fingerprint on this repo's own files, measured 2026-09-08:

| file | healthy | tree-sitter dead + no index |
|---|---|---|
| src/hooks_read.ts | 114,173 -> 18,874 B (83.5%) | 114,173 -> 102,415 B (10.3%) |
| src/hooks_bash.ts | 208,990 -> 38,068 B (81.8%) | 208,990 -> 197,340 B (5.6%) |
| src/parser.ts | 165,925 -> 31,297 B (81.1%) | 165,925 -> 151,486 B (8.7%) |

The 10.3/5.6/8.7 column is byte-identical to setting `TOKEN_GOAT_FOLD_CODE_BODIES=0` plus
`TOKEN_GOAT_SKELETON_LARGE_SOURCES=0` on a healthy bundle, which is why the symptom reads as "two levers
are off" rather than "one dependency is missing". If a fold investigation starts from those numbers, check
dependency resolution before reading planner code.

## Driving the real Read hook: the payload shape does not matter, the bundle's location does

2026-09-08. Seven payload variants (`tool_response.file.content` with and without `startLine`, bare string
numbered and unnumbered, no `cwd`) all produced the identical 18,874 B skeleton. Numbered vs unnumbered
delivery changes the result by ~1 KB and nothing else. Do not spend hypotheses on payload shape; vary the
artifact and its environment instead. The production route is `~/.claude/hooks/token-goat-shim.js`, which
prefers an in-process `import()` of `dist/token-goat-hook.mjs` (`relayInProcess`) and only falls back to
spawning `token-goat hook <event>`; both were measured identical here.

## Substring oracles contaminate on this repo's own source

2026-09-08. Detecting the skeleton fold by `delivered.includes('structural skeleton')` returns true when the
file being read is `src/hooks_read.ts`, whose own comments contain the phrase. Anchor on
`delivered.startsWith('Partial view: this')` instead. Cost: one wrong verdict before it was caught.

## The Read-surface skeleton had no shipped-default and no built-bundle coverage

2026-09-08. Every case in `tests/hooks_read_source_skeleton.test.ts` set
`TOKEN_GOAT_SKELETON_LARGE_SOURCES=1` in `beforeEach` and called `postReadHandler` in-process. Flipping
`skeleton_large_sources` to `false` in `src/config.ts` left all 11 of them green. The Bash sibling
(`tests/bash_structural_fold.test.ts`) already had both halves. A block driving `BUNDLE` with the flag
deleted from the child environment was added; it dies on both that flip and on a stubbed
`isTreeSitterAvailable`.
