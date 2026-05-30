"""Tests for the TypeScript extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.typescript import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "ts_sample"
INDEX_TS = FIXTURE_DIR / "index.ts"


@pytest.fixture
def ts_source() -> bytes:
    return INDEX_TS.read_bytes()


@pytest.fixture
def ts_extracted(ts_source):
    return extract(ts_source, "index.ts")


def test_extract_returns_three_lists(ts_extracted):
    symbols, refs, imp_exp, _ = ts_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_greet_function_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "greet" in names
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.kind == "function"
    assert greet.line == 4


def test_userservice_class_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "UserService" in names
    svc = next(s for s in symbols if s.name == "UserService")
    assert svc.kind == "class"


def test_hello_method_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "hello" in names
    hello = next(s for s in symbols if s.name == "hello")
    assert hello.kind == "method"
    assert hello.parent_name == "UserService"


def test_user_interface_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "User" in names
    user = next(s for s in symbols if s.name == "User")
    assert user.kind == "interface"


def test_userid_type_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "UserId" in names
    uid = next(s for s in symbols if s.name == "UserId")
    assert uid.kind == "type"


def test_router_const_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "router" in names
    router = next(s for s in symbols if s.name == "router")
    assert router.kind == "const"


def test_greet_has_signature(ts_extracted):
    symbols, _, _, _ = ts_extracted
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.signature is not None
    assert "greet" in greet.signature
    assert "name" in greet.signature


def test_imports_include_node_path(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "node:path" in import_targets


def test_imports_include_express(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "express" in import_targets


def test_exports_include_greet(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    export_targets = {ie.target for ie in imp_exp if ie.kind == "export"}
    assert "greet" in export_targets


def test_refs_include_greet_call(ts_extracted):
    _, refs, _, _ = ts_extracted
    ref_names = {r.name for r in refs}
    # greet is called inside hello()
    assert "greet" in ref_names


def test_refs_include_express_call(ts_extracted):
    _, refs, _, _ = ts_extracted
    ref_names = {r.name for r in refs}
    assert "express" in ref_names


def test_ref_has_line_and_context(ts_extracted):
    _, refs, _, _ = ts_extracted
    greet_refs = [r for r in refs if r.name == "greet"]
    assert len(greet_refs) > 0
    for r in greet_refs:
        assert r.line > 0
        assert r.context is not None


def test_no_single_char_refs(ts_extracted):
    _, refs, _, _ = ts_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(ts_extracted):
    symbols, _, _, _ = ts_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name} has 0-indexed line {s.line}"


def test_tsx_extension_accepted():
    """tsx files should parse without error."""
    source = b"export const Comp = () => <div>hello</div>;\n"
    symbols, refs, imp_exp, _ = extract(source, "comp.tsx")
    assert isinstance(symbols, list)


def test_js_extension_accepted():
    """Plain .js files should parse."""
    source = b"export function foo() { return 1; }\n"
    symbols, refs, imp_exp, _ = extract(source, "util.js")
    names = {s.name for s in symbols}
    assert "foo" in names


# ---------------------------------------------------------------------------
# Precision: TypeScript decorator lines must be included in the symbol's start_line.
# Mirrors the Python adapter's _extend_starts_for_decorators post-pass.
# ---------------------------------------------------------------------------


def test_single_decorator_extends_class_start_line():
    """``@Injectable()``-decorated class: start_line must point at the decorator."""
    src = b"@Injectable()\nexport class Foo {\n  x = 1;\n}\n"
    symbols, _, _, _ = extract(src, "deco_single.ts")
    foo = next(s for s in symbols if s.name == "Foo")
    assert foo.line == 1, f"expected line 1 (decorator), got {foo.line}"


def test_multiline_decorator_extends_class_start_line():
    """``@Component({ … })`` spanning multiple lines: start_line at the @ line."""
    src = (
        b"@Component({\n"
        b"  selector: 'x-foo',\n"
        b"  template: '<div></div>',\n"
        b"})\n"
        b"export class Foo {}\n"
    )
    symbols, _, _, _ = extract(src, "deco_multiline.ts")
    foo = next(s for s in symbols if s.name == "Foo")
    assert foo.line == 1, f"expected line 1 (@Component), got {foo.line}"


def test_stacked_decorators_extend_start_line():
    """Multiple stacked TS decorators: start_line is the topmost @ line."""
    src = (
        b"@First\n"
        b"@Second('arg')\n"
        b"@Third\n"
        b"export class Foo {}\n"
    )
    symbols, _, _, _ = extract(src, "deco_stacked.ts")
    foo = next(s for s in symbols if s.name == "Foo")
    assert foo.line == 1


def test_method_decorator_extends_start_line():
    """A decorated method inside a class also gets start_line moved up."""
    src = (
        b"export class C {\n"
        b"  @log\n"
        b"  hello(): string {\n"
        b"    return 'hi';\n"
        b"  }\n"
        b"}\n"
    )
    symbols, _, _, _ = extract(src, "deco_method.ts")
    hello = next(s for s in symbols if s.name == "hello")
    # @log is on line 2; the method def is on line 3 — start should be 2.
    assert hello.line == 2


def test_undecorated_class_unchanged():
    """No decorator → start_line is the `class` line as before."""
    src = b"export class Plain {\n  x = 1;\n}\n"
    symbols, _, _, _ = extract(src, "plain.ts")
    plain = next(s for s in symbols if s.name == "Plain")
    assert plain.line == 1


def test_comment_above_class_is_not_treated_as_decorator():
    """Only ``@`` lines (and their argument continuations) are pulled in."""
    src = b"// docs above\nexport class Foo {}\n"
    symbols, _, _, _ = extract(src, "comment.ts")
    foo = next(s for s in symbols if s.name == "Foo")
    assert foo.line == 2  # the // comment must stay outside


def test_class_methods_have_parent_name():
    """All methods on a class should carry parent_name = class name."""
    src = b"""export class MyService {
  constructor(private url: string) {}

  async fetchData(id: number): Promise<string> {
    return '';
  }

  render(): void {}
}
"""
    symbols, _, _, _ = extract(src, "service.ts")
    methods = {s.name: s for s in symbols if s.kind == "method"}
    assert "fetchData" in methods
    assert "render" in methods
    assert methods["fetchData"].parent_name == "MyService"
    assert methods["render"].parent_name == "MyService"


def test_class_methods_are_not_top_level_functions():
    """Class methods should not be emitted with kind='function'."""
    src = b"""export class Calc {
  add(a: number, b: number): number { return a + b; }
  sub(a: number, b: number): number { return a - b; }
}

export function topLevel(): void {}
"""
    symbols, _, _, _ = extract(src, "calc.ts")
    top = next(s for s in symbols if s.name == "topLevel")
    assert top.kind == "function"
    assert top.parent_name is None

    add = next((s for s in symbols if s.name == "add"), None)
    if add:
        assert add.kind == "method"
        assert add.parent_name == "Calc"
