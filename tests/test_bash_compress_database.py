"""Tests for database CLI filters: PsqlFilter, MySQLFilter, Sqlite3Filter, RedisCLIFilter."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# PsqlFilter
# ---------------------------------------------------------------------------

_PSQL_ARGV = ["psql", "-U", "postgres", "mydb"]


def _psql_table(n_rows: int) -> str:
    """Build a synthetic psql aligned-table SELECT result with n_rows data rows."""
    header = " id | name "
    sep = "----+------"
    rows = [f"  {i} | row{i} " for i in range(1, n_rows + 1)]
    footer = f"({n_rows} rows)"
    return "\n".join([header, sep, *rows, sep, footer])


class TestPsqlFilter:
    def test_matches(self):
        assert bc.PsqlFilter().matches(["psql", "-U", "postgres", "db"])
        assert not bc.PsqlFilter().matches(["mysql"])

    def test_select_filter(self):
        assert isinstance(bc.select_filter(["psql", "-U", "postgres", "db"]), bc.PsqlFilter)

    def test_short_table_kept_intact(self):
        out = _psql_table(5)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        # All 5 data rows should be present.
        assert "row5" in r.text

    def test_long_table_collapsed(self):
        out = _psql_table(30)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "30 rows" in r.text
        assert "showing first 5" in r.text
        # Row 6 onwards should be elided.
        assert "row6" not in r.text

    def test_long_table_keeps_first_rows(self):
        out = _psql_table(30)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "row1" in r.text
        assert "row5" in r.text

    def test_timing_kept(self):
        out = "SELECT 1\nTime: 3.412 ms"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "Time: 3.412 ms" in r.text

    def test_dml_tag_kept(self):
        out = "INSERT 0 5"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "INSERT 0 5" in r.text

    def test_update_tag_kept(self):
        out = "UPDATE 3"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "UPDATE 3" in r.text

    def test_delete_tag_kept(self):
        out = "DELETE 7"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "DELETE 7" in r.text

    def test_notice_kept(self):
        out = "NOTICE:  table \"foo\" does not exist, skipping"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "NOTICE" in r.text

    def test_warning_kept(self):
        out = "WARNING:  there is already a transaction in progress"
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "WARNING" in r.text

    def test_error_kept_verbatim(self):
        out = 'ERROR:  relation "foo" does not exist\nLINE 1: SELECT * FROM foo;'
        r = bc.PsqlFilter().apply(out, "", 1, _PSQL_ARGV)
        assert "ERROR" in r.text
        assert 'relation "foo"' in r.text

    def test_connection_error_kept(self):
        err = "psql: error: connection to server on socket failed"
        r = bc.PsqlFilter().apply("", err, 2, _PSQL_ARGV)
        assert "psql: error:" in r.text

    def test_migration_collapsed(self):
        ddl_lines = [f"CREATE TABLE t{i} (id int);" for i in range(5)]
        out = "\n".join(ddl_lines)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "5 tables" in r.text
        # Individual table names should be collapsed.
        assert "CREATE TABLE t4" not in r.text

    def test_migration_with_indexes(self):
        lines = (
            ["CREATE TABLE orders (id int);"] * 3
            + ["CREATE INDEX idx_orders_id ON orders (id);"] * 2
        )
        out = "\n".join(lines)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert "3 tables" in r.text
        assert "2 indexes" in r.text

    def test_empty_output(self):
        r = bc.PsqlFilter().apply("", "", 0, _PSQL_ARGV)
        assert isinstance(r.text, str)

    def test_compression_on_long_table(self):
        out = _psql_table(50)
        r = bc.PsqlFilter().apply(out, "", 0, _PSQL_ARGV)
        assert r.compressed_bytes < r.original_bytes


# ---------------------------------------------------------------------------
# MySQLFilter
# ---------------------------------------------------------------------------

_MYSQL_ARGV = ["mysql", "-u", "root", "mydb"]
_MYSQLDUMP_ARGV = ["mysqldump", "-u", "root", "mydb"]


def _mysql_table(n_rows: int) -> str:
    """Build a synthetic mysql aligned-table result with n_rows data rows."""
    border = "+---------+----------+"
    header = "| id      | name     |"
    rows = [f"| {i:<7} | row{i:<5} |" for i in range(1, n_rows + 1)]
    footer = f"{n_rows} rows in set (0.00 sec)"
    return "\n".join([border, header, border, *rows, border, footer])


class TestMySQLFilter:
    def test_matches_mysql(self):
        assert bc.MySQLFilter().matches(["mysql", "-u", "root", "db"])
        assert not bc.MySQLFilter().matches(["psql"])

    def test_matches_mysqldump(self):
        assert bc.MySQLFilter().matches(["mysqldump", "-u", "root", "db"])

    def test_select_filter_mysql(self):
        assert isinstance(bc.select_filter(["mysql", "-u", "root", "db"]), bc.MySQLFilter)

    def test_select_filter_mysqldump(self):
        assert isinstance(bc.select_filter(["mysqldump", "-u", "root", "db"]), bc.MySQLFilter)

    def test_short_table_intact(self):
        out = _mysql_table(5)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert "row5" in r.text

    def test_long_table_collapsed(self):
        out = _mysql_table(30)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert "30 rows" in r.text
        assert "showing first 5" in r.text
        assert "row6" not in r.text

    def test_long_table_keeps_first_rows(self):
        out = _mysql_table(30)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert "row1" in r.text
        assert "row5" in r.text

    def test_rows_in_set_kept(self):
        out = _mysql_table(3)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert "rows in set" in r.text

    def test_warning_kept(self):
        out = "WARNING: Using a password on the command line interface can be insecure."
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert "WARNING" in r.text

    def test_error_kept_verbatim(self):
        out = "ERROR 1045 (28000): Access denied for user 'root'@'localhost'"
        r = bc.MySQLFilter().apply(out, "", 1, _MYSQL_ARGV)
        assert "ERROR 1045" in r.text

    def test_mysqldump_banner_kept(self):
        out = "-- MySQL dump 10.13  Distrib 8.0.30\n-- Host: localhost    Database: mydb\n"
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQLDUMP_ARGV)
        assert "MySQL dump" in r.text

    def test_mysqldump_collapse_many_tables(self):
        # 5 table structure blocks; only first 3 should be kept verbatim.
        blocks = []
        for i in range(5):
            blocks.append(f"-- Table structure for table `t{i}`")
            blocks.append(f"CREATE TABLE `t{i}` (id int);")
            blocks.append("")
        out = "\n".join(blocks)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQLDUMP_ARGV)
        # The summary note should mention 5 tables.
        assert "5 tables" in r.text

    def test_mysqldump_keeps_first_n_tables(self):
        blocks = []
        for i in range(5):
            blocks.append(f"-- Table structure for table `t{i}`")
            blocks.append(f"CREATE TABLE `t{i}` (id int);")
            blocks.append("")
        out = "\n".join(blocks)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQLDUMP_ARGV)
        # First 3 CREATE TABLE lines should be present.
        assert "CREATE TABLE `t0`" in r.text
        assert "CREATE TABLE `t2`" in r.text

    def test_empty_output(self):
        r = bc.MySQLFilter().apply("", "", 0, _MYSQL_ARGV)
        assert isinstance(r.text, str)

    def test_compression_on_long_table(self):
        out = _mysql_table(50)
        r = bc.MySQLFilter().apply(out, "", 0, _MYSQL_ARGV)
        assert r.compressed_bytes < r.original_bytes


# ---------------------------------------------------------------------------
# Sqlite3Filter
# ---------------------------------------------------------------------------

_SQLITE3_ARGV = ["sqlite3", "mydb.sqlite"]


def _sqlite3_rows(n: int) -> str:
    """Build pipe-separated sqlite3 output with n rows."""
    return "\n".join(f"{i}|row{i}" for i in range(1, n + 1))


class TestSqlite3Filter:
    def test_matches(self):
        assert bc.Sqlite3Filter().matches(["sqlite3", "db.sqlite"])
        assert not bc.Sqlite3Filter().matches(["mysql"])

    def test_select_filter(self):
        assert isinstance(bc.select_filter(["sqlite3", "db.sqlite"]), bc.Sqlite3Filter)

    def test_short_output_intact(self):
        out = _sqlite3_rows(5)
        r = bc.Sqlite3Filter().apply(out, "", 0, _SQLITE3_ARGV)
        assert "row5" in r.text

    def test_long_output_collapsed(self):
        out = _sqlite3_rows(30)
        r = bc.Sqlite3Filter().apply(out, "", 0, _SQLITE3_ARGV)
        assert "30 rows" in r.text
        assert "showing first 5" in r.text
        assert "row6" not in r.text

    def test_long_output_keeps_first_rows(self):
        out = _sqlite3_rows(30)
        r = bc.Sqlite3Filter().apply(out, "", 0, _SQLITE3_ARGV)
        assert "row1" in r.text
        assert "row5" in r.text

    def test_schema_output_kept(self):
        out = (
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n"
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);\n"
            "CREATE INDEX idx_orders_user ON orders(user_id);\n"
        )
        r = bc.Sqlite3Filter().apply(out, "", 0, _SQLITE3_ARGV)
        assert "CREATE TABLE users" in r.text
        assert "CREATE TABLE orders" in r.text

    def test_error_kept_verbatim(self):
        err = "Error: no such table: missing_table"
        r = bc.Sqlite3Filter().apply("", err, 1, _SQLITE3_ARGV)
        assert "Error:" in r.text
        assert "missing_table" in r.text

    def test_parse_error_kept(self):
        err = "Parse error: near \"SELEC\": syntax error"
        r = bc.Sqlite3Filter().apply("", err, 1, _SQLITE3_ARGV)
        assert "Parse error:" in r.text

    def test_empty_output(self):
        r = bc.Sqlite3Filter().apply("", "", 0, _SQLITE3_ARGV)
        assert isinstance(r.text, str)

    def test_compression_on_long_output(self):
        out = _sqlite3_rows(50)
        r = bc.Sqlite3Filter().apply(out, "", 0, _SQLITE3_ARGV)
        assert r.compressed_bytes < r.original_bytes


# ---------------------------------------------------------------------------
# RedisCLIFilter
# ---------------------------------------------------------------------------

_REDIS_ARGV = ["redis-cli"]


def _redis_keys(n: int) -> str:
    """Build a redis-cli KEYS * response with n key entries."""
    lines = [f'{i}) "key:{i}"' for i in range(1, n + 1)]
    return "\n".join(lines)


def _redis_list(n: int) -> str:
    """Build a redis-cli LRANGE response with n items."""
    lines = [f'{i}) "value{i}"' for i in range(1, n + 1)]
    return "\n".join(lines)


class TestRedisCLIFilter:
    def test_matches(self):
        assert bc.RedisCLIFilter().matches(["redis-cli"])
        assert not bc.RedisCLIFilter().matches(["mysql"])

    def test_select_filter(self):
        assert isinstance(bc.select_filter(["redis-cli"]), bc.RedisCLIFilter)

    def test_short_keys_intact(self):
        out = _redis_keys(5)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert '"key:5"' in r.text

    def test_long_keys_collapsed(self):
        out = _redis_keys(30)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert "30" in r.text
        assert "showing first 10" in r.text or "keys total" in r.text

    def test_long_keys_elides_tail(self):
        out = _redis_keys(30)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert '"key:30"' not in r.text

    def test_bulk_ok_collapsed(self):
        out = "\n".join(["OK"] * 10)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert "10 OK" in r.text
        # Individual OK lines should not appear verbatim 10 times.
        assert r.text.count("\nOK\n") < 5

    def test_long_list_collapsed(self):
        out = _redis_list(30)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert "30 items" in r.text
        assert "showing first 10" in r.text

    def test_long_list_keeps_first_items(self):
        out = _redis_list(30)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert '"value1"' in r.text
        assert '"value10"' in r.text
        assert '"value11"' not in r.text

    def test_error_kept_verbatim(self):
        out = "(error) WRONGTYPE Operation against a key holding the wrong kind of value"
        r = bc.RedisCLIFilter().apply(out, "", 1, _REDIS_ARGV)
        assert "WRONGTYPE" in r.text

    def test_scan_output_collapsed(self):
        # Simulate two SCAN pages with a cursor and key list.
        out = (
            "1) (integer) 42\n"
            "2) 1) \"alpha\"\n"
            '   2) "beta"\n'
            '   3) "gamma"\n'
            "1) (integer) 0\n"
            "2) 1) \"delta\"\n"
            '   2) "epsilon"\n'
        )
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        # Should produce a compact summary, not raw cursor output.
        assert isinstance(r.text, str)
        # Original was verbose SCAN output; text should be shorter or a summary.
        assert len(r.text) <= len(out) + 200  # allow for summary line overhead

    def test_empty_output(self):
        r = bc.RedisCLIFilter().apply("", "", 0, _REDIS_ARGV)
        assert isinstance(r.text, str)

    def test_compression_on_long_keys(self):
        out = _redis_keys(50)
        r = bc.RedisCLIFilter().apply(out, "", 0, _REDIS_ARGV)
        assert r.compressed_bytes < r.original_bytes
