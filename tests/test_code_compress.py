"""Tests for compress_to_skeleton in code_compress.py."""
from __future__ import annotations

import pytest

from token_goat.code_compress import compress_to_skeleton

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_PY_FULL = """\
import os
from pathlib import Path
from typing import Any

__all__ = ["Greeter", "greet"]

GreeterType = Any

class Greeter:
    label = "hi"

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self._cache: dict[str, str] = {}

    def greet(self, name: str) -> str:
        key = f"{self.prefix}-{name}"
        result = f"{self.prefix} {name}"
        return result


def greet(name: str) -> str:
    msg = f"Hello, {name}"
    return msg
"""


# ---------------------------------------------------------------------------
# Test 1: large Python file retains all def/class signatures
# ---------------------------------------------------------------------------

def test_python_signatures_retained():
    result = compress_to_skeleton(_PY_FULL, ".py")
    assert result is not None
    assert "class Greeter:" in result
    assert "def __init__(self, prefix: str) -> None:" in result
    assert "def greet(self, name: str) -> str:" in result
    assert "def greet(name: str) -> str:" in result


# ---------------------------------------------------------------------------
# Test 2: decorators immediately before def/class are kept
# ---------------------------------------------------------------------------

def test_decorators_kept():
    source = (
        "import functools\n"
        "\n"
        "@functools.lru_cache(maxsize=128)\n"
        "def cached_func(x: int) -> int:\n"
        "    return x * 2\n"
        "\n"
        "class MyClass:\n"
        "    @staticmethod\n"
        "    def static_method() -> None:\n"
        "        pass\n"
    )
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "@functools.lru_cache(maxsize=128)" in result
    assert "def cached_func(x: int) -> int:" in result
    assert "@staticmethod" in result
    assert "def static_method() -> None:" in result


# ---------------------------------------------------------------------------
# Test 3: function body replaced with # ... N lines sentinel
# ---------------------------------------------------------------------------

def test_body_replaced_with_sentinel():
    source = "def foo():\n    line1 = 1\n    line2 = 2\n    line3 = 3\n"
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "def foo():" in result
    assert "# ... 3 lines" in result
    assert "line1" not in result
    assert "line2" not in result
    assert "line3" not in result


# ---------------------------------------------------------------------------
# Test 4: import lines kept verbatim
# ---------------------------------------------------------------------------

def test_import_lines_kept():
    source = "import os\nfrom pathlib import Path\nfrom typing import Any, Dict\n\ndef foo(): pass\n"
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "import os" in result
    assert "from pathlib import Path" in result
    assert "from typing import Any, Dict" in result


# ---------------------------------------------------------------------------
# Test 5: compress_to_skeleton returns skeleton for a short file (150 lines)
# ---------------------------------------------------------------------------

def test_small_file_still_returns_skeleton():
    # The 200-line threshold lives in the hook, not in compress_to_skeleton.
    lines = ["import os", ""]
    for i in range(148):
        lines.append(f"# comment {i}")
    source = "\n".join(lines)
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "import os" in result


# ---------------------------------------------------------------------------
# Test 6: unsupported extensions return None
# ---------------------------------------------------------------------------

def test_unsupported_ext_returns_none():
    body = "<html><body>hello</body></html>"
    assert compress_to_skeleton(body, ".html") is None
    assert compress_to_skeleton(body, ".md") is None
    assert compress_to_skeleton(body, ".txt") is None
    assert compress_to_skeleton(body, ".css") is None
    assert compress_to_skeleton(body, "") is None


# ---------------------------------------------------------------------------
# Test 7: __all__ kept verbatim
# ---------------------------------------------------------------------------

def test_dunder_all_kept():
    source = '__all__ = ["MyClass", "my_func"]\n\ndef my_func():\n    return 1\n'
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert '__all__ = ["MyClass", "my_func"]' in result


# ---------------------------------------------------------------------------
# Test 8: nested class/function — outer and inner signatures both kept,
#          bodies suppressed separately
# ---------------------------------------------------------------------------

def test_nested_class_and_method():
    source = (
        "class Outer:\n"
        "    class_attr = 1\n"
        "    extra_attr = 2\n"
        "    def outer_method(self):\n"
        "        x = 1\n"
        "        y = 2\n"
        "    class Inner:\n"
        "        def inner_method(self):\n"
        "            return 42\n"
    )
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    # All four signatures present
    assert "class Outer:" in result
    assert "def outer_method(self):" in result
    assert "class Inner:" in result
    assert "def inner_method(self):" in result
    # Body lines suppressed
    assert "class_attr" not in result
    assert "x = 1" not in result
    assert "return 42" not in result
    # Sentinel markers present
    assert "# ... " in result


# ---------------------------------------------------------------------------
# Test 9: JS/TS file — function/class signatures kept, bodies replaced
# ---------------------------------------------------------------------------

def test_js_ts_signatures_and_bodies():
    source = (
        "import React from 'react';\n"
        "\n"
        "function MyComponent(props) {\n"
        "    const x = props.x;\n"
        "    const y = props.y;\n"
        "    return x + y;\n"
        "}\n"
        "\n"
        "class MyClass {\n"
        "    constructor(x) {\n"
        "        this.x = x;\n"
        "    }\n"
        "}\n"
    )
    result = compress_to_skeleton(source, ".ts")
    assert result is not None
    assert "function MyComponent(props)" in result
    assert "class MyClass" in result
    # Bodies replaced
    assert "// ... " in result
    assert "const x = props.x" not in result
    assert "this.x = x" not in result


# ---------------------------------------------------------------------------
# Test 10: empty file returns empty string
# ---------------------------------------------------------------------------

def test_empty_file_returns_empty_string():
    assert compress_to_skeleton("", ".py") == ""
    assert compress_to_skeleton("", ".ts") == ""


# ---------------------------------------------------------------------------
# Test 11: file with only imports — all lines kept, no bodies to suppress
# ---------------------------------------------------------------------------

def test_only_imports_kept():
    source = "import os\nfrom pathlib import Path\nfrom typing import Any\n"
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "import os" in result
    assert "from pathlib import Path" in result
    assert "from typing import Any" in result
    # No sentinel (no bodies to suppress)
    assert "# ..." not in result


# ---------------------------------------------------------------------------
# Test 12: async def kept like a regular def
# ---------------------------------------------------------------------------

def test_async_def_kept():
    source = (
        "import asyncio\n"
        "\n"
        "async def fetch(url: str) -> str:\n"
        "    resp = await get(url)\n"
        "    return resp.text\n"
    )
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "async def fetch(url: str) -> str:" in result
    assert "# ... 2 lines" in result
    assert "resp = await" not in result
    assert "return resp.text" not in result


# ---------------------------------------------------------------------------
# Extra: type aliases at top level kept verbatim
# ---------------------------------------------------------------------------

def test_type_alias_kept():
    source = "import typing\n\nMyType = typing.Union[str, int]\n\ndef foo():\n    pass\n"
    result = compress_to_skeleton(source, ".py")
    assert result is not None
    assert "MyType = typing.Union[str, int]" in result


# ---------------------------------------------------------------------------
# Extra: supported extensions all return non-None for non-empty source
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ext", [".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java"])
def test_all_supported_exts_return_string(ext: str):
    source = "// hello\nfunction foo() {\n    return 1;\n}\n"
    result = compress_to_skeleton(source, ext)
    assert result is not None
    assert isinstance(result, str)


# ---------------------------------------------------------------------------
# Test 13: brace inside string literal should not prematurely close block
# ---------------------------------------------------------------------------

def test_string_with_closing_brace_in_js():
    source = (
        "function test() {\n"
        '    console.log("string with } brace");\n'
        "    const x = 1;\n"
        "}\n"
    )
    result = compress_to_skeleton(source, ".js")
    assert result is not None
    assert "function test()" in result
    assert "// ... " in result
    assert "const x = 1" not in result


def test_string_with_opening_brace_in_ts():
    source = (
        "function test() {\n"
        '    const msg = "obj { key: value }";\n'
        "    return msg;\n"
        "}\n"
    )
    result = compress_to_skeleton(source, ".ts")
    assert result is not None
    assert "function test()" in result
    assert "// ... " in result
    assert "const msg" not in result
    assert "return msg" not in result
