"""Compõe as imagens do README a partir da vitrine gerada por IA.

    python/.venv/bin/python -I scripts/showcase-compose.py reports/vitrine/<data>

Entrada: results.json e PNGs de scripts/showcase-real.ts (saídas do pipeline,
sem retoque). Saída em docs/images/: hero.png (cenário montado só com os
assets gerados, em escala inteira), examples/*.png (cada resultado a 1× e
ampliado por vizinho mais próximo) e pipeline.png (saída bruta do modelo ×
resultado na grade exata). Toda ampliação é inteira; nenhum pixel é redesenhado.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
BG = (24, 26, 33, 255)
PANEL = (34, 37, 47, 255)
TEXT = (226, 230, 240, 255)
MUTED = (150, 158, 176, 255)


def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def zoom(im: Image.Image, k: int) -> Image.Image:
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def trim(im: Image.Image) -> Image.Image:
    box = im.getchannel("A").getbbox()
    return im.crop(box) if box else im


def tile(texture: Image.Image, w: int, h: int) -> Image.Image:
    out = Image.new("RGBA", (w, h))
    for y in range(0, h, texture.height):
        for x in range(0, w, texture.width):
            out.paste(texture, (x, y))
    return out


def shadow(width: int, k: int) -> Image.Image:
    """Sombra de contato em pixel art: elipse achatada desenhada na grade lógica."""
    w, h = max(4, width), max(2, width // 4)
    s = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(s).ellipse((0, 0, w - 1, h - 1), fill=(0, 0, 0, 70))
    return zoom(s, k)


def place(canvas: Image.Image, sprite: Image.Image, foot_x: int, foot_y: int, k: int) -> None:
    """Pousa o sprite (aparado) com a base em (foot_x, foot_y), em escala k."""
    s = trim(sprite)
    sh = shadow(int(s.width * 0.8), k)
    canvas.alpha_composite(sh, (foot_x - sh.width // 2, foot_y - sh.height // 2))
    z = zoom(s, k)
    canvas.alpha_composite(z, (foot_x - z.width // 2, foot_y - z.height))


def load(d: Path, key: str, group: str) -> Image.Image:
    name = f"{key}-texture.png" if group == "texture" else f"{key}-image.png"
    return Image.open(d / name).convert("RGBA")


def hero(d: Path, items: dict[str, dict]) -> None:
    """Cenário de 1024 px (largura do README sem reescala): chão a 2×, personagens a 2×, árvores a 3×."""
    k = 2
    W, H = 1024, 496
    img = lambda key: load(d, key, items[key]["group"])  # noqa: E731
    canvas = tile(zoom(img("grass"), k), W, H)
    # Caminho de pedra atravessando o gramado.
    path = tile(zoom(img("cobblestone"), k), W, 64 * k)
    canvas.alpha_composite(path.crop((0, 0, W, 44 * k)), (0, 290))
    # Cena desenhada de trás para frente (y crescente): árvores, poço, grupo na fogueira.
    scene = [
        ("oak", 225, 228, 3), ("oak", 805, 232, 3), ("oak", 70, 262, 3), ("oak", 960, 268, 3),
        ("well", 668, 272, k),
        ("campfire", 470, 440, 1), ("knight", 352, 458, k), ("wizard", 672, 458, k),
        ("slime", 200, 470, 1), ("ranger", 570, 488, k),
    ]
    for key, x, y, scale in sorted(scene, key=lambda s: s[2]):
        place(canvas, img(key), x, y, scale)
    # Inventário: os doze ícones em slots, a 2×.
    icons = [r["key"] for r in items.values() if r["group"] == "icon"]
    slot, gap, pad = 32 * 2 + 8, 6, 12
    bar_w = len(icons) * slot + (len(icons) - 1) * gap + 2 * pad
    bar = Image.new("RGBA", (bar_w, slot + 2 * pad), (0, 0, 0, 0))
    dr = ImageDraw.Draw(bar)
    dr.rounded_rectangle((0, 0, bar.width - 1, bar.height - 1), radius=8, fill=(20, 22, 30, 215), outline=(90, 96, 120, 255), width=2)
    for i, key in enumerate(icons):
        x = pad + i * (slot + gap)
        dr.rounded_rectangle((x, pad, x + slot - 1, pad + slot - 1), radius=5, fill=(44, 48, 62, 255), outline=(70, 76, 96, 255), width=2)
        z = zoom(img(key), 2)
        bar.alpha_composite(z, (x + (slot - z.width) // 2, pad + (slot - z.height) // 2))
    canvas.alpha_composite(bar, ((W - bar.width) // 2, 14))
    canvas.convert("RGB").save(OUT / "hero.png", optimize=True)


def examples(d: Path, items: dict[str, dict]) -> None:
    ex = OUT / "examples"
    ex.mkdir(parents=True, exist_ok=True)
    for key, r in items.items():
        im = load(d, key, r["group"])
        im.save(ex / f"{key}-1x.png", optimize=True)
        # Cartões de 208 px: ícone a 6×, personagem/prop a 3×, textura em mosaico 3×3 a 1×
        # (as emendas aparecem se existirem). Tamanho natural evita reescala no navegador.
        z = tile(im, im.width * 3, im.height * 3) if r["group"] == "texture" else zoom(im, 192 // max(im.size))
        card = Image.new("RGBA", (z.width + 16, z.height + 16), BG)
        card.alpha_composite(z, (8, 8))
        card.save(ex / f"{key}.png", optimize=True)


def pipeline(d: Path, items: dict[str, dict], key: str = "mushroom") -> None:
    raw = Image.open(d / f"{key}-raw.png").convert("RGBA")
    final = Image.open(d / f"{key}-image.png").convert("RGBA")
    side = 320
    checker = Image.new("RGBA", (side, side))
    cd = ImageDraw.Draw(checker)
    for y in range(0, side, 16):
        for x in range(0, side, 16):
            cd.rectangle((x, y, x + 15, y + 15), fill=(58, 62, 76, 255) if (x // 16 + y // 16) % 2 else (46, 50, 62, 255))
    raw_view = raw.resize((side, side), Image.LANCZOS)
    big = checker.copy()
    big.alpha_composite(zoom(final, side // final.width))
    one = checker.copy().crop((0, 0, 96, 96))
    one.alpha_composite(final, ((96 - final.width) // 2, (96 - final.height) // 2))
    W = side * 2 + 96 + 4 * 32
    canvas = Image.new("RGBA", (W, side + 130), BG)
    dr = ImageDraw.Draw(canvas)
    x0, y0 = 32, 70
    canvas.alpha_composite(raw_view, (x0, y0))
    canvas.alpha_composite(big, (x0 + side + 32, y0))
    canvas.alpha_composite(one, (x0 + 2 * side + 64, y0 + side - 96))
    labels = [
        (x0, f"Model output: {raw.width}x{raw.height}"),
        (x0 + side + 32, f"Pixel Studio: {final.width}x{final.height} sprite (8x)"),
        (x0 + 2 * side + 64, "1x"),
    ]
    for x, text in labels:
        dr.text((x, 28), text, fill=TEXT, font=font(20))
    steps = {st["operation"]: st for st in items[key]["report"]["steps"]}
    cell = steps["unzoom"]["cell"][0]
    note = [
        f"Detected a {cell:.1f} px pixel grid in the model output and recovered it losslessly,",
        f"removed the background and centered the art on the {final.width}x{final.height} cell. No pixel was redrawn.",
    ]
    for i, line in enumerate(note):
        dr.text((x0, y0 + side + 12 + i * 22), line, fill=MUTED, font=font(17))
    canvas.convert("RGB").save(OUT / "pipeline.png", optimize=True)


def inpainting(d: Path) -> None:
    """Fonte | máscara | resultado do inpainting (scripts/showcase-inpaint.ts), a 4×."""
    names = ["inpaint-source.png", "inpaint-mask.png", "inpaint-result.png"]
    if not all((d / n).exists() for n in names):
        return
    src, mask, out = (Image.open(d / n) for n in names)
    src, out, mask = src.convert("RGBA"), out.convert("RGBA"), mask.convert("L")
    overlay = src.copy()
    overlay.paste(Image.new("RGBA", src.size, (255, 0, 255, 190)), (0, 0), mask)
    protected_changed = sum(1 for a, b, m in zip(src.get_flattened_data(), out.get_flattened_data(), mask.get_flattened_data()) if m == 0 and a != b)
    k, gap, pad = 4, 40, 32
    side = src.width * k
    W = 3 * side + 2 * gap + 2 * pad
    canvas = Image.new("RGBA", (W, side + 120), BG)
    dr = ImageDraw.Draw(canvas)
    for i, (im, label) in enumerate([(src, "Source sprite (AI)"), (overlay, "Edit mask (magenta)"), (out, "Inpainted result")]):
        x = pad + i * (side + gap)
        canvas.alpha_composite(zoom(im, k), (x, 64))
        dr.text((x, 24), label, fill=TEXT, font=font(20))
    note = f"Pixels changed outside the mask: {protected_changed} (verified byte by byte on RGBA)."
    dr.text((pad, 64 + side + 20), note, fill=MUTED, font=font(17))
    canvas.convert("RGB").save(OUT / "inpainting.png", optimize=True)


def main() -> None:
    d = Path(sys.argv[1]).resolve()
    data = json.loads((d / "results.json").read_text())
    items = {r["key"]: r for r in data["results"] if r["state"] == "succeeded"}
    OUT.mkdir(parents=True, exist_ok=True)
    hero(d, items)
    examples(d, items)
    pipeline(d, items)
    inpainting(d)
    print(f"{len(items)} resultados · US$ {data['totalUsd']:.4f} · {OUT}")


if __name__ == "__main__":
    main()
