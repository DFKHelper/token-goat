# Contributors

## eSaadster

Authored [pi-token-goat](https://github.com/eSaadster/pi-token-goat), a TypeScript exploration of this codebase. The architecture of this TypeScript port was directly informed by their work:

- **Discriminated union hook types** — `HookOutput` with a `hookType` literal tag enabling exhaustive switch-checking at every dispatch site
- **`reset.ts` test isolation pattern** — modules register cleanup lambdas at load time; `clearModuleCaches()` in `beforeEach` tears down module-global state without subprocess spawning
- **`baseline` command** — attributes every environmental overhead token a fresh session inherits (hooks, MEMORY.md, skills, MCP servers) with `fix:` annotations and `--usage` transcript mining
- **`runGit` as an enforced subprocess chokepoint** — one function in one file, with a build-breaking test that rejects bare `exec`/`spawn` calls to git anywhere else in the source
- **`sleepSync` via `Atomics.wait`** — zero-overhead synchronous sleep using `SharedArrayBuffer`, no subprocess spawn
- **`safeJoin` colon rejection** — unconditional colon rejection guards Windows drive-letter path-escape vectors
- **`pool: 'forks'` test isolation** — file-level process isolation in vitest eliminates module-global state leaks between test files
- **`scanTranscriptUsage`** — streams `.jsonl` transcripts to cross-reference skill and MCP usage counts against installed configuration
- **`envFloat`/`envInt` overflow guards** — `!Number.isFinite()` check and strict `^[+-]?\d+$` regex reject `Infinity` and float strings
- **Symlink-aware entry detection** — `realpathSync` on both `process.argv[1]` and `import.meta.url` before comparing, correct under `npm link` and system installs
