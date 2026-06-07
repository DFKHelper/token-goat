"""Shared hook-response assertion helpers for all hook test modules.

Kept in a separate importable module (not conftest.py) because pytest's conftest
is injected into the session but is not importable as ``from conftest import …``
on all Python/pytest configurations.

Usage::

    from hook_helpers import assert_continue, assert_deny, run_hook_subprocess
    from hook_helpers import make_image, make_large_jpeg, make_small_jpeg
"""
from __future__ import annotations

import json
import random
import subprocess
import sys
from pathlib import Path


def make_image(path: Path, width: int, height: int, mode: str = "RGB") -> Path:
    """Create a synthetic image at *path* using Pillow.

    Shared by ``test_image_shrink.py`` and ``test_hooks_image.py`` so the
    pixel-generation logic is not duplicated across both modules.

    Args:
        path:   Destination file path. The suffix determines the format hint
                used by the caller; this function saves RGB as JPEG and RGBA
                as PNG regardless of the extension.
        width:  Image width in pixels.
        height: Image height in pixels.
        mode:   Pillow color mode — ``"RGB"`` or ``"RGBA"``.

    Returns:
        *path* (unchanged) after the file has been written.
    """
    from PIL import Image

    img = Image.new(mode, (width, height))
    if mode == "RGB":
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(width * height)
        ]
        img.putdata(pixels)
    elif mode == "RGBA":
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255), 200)
            for _ in range(width * height)
        ]
        img.putdata(pixels)
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode == "RGB":
        img.save(path, "JPEG", quality=95)
    else:
        img.save(path, "PNG")
    return path


def make_large_jpeg(tmp_path: Path, *, name: str = "large.jpg") -> Path:
    """Return a path to a synthetic >100 KB JPEG in *tmp_path*.

    Creates a 1100×825 image filled with random pixel data.  The long edge
    (1100 px) exceeds token-goat's MAX_LONG_EDGE (1024 px) so shrink() will
    actually resize it, and the file size at quality=95 is reliably above
    SIZE_THRESHOLD_BYTES (100 KB).  Using 1100×825 instead of the original
    1600×1200 cuts pixel generation and JPEG encoding time by ~60% while still
    satisfying all image-shrink test requirements.

    If JPEG compression somehow produces a file under the threshold (unlikely
    with random noise at quality=95), falls back to BMP which is guaranteed.

    Shared by ``test_image_shrink.py`` and ``test_hooks_image.py``.
    """
    from token_goat import image_shrink

    p = tmp_path / name
    make_image(p, 1100, 825, mode="RGB")
    if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
        # BMP is uncompressed — guaranteed to be large enough.
        bmp = p.with_suffix(".bmp")
        from PIL import Image
        img = Image.new("RGB", (1100, 825))
        img.putdata([
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1100 * 825)
        ])
        img.save(bmp, "BMP")
        bmp.rename(p)
    return p


def make_small_jpeg(tmp_path: Path, *, name: str = "small.jpg") -> Path:
    """Return a path to a synthetic sub-threshold JPEG in *tmp_path*.

    Creates a 50×50 image; the resulting JPEG is well under
    ``image_shrink.SIZE_THRESHOLD_BYTES``.

    Shared by ``test_image_shrink.py`` and ``test_hooks_image.py``.
    """
    p = tmp_path / name
    make_image(p, 50, 50, mode="RGB")
    return p


def run_hook_subprocess(event: str, payload: dict, *, timeout: int = 30) -> dict:
    """Run ``token-goat hook <event>`` as a subprocess, returning the parsed JSON response.

    Sends *payload* as JSON on stdin and asserts the process exits 0.  Shared
    by ``test_cli_hook_smoke.py`` and ``TestPreReadCli`` so the subprocess
    invocation is not copy-pasted across test modules.

    Args:
        event:   Hook event name, e.g. ``"pre-read"`` or ``"session-start"``.
        payload: Dict that will be JSON-encoded and sent on stdin.
        timeout: Subprocess timeout in seconds (default 30).

    Returns:
        Parsed JSON dict from stdout.

    Raises:
        AssertionError: If the subprocess exits non-zero.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "token_goat.cli", "hook", event],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert proc.returncode == 0, f"hook {event!r} subprocess failed:\nSTDERR: {proc.stderr}"
    return json.loads(proc.stdout)


def post_edit_sync(payload: dict) -> dict:
    """Call ``hooks_edit.post_edit`` and join the predictive-snapshot thread.

    Captures the daemon thread spawned by ``_pre_snapshot_imports`` via a
    monkeypatch and joins it before returning, eliminating ``time.sleep()``
    in tests that need the snapshot to be present immediately.

    Usage::

        from hook_helpers import post_edit_sync
        result = post_edit_sync({"session_id": sid, "path": str(p)})
    """
    import threading

    from token_goat import hooks_edit

    threads: list[threading.Thread] = []
    original = hooks_edit._pre_snapshot_imports

    def _capturing(*args: object, **kwargs: object) -> object:
        t = original(*args, **kwargs)
        threads.append(t)
        return t

    hooks_edit._pre_snapshot_imports = _capturing  # type: ignore[assignment]
    try:
        result = hooks_edit.post_edit(payload)
    finally:
        hooks_edit._pre_snapshot_imports = original  # type: ignore[assignment]
    for t in threads:
        t.join(timeout=5)
    return result


def assert_continue(result: dict) -> None:
    """Assert ``continue: True``, tolerating extra diagnostic fields from dispatch.

    Centralised here so the identical one-liner does not have to be copy-pasted
    into every hook test module.
    """
    assert result.get("continue") is True


def assert_deny(result: dict) -> None:
    """Assert that a hook response carries a ``permissionDecision: deny`` payload.

    Checks both the outer ``continue: True`` (fail-soft contract) and the inner
    ``hookSpecificOutput.permissionDecision`` field so callers do not need to
    repeat the two-step pattern.
    """
    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput", {})
    assert hso.get("permissionDecision") == "deny"


def extract_diff_block(text: str) -> str:
    """Return the body of the first ```diff fenced block in *text*.

    Raises AssertionError if no fenced diff block is present. The returned
    string has the surrounding fences and their adjacent newlines stripped.
    """
    marker = "```diff"
    start = text.find(marker)
    assert start != -1, f"no ```diff block found in: {text[:200]!r}"
    rest = text[start + len(marker):]
    end = rest.find("```")
    assert end != -1, f"unterminated ```diff block in: {text[:200]!r}"
    return rest[:end].strip("\n")


def assert_well_formed_unified_diff(diff_text: str) -> None:
    """Assert *diff_text* is a structurally valid unified diff.

    Catches the two malformations produced by mixing
    ``splitlines(keepends=True)`` with ``lineterm=""``:

    * doubled blank lines on content rows (``"\\n".join`` + kept newlines), and
    * ``---``/``+++``/``@@`` headers glued onto a single line (``"".join`` +
      empty line terminator).

    The diff fixtures used with this helper must contain **no genuinely blank
    content lines**, so any empty interior line is necessarily a malformation.
    """
    lines = diff_text.split("\n")
    assert any(ln.startswith("--- ") for ln in lines), f"missing '---' header: {diff_text!r}"
    assert any(ln.startswith("+++ ") for ln in lines), f"missing '+++' header: {diff_text!r}"
    assert any(ln.startswith("@@") for ln in lines), f"missing '@@' hunk header: {diff_text!r}"

    for ln in lines:
        # Headers must each occupy their own line — never glued together.
        assert not (ln.startswith("--- ") and "+++" in ln), f"glued ---/+++ header: {ln!r}"
        if "@@" in ln:
            assert ln.startswith("@@"), f"'@@' hunk header not at line start (glued): {ln!r}"
        # Every body line carries a unified-diff prefix; an empty interior line
        # is the doubled-newline artifact (fixtures contain no blank content).
        assert ln != "", f"empty/doubled line in diff body: {diff_text!r}"
        assert ln[:1] in (" ", "+", "-", "@"), f"line lacks unified-diff prefix: {ln!r}"
