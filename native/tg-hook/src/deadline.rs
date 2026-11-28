//! The answer for a call that no route could serve before its deadline, because every lane stayed busy. [`deadline_answer`] is the one place that decides it: a read is allowed with the notice, a shell command the node walk guard could refuse is answered busy, and so is a write; every other call keeps the safe answer. Only Claude Code has a deny form confirmed from source, so every other host keeps the safe answer.

use crate::lanes::{Class, class_of};

/// The answer a busy call gets: Claude Code's `decision: block`, the form `serializeOutput` in src/hook_registry.ts writes for a `deny` (FORMAT-DERIVED from that source, read this run).
pub const BUSY_ANSWER: &str = r#"{"decision":"block","reason":"token-goat is busy; run this again"}"#;

/// The characters that make a shell command unsafe to allow without the guard: src/hooks_bash.ts `PREFILTER_CHARS`.
pub const PREFILTER_CHARS: &str = "$`'\"\\";

/// The walker names of src/hooks_bash.ts `PREFILTER_NAMES`, with its regex alternatives written out: `[efz]?grep`, `v?dir` and `ch(?:mod|own|grp)`. The `[a-z]{0,2}a?sh` alternative is [`is_sh_family`].
pub const PREFILTER_NAMES: &[&str] = &[
    "fd",
    "fdfind",
    "find",
    "findstr",
    "rg",
    "grep",
    "egrep",
    "fgrep",
    "zgrep",
    "du",
    "tree",
    "dir",
    "vdir",
    "ls",
    "gci",
    "get-childitem",
    "xargs",
    "eval",
    "where",
    "forfiles",
    "chmod",
    "chown",
    "chgrp",
    "cp",
    "ag",
    "ack",
    "dust",
    "ncdu",
    "exa",
    "eza",
    "cmd",
    "pwsh",
    "powershell",
    "env",
    "nice",
    "ionice",
    "timeout",
    "sudo",
    "doas",
    "wsl",
    "time",
    "command",
    "builtin",
    "exec",
    "nohup",
    "setsid",
    "call",
    "stdbuf",
    "busybox",
    "source",
];

/// What a call that missed its deadline is answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Deadline {
    /// The harness's safe answer, with the existing notice.
    Allow,
    /// [`BUSY_ANSWER`]: the call was not run, and the host is told to run it again.
    Busy,
}

enum Tool {
    Shell,
    ReadOnly,
    Write,
    Other,
}

/// The tool class of a tool name, folded as src/tool_name_fold.ts folds it: lower case, with `_` and `-` removed.
fn tool_of(name: &str) -> Tool {
    match name.to_ascii_lowercase().replace(['_', '-'], "").as_str() {
        "bash" | "powershell" => Tool::Shell,
        "read" | "grep" | "glob" => Tool::ReadOnly,
        "write" | "edit" | "multiedit" => Tool::Write,
        _ => Tool::Other,
    }
}

/// `[a-z]{0,2}a?sh` with the walker's case-insensitive flag: up to two letters, then an optional `a`, then `sh`.
fn is_sh_family(word: &str) -> bool {
    let Some(prefix) = word.strip_suffix("sh") else { return false };
    let letters = prefix.bytes().all(|b| b.is_ascii_alphabetic());
    letters && (prefix.len() <= 2 || (prefix.len() == 3 && prefix.ends_with('a')))
}

/// Whether `word` is one of the walker names, compared as the node regex compares a whole word.
fn is_name(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    PREFILTER_NAMES.contains(&lower.as_str()) || is_sh_family(&lower)
}

/// The coarse check that stands in for node's walk-guard prefilter: true when node would load the guard for `command`, so the native client cannot allow it without it.
pub fn prefilter_hits(command: &str) -> bool {
    command.contains(|c: char| PREFILTER_CHARS.contains(c)) || command.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).any(|word| !word.is_empty() && is_name(word))
}

/// The answer for a call that no route served before its deadline: `event` and `harness` name the call, and `payload` is the hook's stdin as read.
pub fn deadline_answer(harness: &str, event: &str, payload: Option<&[u8]>) -> Deadline {
    if harness != "claudecode" || class_of(event) != Class::Deny {
        return Deadline::Allow;
    }
    let Some(value) = payload.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok()) else { return Deadline::Allow };
    let Some(name) = value.get("tool_name").and_then(|v| v.as_str()) else { return Deadline::Allow };
    match tool_of(name) {
        Tool::Write => Deadline::Busy,
        Tool::ReadOnly | Tool::Other => Deadline::Allow,
        Tool::Shell => match value.get("tool_input").and_then(|input| input.get("command")).and_then(|c| c.as_str()) {
            Some(command) if prefilter_hits(command) => Deadline::Busy,
            _ => Deadline::Allow,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HAND-DERIVED: the answer for one call, built as Claude Code sends it: the tool name, and the command for a shell tool.
    fn answer(tool: &str, command: Option<&str>) -> Deadline {
        let payload = match command {
            Some(command) => serde_json::json!({"tool_name": tool, "tool_input": {"command": command}}),
            None => serde_json::json!({"tool_name": tool}),
        };
        deadline_answer("claudecode", "PreToolUse", Some(payload.to_string().as_bytes()))
    }

    /// HAND-DERIVED from the node prefilter (src/hooks_bash.ts PREFILTER_CHARS and PREFILTER_NAMES); the commands are test inputs, never run.
    #[test]
    fn the_eleven_rows_get_the_answer_the_row_file_names() {
        let rows: [(&str, Option<&str>, Deadline); 11] = [
            ("Bash", Some("git status"), Deadline::Allow),
            ("Bash", Some("find / -name x"), Deadline::Busy),
            ("Bash", Some("\"fi\"nd /"), Deadline::Busy),
            ("Bash", Some("f\\ind /"), Deadline::Busy),
            ("Bash", Some("${F} / -name x"), Deadline::Busy),
            ("Bash", Some("cp -r / dest"), Deadline::Busy),
            ("Bash", Some("dust /"), Deadline::Busy),
            ("Read", None, Deadline::Allow),
            ("Write", None, Deadline::Busy),
            ("Edit", None, Deadline::Busy),
            ("Mystery", None, Deadline::Allow),
        ];
        for (tool, command, want) in rows {
            assert_eq!(answer(tool, command), want, "row {tool} | {command:?} must get {want:?}");
        }
    }

    /// HAND-DERIVED: src/hooks_write.ts registers Write, Edit and MultiEdit on PreToolUse; NotebookEdit has none.
    #[test]
    fn the_write_tools_node_guards_get_busy_and_the_rest_stay_allowed() {
        for tool in ["Write", "Edit", "MultiEdit"] {
            assert_eq!(answer(tool, None), Deadline::Busy, "node's write guard denies {tool}, so it must be busy at the deadline");
        }
        for tool in ["NotebookEdit", "TodoWrite", "Task"] {
            assert_eq!(answer(tool, None), Deadline::Allow, "{tool} has no node PreToolUse write guard, so it must stay allowed");
        }
    }

    /// HAND-DERIVED: near misses that node allows, so a shell command that only shares letters with a walker name stays allowed.
    #[test]
    fn a_word_that_only_contains_a_walker_name_stays_allowed() {
        for command in ["lsof -i", "findings.md", "echo shadow", "npm run build"] {
            assert_eq!(answer("Bash", Some(command)), Deadline::Allow, "near miss {command:?} must stay allowed");
        }
    }

    /// HAND-DERIVED: the `[a-z]{0,2}a?sh` family, in and out of the shape.
    #[test]
    fn the_sh_family_matches_only_its_shape() {
        assert!(is_sh_family("sh") && is_sh_family("bash") && is_sh_family("zsh") && is_sh_family("tcsh") && is_sh_family("ash"));
        assert!(is_sh_family("fish"), "fish is two letters and sh, which node's alternative matches");
        assert!(!is_sh_family("abcsh") && !is_sh_family("shell"));
    }

    /// HAND-DERIVED: a call with no verified deny form, or a tool the guard never sees, keeps the safe answer.
    #[test]
    fn only_claude_code_pre_tool_use_can_be_answered_busy() {
        let payload = serde_json::json!({"tool_name": "Write"}).to_string();
        assert_eq!(deadline_answer("codex", "PreToolUse", Some(payload.as_bytes())), Deadline::Allow, "codex has no verified busy form");
        assert_eq!(deadline_answer("claudecode", "PostToolUse", Some(payload.as_bytes())), Deadline::Allow, "only PreToolUse refuses");
        assert_eq!(deadline_answer("claudecode", "PreToolUse", Some(b"not json")), Deadline::Allow, "an unparseable payload allows");
    }
}
