"""Render the paired-evaluation capture as a PDF.

This script reads `demo/evidence/12-eval-paired.txt` and nothing else. The
capture is the single source of truth, so the PDF cannot state a figure the
evidence pane does not. Regenerate the capture first when the harness database
changes:

    python scripts/generate-eval-capture.py --db ../token-goat-eval/results.db
    python scripts/generate-eval-pdf.py
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "demo" / "evidence" / "12-eval-paired.txt"
OUTPUT = ROOT / "demo" / "fixtures" / "token-goat-eval.pdf"

PAGE_WIDTH, PAGE_HEIGHT = letter
MARGIN = 64
LINE_HEIGHT = 13
BODY_SIZE = 9
INK = HexColor("#1f2933")
MUTED = HexColor("#5c6b7a")

TITLE = "Token-Goat paired evaluation"
SUBTITLE = "Recorded harness output. Read the limitations with the medians."


def body_lines() -> list[str]:
    text = SOURCE.read_text(encoding="utf-8")
    # The leading shell line names the regeneration command; the heading rule
    # below it is redundant once the page carries a real title.
    lines = text.splitlines()
    return [line for line in lines if not line.startswith("=" * 10)]


def start_page(pdf: canvas.Canvas, page: int) -> float:
    if page == 1:
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 16)
        pdf.drawString(MARGIN, PAGE_HEIGHT - MARGIN, TITLE)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 10)
        pdf.drawString(MARGIN, PAGE_HEIGHT - MARGIN - 18, SUBTITLE)
        return PAGE_HEIGHT - MARGIN - 46
    return PAGE_HEIGHT - MARGIN


def finish_page(pdf: canvas.Canvas, page: int) -> None:
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(MARGIN, MARGIN - 24, f"demo/evidence/{SOURCE.name}")
    pdf.drawRightString(PAGE_WIDTH - MARGIN, MARGIN - 24, str(page))


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"missing capture {SOURCE}; run generate-eval-capture.py first")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=letter)
    pdf.setTitle(TITLE)

    page = 1
    y = start_page(pdf, page)
    for line in body_lines():
        if y < MARGIN:
            finish_page(pdf, page)
            pdf.showPage()
            page += 1
            y = start_page(pdf, page)
        # A heading is a non-indented, non-empty line; the capture indents every
        # data row by two spaces.
        heading = bool(line) and not line.startswith(" ")
        pdf.setFillColor(INK if heading else MUTED)
        pdf.setFont("Helvetica-Bold" if heading else "Courier", 10 if heading else BODY_SIZE)
        pdf.drawString(MARGIN, y, line)
        y -= LINE_HEIGHT

    finish_page(pdf, page)
    pdf.save()
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({page} page{'s' if page > 1 else ''})")


if __name__ == "__main__":
    main()
