# Changelog

All notable changes to Tokenwise are documented in this file. Format follows Keep a Changelog. Tokenwise follows Semantic Versioning starting at 1.0.

## [Unreleased]

### Added

### Changed

### Fixed

## [0.2.0] - 2026-05-12

### Added

- Session hint events in `tokenwise stats`. When the agent tries to re-read a file already pulled into the current session, Tokenwise now records the savings estimate alongside the existing reminder. The hints show up in the stats output next to image-shrink and read-replacement counts.
- Automatic first-time indexing at session start. The first time Tokenwise sees a new project, it kicks off a background symbol index so the next `tokenwise symbol`, `tokenwise read`, and `tokenwise section` calls return data instead of an empty result.
- "Project not yet indexed" hint in `tokenwise symbol`, `ref`, `read`, and `section`. The old response was "No matches", which made it look like Tokenwise was broken when the index was still warming up.
- Tokenwise logo (`assets/logo.png`) and a Windows multi-size icon (`assets/tokenwise.ico`). README now opens with the logo centered.
- Availability line in the README footer for engineering inquiries.

### Changed

- Hook commands and the worker auto-start command now invoke `pythonw.exe -m tokenwise.cli ...` directly from Tokenwise's uv tool venv. The previous launcher .exe approach tripped behavioral heuristics in several major antivirus and EDR products; the signed Python interpreter plus module invocation does not. See Security below.
- `tokenwise stats` redesigned. A one-line headline summary at the top, unicode bar charts proportional to bytes saved, and separate breakdowns by event kind, day, and project below.
- Image-shrink events now include a token-savings estimate at one token per four bytes saved, so the headline counter reflects token impact and not just bytes on disk.
- License changed from MIT to PolyForm Noncommercial 1.0.0. Tokenwise stays free for personal and noncommercial use; commercial use requires a separate license. See LICENSE for full terms.
- CLAUDE.md, Codex AGENTS.md, and SKILL.md directives sharpened. Imperative phrasing, before-and-after tables that show the token-cost difference between `tokenwise symbol` and `grep`, and a verification cue at the bottom.
- Python version pin widened to support 3.14.
- Continuous integration now runs `mypy` alongside `ruff` and `pytest`.

### Fixed

- "hook exited with code 1" errors in Codex and Claude Code. Hook entry points now eat unknown arguments, catch every exception class including `SystemExit`, and always exit zero with valid JSON on stdout, even when the harness passes arguments the typer entry point did not expect.
- Database integrity check no longer treats a locked or busy SQLite file as corruption. The previous behavior tried to quarantine the file, failed because Windows held the file lock, and surfaced as `tokenwise map` or `tokenwise stats` exiting 1.
- Test runs no longer write to the production hook log file. An autouse fixture isolates the hook logger for the duration of each test.
- `read_payload` coerces non-dict JSON (`null`, lists, scalars) to an empty dict so hook handlers can safely call `payload.get(...)` regardless of what the harness sends on stdin.
- Pillow `Image.LANCZOS` replaced with `Image.Resampling.LANCZOS` to remove the deprecation warning on Pillow 10 and newer.
- Rust and Go extractor error fallbacks now return the four-tuple the extractor protocol requires. The previous three-tuple return crashed downstream and was caught by fail-soft, so Go and Rust files never indexed when extraction failed.
- Variable-name shadowing in `embeddings.py` chunk extraction. Caught by mypy, not a runtime bug, but cleaner now.

### Security

- Hook and worker spawn pattern reworked so antivirus and EDR products do not behavior-flag Tokenwise. The previous design spawned a small PyInstaller-style launcher .exe from a user-writable directory (`~/.local/bin/`), which matched the textbook payload-drop signature those products monitor for. Hooks now invoke the Python Software Foundation signed `pythonw.exe` from Tokenwise's uv tool venv directly, with `-m tokenwise.cli`. This is the most boring spawn pattern on Windows and gets treated as benign by Bitdefender, Defender, Norton, McAfee, Kaspersky, Sophos, and ESET.

## [0.1.0] - 2026-05-12

First public release.

### Added

- Image shrinking on local file reads. When the agent opens a large PNG or JPEG, Tokenwise returns a compressed copy in place of the original. A 3.3 MB screenshot from one test session arrived at 84 KB.
- Image shrinking on Google Drive image downloads. Activates only when the user has already authorized Google Drive through Claude Code's built-in connector. Tokenwise never asks for its own Drive auth.
- Session-aware read hints. When the agent tries to read a file already pulled into the current session, it gets a short reminder of the prior read and a nudge to grab a narrower slice instead.
- Targeted symbol reads via `tokenwise read "file.py::function_name"`. Pulls one function or class, not the whole file.
- Targeted section reads via `tokenwise section "doc.md::Heading"`. Pulls one Markdown section by heading.
- Semantic search via `tokenwise semantic "<query>"`. Find code by meaning, not by filename. First call downloads a small embedding model into `%LOCALAPPDATA%\tokenwise\models\`.
- Repo orientation via `tokenwise map`. A compact, ranked overview of the most important files in a repository.
- Cumulative savings tracking via `tokenwise stats`.
- Install and uninstall flow for Claude Code, with `--codex` flag to patch Codex CLI in the same pass.
- Diagnostic command `tokenwise doctor` confirms the install is healthy.
- Background worker that auto-starts at logon, runs without a console window, and survives reboots.

### Notes

- Licensed under PolyForm Noncommercial 1.0.0. See LICENSE for full terms.
- Windows 10 and 11 only.
- Python 3.11, 3.12, 3.13, and 3.14 supported.
