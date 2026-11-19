"""Fonte bitmap do cartão D1: gabarito de glyphs, medição da folha e texto de teste.

- `font_guide` desenha a grade de células com baseline, altura de maiúscula e
  uma letra-fantasma em cada célula (posição e tamanho, não estilo). A fonte
  embutida do Pillow cobre só ASCII; acentos dos fantasmas são compostos aqui
  com marcas de pixel. O fantasma é guia, nunca glyph exportado.
- `font_measure` fatia a folha devolvida, binariza o alfa, mede a tinta de cada
  célula e calcula `rect`, `bearingX`, `bearingY` e `advanceX` relativos à
  baseline (Y para baixo). Célula sem tinta = glyph AUSENTE (listado, nunca
  substituído).
- `font_render` compõe textos com o atlas + métricas (mesma regra do leitor
  independente): 1×, zoom inteiro, ausentes, largura e quebra de linha.
"""

from __future__ import annotations

import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from pixel_pipeline.i18n import tx
from pixel_pipeline.operations import hex_rgb, inputs_by_ordinal, load_rgba, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, Text, input_by_role

Json = dict[str, Any]

GUIDE_BG = (255, 255, 255, 255)
GHOST = (140, 140, 140, 255)
CELL_LINE = (190, 200, 255, 255)
BASELINE = (255, 120, 120, 255)
CAPLINE = (120, 200, 140, 255)
MISSING = (255, 0, 80, 255)
WIDTH_LINE = (0, 200, 255, 255)

# Glyphs cujo pé apoia na baseline (sem descendente); o resto mede relativo à baseline estimada.
DESCENDERS = set("gjpqyQ,;_()[]{}|")
ABOVE = {"́": "acute", "̀": "grave", "̂": "circumflex", "̃": "tilde", "̈": "diaeresis", "̊": "ring"}
BELOW = {"̧": "cedilla", "̨": "ogonek"}
MARKS = {
    "acute": ["..#", ".#."],
    "grave": ["#..", ".#."],
    "circumflex": [".#.", "#.#"],
    "tilde": [".#.#", "#.#."],
    "diaeresis": ["#.#"],
    "ring": [".#.", "#.#", ".#."],
    "cedilla": [".#", "#."],
    "ogonek": [".#", "..#"],
}


def _sits_on_baseline(cp: int) -> bool:
    ch = chr(cp)
    base = unicodedata.normalize("NFD", ch)
    if any(m in BELOW for m in base[1:]):
        return False
    b = base[0]
    if b in DESCENDERS:
        return False
    return b.isalnum() or b in ".!?:%"


# ---------------------------------------------------------------------------
# Gabarito
# ---------------------------------------------------------------------------


@lru_cache(maxsize=32)
def _ghost_font(cap_height: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Fonte embutida do Pillow no maior tamanho cuja maiúscula `H` cabe na altura pedida."""
    best = None
    for size in range(4, 129):
        try:
            font = ImageFont.load_default(size=size)
        except (TypeError, OSError):
            return ImageFont.load_default()
        box = font.getbbox("H")
        if box[3] - box[1] <= cap_height:
            best = font
        else:
            break
    return best or ImageFont.load_default(size=4)


def _mask_rows(font: ImageFont.FreeTypeFont | ImageFont.ImageFont, ch: str) -> tuple[int, int, list[list[bool]]] | None:
    """Pixels da letra (sem suavização) com o deslocamento até a origem na baseline."""
    try:
        bbox = font.getbbox(ch, anchor="ls")
    except (TypeError, ValueError):
        bbox = font.getbbox(ch)
    img = Image.new("1", (max(1, bbox[2] - bbox[0]), max(1, bbox[3] - bbox[1])), 0)
    draw = ImageDraw.Draw(img)
    draw.fontmode = "1"
    try:
        draw.text((-bbox[0], -bbox[1]), ch, font=font, fill=1, anchor="ls")
    except (TypeError, ValueError):
        draw.text((-bbox[0], -bbox[1]), ch, font=font, fill=1)
    px = img.load()
    rows = [[bool(px[x, y]) for x in range(img.width)] for y in range(img.height)]
    if not any(any(r) for r in rows):
        return None
    return bbox[0], bbox[1], rows


@lru_cache(maxsize=4096)
def _has_glyph(cap_height: int, ch: str) -> bool:
    font = _ghost_font(cap_height)
    probe = _mask_rows(font, ch)
    notdef = _mask_rows(font, "￿")
    return probe is not None and probe != notdef


def _ghost(cap_height: int, ch: str) -> list[tuple[int, int]]:
    """Pixels do fantasma relativos à origem (caneta na baseline): letra embutida + marcas compostas."""
    font = _ghost_font(cap_height)
    if _has_glyph(cap_height, ch):
        dx, dy, rows = _mask_rows(font, ch)  # type: ignore[misc]
        return [(dx + x, dy + y) for y, row in enumerate(rows) for x, on in enumerate(row) if on]
    parts = unicodedata.normalize("NFD", ch)
    base, marks = parts[0], parts[1:]
    if marks and _has_glyph(cap_height, base):
        pixels = _ghost(cap_height, base)
        xs = [p[0] for p in pixels]
        top = min(p[1] for p in pixels)
        cx = (min(xs) + max(xs)) // 2
        for m in marks:
            name = ABOVE.get(m) or BELOW.get(m)
            if not name:
                continue
            pattern = MARKS[name]
            w, h = len(pattern[0]), len(pattern)
            ox = cx - w // 2
            oy = top - h - 1 if m in ABOVE else 0
            if m in ABOVE:
                top = oy
            pixels += [(ox + x, oy + y) for y, row in enumerate(pattern) for x, c in enumerate(row) if c == "#"]
        return pixels
    width = max(3, cap_height * 3 // 4)
    if ch in "—–":
        y = -max(2, cap_height * 2 // 5)
        length = width + 2 if ch == "—" else width - 1
        return [(x, y) for x in range(length)]
    if ch == "…":
        return [(x, -1) for x in (0, 2, 4)]
    # Sem fantasma conhecido: caixa vazia na altura da maiúscula (o prompt nomeia o caractere).
    return [(x, y) for x in range(width) for y in range(-cap_height, 0) if x in (0, width - 1) or y in (-cap_height, -1)]


def font_guide(request: Json, workdir: Path) -> Json:
    """Grade de células com baseline e letra-fantasma, ampliada por fator inteiro (linhas finas fora da grade lógica)."""
    recipe = recipe_of(request)
    cols, rows = recipe["columns"], recipe["rows"]
    cw, ch = recipe["cell"]
    base_y, pad, cap = recipe["baselineY"], recipe["padLeft"], recipe["capHeight"]
    cps: list[int | None] = recipe["codepoints"]
    if len(cps) > cols * rows:
        raise PipelineError("invalid_request", tx("Mais glyphs que células no gabarito", "More glyphs than template cells"))
    logical = Image.new("RGBA", (cols * cw, rows * ch), GUIDE_BG)
    px = logical.load()
    for i, cp in enumerate(cps):
        if cp is None:
            continue
        ox, oy = (i % cols) * cw + pad, (i // cols) * ch + base_y
        for x, y in _ghost(cap, chr(cp)):
            gx, gy = ox + x, oy + y
            if (i % cols) * cw <= gx < (i % cols + 1) * cw and (i // cols) * ch <= gy < (i // cols + 1) * ch:
                px[gx, gy] = GHOST
    scale = recipe["scale"]
    big = logical.resize((logical.width * scale, logical.height * scale), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(big)
    for r in range(rows):
        y = (r * ch + base_y) * scale
        draw.line([(0, y), (big.width - 1, y)], fill=BASELINE)
        yc = (r * ch + base_y - cap) * scale
        draw.line([(0, yc), (big.width - 1, yc)], fill=CAPLINE)
    for c in range(cols + 1):
        x = min(big.width - 1, c * cw * scale)
        draw.line([(x, 0), (x, big.height - 1)], fill=CELL_LINE)
    for r in range(rows + 1):
        y = min(big.height - 1, r * ch * scale)
        draw.line([(0, y), (big.width - 1, y)], fill=CELL_LINE)
    outputs = [write_png(workdir, big, "out/guide.png", "guide"), write_png(workdir, logical, "out/guide-1x.png", "guide_1x")]
    return respond(outputs, {"size": [big.width, big.height], "logicalSize": [logical.width, logical.height], "scale": scale, "cells": len(cps)})


# ---------------------------------------------------------------------------
# Medição da folha devolvida
# ---------------------------------------------------------------------------


def _hue(rgb: tuple[int, int, int]) -> float:
    import colorsys

    return colorsys.rgb_to_hsv(*(c / 255 for c in rgb))[0] * 360


def _is_key(r: int, g: int, b: int, key_hue: float) -> bool:
    """Mesma família da cor-chave (matiz próxima, saturada e clara), em qualquer brilho da sombra."""
    import colorsys

    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    diff = abs(h * 360 - key_hue)
    return min(diff, 360 - diff) <= 25 and s * 255 >= 96 and v * 255 >= 100


def font_measure(request: Json, workdir: Path) -> Json:
    """Página binarizada + glyphs medidos na grade declarada; células vazias = glyph ausente."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    sheet = load_rgba(path)
    cols, rows = recipe["columns"], recipe["rows"]
    cw, ch = recipe["cell"]
    base_y, cap = recipe["baselineY"], recipe["capHeight"]
    if sheet.size != (cols * cw, rows * ch):
        raise PipelineError("geometry_mismatch", tx(f"Folha {sheet.width}×{sheet.height} difere da grade {cols * cw}×{rows * ch}", f"Sheet {sheet.width}×{sheet.height} differs from grid {cols * cw}×{rows * ch}"))
    cps: list[int | None] = recipe["codepoints"]
    threshold = recipe["alphaThreshold"]
    key = _hue(hex_rgb(recipe["keyColor"])) if recipe.get("keyColor") else None
    page = sheet.copy()
    pp = page.load()
    cleared = 0
    for y in range(page.height):
        for x in range(page.width):
            r, g, b, a = pp[x, y]
            if a >= threshold and key is not None and _is_key(r, g, b, key):
                # Miolo fechado de letra (o, A, B) pintado com a cor-chave: fundo, não tinta.
                cleared += 1
                a = 0
            pp[x, y] = (r, g, b, 255) if a >= threshold else (0, 0, 0, 0)
    warnings: list[Text] = []
    measured: list[Json] = []
    missing: list[int] = []
    for i in range(cols * rows):
        cell_box = ((i % cols) * cw, (i // cols) * ch)
        cell = page.crop((cell_box[0], cell_box[1], cell_box[0] + cw, cell_box[1] + ch))
        box = cell.getchannel("A").getbbox()
        cp = cps[i] if i < len(cps) else None
        if cp is None:
            if box:
                warnings.append(tx(f"Célula {i + 1} deveria estar vazia e tem tinta (ignorada)", f"Cell {i + 1} should be empty but has ink (ignored)"))
            continue
        if box is None:
            missing.append(cp)
            continue
        x0, y0, x1, y1 = box
        measured.append(
            {
                "codepoint": cp,
                "cell": i,
                "rect": [cell_box[0] + x0, cell_box[1] + y0, x1 - x0, y1 - y0],
                "top": y0,
                "bottom": y1,
                "touchesEdge": x0 == 0 or y0 == 0 or x1 == cw or y1 == ch,
                "sits": _sits_on_baseline(cp),
            }
        )
    # Baseline da página: mediana do pé dos glyphs que apoiam nela (robusta a folha deslocada).
    feet = sorted(m["bottom"] for m in measured if m["sits"])
    page_base = feet[len(feet) // 2] if len(feet) >= 2 else base_y
    caps_h = sorted(m["rect"][3] for m in measured if 0x41 <= m["codepoint"] <= 0x5A and m["sits"])
    cap_median = caps_h[len(caps_h) // 2] if caps_h else None
    glyphs: list[Json] = []
    snapped: list[Json] = []
    tracking = recipe["tracking"]
    for m in measured:
        w, h = m["rect"][2], m["rect"][3]
        bearing_y = m["top"] - page_base
        label = chr(m["codepoint"])
        if m["sits"] and m["bottom"] != page_base:
            delta = page_base - m["bottom"]
            if recipe["snapBaseline"]:
                bearing_y = -h
                snapped.append({"codepoint": m["codepoint"], "deltaPx": delta})
                if abs(delta) > 1:
                    warnings.append(tx(f"Glyph {label} estava {abs(delta)} px fora da baseline; métrica alinhada (pixels intactos)", f"Glyph {label} was {abs(delta)} px off the baseline; metric aligned (pixels untouched)"))
            else:
                warnings.append(tx(f"Glyph {label} fora da baseline por {delta} px", f"Glyph {label} off the baseline by {delta} px"))
        if m["touchesEdge"]:
            warnings.append(tx(f"Glyph {label} encosta na borda da célula (pode estar cortado ou invadindo a vizinha)", f"Glyph {label} touches the cell edge (may be clipped or bleeding into the neighbor)"))
        if cap_median is not None and 0x41 <= m["codepoint"] <= 0x5A and m["sits"] and abs(h - cap_median) > 1:
            warnings.append(tx(f"Maiúscula {label} com {h} px de altura; as outras têm {cap_median}", f"Capital {label} is {h} px tall; the others are {cap_median}"))
        glyphs.append({"codepoint": m["codepoint"], "cell": m["cell"], "rect": m["rect"], "bearingX": 0, "bearingY": bearing_y, "advanceX": w + tracking, "touchesEdge": m["touchesEdge"]})
    if missing:
        listed = " ".join(chr(c) for c in missing[:24])
        warnings.append(tx(f"{len(missing)} glyph(s) ausente(s) nesta folha: {listed}", f"{len(missing)} glyph(s) missing on this sheet: {listed}"))
    if abs(page_base - base_y) > 0:
        warnings.append(tx(f"Baseline da folha medida em {page_base} (gabarito: {base_y})", f"Sheet baseline measured at {page_base} (template: {base_y})"))
    # Prévia: página ampliada com a grade, a baseline medida e as células ausentes marcadas.
    zoom = max(1, 256 // max(1, page.width))
    preview = page.resize((page.width * zoom, page.height * zoom), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(preview)
    for i in range(min(len(cps), cols * rows)):
        cx, cy = (i % cols) * cw * zoom, (i // cols) * ch * zoom
        draw.rectangle([cx, cy, cx + cw * zoom - 1, cy + ch * zoom - 1], outline=CELL_LINE)
        draw.line([(cx, cy + page_base * zoom), (cx + cw * zoom - 1, cy + page_base * zoom)], fill=BASELINE)
        if cps[i] is not None and cps[i] in missing:
            draw.line([(cx, cy), (cx + cw * zoom - 1, cy + ch * zoom - 1)], fill=MISSING)
    report = {
        "glyphs": glyphs,
        "missing": missing,
        "pageBaseline": page_base,
        "declaredBaseline": base_y,
        "capHeight": cap,
        "capHeightMeasured": cap_median,
        "snapped": snapped,
        "spacing": "proportional",
        "tracking": tracking,
        "keyPixelsCleared": cleared,
    }
    outputs = [write_png(workdir, page, "out/page.png", "page"), write_png(workdir, preview, "out/preview.png", "preview")]
    return respond(outputs, report, warnings)


# ---------------------------------------------------------------------------
# Texto de teste (mesma regra do leitor independente)
# ---------------------------------------------------------------------------


def layout_text(text: str, glyphs: dict[int, Json], metrics: Json, kerning: dict[tuple[int, int], int], max_width: int | None) -> Json:
    """Quebra por palavras na largura máxima; ausentes ocupam uma caixa de diagnóstico (nunca outro glyph)."""
    text = unicodedata.normalize("NFC", text)
    space = metrics["spaceAdvance"]
    box_w = max(3, space)

    def advance(cp: int) -> int:
        g = glyphs.get(cp)
        return g["advanceX"] if g else box_w + 1

    def word_width(word: list[tuple[int, int]]) -> int:
        width = 0
        for j, (cp, _) in enumerate(word):
            width += advance(cp)
            if j + 1 < len(word):
                width += kerning.get((cp, word[j + 1][0]), 0)
        return width

    lines: list[list[tuple[int, int]]] = []
    overflow = False
    wrapped = False
    position = 0
    for para in text.split("\n"):
        words: list[list[tuple[int, int]]] = [[]]
        for ch in para:
            if ch == " ":
                words.append([])
            else:
                words[-1].append((ord(ch), position))
            position += 1
        position += 1  # a quebra de linha conta como posição
        current: list[tuple[int, int]] = []
        width = 0
        for w in (w for w in words if w):
            ww = word_width(w)
            needed = (space if current else 0) + ww
            if max_width is not None and current and width + needed > max_width:
                lines.append(current)
                wrapped = True
                current, width, needed = [], 0, ww
            if current:
                current.append((32, -1))
            current.extend(w)
            width += needed
            if max_width is not None and ww > max_width:
                overflow = True
        lines.append(current)
    placed: list[Json] = []
    missing: list[Json] = []
    line_widths: list[int] = []
    for li, line in enumerate(lines):
        pen = 0
        for j, (cp, pos) in enumerate(line):
            if cp == 32:
                pen += space
                continue
            g = glyphs.get(cp)
            if g is None:
                missing.append({"char": chr(cp), "codepoint": cp, "position": pos, "line": li})
                placed.append({"missing": True, "x": pen, "line": li, "width": box_w})
            else:
                placed.append({"missing": False, "x": pen + g["bearingX"], "line": li, "glyph": g})
            pen += advance(cp)
            if j + 1 < len(line) and line[j + 1][0] != 32:
                pen += kerning.get((cp, line[j + 1][0]), 0)
        line_widths.append(pen)
    width = max(line_widths, default=0)
    if max_width is not None and width > max_width:
        overflow = True
    return {"placed": placed, "lines": len(lines), "lineWidths": line_widths, "width": width, "height": len(lines) * metrics["lineHeight"], "missing": missing, "overflow": overflow, "wrapped": wrapped}


def render_layout(layout: Json, pages: list[Image.Image], metrics: Json, color: tuple[int, int, int] | None, background: tuple[int, int, int] | None, min_width: int) -> Image.Image:
    w = max(1, layout["width"], min_width)
    h = max(1, layout["height"])
    canvas = Image.new("RGBA", (w, h), (*background, 255) if background else (0, 0, 0, 0))
    for p in layout["placed"]:
        top = p["line"] * metrics["lineHeight"]
        if p["missing"]:
            ImageDraw.Draw(canvas).rectangle([p["x"], top, p["x"] + p["width"] - 1, top + metrics["ascent"] - 1], outline=MISSING)
            continue
        g = p["glyph"]
        x, y, gw, gh = g["rect"]
        img = pages[g["page"]].crop((x, y, x + gw, y + gh))
        if color:
            alpha = img.getchannel("A")
            img = Image.new("RGBA", img.size, (*color, 255))
            img.putalpha(alpha)
        canvas.alpha_composite(img, dest=(p["x"], top + metrics["ascent"] + g["bearingY"]))
    return canvas


def font_render(request: Json, workdir: Path) -> Json:
    """Cada texto em 1× e em zoom inteiro, com caracteres ausentes, largura, linhas e excesso no relatório."""
    recipe = recipe_of(request)
    layers = inputs_by_ordinal(request, workdir, "layer")
    pages = [load_rgba(layers[k]) for k in sorted(layers)]
    if not pages:
        raise PipelineError("invalid_request", tx("Texto de teste exige ao menos uma página do atlas", "The test text needs at least one atlas page"))
    glyphs: dict[int, Json] = {}
    for g in recipe["glyphs"]:
        if g["page"] >= len(pages):
            raise PipelineError("invalid_request", tx(f"Glyph U+{g['codepoint']:04X} aponta página inexistente", f"Glyph U+{g['codepoint']:04X} points to a missing page"))
        x, y, w, h = g["rect"]
        page = pages[g["page"]]
        if x + w > page.width or y + h > page.height:
            raise PipelineError("geometry_mismatch", tx(f"Retângulo do glyph U+{g['codepoint']:04X} fora da página", f"Glyph U+{g['codepoint']:04X} rectangle outside the page"))
        glyphs[g["codepoint"]] = g
    kerning = {(k["left"], k["right"]): k["amount"] for k in recipe["kerning"]}
    metrics = recipe["metrics"]
    color = hex_rgb(recipe["color"]) if recipe["color"] else None
    background = hex_rgb(recipe["background"]) if recipe["background"] else None
    zoom = recipe["zoom"]
    max_width = recipe["maxWidth"]
    outputs: list[Json] = []
    results: list[Json] = []
    warnings: list[Text] = []
    for i, text in enumerate(recipe["texts"]):
        layout = layout_text(text, glyphs, metrics, kerning, max_width)
        img = render_layout(layout, pages, metrics, color, background, max_width or 0)
        big = img.resize((img.width * zoom, img.height * zoom), Image.Resampling.NEAREST)
        if max_width is not None and max_width * zoom < big.width:
            ImageDraw.Draw(big).line([(max_width * zoom, 0), (max_width * zoom, big.height - 1)], fill=WIDTH_LINE)
        outputs.append(write_png(workdir, img, f"out/text-{i}.png", "text", key=str(i)))
        outputs.append(write_png(workdir, big, f"out/text-{i}-zoom.png", "text_zoom", key=str(i)))
        results.append({k: layout[k] for k in ("lines", "lineWidths", "width", "height", "missing", "overflow", "wrapped")} | {"text": unicodedata.normalize("NFC", text)})
        if layout["missing"]:
            chars = "".join(sorted({m["char"] for m in layout["missing"]}))
            warnings.append(tx(f"Texto {i + 1}: glyph(s) ausente(s) {chars}", f"Text {i + 1}: missing glyph(s) {chars}"))
        if layout["overflow"]:
            warnings.append(tx(f"Texto {i + 1} excede a largura de {max_width} px", f"Text {i + 1} exceeds the {max_width} px width"))
    return respond(outputs, {"texts": results, "zoom": zoom, "maxWidth": max_width, "metrics": metrics}, warnings)
