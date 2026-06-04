"""Tests for the per-file symbol cap in parser.write_file_index.

Guards against pathological generated files (compiled CSS bundles,
auto-generated protobuf stubs) producing too many symbols.
"""
from __future__ import annotations

import sqlite3
import time

from token_goat import db
from token_goat.parser import (
    MAX_SYMBOLS_PER_FILE,
    FileIndex,
    Symbol,
    write_file_index,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_symbols(n: int, kind: str = "function") -> list[Symbol]:
    """Return *n* distinct Symbol objects (source-order, line 1..n)."""
    return [Symbol(name=f"sym_{i}", kind=kind, line=i + 1) for i in range(n)]


def _make_fi(h: str, symbols: list[Symbol]) -> FileIndex:
    """Build a minimal FileIndex backed by project hash *h*."""
    return FileIndex(
        rel_path="src/generated.ts",
        language="typescript",
        size=100,
        line_count=len(symbols) + 1,
        mtime=time.time(),
        content_sha256="a" * 64,
        symbols=symbols,
    )


def _symbol_count_in_db(conn: sqlite3.Connection, rel_path: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM symbols WHERE file_rel = ?", (rel_path,)
    ).fetchone()
    return int(row[0])


# ---------------------------------------------------------------------------
# 1. Below the cap: all symbols stored
# ---------------------------------------------------------------------------

def test_symbols_below_cap_all_stored(tmp_data_dir):
    """When symbol count <= MAX_SYMBOLS_PER_FILE, every valid symbol is persisted."""
    h = "ca01e5100100000000000000000000000000000a"
    n = MAX_SYMBOLS_PER_FILE
    fi = _make_fi(h, _make_symbols(n))

    with db.open_project(h) as conn:
        # Seed the files table so the FK constraint is satisfied
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        write_file_index(conn, fi)
        count = _symbol_count_in_db(conn, fi.rel_path)

    assert count == n, f"expected {n} symbols stored, got {count}"


# ---------------------------------------------------------------------------
# 2. Exactly at the cap: all stored
# ---------------------------------------------------------------------------

def test_symbols_exactly_at_cap_all_stored(tmp_data_dir):
    """Exactly MAX_SYMBOLS_PER_FILE symbols must all be stored (boundary case)."""
    h = "ca01e5100200000000000000000000000000000a"
    n = MAX_SYMBOLS_PER_FILE
    fi = _make_fi(h, _make_symbols(n))

    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        write_file_index(conn, fi)
        count = _symbol_count_in_db(conn, fi.rel_path)

    assert count == MAX_SYMBOLS_PER_FILE


# ---------------------------------------------------------------------------
# 3. Above the cap: truncated to MAX_SYMBOLS_PER_FILE
# ---------------------------------------------------------------------------

def test_symbols_above_cap_truncated(tmp_data_dir):
    """When a file has > MAX_SYMBOLS_PER_FILE symbols, only the first cap are stored."""
    h = "ca01e5100300000000000000000000000000000a"
    n = MAX_SYMBOLS_PER_FILE + 500  # well above the cap
    fi = _make_fi(h, _make_symbols(n))

    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        write_file_index(conn, fi)
        count = _symbol_count_in_db(conn, fi.rel_path)

    assert count == MAX_SYMBOLS_PER_FILE, (
        f"expected cap={MAX_SYMBOLS_PER_FILE} symbols stored, got {count}"
    )


# ---------------------------------------------------------------------------
# 4. Source-order preservation under cap
# ---------------------------------------------------------------------------

def test_symbols_truncated_preserves_source_order(tmp_data_dir):
    """The first MAX_SYMBOLS_PER_FILE symbols (lowest line numbers) must be stored."""
    h = "ca01e5100400000000000000000000000000000a"
    n = MAX_SYMBOLS_PER_FILE + 10
    symbols = _make_symbols(n)  # sym_0 (line 1) .. sym_{n-1} (line n)
    fi = _make_fi(h, symbols)

    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        write_file_index(conn, fi)
        rows = conn.execute(
            "SELECT name FROM symbols WHERE file_rel = ? ORDER BY line", (fi.rel_path,)
        ).fetchall()

    stored_names = [r[0] for r in rows]
    expected_names = [f"sym_{i}" for i in range(MAX_SYMBOLS_PER_FILE)]
    assert stored_names == expected_names, (
        f"first stored name={stored_names[0]!r}, last={stored_names[-1]!r}; "
        f"expected sym_0..sym_{MAX_SYMBOLS_PER_FILE - 1}"
    )


# ---------------------------------------------------------------------------
# 5. Warning logged when cap is exceeded
# ---------------------------------------------------------------------------

def test_symbols_above_cap_logs_warning(tmp_data_dir, caplog):
    """write_file_index must emit a WARNING when symbol count exceeds cap."""
    import logging

    h = "ca01e5100500000000000000000000000000000a"
    n = MAX_SYMBOLS_PER_FILE + 1
    fi = _make_fi(h, _make_symbols(n))

    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        with caplog.at_level(logging.WARNING, logger="token_goat.parser"):
            write_file_index(conn, fi)

    assert any("truncating" in rec.message or "cap=" in rec.message for rec in caplog.records), (
        f"expected a truncation warning; got records: {[r.message for r in caplog.records]}"
    )


# ---------------------------------------------------------------------------
# 6. Zero symbols: no crash, no DB rows
# ---------------------------------------------------------------------------

def test_zero_symbols_no_crash(tmp_data_dir):
    """write_file_index must not crash and must store 0 rows when fi.symbols is empty."""
    h = "ca01e5100600000000000000000000000000000a"
    fi = _make_fi(h, [])

    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, int(time.time())),
        )
        write_file_index(conn, fi)
        count = _symbol_count_in_db(conn, fi.rel_path)

    assert count == 0


# ---------------------------------------------------------------------------
# 7. MAX_SYMBOLS_PER_FILE constant is sane
# ---------------------------------------------------------------------------

def test_max_symbols_per_file_value():
    """MAX_SYMBOLS_PER_FILE must be a positive integer in a reasonable range."""
    assert isinstance(MAX_SYMBOLS_PER_FILE, int)
    assert 100 <= MAX_SYMBOLS_PER_FILE <= 10_000, (
        f"MAX_SYMBOLS_PER_FILE={MAX_SYMBOLS_PER_FILE} is outside the expected [100, 10000] range"
    )
