"""Tests for the CSS and SQL language extractors."""
from __future__ import annotations

import pytest

from token_goat.languages import css_idx, sql_idx

# ---------------------------------------------------------------------------
# CSS extractor
# ---------------------------------------------------------------------------


class TestCssClassSelectors:
    def test_class_selector(self):
        src = b".btn-primary { color: red; }\n"
        symbols, refs, imps, sections = css_idx.extract(src, "style.css")
        assert refs == [] and imps == []
        names = [s.name for s in symbols]
        assert ".btn-primary" in names

    def test_multiple_class_selectors(self):
        src = b".foo { }\n.bar { }\n.baz { }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert ".foo" in names
        assert ".bar" in names
        assert ".baz" in names

    def test_id_selector(self):
        src = b"#header { margin: 0; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert "#header" in names

    def test_selector_kind_is_css_selector(self):
        src = b".btn { color: blue; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        kinds = {s.kind for s in symbols if s.name == ".btn"}
        assert kinds == {"css_selector"}


class TestCssCustomProperties:
    def test_custom_property_in_root(self):
        src = b":root {\n  --primary-color: #333;\n  --font-size: 16px;\n}\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert "--primary-color" in names
        assert "--font-size" in names

    def test_custom_property_kind(self):
        src = b":root { --brand: red; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        kinds = {s.kind for s in symbols if s.name == "--brand"}
        assert kinds == {"css_var"}

    def test_duplicate_custom_property_deduped(self):
        """Same --var appearing multiple times should produce one symbol."""
        src = b":root { --color: red; }\n.dark { --color: blue; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        count = sum(1 for s in symbols if s.name == "--color")
        assert count == 1


class TestCssAtRules:
    def test_keyframes(self):
        src = b"@keyframes slide-in { from { opacity: 0; } to { opacity: 1; } }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert "@keyframes slide-in" in names

    def test_keyframes_kind(self):
        src = b"@keyframes spin { }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        kinds = {s.kind for s in symbols if "spin" in s.name}
        assert kinds == {"css_keyframe"}

    def test_mixin(self):
        src = b"@mixin flex-center { display: flex; align-items: center; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert "@mixin flex-center" in names

    def test_mixin_kind(self):
        src = b"@mixin button-base { }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        kinds = {s.kind for s in symbols if "button-base" in s.name}
        assert kinds == {"css_mixin"}

    def test_media_query(self):
        src = b"@media (max-width: 768px) { .col { width: 100%; } }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert any("media" in n for n in names)

    def test_media_query_kind(self):
        src = b"@media screen { }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        kinds = {s.kind for s in symbols if "media" in s.name}
        assert kinds == {"css_rule"}


class TestCssSections:
    def test_sections_match_symbols(self):
        src = b".foo { color: red; }\n.bar { color: blue; }\n"
        symbols, _, _, sections = css_idx.extract(src, "style.css")
        sym_names = {s.name for s in symbols}
        sec_names = {s.heading for s in sections}
        assert sym_names == sec_names

    def test_end_lines_assigned(self):
        src = b".a { }\n.b { }\n"
        _, _, _, sections = css_idx.extract(src, "style.css")
        for sec in sections:
            assert sec.end_line is not None

    def test_line_numbers_are_one_based(self):
        src = b"/* header */\n.target { color: red; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        target = next((s for s in symbols if s.name == ".target"), None)
        assert target is not None
        assert target.line == 2

    def test_comment_stripped_no_false_positive(self):
        """Selectors inside comments must not be extracted."""
        src = b"/* .inside-comment { } */\n.real { color: red; }\n"
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert ".inside-comment" not in names
        assert ".real" in names


class TestCssImports:
    def test_css_import_double_quote(self):
        src = b'@import "variables.css";\n.btn { color: red; }\n'
        _, _, imps, _ = css_idx.extract(src, "style.css")
        targets = [i.target for i in imps]
        assert "variables.css" in targets

    def test_css_import_single_quote(self):
        src = b"@import 'reset.css';\n"
        _, _, imps, _ = css_idx.extract(src, "style.css")
        targets = [i.target for i in imps]
        assert "reset.css" in targets

    def test_css_import_url_form(self):
        src = b'@import url("fonts.css");\n'
        _, _, imps, _ = css_idx.extract(src, "style.css")
        targets = [i.target for i in imps]
        assert "fonts.css" in targets

    def test_scss_use_directive(self):
        src = b'@use "sass:math";\n@use "mixins/flex";\n'
        _, _, imps, _ = css_idx.extract(src, "main.scss")
        targets = [i.target for i in imps]
        assert "sass:math" in targets
        assert "mixins/flex" in targets

    def test_scss_forward_directive(self):
        src = b'@forward "components/button";\n'
        _, _, imps, _ = css_idx.extract(src, "_index.scss")
        targets = [i.target for i in imps]
        assert "components/button" in targets

    def test_import_kind_is_import(self):
        src = b'@import "base.css";\n'
        _, _, imps, _ = css_idx.extract(src, "style.css")
        assert all(i.kind == "import" for i in imps)

    def test_import_line_number(self):
        src = b"/* preamble */\n@import 'vars.css';\n"
        _, _, imps, _ = css_idx.extract(src, "style.css")
        assert any(i.line == 2 for i in imps)

    def test_multiple_imports(self):
        src = b'@import "reset.css";\n@import "vars.css";\n@import "components.css";\n'
        _, _, imps, _ = css_idx.extract(src, "style.css")
        targets = {i.target for i in imps}
        assert targets == {"reset.css", "vars.css", "components.css"}

    def test_no_import_in_plain_css(self):
        src = b".btn { color: red; }\n#header { margin: 0; }\n"
        _, _, imps, _ = css_idx.extract(src, "style.css")
        assert imps == []

    def test_import_inside_comment_not_extracted(self):
        """@import inside a block comment must not produce an import edge."""
        src = b'/* @import "should-not-appear.css"; */\n@import "real.css";\n'
        _, _, imps, _ = css_idx.extract(src, "style.css")
        targets = [i.target for i in imps]
        assert "should-not-appear.css" not in targets
        assert "real.css" in targets


class TestCssEdgeCases:
    def test_empty_file(self):
        symbols, refs, imps, sections = css_idx.extract(b"", "empty.css")
        assert symbols == [] and sections == []

    def test_invalid_utf8_does_not_crash(self):
        """Replace invalid bytes — must not raise."""
        src = b".btn { content: '\xff'; }\n"
        result = css_idx.extract(src, "bad.css")
        assert len(result) == 4  # (symbols, refs, imps, sections)

    def test_utf8_bom_on_first_symbol(self):
        """A UTF-8 BOM prefix must not swallow the first symbol."""
        src = "﻿.hero { color: blue; }\n".encode()
        symbols, _, _, _ = css_idx.extract(src, "style.css")
        names = [s.name for s in symbols]
        assert ".hero" in names

    def test_scss_extension_uses_same_extractor(self):
        src = b"@mixin rounded($r: 4px) { border-radius: $r; }\n"
        symbols, _, _, _ = css_idx.extract(src, "theme.scss")
        names = [s.name for s in symbols]
        assert "@mixin rounded" in names


# ---------------------------------------------------------------------------
# SQL extractor
# ---------------------------------------------------------------------------


class TestSqlTables:
    def test_create_table(self):
        src = b"CREATE TABLE users (id INTEGER PRIMARY KEY);\n"
        symbols, refs, imps, sections = sql_idx.extract(src, "schema.sql")
        assert refs == [] and imps == []
        names = [s.name for s in symbols]
        assert "users" in names

    def test_create_table_kind(self):
        src = b"CREATE TABLE orders (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "orders"}
        assert kinds == {"sql_table"}

    def test_create_table_if_not_exists(self):
        src = b"CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "settings" in names

    def test_create_temp_table(self):
        src = b"CREATE TEMP TABLE tmp_data (val INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "tmp_data" in names

    def test_create_temporary_table(self):
        src = b"CREATE TEMPORARY TABLE staging (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "staging" in names

    def test_schema_qualified_table(self):
        src = b"CREATE TABLE public.events (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "public.events" in names


class TestSqlViews:
    def test_create_view(self):
        src = b"CREATE VIEW active_users AS SELECT * FROM users WHERE active=1;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "active_users" in names

    def test_create_view_kind(self):
        src = b"CREATE VIEW vw_orders AS SELECT id FROM orders;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "vw_orders"}
        assert kinds == {"sql_view"}

    def test_create_or_replace_view(self):
        src = b"CREATE OR REPLACE VIEW summary AS SELECT count(*) FROM users;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "summary" in names


class TestSqlFunctions:
    def test_create_function(self):
        src = b"CREATE FUNCTION get_user(user_id INT) RETURNS TEXT AS $$ BEGIN END $$ LANGUAGE plpgsql;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "get_user" in names

    def test_create_function_kind(self):
        src = b"CREATE FUNCTION add_numbers(a INT, b INT) RETURNS INT AS $$ SELECT a+b; $$ LANGUAGE SQL;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "add_numbers"}
        assert kinds == {"sql_function"}

    def test_create_or_replace_function(self):
        src = b"CREATE OR REPLACE FUNCTION compute_tax(amount NUMERIC) RETURNS NUMERIC AS $$ BEGIN RETURN amount * 0.1; END; $$ LANGUAGE plpgsql;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "compute_tax" in names

    def test_create_procedure(self):
        src = b"CREATE PROCEDURE update_status(id INT) AS BEGIN UPDATE t SET s=1 WHERE id=id; END;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "update_status" in names

    def test_create_procedure_kind(self):
        src = b"CREATE PROCEDURE cleanup_old() AS BEGIN DELETE FROM logs WHERE ts < NOW()-7; END;\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "cleanup_old"}
        assert kinds == {"sql_procedure"}


class TestSqlIndexes:
    def test_create_index(self):
        src = b"CREATE INDEX idx_users_email ON users(email);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "idx_users_email" in names

    def test_create_unique_index(self):
        src = b"CREATE UNIQUE INDEX ux_users_email ON users(email);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "ux_users_email" in names

    def test_create_index_kind(self):
        src = b"CREATE INDEX idx_orders_user ON orders(user_id);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "idx_orders_user"}
        assert kinds == {"sql_index"}

    def test_create_index_if_not_exists(self):
        src = b"CREATE INDEX IF NOT EXISTS idx_tmp ON tmp(col);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "idx_tmp" in names


class TestSqlTriggers:
    def test_create_trigger(self):
        src = b"CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION log_insert();\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "trg_audit" in names

    def test_create_trigger_kind(self):
        src = b"CREATE TRIGGER trg_check BEFORE UPDATE ON orders FOR EACH ROW EXECUTE PROCEDURE validate();\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        kinds = {s.kind for s in symbols if s.name == "trg_check"}
        assert kinds == {"sql_trigger"}


class TestSqlSections:
    def test_sections_match_symbols(self):
        src = b"CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n"
        symbols, _, _, sections = sql_idx.extract(src, "schema.sql")
        sym_names = {s.name for s in symbols}
        sec_names = {s.heading for s in sections}
        assert sym_names == sec_names

    def test_end_lines_assigned(self):
        src = b"CREATE TABLE x (id INT);\nCREATE TABLE y (id INT);\n"
        _, _, _, sections = sql_idx.extract(src, "schema.sql")
        for sec in sections:
            assert sec.end_line is not None

    def test_line_numbers_are_one_based(self):
        src = b"-- migration\nCREATE TABLE tasks (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        task_sym = next((s for s in symbols if s.name == "tasks"), None)
        assert task_sym is not None
        assert task_sym.line == 2

    def test_comment_stripped_no_false_positive(self):
        """Table names inside SQL comments must not be extracted."""
        src = b"-- CREATE TABLE ghost (id INT);\nCREATE TABLE real_table (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "ghost" not in names
        assert "real_table" in names

    def test_block_comment_stripped(self):
        src = b"/* CREATE TABLE ghost (id INT); */\nCREATE TABLE visible (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "ghost" not in names
        assert "visible" in names


class TestSqlEdgeCases:
    def test_empty_file(self):
        symbols, refs, imps, sections = sql_idx.extract(b"", "empty.sql")
        assert symbols == [] and sections == []

    def test_invalid_utf8_does_not_crash(self):
        src = b"CREATE TABLE bad\xff_name (id INT);\n"
        result = sql_idx.extract(src, "bad.sql")
        assert len(result) == 4

    def test_utf8_bom_on_first_symbol(self):
        """A UTF-8 BOM prefix must not swallow the first CREATE TABLE."""
        src = "﻿CREATE TABLE accounts (id INT);\n".encode()
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "accounts" in names

    def test_double_quoted_name(self):
        src = b'CREATE TABLE "MyTable" (id INT);\n'
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "MyTable" in names

    def test_backtick_quoted_name(self):
        src = b"CREATE TABLE `my_table` (id INT);\n"
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "my_table" in names

    def test_multiple_statements(self):
        src = (
            b"CREATE TABLE users (id INT);\n"
            b"CREATE TABLE orders (id INT);\n"
            b"CREATE INDEX idx_orders ON orders(id);\n"
            b"CREATE VIEW active AS SELECT * FROM users;\n"
        )
        symbols, _, _, _ = sql_idx.extract(src, "schema.sql")
        names = [s.name for s in symbols]
        assert "users" in names
        assert "orders" in names
        assert "idx_orders" in names
        assert "active" in names


# ---------------------------------------------------------------------------
# Integration: parser.py dispatch
# ---------------------------------------------------------------------------


class TestParserDispatch:
    @pytest.mark.parametrize("filename,content,expected_lang,expected_symbol", [
        ("style.css", ".btn { color: red; }\n", "css", ".btn"),
        ("theme.scss", "@mixin flex-center { display: flex; }\n", "css", "@mixin flex-center"),
        ("schema.sql", "CREATE TABLE accounts (id INT);\n", "sql", "accounts"),
        ("styles.less", "#main { color: black; }\n", "css", "#main"),
    ])
    def test_extension_dispatches(
        self, tmp_path, tmp_data_dir, filename, content, expected_lang, expected_symbol
    ):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        src_file = tmp_path / filename
        src_file.write_text(content, encoding="utf-8")
        root = canonicalize(tmp_path)
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, src_file)
        assert result is not None
        assert result.language == expected_lang
        names = [s.name for s in result.symbols]
        assert expected_symbol in names
