"""Tests for PsFilter (ps/top/tasklist process listing compression)."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from token_goat.bash_compress import PsFilter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PS_AUX_HEADER = "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND"

# Enough system-daemon lines to exceed the 20-line threshold
_DAEMON_LINES: list[str] = [
    f"root       {100 + i}  0.0  0.0      0     0 ?        S    Jun08   0:00 [kworker/{i}:0]"
    for i in range(25)
]

_PS_EF_HEADER = "UID        PID  PPID  C STIME TTY          TIME CMD"


def _make_ps_aux(extra_lines: list[str] | None = None) -> str:
    """Return a ps aux output string with daemon filler + optional extra lines."""
    lines = [_PS_AUX_HEADER] + _DAEMON_LINES
    if extra_lines:
        lines += extra_lines
    return "\n".join(lines)


def _compress(stdout: str, argv: list[str] | None = None) -> str:
    return PsFilter().compress(stdout, "", 0, argv or ["ps", "aux"])


# ---------------------------------------------------------------------------
# 1. Short output (≤ 20 lines) → passthrough unchanged
# ---------------------------------------------------------------------------

def test_short_output_passthrough() -> None:
    short = "\n".join([_PS_AUX_HEADER] + _DAEMON_LINES[:10])
    assert len(short.splitlines()) <= 20
    result = _compress(short)
    assert result == short


# ---------------------------------------------------------------------------
# 2. Large ps aux: header kept, python process kept, daemons suppressed
# ---------------------------------------------------------------------------

def test_large_ps_aux_python_kept() -> None:
    python_line = "user      9999  1.2  3.4 123456 65432 pts/0    S    09:00   0:05 python app.py"
    output = _make_ps_aux([python_line])
    result = _compress(output)
    assert _PS_AUX_HEADER in result
    assert "python app.py" in result
    assert "[suppressed" in result


# ---------------------------------------------------------------------------
# 3. High-CPU process (>5%) is kept
# ---------------------------------------------------------------------------

def test_high_cpu_process_kept() -> None:
    high_cpu = "root        42 12.5  0.1  50000  4096 ?        R    09:00   0:30 /usr/bin/stress"
    output = _make_ps_aux([high_cpu])
    result = _compress(output)
    assert "/usr/bin/stress" in result


# ---------------------------------------------------------------------------
# 4. High-MEM process (>2%) is kept
# ---------------------------------------------------------------------------

def test_high_mem_process_kept() -> None:
    high_mem = "root        99  0.0  5.8 800000 98304 ?        S    09:00   1:00 /usr/bin/bloat"
    output = _make_ps_aux([high_mem])
    result = _compress(output)
    assert "/usr/bin/bloat" in result


# ---------------------------------------------------------------------------
# 5. User-owned process is kept (USERNAME/USER env match)
# ---------------------------------------------------------------------------

def test_user_owned_process_kept() -> None:
    user_line = "alice      7777  0.0  0.1  12345   512 pts/1    S    09:00   0:00 bash"
    output = _make_ps_aux([user_line])
    with patch.dict(os.environ, {"USERNAME": "alice", "USER": "alice"}):
        result = _compress(output)
    assert "bash" in result


# ---------------------------------------------------------------------------
# 6. Dev-relevant command names (uvicorn, node, redis, nginx, …) are kept
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("cmd,binary", [
    ("uvicorn main:app --port 8000", "uvicorn"),
    ("node server.js", "node"),
    ("redis-server /etc/redis.conf", "redis"),
    ("nginx: worker process", "nginx"),
    ("docker-proxy -proto tcp", "docker"),
])
def test_dev_relevant_commands_kept(cmd: str, binary: str) -> None:
    dev_line = f"user      8888  0.0  0.1  50000  1024 pts/0    S    09:00   0:00 {cmd}"
    output = _make_ps_aux([dev_line])
    result = _compress(output)
    assert binary in result


# ---------------------------------------------------------------------------
# 7. Suppressed sentinel shows correct count
# ---------------------------------------------------------------------------

def test_suppressed_sentinel_correct_count() -> None:
    # All daemon lines should be suppressed; none are user-owned or dev-relevant
    output = _make_ps_aux()
    with patch.dict(os.environ, {"USERNAME": "noone", "USER": "noone"}):
        result = _compress(output)
    sentinel_line = next(
        (ln for ln in result.splitlines() if ln.startswith("[suppressed")), None
    )
    assert sentinel_line is not None
    suppressed = int(sentinel_line.split()[1])
    assert suppressed == len(_DAEMON_LINES)


# ---------------------------------------------------------------------------
# 8. No lines suppressed → sentinel NOT appended, output unchanged
# ---------------------------------------------------------------------------

def test_no_suppression_no_sentinel() -> None:
    # Build output with ONLY the header + python lines so nothing is suppressed
    lines = [_PS_AUX_HEADER] + [
        f"user      {1000 + i}  0.0  0.5 100000 10000 pts/0    S    09:00   0:01 python worker{i}.py"
        for i in range(25)
    ]
    output = "\n".join(lines)
    result = _compress(output)
    assert "[suppressed" not in result
    assert result == output


# ---------------------------------------------------------------------------
# 9. detect() True for ps aux header, False for plain text
# ---------------------------------------------------------------------------

def test_detect_true_ps_aux_header() -> None:
    assert PsFilter.detect(_PS_AUX_HEADER + "\nroot  1  0.0  0.0  0 0 ? Ss Jun08 0:00 init") is True


def test_detect_true_top_batch_mode() -> None:
    top_output = "top - 09:00:00 up 2 days,  3:14,  1 user,  load average: 0.10, 0.20, 0.15"
    assert PsFilter.detect(top_output) is True


def test_detect_false_plain_text() -> None:
    assert PsFilter.detect("Hello world\nThis is just plain text\nNo process table here") is False


# ---------------------------------------------------------------------------
# 10. tasklist format: header kept, IMAGE NAME used for dev-relevant match
# ---------------------------------------------------------------------------

def test_tasklist_dev_process_kept() -> None:
    tasklist_output = "\n".join([
        "Image Name                     PID Session Name        Session#    Mem Usage",
        "========================= ======== ================ =========== ============",
    ] + [
        f"svchost.exe                  {200 + i} Services                   0       1,234 K"
        for i in range(22)
    ] + [
        "python.exe                    5678 Console                    1     87,456 K",
    ])
    result = _compress(tasklist_output, argv=["tasklist"])
    assert "python.exe" in result
    assert "[suppressed" in result


def test_tasklist_header_always_kept() -> None:
    tasklist_output = "\n".join([
        "Image Name                     PID Session Name        Session#    Mem Usage",
        "========================= ======== ================ =========== ============",
    ] + [
        f"svchost.exe                  {300 + i} Services                   0       1,234 K"
        for i in range(22)
    ])
    result = _compress(tasklist_output, argv=["tasklist"])
    assert "Image Name" in result


# ---------------------------------------------------------------------------
# 11. ps -ef format: no CPU/MEM columns; CMD column used
# ---------------------------------------------------------------------------

def test_ps_ef_dev_command_kept() -> None:
    ef_lines = [_PS_EF_HEADER]
    ef_lines += [
        f"root       {500 + i}     1  0 09:00 ?  00:00:00 [kworker/{i}:H]"
        for i in range(22)
    ]
    ef_lines.append("user      9001     1  0 09:01 pts/0  00:01:00 uvicorn api:app --workers 4")
    output = "\n".join(ef_lines)
    result = _compress(output, argv=["ps", "-ef"])
    assert "uvicorn" in result
    assert "[suppressed" in result


# ---------------------------------------------------------------------------
# 12. top -bn1 batch output: summary header block kept, process table filtered
# ---------------------------------------------------------------------------

def test_top_batch_process_table_filtered() -> None:
    top_lines = [
        "top - 09:00:00 up 1 day,  2:34,  1 user,  load average: 0.10, 0.20, 0.15",
        "Tasks: 200 total,   1 running, 199 sleeping,   0 stopped,   0 zombie",
        "%Cpu(s):  0.3 us,  0.7 sy,  0.0 ni, 98.5 id,  0.0 wa,  0.0 hi,  0.5 si,  0.0 st",
        "MiB Mem :  15914.0 total,  12345.0 free,   2100.0 used,   1469.0 buff/cache",
        "MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  11969.0 avail Mem",
        "",
        "  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
    ]
    # Add enough daemon lines to exceed threshold
    top_lines += [
        f"  {100 + i} root      20   0    1234    456    123 S   0.0   0.0   0:00.{i:02d} kworker/{i}:0"
        for i in range(20)
    ]
    top_lines.append("  5678 user      20   0  234567  89012  12345 S   3.2   1.1   0:10.00 node server.js")
    output = "\n".join(top_lines)
    result = _compress(output, argv=["top", "-bn1"])
    assert "node server.js" in result
    assert "[suppressed" in result
