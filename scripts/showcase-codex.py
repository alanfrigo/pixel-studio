"""Imagem do README para o provedor Codex CLI local (saídas reais, sem retoque).

    python/.venv/bin/python -I scripts/showcase-codex.py <data>

Entrada: reports/codex/<data>/ (scripts/codex-real.ts). Saída: docs/images/codex.png,
com ampliação inteira (vizinho mais próximo) e largura natural ≤ 1024 px.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BG = (24, 26, 33, 255)
CARD = (34, 37, 47, 255)
TEXT = (226, 230, 240, 255)
MUTED = (150, 156, 172, 255)

CARDS = [
    ("potion-image.png", 4, "Potion", "text only"),
    ("sword-image.png", 4, "Sword", "text only"),
    ("mana-image.png", 4, "Mana potion", "style ref: the potion"),
    ("knight-image.png", 2, "Knight", "text only"),
    ("oak-image.png", 2, "Oak", "text only"),
    ("inpaint-image.png", 2, "Knight, inpainted", "cape to blue, 0 px outside"),
]


def main() -> None:
    src = ROOT / "reports" / "codex" / sys.argv[1]
    side, gap, pad, label_h = 152, 12, 16, 44
    width = pad * 2 + len(CARDS) * side + (len(CARDS) - 1) * gap
    canvas = Image.new("RGBA", (width, pad * 2 + side + label_h), BG)
    draw = ImageDraw.Draw(canvas)
    title = ImageFont.load_default(size=15)
    small = ImageFont.load_default(size=12)
    for i, (name, k, label, note) in enumerate(CARDS):
        x = pad + i * (side + gap)
        draw.rectangle((x, pad, x + side - 1, pad + side - 1), fill=CARD)
        im = Image.open(src / name).convert("RGBA")
        im = im.resize((im.width * k, im.height * k), Image.NEAREST)
        canvas.alpha_composite(im, (x + (side - im.width) // 2, pad + (side - im.height) // 2))
        draw.text((x + 2, pad + side + 8), label, fill=TEXT, font=title)
        draw.text((x + 2, pad + side + 27), note, fill=MUTED, font=small)
    out = ROOT / "docs" / "images" / "codex.png"
    canvas.convert("RGB").save(out, optimize=True)
    print(out.relative_to(ROOT), canvas.size, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
