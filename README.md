# tokenwise

Claude Code companion that reduces token usage via local indexing, image shrinking, and session-context caching.

## What is it?

`tokenwise` watches your Claude Code edits and intelligently shrinks context: symbol tables + semantic search replace verbose file reads, cached images replace GDrive fetches, session-context replay avoids re-reading touched files. On Claude Haiku (cheaper model), savings range from 40–70% per interaction.

## Install

See [Phase 15](docs/architecture.md).

## CLI Surface

| Command | Purpose |
|---------|---------|
| `symbol <name>` | Find symbol definition |
| `ref <name>` | Find all references |
| `semantic <query>` | Semantic search by description |
| `map` | Generate repo map (PageRank) |
| `deps <file>` | Show dependency graph |
| `read <file::symbol>` | Read from index |
| `section <file::heading>` | Extract heading section |
| `session-touched` | List touched files |
| `session-mark <file>` | Mark as touched |
| `gdrive-fetch <id>` | Cache GDrive image |
| `fetch-image <url>` | Cache URL image |
| `index` | Rebuild indices |
| `stats` | Show savings stats |
| `doctor` | Diagnose health |
| `install` | Hook entrypoints + Task Scheduler |
| `uninstall` | Remove entrypoints |

## Architecture

See [architecture.md](docs/architecture.md).

## Windows Defender Exclusion

Add tokenwise data directory to Windows Defender exclusions to prevent slowdowns:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\tokenwise"
```

## License

MIT

## Status

Phase 0 of 17 complete. Module stubs, CLI skeleton, pyproject.toml with all dependencies, Windows CI matrix.
