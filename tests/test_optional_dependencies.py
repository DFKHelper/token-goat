from __future__ import annotations

import builtins
import importlib

import token_goat.db as db
import token_goat.worker as worker
from token_goat.languages import typescript as ts


def _missing_import(name: str):
    real_import = builtins.__import__

    def fake_import(module_name, globals=None, locals=None, fromlist=(), level=0):
        if module_name == name:
            raise ModuleNotFoundError(module_name)
        return real_import(module_name, globals, locals, fromlist, level)

    return fake_import


def test_db_import_survives_missing_sqlite_vec(monkeypatch):
    # db.py imports sqlite_vec lazily inside _connect(), so the module reloads
    # cleanly with sqlite_vec absent.  The reload itself is the success
    # criterion — any ModuleNotFoundError would propagate out of importlib.
    with monkeypatch.context() as m:
        m.setattr(builtins, "__import__", _missing_import("sqlite_vec"))
        importlib.reload(db)
    importlib.reload(db)


def test_worker_import_survives_missing_psutil(monkeypatch):
    with monkeypatch.context() as m:
        m.setattr(builtins, "__import__", _missing_import("psutil"))
        reloaded = importlib.reload(worker)
        assert reloaded.psutil.pid_exists(123456789) is False
        assert hasattr(reloaded.psutil, "Process")
        assert hasattr(reloaded.psutil, "NoSuchProcess")
    importlib.reload(worker)


def test_typescript_extract_survives_missing_tree_sitter(monkeypatch):
    with monkeypatch.context() as m:
        m.setattr(builtins, "__import__", _missing_import("tree_sitter_language_pack"))
        reloaded = importlib.reload(ts)
        symbols, refs, imp_exp, sections = reloaded.extract(
            b"export const value = 1;\n",
            "value.ts",
        )
        assert symbols == []
        assert refs == []
        assert imp_exp == []
        assert sections == []
    importlib.reload(ts)
