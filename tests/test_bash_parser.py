"""Tests for tokenwise.bash_parser — Phase 18."""
from __future__ import annotations

from tokenwise.bash_parser import parse

# ---------------------------------------------------------------------------
# 1. cat foo.py → read
# ---------------------------------------------------------------------------


def test_cat_simple():
    intent = parse("cat foo.py")
    assert intent.kind == "read"
    assert intent.target_path == "foo.py"
    assert intent.limit is None
    assert intent.offset is None


# ---------------------------------------------------------------------------
# 2. head -n 50 foo.py → read, limit=50
# ---------------------------------------------------------------------------


def test_head_n_flag_space():
    intent = parse("head -n 50 foo.py")
    assert intent.kind == "read"
    assert intent.target_path == "foo.py"
    assert intent.limit == 50


# ---------------------------------------------------------------------------
# 3. head -n50 foo.py → read, limit=50 (concatenated flag)
# ---------------------------------------------------------------------------


def test_head_n_flag_concat():
    intent = parse("head -n50 foo.py")
    assert intent.kind == "read"
    assert intent.target_path == "foo.py"
    assert intent.limit == 50


# ---------------------------------------------------------------------------
# 4. head --lines=50 foo.py → read, limit=50
# ---------------------------------------------------------------------------


def test_head_lines_eq():
    intent = parse("head --lines=50 foo.py")
    assert intent.kind == "read"
    assert intent.target_path == "foo.py"
    assert intent.limit == 50


# ---------------------------------------------------------------------------
# 5. rg pattern src/ → grep, pattern=pattern
# ---------------------------------------------------------------------------


def test_rg_simple():
    intent = parse("rg pattern src/")
    assert intent.kind == "grep"
    assert intent.pattern == "pattern"


# ---------------------------------------------------------------------------
# 6. grep -n 'foo bar' --color file.py → grep, pattern='foo bar'
# ---------------------------------------------------------------------------


def test_grep_quoted_pattern():
    intent = parse("grep -n 'foo bar' --color file.py")
    assert intent.kind == "grep"
    assert intent.pattern == "foo bar"


# ---------------------------------------------------------------------------
# 7. find . -name '*.py' → glob
# ---------------------------------------------------------------------------


def test_find_glob():
    intent = parse("find . -name '*.py'")
    assert intent.kind == "glob"


# ---------------------------------------------------------------------------
# 8. sudo cat /etc/passwd → read, target=/etc/passwd (strips sudo)
# ---------------------------------------------------------------------------


def test_sudo_prefix_stripped():
    intent = parse("sudo cat /etc/passwd")
    assert intent.kind == "read"
    assert intent.target_path == "/etc/passwd"


# ---------------------------------------------------------------------------
# 9. VAR=value cat foo → read, target=foo (strips env assignment)
# ---------------------------------------------------------------------------


def test_env_prefix_stripped():
    intent = parse("VAR=value cat foo")
    assert intent.kind == "read"
    assert intent.target_path == "foo"


# ---------------------------------------------------------------------------
# 10. unknown binary → unknown
# ---------------------------------------------------------------------------


def test_unknown_binary():
    intent = parse("garbage")
    assert intent.kind == "unknown"


# ---------------------------------------------------------------------------
# 11. pipe: only leading segment is inspected
# ---------------------------------------------------------------------------


def test_pipe_leading_command():
    intent = parse("cat README.md | grep foo")
    assert intent.kind == "read"
    assert intent.target_path == "README.md"


# ---------------------------------------------------------------------------
# 12. tail -n 20 file.txt → read, limit=20
# ---------------------------------------------------------------------------


def test_tail_n_flag():
    intent = parse("tail -n 20 file.txt")
    assert intent.kind == "read"
    assert intent.target_path == "file.txt"
    assert intent.limit == 20


# ---------------------------------------------------------------------------
# 13. bat src/main.rs → read
# ---------------------------------------------------------------------------


def test_bat_read():
    intent = parse("bat src/main.rs")
    assert intent.kind == "read"
    assert intent.target_path == "src/main.rs"


# ---------------------------------------------------------------------------
# 14. rg -e 'mypattern' → grep via -e flag
# ---------------------------------------------------------------------------


def test_rg_e_flag():
    intent = parse("rg -e 'mypattern' src/")
    assert intent.kind == "grep"
    assert intent.pattern == "mypattern"


# ---------------------------------------------------------------------------
# 15. fd -e ts → glob
# ---------------------------------------------------------------------------


def test_fd_glob():
    intent = parse("fd -e ts")
    assert intent.kind == "glob"


# ---------------------------------------------------------------------------
# 16. empty / whitespace → unknown
# ---------------------------------------------------------------------------


def test_empty_command():
    intent = parse("")
    assert intent.kind == "unknown"


def test_whitespace_only():
    intent = parse("   ")
    assert intent.kind == "unknown"
