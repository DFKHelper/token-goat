"""Tests for BinaryInspectFilter and FileTypeFilter."""
from __future__ import annotations

import pytest
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc
from token_goat import bash_detect

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _xxd_line(offset: int, data_hex: str, ascii_repr: str = "................") -> str:
    """Build a synthetic xxd output line."""
    # xxd groups bytes in pairs separated by spaces; 8 pairs per line.
    groups = [data_hex[i:i+4] for i in range(0, min(len(data_hex), 32), 4)]
    hex_part = " ".join(groups).ljust(39)
    return f"{offset:08x}: {hex_part}  {ascii_repr}"


def _make_xxd_output(magic_hex: str, n_extra_lines: int = 10) -> str:
    """Build a fake xxd dump with the given magic bytes in the first line."""
    # Pad magic to 32 hex chars (16 bytes) for a full first line.
    padded = (magic_hex + "00" * 16)[:32]
    lines = [_xxd_line(0, padded)]
    for i in range(1, n_extra_lines + 1):
        lines.append(_xxd_line(i * 16, "00" * 16))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_PNG_DUMP = _make_xxd_output("89504e470d0a1a0a0000000d49484452", n_extra_lines=20)
_JPEG_DUMP = _make_xxd_output("ffd8ffe000104a464946000101000048", n_extra_lines=20)
_PDF_DUMP = _make_xxd_output("255044462d312e350a0a", n_extra_lines=20)
_ZIP_DUMP = _make_xxd_output("504b0304140000000800", n_extra_lines=20)
_ELF_DUMP = _make_xxd_output("7f454c4602010100000000000000000", n_extra_lines=20)
_EXE_DUMP = _make_xxd_output("4d5a900003000000040000ffff0000b8", n_extra_lines=20)
_GZIP_DUMP = _make_xxd_output("1f8b080800000000000003", n_extra_lines=20)
_SEVENZ_DUMP = _make_xxd_output("377abcaf271c000000000000", n_extra_lines=20)
_UNKNOWN_DUMP = _make_xxd_output("deadbeef1234567890abcdef", n_extra_lines=20)

_FILTER = bc.BinaryInspectFilter()
_FILE_FILTER = bc.FileTypeFilter()


# ---------------------------------------------------------------------------
# BinaryInspectFilter — magic byte detection
# ---------------------------------------------------------------------------

def test_png_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_PNG_DUMP, argv=["xxd"])
    assert "PNG image" in result
    assert "89504e47" in result


def test_jpeg_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_JPEG_DUMP, argv=["xxd"])
    assert "JPEG image" in result
    assert "ffd8ff" in result


def test_zip_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_ZIP_DUMP, argv=["xxd"])
    assert "ZIP archive" in result
    assert "504b0304" in result


def test_elf_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_ELF_DUMP, argv=["xxd"])
    assert "ELF binary" in result
    assert "7f454c46" in result


def test_windows_exe_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_EXE_DUMP, argv=["xxd"])
    assert "Windows EXE/DLL" in result
    assert "4d5a" in result


def test_gzip_magic_detected() -> None:
    result = _compress(_FILTER, stdout=_GZIP_DUMP, argv=["xxd"])
    assert "gzip archive" in result


def test_unknown_binary_shows_magic_bytes() -> None:
    result = _compress(_FILTER, stdout=_UNKNOWN_DUMP, argv=["xxd"])
    assert "unknown binary type" in result
    assert "deadbeef" in result


def test_first_two_lines_preserved() -> None:
    result = _compress(_FILTER, stdout=_PNG_DUMP, argv=["xxd"])
    input_lines = _PNG_DUMP.splitlines()
    result_lines = result.splitlines()
    # First two hex lines must appear verbatim in the output.
    assert input_lines[0] in result_lines
    assert input_lines[1] in result_lines


def test_suppressed_line_count_accurate() -> None:
    # _make_xxd_output with n_extra_lines=20 → 21 lines total.
    result = _compress(_FILTER, stdout=_PNG_DUMP, argv=["xxd"])
    assert "21 lines" in result


def test_short_output_passes_through() -> None:
    # ≤4 lines should never be compressed.
    short = _make_xxd_output("89504e47", n_extra_lines=1)  # 2 lines
    result = _compress(_FILTER, stdout=short, argv=["xxd"])
    assert "[token-goat:" not in result
    # apply() may strip a trailing newline; compare stripped content.
    assert result.strip() == short.strip()


# ---------------------------------------------------------------------------
# Dispatch: xxd / hexdump / od / hd all route to BinaryInspectFilter
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("binary", ["xxd", "hexdump", "od", "hd"])
def test_dispatch_hex_binaries(binary: str) -> None:
    detected = bash_detect.detect([binary])
    assert detected == "xxd", f"Expected 'xxd' filter for {binary!r}, got {detected!r}"


# ---------------------------------------------------------------------------
# FileTypeFilter — pass-through and batch truncation
# ---------------------------------------------------------------------------

def test_file_command_short_passes_through() -> None:
    output = "foo.png: PNG image data, 800 x 600, 8-bit/color RGBA, non-interlaced\n"
    result = _compress(_FILE_FILTER, stdout=output, argv=["file"])
    # apply() may strip a trailing newline; compare stripped content.
    assert result.strip() == output.strip()


def test_file_command_batch_truncated() -> None:
    # Generate 25 file output lines.
    lines = [f"file_{i:03d}.bin: data\n" for i in range(25)]
    big_output = "".join(lines)
    result = _compress(_FILE_FILTER, stdout=big_output, argv=["file"])
    assert "5 more file entries truncated" in result
    # First 20 lines should be present.
    assert "file_000.bin" in result
    assert "file_019.bin" in result
    # Line 21 should NOT be present verbatim.
    assert "file_020.bin" not in result


def test_file_filter_dispatch() -> None:
    detected = bash_detect.detect(["file"])
    assert detected == "file"
