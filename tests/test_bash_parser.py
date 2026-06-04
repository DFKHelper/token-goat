"""Tests for token_goat.bash_parser."""
from __future__ import annotations

import pytest

from token_goat.bash_parser import parse

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
# 8. sudo prefix stripping with system path guard
# ---------------------------------------------------------------------------


def test_sudo_prefix_stripped():
    # sudo prefix is stripped, but /etc/passwd is a system path and rejected
    intent = parse("sudo cat /etc/passwd")
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_sudo_prefix_stripped_project_file():
    # sudo prefix is stripped, and project files are still treated as reads
    intent = parse("sudo cat src/main.py")
    assert intent.kind == "read"
    assert intent.target_path == "src/main.py"


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
# 13b. other read-like commands → read
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,target_path",
    [
        ("less README.md", "README.md"),
        ("more README.md", "README.md"),
        ("zless README.md", "README.md"),
        ("zmore README.md", "README.md"),
        ("batcat README.md", "README.md"),
        ("nl README.md", "README.md"),
        ("cat -n README.md", "README.md"),
        ("awk 'BEGIN { print }' src/main.py", "src/main.py"),
        ("perl -ne 'print' src/main.py", "src/main.py"),
    ],
)
def test_additional_read_like_commands(command, target_path):
    intent = parse(command)
    assert intent.kind == "read"
    assert intent.target_path == target_path


# ---------------------------------------------------------------------------
# 14a. zcat file.txt → read
# ---------------------------------------------------------------------------


def test_zcat_read():
    intent = parse("zcat docs/notes.txt")
    assert intent.kind == "read"
    assert intent.target_path == "docs/notes.txt"


# ---------------------------------------------------------------------------
# 14b. sed -n '1,20p' file.py → read
# ---------------------------------------------------------------------------


def test_sed_scripted_read():
    intent = parse("sed -n '1,20p' src/main.py")
    assert intent.kind == "read"
    assert intent.target_path == "src/main.py"


# ---------------------------------------------------------------------------
# 14c. sed / perl -i... 's/a/b/' file.py → unknown
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "sed -i 's/a/b/' src/main.py",
        "sed --in-place 's/a/b/' src/main.py",
        "perl -i.bak -ne 'print' src/main.py",
    ],
)
def test_scripted_in_place_not_read(command):
    intent = parse(command)
    assert intent.kind == "unknown"
    assert intent.reason is not None
    assert "in place" in intent.reason


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


# ---------------------------------------------------------------------------
# 17. Additional read-equivalent binaries (xxd, od, wc, type)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,target_path",
    [
        ("xxd binary.bin", "binary.bin"),
        ("od -c binary.bin", "binary.bin"),
        ("wc -l README.md", "README.md"),
        ("wc README.md", "README.md"),
        ("type foo.txt", "foo.txt"),
    ],
)
def test_binary_dump_and_count_readers(command, target_path):
    intent = parse(command)
    assert intent.kind == "read"
    assert intent.target_path == target_path


# ---------------------------------------------------------------------------
# 18. PowerShell Get-Content / gc — case-insensitive, -Path, -TotalCount/-Tail
# ---------------------------------------------------------------------------


def test_powershell_get_content_positional():
    intent = parse("Get-Content foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.limit is None


def test_powershell_get_content_case_insensitive():
    # PowerShell cmdlets are case-insensitive; both must be detected.
    intent = parse("GET-CONTENT foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_gc_alias():
    intent = parse("gc foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_get_content_path_flag():
    intent = parse("Get-Content -Path foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_get_content_literalpath_flag():
    intent = parse("Get-Content -LiteralPath foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_get_content_totalcount_offset():
    # -TotalCount maps to head -n N → offset=1, limit=N.
    intent = parse("Get-Content -Path foo.txt -TotalCount 50")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset == 1
    assert intent.limit == 50


def test_powershell_get_content_tail_no_offset():
    # -Tail N maps to tail -n N → limit only, no offset.
    intent = parse("Get-Content foo.txt -Tail 20")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset is None
    assert intent.limit == 20


def test_powershell_get_content_skip_encoding_arg():
    # ``-Encoding utf8`` must not be mistaken for the positional path.
    intent = parse("Get-Content -Encoding utf8 foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


# ---------------------------------------------------------------------------
# 19. Stdin redirection (cmd < FILE) — treated as read of FILE
# ---------------------------------------------------------------------------


def test_redirect_cat_lt_file():
    # ``cat < foo.txt`` is a read of foo.txt — same effect as ``cat foo.txt``.
    intent = parse("cat < foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_redirect_wc_lt_file():
    # ``wc -l < foo.txt`` — wc has no positional path, redirect supplies it.
    intent = parse("wc -l < foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_redirect_unknown_binary_lt_file():
    # Unknown leading binary but stdin redirected from a real file — still a
    # read of the file, since the agent will consume its contents.
    intent = parse("python_script.py < foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_redirect_attached_form():
    # ``cat <foo.txt`` (no space between ``<`` and the path) is valid shell.
    intent = parse("cat <foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


# ---------------------------------------------------------------------------
# 20. Heredoc / here-string — must NOT be classified as a read
# ---------------------------------------------------------------------------


def test_heredoc_not_a_read():
    # ``cat << EOF ... EOF`` consumes the literal heredoc body, not a file.
    intent = parse("cat << EOF")
    assert intent.kind == "unknown"
    assert intent.reason is not None
    assert "heredoc" in intent.reason


def test_here_string_not_a_read():
    # ``grep foo <<< 'bar'`` is a here-string, not a file read.
    intent = parse("cat <<< 'foo bar'")
    assert intent.kind == "unknown"
    assert intent.reason is not None
    assert "heredoc" in intent.reason


# ---------------------------------------------------------------------------
# 21. head extracts offset=1 alongside limit
# ---------------------------------------------------------------------------


def test_head_records_offset_one():
    # head -n N is conceptually "read lines 1..N"; record the slice precisely
    # so session tracking knows the exact range consumed.
    intent = parse("head -n 50 foo.py")
    assert intent.kind == "read"
    assert intent.offset == 1
    assert intent.limit == 50


def test_tail_records_limit_only():
    # tail's starting line depends on the file's total length, which we don't
    # know at parse time — so we record limit only, not offset.
    intent = parse("tail -n 20 file.txt")
    assert intent.kind == "read"
    assert intent.offset is None
    assert intent.limit == 20


@pytest.mark.parametrize("cmd, expected_offset", [
    ("tail -n +10 file.py", 10),
    ("tail -n +1 file.py", 1),
    ("tail -n +100 src/main.py", 100),
    ("tail -n+50 file.py", 50),    # compact form: no space between -n and +50
    ("tail --lines +25 file.py", 25),
    ("tail -n +0 file.py", 1),     # +0 floors to 1 (GNU tail semantics; avoids offset=-1 bleed)
])
def test_tail_skip_to_line_sets_offset(cmd, expected_offset):
    # ``tail -n +N`` outputs from line N to EOF — offset IS known (1-indexed).
    intent = parse(cmd)
    assert intent.kind == "read"
    assert intent.offset == expected_offset
    assert intent.limit is None  # no upper bound: read to EOF


def test_tail_plain_n_does_not_set_offset():
    # Plain ``tail -n N`` (no +) reads the LAST N lines; starting line is unknown.
    intent = parse("tail -n 20 file.txt")
    assert intent.offset is None
    assert intent.limit == 20


# ---------------------------------------------------------------------------
# 22. sed -n 'M,Np' line-range extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,offset,limit",
    [
        ("sed -n '10,20p' src/main.py", 10, 11),  # inclusive: 10..20 → 11 lines
        ("sed -n '5p' src/main.py", 5, 1),  # single line
        ("sed -n '1,100p' README.md", 1, 100),
    ],
)
def test_sed_line_range_extraction(command, offset, limit):
    intent = parse(command)
    assert intent.kind == "read"
    assert intent.offset == offset
    assert intent.limit == limit


def test_sed_inverted_range_falls_through():
    # End < start is nonsensical — fall back to whole-file semantics rather
    # than emitting negative line counts to the session tracker.
    intent = parse("sed -n '20,10p' src/main.py")
    assert intent.kind == "read"
    assert intent.offset is None
    assert intent.limit is None


def test_sed_unknown_script_no_range():
    # Substitution / other commands don't encode a slice → no offset/limit.
    intent = parse("sed -n '/foo/p' src/main.py")
    assert intent.kind == "read"
    assert intent.offset is None
    assert intent.limit is None


# ---------------------------------------------------------------------------
# 23. awk NR slice extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,offset,limit",
    [
        ("awk 'NR==5' src/main.py", 5, 1),
        ("awk 'NR>=10 && NR<=20' src/main.py", 10, 11),
        ("awk 'NR >= 10 && NR <= 20' src/main.py", 10, 11),
    ],
)
def test_awk_line_range_extraction(command, offset, limit):
    intent = parse(command)
    assert intent.kind == "read"
    assert intent.offset == offset
    assert intent.limit == limit


def test_awk_complex_script_no_range():
    # Anything beyond the recognised NR forms falls back to whole-file.
    intent = parse("awk '/foo/ { print }' src/main.py")
    assert intent.kind == "read"
    assert intent.offset is None
    assert intent.limit is None


# ---------------------------------------------------------------------------
# 24. Combined: pipe + redirect — leading segment still recognised
# ---------------------------------------------------------------------------


def test_pipe_with_head_offset():
    # ``head -n 30 foo.py | grep bar`` — only the leading read is parsed,
    # and the head offset/limit must survive.
    intent = parse("head -n 30 foo.py | grep bar")
    assert intent.kind == "read"
    assert intent.target_path == "foo.py"
    assert intent.offset == 1
    assert intent.limit == 30


# ---------------------------------------------------------------------------
# 25. PowerShell pipeline filter detection (iter 27)
# ---------------------------------------------------------------------------


def test_powershell_pipe_select_string_positional():
    # ``Get-Content foo | Select-String 'pat'`` — equivalent to ``grep pat foo``.
    # Source path is captured; filtered=True so dedup logic treats it as a
    # partial read, and the search pattern is recorded.
    intent = parse("Get-Content foo.txt | Select-String 'mypat'")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "mypat"


def test_powershell_pipe_select_string_pattern_flag():
    intent = parse("Get-Content foo.txt | Select-String -Pattern 'foo bar'")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "foo bar"


def test_powershell_pipe_sls_alias():
    # ``sls`` is the PowerShell alias for Select-String.
    intent = parse("gc foo.txt | sls 'needle'")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "needle"


def test_powershell_pipe_where_object_match():
    # ``Where-Object { $_ -match 'pat' }`` filters by regex; capture the pattern.
    intent = parse("Get-Content foo.txt | Where-Object { $_ -match 'needle' }")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "needle"


def test_powershell_pipe_where_alias_question_mark():
    # ``?`` is the canonical alias for Where-Object.
    intent = parse("gc foo.txt | ? { $_ -match 'pat' }")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "pat"


def test_powershell_pipe_select_object_first():
    # ``Select-Object -First N`` is head-N for a pipeline.  No upstream filter
    # so this stays an *unfiltered* head read: offset=1, limit=N, filtered=False.
    intent = parse("Get-Content foo.txt | Select-Object -First 10")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset == 1
    assert intent.limit == 10
    assert intent.filtered is False


def test_powershell_pipe_select_first_alias():
    # ``select`` is the PowerShell alias for Select-Object.
    intent = parse("gc foo.txt | select -First 5")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset == 1
    assert intent.limit == 5


def test_powershell_pipe_select_last():
    # ``Select-Object -Last N`` is tail-N — limit only, no offset.
    intent = parse("Get-Content foo.txt | Select-Object -Last 3")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset is None
    assert intent.limit == 3


def test_powershell_pipe_out_string_passthrough():
    # ``Out-String`` is a formatting stage; the source Get-Content is still a
    # full read (no filter, no limit narrowing).
    intent = parse("Get-Content foo.txt | Out-String -Width 200")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is False
    assert intent.limit is None


def test_powershell_pipe_combined_filter_and_limit():
    # ``gc foo | ? { $_ -match 'foo' } | select -First 5`` — both filter and
    # limit; filtered=True takes precedence, limit/offset recorded.
    intent = parse("gc foo.txt | ? { $_ -match 'foo' } | select -First 5")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is True
    assert intent.filter_pattern == "foo"
    assert intent.offset == 1
    assert intent.limit == 5


def test_powershell_pipe_does_not_override_source_totalcount():
    # When Get-Content already specifies -TotalCount, a downstream
    # Select-Object -First should not widen or override the slice.
    intent = parse("Get-Content foo.txt -TotalCount 20 | Select-Object -First 5")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    # Source flag wins: offset=1, limit=20 (the upstream slice is the tighter
    # bound on what was actually read off disk).
    assert intent.offset == 1
    assert intent.limit == 20


def test_powershell_pipe_unfiltered_passthrough_keeps_full_read():
    # Bare Get-Content with no tail must remain an unfiltered full read.
    intent = parse("Get-Content foo.txt")
    assert intent.kind == "read"
    assert intent.filtered is False
    assert intent.filter_pattern is None


def test_bash_pipe_unchanged_no_filtered_flag():
    # Backward compat: bash-style ``cat foo | grep bar`` pipelines retain
    # their historical whole-file-read semantics and never set filtered=True.
    intent = parse("cat foo.txt | grep bar")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.filtered is False
    assert intent.filter_pattern is None


# ---------------------------------------------------------------------------
# 26. ``type`` ambiguity guard — POSIX builtin vs cmd.exe / PowerShell read
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,expected_path",
    [
        # Path-like arguments (contain ., /, \, :, or ~) → treated as reads.
        ("type foo.txt", "foo.txt"),
        ("type ./foo", "./foo"),
        ("type ../foo", "../foo"),
        ("type src/main.py", "src/main.py"),
        ("type ~/notes.md", "~/notes.md"),
        # Quoted Windows absolute path — shlex preserves backslashes inside quotes.
        ('type "C:\\config.ini"', "C:\\config.ini"),
        # cmd.exe absolute path.
        ("TYPE README.md", "README.md"),
    ],
)
def test_type_with_path_like_argument_is_read(command, expected_path):
    intent = parse(command)
    assert intent.kind == "read"
    assert intent.target_path == expected_path


@pytest.mark.parametrize(
    "command",
    [
        # Bare identifiers — POSIX builtin command-lookup, not a file read.
        "type ls",
        "type git",
        "type python",
        "type cd",
    ],
)
def test_type_with_bare_identifier_is_unknown(command):
    intent = parse(command)
    assert intent.kind == "unknown"
    assert intent.reason is not None
    assert "type" in intent.reason


# ---------------------------------------------------------------------------
# 27. PowerShell Get-Content / gc — additional inline-equals flag forms
# ---------------------------------------------------------------------------


def test_powershell_get_content_path_equals_form():
    # ``Get-Content -Path=foo.txt`` — PowerShell accepts the inline equals form.
    intent = parse("Get-Content -Path=foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_get_content_literalpath_equals_form():
    intent = parse("Get-Content -LiteralPath=foo.txt")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"


def test_powershell_get_content_literalpath_with_spaces():
    """Get-Content -LiteralPath 'my file.txt' must extract the spaced path correctly."""
    intent = parse('Get-Content -LiteralPath "my file with spaces.txt"')
    assert intent.kind == "read"
    assert intent.target_path == "my file with spaces.txt"


def test_powershell_get_content_path_with_spaces():
    """Get-Content path with spaces in double-quotes parses correctly."""
    intent = parse('Get-Content "path/to/my file.txt"')
    assert intent.kind == "read"
    assert intent.target_path == "path/to/my file.txt"


def test_powershell_get_content_totalcount_equals_form():
    intent = parse("Get-Content -Path=foo.txt -TotalCount=50")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset == 1
    assert intent.limit == 50


def test_powershell_get_content_tail_equals_form():
    intent = parse("Get-Content foo.txt -Tail=20")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset is None
    assert intent.limit == 20


def test_powershell_get_content_first_alias():
    # ``-First N`` is a PowerShell partial-name alias for -TotalCount.
    intent = parse("Get-Content foo.txt -First 10")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset == 1
    assert intent.limit == 10


def test_powershell_get_content_last_alias():
    # ``-Last N`` is the partial-name alias for -Tail.
    intent = parse("Get-Content foo.txt -Last 5")
    assert intent.kind == "read"
    assert intent.target_path == "foo.txt"
    assert intent.offset is None
    assert intent.limit == 5


# ---------------------------------------------------------------------------
# 20. Interactive pagers (less, more) — marked as interactive but still tracked
# ---------------------------------------------------------------------------


def test_less_interactive_pager():
    intent = parse("less src/main.rs")
    assert intent.kind == "read"
    assert intent.target_path == "src/main.rs"
    assert intent.is_interactive_pager is True


def test_more_interactive_pager():
    intent = parse("more /var/log/syslog")
    assert intent.kind == "read"
    assert intent.target_path == "/var/log/syslog"
    assert intent.is_interactive_pager is True


def test_less_with_flags():
    intent = parse("less -N file.txt")
    assert intent.kind == "read"
    assert intent.target_path == "file.txt"
    assert intent.is_interactive_pager is True


# ---------------------------------------------------------------------------
# 21. grep/rg read-equivalents (trivial patterns matching everything)
# ---------------------------------------------------------------------------


def test_grep_empty_pattern_is_read_equivalent():
    # grep "" file.txt matches everything in file.txt → treat as read
    intent = parse('grep "" src/main.py')
    assert intent.kind == "read"
    assert intent.target_path == "src/main.py"


def test_rg_dot_pattern_is_read_equivalent():
    # rg "." file.txt matches every line → treat as read
    intent = parse('rg "." README.md')
    assert intent.kind == "read"
    assert intent.target_path == "README.md"


def test_grep_nontrivial_pattern_is_grep():
    # grep with a real pattern remains a grep
    intent = parse('grep "TODO" src/main.py')
    assert intent.kind == "grep"
    assert intent.pattern == "TODO"


def test_rg_nontrivial_pattern_is_grep():
    # rg with a real pattern remains a grep
    intent = parse('rg "error" logs/')
    assert intent.kind == "grep"
    assert intent.pattern == "error"


# ---------------------------------------------------------------------------
# 22. System path guard — reject /etc, /sys, C:\Windows, etc.
# ---------------------------------------------------------------------------


def test_cat_etc_hosts_rejected():
    # cat /etc/hosts is not a project file → unknown
    intent = parse("cat /etc/hosts")
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_cat_windows_system32_rejected():
    # cat C:\Windows\System32\config\... is not a project file
    # Note: shlex.split with posix=True treats backslashes as escapes,
    # so the path becomes C:WindowsSystem32... without backslashes.
    # In a real Windows shell, the path would have backslashes. This test
    # verifies the guard works when the path is properly formed.
    intent = parse('cat "C:\\Windows\\System32\\drivers\\etc\\hosts"')
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_cat_etc_passwd_rejected():
    intent = parse("cat /etc/passwd")
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_cat_sys_rejected():
    intent = parse("cat /sys/devices/pci0000:00/0000:00:00.0/uevent")
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_cat_program_files_rejected():
    intent = parse('cat "C:\\Program Files\\Python\\python.exe"')
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_cat_project_file_accepted():
    # cat src/main.py (a relative path) should still be treated as a read
    intent = parse("cat src/main.py")
    assert intent.kind == "read"
    assert intent.target_path == "src/main.py"


def test_less_etc_logs_rejected():
    # less /etc/something should reject system paths too
    intent = parse("less /etc/sudoers")
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


def test_grep_empty_on_system_path_rejected():
    # grep "" /etc/hosts should still reject as system path
    intent = parse('grep "" /etc/hostname')
    assert intent.kind == "unknown"
    assert "system path" in intent.reason


# ---------------------------------------------------------------------------
# 28. Multi-file cat — target_paths populated when more than one file given
# ---------------------------------------------------------------------------


def test_cat_two_files_target_paths():
    # ``cat file1.py file2.py`` reads both files; target_path holds the first
    # for backward compat, target_paths holds all.
    intent = parse("cat file1.py file2.py")
    assert intent.kind == "read"
    assert intent.target_path == "file1.py"
    assert intent.target_paths == ["file1.py", "file2.py"]


def test_cat_three_files_target_paths():
    intent = parse("cat a.py b.py c.py")
    assert intent.kind == "read"
    assert intent.target_path == "a.py"
    assert intent.target_paths == ["a.py", "b.py", "c.py"]


def test_cat_single_file_no_target_paths():
    # Single-file reads must not populate target_paths (backward compat).
    intent = parse("cat file.py")
    assert intent.kind == "read"
    assert intent.target_path == "file.py"
    assert intent.target_paths is None


def test_cat_multi_file_with_flags():
    # Flags (-n) mixed with multiple file paths.
    intent = parse("cat -n file1.py file2.py")
    assert intent.kind == "read"
    assert intent.target_path == "file1.py"
    assert intent.target_paths == ["file1.py", "file2.py"]


def test_cat_multi_file_system_path_excluded():
    # A system path mixed into a multi-file cat must be silently dropped;
    # the remaining project files form the valid target_paths list.
    intent = parse("cat file.py /etc/hosts other.py")
    assert intent.kind == "read"
    assert intent.target_path == "file.py"
    assert intent.target_paths == ["file.py", "other.py"]


def test_cat_multi_file_quoted_spaces():
    # Quoted paths with spaces must be handled correctly across multiple files.
    intent = parse('cat "dir with spaces/a.py" "dir with spaces/b.py"')
    assert intent.kind == "read"
    assert intent.target_path == "dir with spaces/a.py"
    assert intent.target_paths == ["dir with spaces/a.py", "dir with spaces/b.py"]


# ---------------------------------------------------------------------------
# 29. jq / yq read-equivalent detection (trivial identity filter '.')
# ---------------------------------------------------------------------------


def test_jq_dot_filter_is_read():
    # ``jq '.' config.json`` — identity filter streams whole file → read.
    intent = parse("jq '.' config.json")
    assert intent.kind == "read"
    assert intent.target_path == "config.json"
    assert intent.target_paths is None


def test_yq_dot_filter_is_read():
    # ``yq '.' config.yaml`` — same semantics as jq.
    intent = parse("yq '.' config.yaml")
    assert intent.kind == "read"
    assert intent.target_path == "config.yaml"


def test_jq_with_raw_output_flag_is_read():
    # ``jq -r '.' file.json`` — the -r flag changes output encoding, not the
    # files consumed; still a full-file read.
    intent = parse("jq -r '.' config.json")
    assert intent.kind == "read"
    assert intent.target_path == "config.json"


def test_jq_with_compact_flag_is_read():
    # ``jq -c '.' file.json`` — compact output, still reads entire file.
    intent = parse("jq -c '.' config.json")
    assert intent.kind == "read"
    assert intent.target_path == "config.json"


def test_jq_nontrivial_filter_is_unknown():
    # ``.foo`` is not the identity filter — the agent only sees a projection.
    intent = parse("jq '.foo' config.json")
    assert intent.kind == "unknown"
    assert "non-trivial filter" in intent.reason


def test_jq_complex_filter_is_unknown():
    intent = parse("jq '.[] | .name' items.json")
    assert intent.kind == "unknown"


def test_jq_no_file_is_unknown():
    # ``jq '.'`` with no file reads stdin — not a file read for session tracking.
    intent = parse("jq '.'")
    assert intent.kind == "unknown"
    assert "stdin" in intent.reason


def test_jq_no_args_is_unknown():
    intent = parse("jq")
    assert intent.kind == "unknown"


def test_jq_system_path_rejected():
    # ``jq '.' /etc/hosts`` — system path must be rejected.
    intent = parse("jq '.' /etc/hosts")
    assert intent.kind == "unknown"


def test_jq_multi_file_target_paths():
    # ``jq '.' file1.json file2.json`` reads all listed files.
    intent = parse("jq '.' a.json b.json")
    assert intent.kind == "read"
    assert intent.target_path == "a.json"
    assert intent.target_paths == ["a.json", "b.json"]


def test_yq_nontrivial_filter_is_unknown():
    intent = parse("yq '.metadata.name' pod.yaml")
    assert intent.kind == "unknown"


# ---------------------------------------------------------------------------
# 28. PowerShell Get-Content — additional flag aliases and filter operators
# ---------------------------------------------------------------------------
class TestGetContentAdditionalCoverage:
    """Covers -Head alias and Where-Object -like/-imatch operators not previously tested."""

    def test_get_content_head_flag_alias(self):
        """-Head N is an alias for -TotalCount N and -First N; records offset=1, limit=N."""
        intent = parse("Get-Content foo.py -Head 15")
        assert intent.kind == "read"
        assert intent.target_path == "foo.py"
        assert intent.offset == 1
        assert intent.limit == 15

    def test_gc_head_flag_alias(self):
        """gc alias with -Head N must work identically to Get-Content -Head N."""
        intent = parse("gc foo.py -Head 5")
        assert intent.kind == "read"
        assert intent.target_path == "foo.py"
        assert intent.offset == 1
        assert intent.limit == 5

    def test_where_object_like_operator_captured(self):
        """Where-Object { $_ -like '...' } must set filtered=True and capture pattern."""
        intent = parse("gc foo.txt | ? { $_ -like '*needle*' }")
        assert intent.kind == "read"
        assert intent.target_path == "foo.txt"
        assert intent.filtered is True
        assert intent.filter_pattern == "*needle*"

    def test_where_object_imatch_operator_captured(self):
        """Where-Object { $_ -imatch '...' } (case-insensitive match) must be captured."""
        intent = parse("Get-Content foo.txt | ? { $_ -imatch 'ErrorLevel' }")
        assert intent.kind == "read"
        assert intent.target_path == "foo.txt"
        assert intent.filtered is True
        assert intent.filter_pattern == "ErrorLevel"

    def test_get_content_no_args_is_unknown(self):
        """Get-Content with no file argument must return kind='unknown'."""
        intent = parse("Get-Content")
        assert intent.kind == "unknown"

    def test_gc_no_args_is_unknown(self):
        """gc alias with no file argument must return kind='unknown'."""
        intent = parse("gc")
        assert intent.kind == "unknown"


# ---------------------------------------------------------------------------
# 29. PowerShell Get-Content — new capabilities: -Wait, multi-file, expanded
#     passthrough cmdlets, and notmatch/notlike Where-Object operators
# ---------------------------------------------------------------------------
class TestGetContentNewCapabilities:
    """Covers -Wait (interactive pager), multi-file reads, expanded passthrough
    cmdlets, and negation operators in Where-Object predicates."""

    # -Wait flag (continuous tail-f mode) -----------------------------------

    def test_get_content_wait_is_interactive_pager(self):
        """-Wait streams continuously — must be treated as an interactive pager."""
        intent = parse("Get-Content app.log -Wait")
        assert intent.kind == "read"
        assert intent.target_path == "app.log"
        assert intent.is_interactive_pager is True

    def test_gc_wait_is_interactive_pager(self):
        """gc alias with -Wait must also be marked interactive."""
        intent = parse("gc service.log -Wait")
        assert intent.kind == "read"
        assert intent.target_path == "service.log"
        assert intent.is_interactive_pager is True

    def test_get_content_wait_no_limit(self):
        """-Wait with no count flag: no limit, interactive, full path captured."""
        intent = parse("Get-Content C:/logs/app.log -Wait")
        assert intent.kind == "read"
        assert intent.target_path == "C:/logs/app.log"
        assert intent.limit is None
        assert intent.is_interactive_pager is True

    def test_get_content_without_wait_not_pager(self):
        """Plain Get-Content without -Wait must not be an interactive pager."""
        intent = parse("Get-Content app.log")
        assert intent.kind == "read"
        assert intent.is_interactive_pager is False

    # Multi-file reads -------------------------------------------------------

    def test_get_content_two_files_positional(self):
        """gc file1.txt file2.txt — both paths must appear in target_paths."""
        intent = parse("gc file1.txt file2.txt")
        assert intent.kind == "read"
        assert intent.target_path == "file1.txt"
        assert intent.target_paths == ["file1.txt", "file2.txt"]

    def test_get_content_three_files(self):
        """Get-Content with three positional files collects all three."""
        intent = parse("Get-Content a.log b.log c.log")
        assert intent.kind == "read"
        assert intent.target_path == "a.log"
        assert intent.target_paths == ["a.log", "b.log", "c.log"]

    def test_get_content_single_file_target_paths_is_none(self):
        """Single-file Get-Content must leave target_paths as None (compat)."""
        intent = parse("Get-Content only.txt")
        assert intent.kind == "read"
        assert intent.target_path == "only.txt"
        assert intent.target_paths is None

    # Expanded passthrough cmdlets -------------------------------------------

    def test_sort_object_is_passthrough(self):
        """Sort-Object does not narrow the stream; source is a full read."""
        intent = parse("Get-Content data.txt | Sort-Object")
        assert intent.kind == "read"
        assert intent.target_path == "data.txt"
        assert intent.filtered is False

    def test_sort_alias_is_passthrough(self):
        """``sort`` alias for Sort-Object must also be a passthrough."""
        intent = parse("gc data.txt | sort")
        assert intent.kind == "read"
        assert intent.filtered is False

    def test_foreach_object_is_passthrough(self):
        """ForEach-Object visits every line — source is a full read."""
        intent = parse("Get-Content file.txt | ForEach-Object { $_ }")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.filtered is False

    def test_foreach_percent_alias_is_passthrough(self):
        """``%`` alias for ForEach-Object must be treated as passthrough."""
        intent = parse("gc file.txt | % { $_ }")
        assert intent.kind == "read"
        assert intent.filtered is False

    def test_tee_object_is_passthrough(self):
        """Tee-Object copies the stream without narrowing it."""
        intent = parse("Get-Content src.txt | Tee-Object -FilePath copy.txt")
        assert intent.kind == "read"
        assert intent.target_path == "src.txt"
        assert intent.filtered is False

    def test_measure_object_is_passthrough(self):
        """Measure-Object reads all lines to compute statistics."""
        intent = parse("Get-Content data.csv | Measure-Object -Line")
        assert intent.kind == "read"
        assert intent.filtered is False

    def test_convertto_json_is_passthrough(self):
        """ConvertTo-Json serialises all source content — full read."""
        intent = parse("Get-Content config.txt | ConvertTo-Json")
        assert intent.kind == "read"
        assert intent.target_path == "config.txt"
        assert intent.filtered is False

    def test_group_object_is_passthrough(self):
        """Group-Object groups all lines — full read."""
        intent = parse("gc events.log | Group-Object")
        assert intent.kind == "read"
        assert intent.filtered is False

    # Where-Object negation operators ----------------------------------------

    def test_where_notmatch_sets_filtered_and_captures_pattern(self):
        """-notmatch still narrows to non-matching lines — filtered=True."""
        intent = parse("gc app.log | ? { $_ -notmatch 'DEBUG' }")
        assert intent.kind == "read"
        assert intent.target_path == "app.log"
        assert intent.filtered is True
        assert intent.filter_pattern == "DEBUG"

    def test_where_notlike_sets_filtered_and_captures_pattern(self):
        """-notlike is a negation filter — filtered=True, pattern captured."""
        intent = parse("Get-Content log.txt | ? { $_ -notlike '*TRACE*' }")
        assert intent.kind == "read"
        assert intent.filtered is True
        assert intent.filter_pattern == "*TRACE*"

    def test_where_cnotmatch_sets_filtered(self):
        """-cnotmatch (case-sensitive negation) must be detected as filtered."""
        intent = parse("gc file.txt | ? { $_ -cnotmatch 'Error' }")
        assert intent.kind == "read"
        assert intent.filtered is True
        assert intent.filter_pattern == "Error"

    def test_where_inotmatch_sets_filtered(self):
        """-inotmatch (case-insensitive negation) must be detected as filtered."""
        intent = parse("gc file.txt | ? { $_ -inotmatch 'warning' }")
        assert intent.kind == "read"
        assert intent.filtered is True
        assert intent.filter_pattern == "warning"

    # Flag arg-consumer edge cases (Category A unconditional) ----------------

    def test_stream_after_path_does_not_add_stream_name_as_target(self):
        """-Stream after the path must not add the stream name to target_paths.

        ``gc file.txt -Stream Zone.Identifier`` reads an NTFS alternate data
        stream.  ``Zone.Identifier`` is the *stream name*, never a file path.
        It must be consumed as the flag's argument and not appended to
        ``target_paths``.
        """
        intent = parse("gc file.txt -Stream Zone.Identifier")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None

    def test_stream_before_path_is_consumed(self):
        """``gc -Stream Zone.Identifier file.txt`` — stream name before path is consumed."""
        intent = parse("gc -Stream Zone.Identifier file.txt")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None

    def test_readcount_after_path_does_not_add_count_as_target(self):
        """-ReadCount N after the path must not append N to target_paths.

        ``gc file.txt -ReadCount 10`` reads all lines, processing them in
        batches of 10.  The count ``10`` is the flag's argument and must not
        be treated as a second file path.
        """
        intent = parse("gc file.txt -ReadCount 10")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None
        assert intent.limit is None  # -ReadCount is not a total-count limit

    def test_readcount_before_path_is_consumed(self):
        """``gc -ReadCount 5 file.txt`` — count before path is consumed."""
        intent = parse("gc -ReadCount 5 file.txt")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None

    def test_encoding_after_path_does_not_add_encoding_as_target(self):
        """-Encoding value after the path must not append to target_paths."""
        intent = parse("gc file.txt -Encoding UTF8")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None

    def test_delimiter_after_path_does_not_add_delimiter_as_target(self):
        """-Delimiter value after the path must not append to target_paths."""
        intent = parse("gc file.txt -Delimiter ,")
        assert intent.kind == "read"
        assert intent.target_path == "file.txt"
        assert intent.target_paths is None

    def test_asbyte_stream_is_full_read(self):
        """-AsByteStream reads the whole file in binary mode — kind='read'.

        token-goat treats -AsByteStream as a full file read for session-tracking
        and image-shrink purposes: the entire file is loaded into the agent's
        context regardless of whether it is text or binary.
        """
        intent = parse("Get-Content file.bin -AsByteStream")
        assert intent.kind == "read"
        assert intent.target_path == "file.bin"
        assert intent.limit is None
        assert intent.offset is None
        assert intent.is_interactive_pager is False

    def test_asbyte_stream_on_image_is_read(self):
        """-AsByteStream on an image still yields kind='read' (image-shrink applies)."""
        intent = parse("Get-Content image.png -AsByteStream")
        assert intent.kind == "read"
        assert intent.target_path == "image.png"

    def test_full_cmdlet_stream_after_path(self):
        """Full cmdlet name Get-Content with -Stream after path."""
        intent = parse("Get-Content notes.txt -Stream Zone.Identifier")
        assert intent.kind == "read"
        assert intent.target_path == "notes.txt"
        assert intent.target_paths is None

    def test_multi_file_unaffected_by_stream_fix(self):
        """Multi-file reads still populate target_paths after -Stream fix."""
        intent = parse("gc file1.txt file2.txt")
        assert intent.kind == "read"
        assert intent.target_path == "file1.txt"
        assert intent.target_paths == ["file1.txt", "file2.txt"]
