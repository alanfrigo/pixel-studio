"""Imagens do README para estados/animação de objeto (S3) e cenas/salas (T2).

    python/.venv/bin/python -I scripts/showcase-features.py <data>

Entradas, todas saídas reais do pipeline (sem retoque):
  reports/vitrine/<data>/bau/            frames do clipe "abrir" do baú (clip.json com durationMs)
  reports/cenas/<data>/                  cena plana e planos de paralaxe (scripts/scenes-real.ts)
  reports/cenas/<data>-salas-v2/         salas ligadas e a mesa recortada (--rooms-only)
Saída em docs/images/. Toda ampliação é inteira (vizinho mais próximo).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
BG = (24, 26, 33, 255)
TEXT = (226, 230, 240, 255)


def zoom(im: Image.Image, k: int) -> Image.Image:
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def on_bg(im: Image.Image, color: tuple[int, int, int, int] = BG) -> Image.Image:
    out = Image.new("RGBA", im.size, color)
    out.alpha_composite(im.convert("RGBA"))
    return out


def save_gif(frames: list[Image.Image], durations: list[int], path: Path, colors: int = 255) -> None:
    rgb = [f.convert("RGB") for f in frames]
    # Paleta comum a todos os quadros: sem cintilação entre frames.
    palette = rgb[0].quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in rgb]
    quantized[0].save(path, save_all=True, append_images=quantized[1:], duration=durations, loop=0, optimize=False, disposal=1)


def chest(d: Path) -> None:
    clip = json.loads((d / "bau" / "clip.json").read_text())
    k = 4
    frames, durations = [], []
    for f in clip["frames"]:
        frames.append(zoom(on_bg(Image.open(d / "bau" / f["file"])), k))
        durations.append(int(f["durationMs"]))
    # O clipe é "once": no GIF, segura o baú fechado e o aberto antes de repetir.
    durations[0] += 700
    durations[-1] += 1100
    save_gif(frames, durations, OUT / "chest-open.gif")


def bridge(scenes: Path) -> None:
    on_bg(zoom(Image.open(scenes / "cena-ponte-flare.png"), 3)).convert("RGB").save(OUT / "scene-bridge.png", optimize=True)


def parallax(scenes: Path, colors: int = 96) -> None:
    """Câmera em vaivém por uma largura: céu a 0,15 e chão a 1,0, os dois com repetição em X (aprovados).

    O vaivém fecha o loop do GIF sem salto (o céu não completa um ciclo em poucas larguras).
    """
    sky = Image.open(scenes / "plano-ceu.png").convert("RGBA")
    ground = Image.open(scenes / "v2-plano-chao.png").convert("RGBA")
    w, h = sky.size
    layers = [(sky, 0.15, (0, 0)), (ground, 1.0, (0, 22))]
    k, half = 2, 24
    positions = [round(i * w / half) for i in range(half)] + [round((half - i) * w / half) for i in range(half)]
    frames = []
    for cam in positions:
        view = Image.new("RGBA", (w, h), BG)
        for img, factor, (ox, oy) in layers:
            x = -int(cam * factor) % img.width
            for tx in (x - img.width, x, x + img.width):
                if -img.width < tx + ox < w:
                    view.alpha_composite(img.crop((max(0, -(tx + ox)), 0, img.width, img.height)), (max(0, tx + ox), oy))
        frames.append(zoom(view, k))
    save_gif(frames, [70] * len(frames), OUT / "parallax.gif", colors)


def rooms(salas: Path) -> None:
    on_bg(zoom(Image.open(salas / "salas-ligadas.png"), 2)).convert("RGB").save(OUT / "rooms.png", optimize=True)


def furniture(salas: Path) -> None:
    box = (48, 80, 208, 230)
    k, gap, pad = 2, 16, 16
    panels = [
        ("Generated room", "sala-a.png"),
        ("Table cut out, rug rebuilt (E1)", "sala-a-sem-mesa.png"),
        ("Table moved as a reusable prop", "sala-a-mesa-movida.png"),
    ]
    pw, ph = (box[2] - box[0]) * k, (box[3] - box[1]) * k
    canvas = Image.new("RGBA", (pad * 2 + 3 * pw + 2 * gap, ph + 56 + pad), BG)
    dr = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=18)
    for i, (label, name) in enumerate(panels):
        x = pad + i * (pw + gap)
        canvas.alpha_composite(zoom(on_bg(Image.open(salas / name)).crop(box), k), (x, 44))
        dr.text((x, 14), label, fill=TEXT, font=font)
    canvas.convert("RGB").save(OUT / "furniture.png", optimize=True)


def main() -> None:
    date = sys.argv[1]
    vitrine = ROOT / "reports" / "vitrine" / date
    scenes = ROOT / "reports" / "cenas" / date
    salas = ROOT / "reports" / "cenas" / f"{date}-salas-v2"
    OUT.mkdir(parents=True, exist_ok=True)
    chest(vitrine)
    bridge(scenes)
    parallax(scenes)
    rooms(salas)
    furniture(salas)
    for name in ["chest-open.gif", "scene-bridge.png", "parallax.gif", "rooms.png", "furniture.png"]:
        print(name, (OUT / name).stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
