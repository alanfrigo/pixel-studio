"""Retratos, expressões/visemes e prévia de fala (cartão D1).

Operações locais e determinísticas: conferem o retrato contra o personagem
(paleta, escala, regiões do rosto sugeridas), montam a guia da folha de
visemes, fatiam a folha devolvida na grade declarada medindo a estabilidade do
rosto e geram a prévia animada de uma fala. Nada aqui sintetiza voz nem ouve
áudio: a fala é um plano de quadros por texto.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from pixel_pipeline.i18n import tx
from pixel_pipeline.operations import hex_rgb, load_rgba, optional_input, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, Text, input_by_role, resolve_inside, sha256_file

Json = dict[str, Any]

CHANGE_THRESHOLD = 24  # soma das diferenças RGB que conta como pixel alterado
PALETTE_DISTANCE = 48  # distância RGB até a cor mais próxima da referência
FACE_LINE = (255, 214, 0, 255)
MOUTH_LINE = (255, 0, 200, 255)
DIFF_TINT = (255, 0, 120, 255)


def _content_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    return img.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox()


def _opaque_colors(img: Image.Image) -> dict[tuple[int, int, int], int]:
    counts: dict[tuple[int, int, int], int] = {}
    for r, g, b, a in img.getdata():
        if a >= 128:
            counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    return counts


def _zoom(img: Image.Image, factor: int) -> Image.Image:
    return img if factor == 1 else img.resize((img.width * factor, img.height * factor), Image.Resampling.NEAREST)


def _changed(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    if (a[3] >= 128) != (b[3] >= 128):
        return True
    if a[3] < 128:
        return False
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2]) > CHANGE_THRESHOLD


def _inside(x: int, y: int, rect: list[int]) -> bool:
    return rect[0] <= x < rect[0] + rect[2] and rect[1] <= y < rect[1] + rect[3]


def _diff_ratio(a: Image.Image, b: Image.Image, exclude: list[int] | None, only: list[int] | None = None) -> tuple[float, int]:
    """Fração de pixels alterados entre duas células do mesmo tamanho, fora de `exclude` (ou só dentro de `only`)."""
    pa, pb = a.load(), b.load()
    total = changed = 0
    for y in range(a.height):
        for x in range(a.width):
            if exclude is not None and _inside(x, y, exclude):
                continue
            if only is not None and not _inside(x, y, only):
                continue
            total += 1
            if _changed(pa[x, y], pb[x, y]):
                changed += 1
    return (changed / total if total else 0.0), changed


def suggest_regions(size: tuple[int, int], bbox: tuple[int, int, int, int] | None) -> Json:
    """Regiões sugeridas para revisão: rosto no terço superior do conteúdo, boca no terço inferior do rosto."""
    w, h = size
    x0, y0, x1, y1 = bbox if bbox else (0, 0, w, h)
    cw, ch = x1 - x0, y1 - y0
    face = [x0 + round(cw * 0.25), y0 + round(ch * 0.12), max(4, round(cw * 0.5)), max(4, round(ch * 0.42))]
    face[2] = min(face[2], w - face[0])
    face[3] = min(face[3], h - face[1])
    mouth = [face[0] + round(face[2] * 0.25), face[1] + round(face[3] * 0.62), max(2, round(face[2] * 0.5)), max(2, round(face[3] * 0.3))]
    mouth[2] = min(mouth[2], w - mouth[0])
    mouth[3] = min(mouth[3], h - mouth[1])
    anchor = [min(w - 1, face[0] + face[2] // 2), min(h - 1, face[1] + face[3] // 2)]
    return {"faceRect": face, "mouthRect": mouth, "faceAnchor": anchor}


# ---------------------------------------------------------------------------
# Retrato × personagem
# ---------------------------------------------------------------------------


def portrait_check(request: Json, workdir: Path) -> Json:
    """Paleta, escala e conteúdo do retrato contra a vista do personagem; regiões do rosto sugeridas."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    portrait = load_rgba(path)
    char_path = optional_input(request, workdir, "layer")
    character = load_rgba(char_path) if char_path else None
    bbox = _content_bbox(portrait)
    if bbox is None:
        raise PipelineError("invalid_request", tx("Retrato sem nenhum pixel visível", "Portrait has no visible pixel"))
    warnings: list[Text] = []
    colors = _opaque_colors(portrait)
    opaque = sum(colors.values())
    report: Json = {
        "size": [portrait.width, portrait.height],
        "contentBox": [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]],
        "opaqueRatio": round(opaque / (portrait.width * portrait.height), 4),
        "colors": len(colors),
        "suggested": suggest_regions(portrait.size, bbox),
        "palette": None,
        "scale": None,
    }
    if bbox[1] == 0:
        warnings.append(tx("O conteúdo encosta na borda de cima: a cabeça pode estar cortada", "Content touches the top edge: the head may be cropped"))
    if character is not None:
        ref = _opaque_colors(character)
        ref_colors = list(ref)
        near = 0
        for color, n in colors.items():
            best = min((sum((a - b) ** 2 for a, b in zip(color, rc)) for rc in ref_colors), default=10**9)
            if best <= PALETTE_DISTANCE**2:
                near += n
        ratio = near / opaque if opaque else 0.0
        report["palette"] = {"referenceColors": len(ref), "portraitColors": len(colors), "nearReferenceRatio": round(ratio, 4), "distance": PALETTE_DISTANCE}
        if ratio < 0.6:
            pct = round(ratio * 100)
            warnings.append(
                tx(
                    f"Paleta diverge do personagem: só {pct}% dos pixels ficam perto das cores da referência",
                    f"Palette drifts from the character: only {pct}% of pixels are close to the reference colors",
                )
            )
        cbox = _content_bbox(character)
        if cbox:
            sprite_h = cbox[3] - cbox[1]
            portrait_h = bbox[3] - bbox[1]
            report["scale"] = {"spriteHeightPx": sprite_h, "portraitHeightPx": portrait_h, "ratio": round(portrait_h / sprite_h, 3) if sprite_h else None}
    # Prévia lado a lado: personagem e retrato na mesma altura de tela (zoom inteiro de cada um).
    zoom = recipe["zoom"]
    target_h = portrait.height * zoom
    panels = [_zoom(portrait, zoom)]
    if character is not None:
        cz = max(1, target_h // max(1, character.height))
        panels.insert(0, _zoom(character, cz))
    gap = 4 * zoom
    sheet = Image.new("RGBA", (sum(p.width for p in panels) + gap * (len(panels) - 1), max(p.height for p in panels)), (0, 0, 0, 0))
    x = 0
    for p in panels:
        sheet.alpha_composite(p, dest=(x, sheet.height - p.height))
        x += p.width + gap
    outputs = [write_png(workdir, sheet, "out/compare.png", "compare")]
    return respond(outputs, report, warnings)


# ---------------------------------------------------------------------------
# Folha de visemes
# ---------------------------------------------------------------------------


def _outline(draw: ImageDraw.ImageDraw, rect: list[int], color: tuple[int, int, int, int], scale: int = 1, inset: int = 0) -> None:
    x, y, w, h = rect
    draw.rectangle([x * scale - inset, y * scale - inset, (x + w) * scale - 1 + inset, (y + h) * scale - 1 + inset], outline=color, width=max(1, scale // 4))


def viseme_guide(request: Json, workdir: Path) -> Json:
    """Retrato aprovado repetido na grade declarada, com a boca marcada: o modelo redesenha só a boca em cada célula."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    portrait = load_rgba(path)
    cw, ch = recipe["cell"]
    if portrait.size != (cw, ch):
        raise PipelineError("geometry_mismatch", tx(f"Retrato {portrait.width}×{portrait.height} difere da célula {cw}×{ch}", f"Portrait {portrait.width}×{portrait.height} differs from cell {cw}×{ch}"))
    if recipe["flattenOnto"]:
        flat = Image.new("RGBA", portrait.size, (*hex_rgb(recipe["flattenOnto"]), 255))
        flat.alpha_composite(portrait)
        portrait = flat
    cols, rows, scale = recipe["columns"], recipe["rows"], recipe["scale"]
    sheet = Image.new("RGBA", (cols * cw, rows * ch), (0, 0, 0, 0))
    for i in range(cols * rows):
        sheet.alpha_composite(portrait, dest=((i % cols) * cw, (i // cols) * ch))
    big = _zoom(sheet, scale)
    draw = ImageDraw.Draw(big)
    mark = (*hex_rgb(recipe["markColor"]), 255)
    mx, my, mw, mh = recipe["mouthRect"]
    for i in range(cols * rows):
        ox, oy = (i % cols) * cw, (i // cols) * ch
        _outline(draw, [ox + mx, oy + my, mw, mh], mark, scale, inset=max(1, scale // 4))
    outputs = [write_png(workdir, big, "out/guide.png", "guide"), write_png(workdir, sheet, "out/guide-1x.png", "guide_1x")]
    return respond(outputs, {"size": [big.width, big.height], "logicalSize": [sheet.width, sheet.height], "scale": scale, "cells": cols * rows})


def expression_sheet(request: Json, workdir: Path) -> Json:
    """Fatia a folha na grade declarada e mede: viseme vazio, mudança fora da boca (× repouso) e fora do rosto (× retrato)."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    sheet = load_rgba(path)
    portrait_path = optional_input(request, workdir, "layer")
    portrait = load_rgba(portrait_path) if portrait_path else None
    cols, rows = recipe["columns"], recipe["rows"]
    cw, ch = recipe["cell"]
    if sheet.size != (cols * cw, rows * ch):
        raise PipelineError("geometry_mismatch", tx(f"Folha {sheet.width}×{sheet.height} difere da grade {cols * cw}×{rows * ch}", f"Sheet {sheet.width}×{sheet.height} differs from grid {cols * cw}×{rows * ch}"))
    if portrait is not None and portrait.size != (cw, ch):
        raise PipelineError("geometry_mismatch", tx("Retrato fora da célula declarada", "Portrait does not match the declared cell"))
    frame_ids: list[str] = recipe["frameIds"]
    if len(frame_ids) > cols * rows:
        raise PipelineError("invalid_request", tx("Mais visemes que células na grade", "More visemes than grid cells"))
    if recipe["restId"] not in frame_ids:
        raise PipelineError("invalid_request", tx("O viseme de repouso precisa estar na folha", "The rest viseme must be in the sheet"))
    mouth, face = recipe["mouthRect"], recipe["faceRect"]
    cells: dict[str, Image.Image] = {}
    frames: list[Json] = []
    warnings: list[Text] = []
    for i, fid in enumerate(frame_ids):
        rect = [(i % cols) * cw, (i // cols) * ch, cw, ch]
        cell = sheet.crop((rect[0], rect[1], rect[0] + cw, rect[1] + ch))
        cells[fid] = cell
        empty = _content_bbox(cell) is None
        frames.append({"frameId": fid, "rect": rect, "empty": empty})
        if empty:
            warnings.append(tx(f"Viseme {fid} veio vazio: o conjunto fica incompleto", f"Viseme {fid} came back empty: the set is incomplete"))
    rest = cells[recipe["restId"]]
    limits = recipe["thresholds"]
    for frame in frames:
        fid = frame["frameId"]
        if frame["empty"]:
            continue
        if fid != recipe["restId"]:
            ratio, n = _diff_ratio(cells[fid], rest, exclude=mouth)
            mouth_ratio, _ = _diff_ratio(cells[fid], rest, exclude=None, only=mouth)
            frame.update(outsideMouth=round(ratio, 4), outsideMouthPixels=n, mouthChanged=round(mouth_ratio, 4))
            if ratio > limits["outsideMouth"]:
                pct = round(ratio * 100, 1)
                warnings.append(tx(f"Rosto instável no viseme {fid}: {pct}% dos pixels fora da boca mudaram em relação ao repouso", f"Unstable face in viseme {fid}: {pct}% of pixels outside the mouth changed against rest"))
            if mouth_ratio == 0 and fid != "mbp":
                warnings.append(tx(f"Viseme {fid} tem a boca idêntica ao repouso", f"Viseme {fid} has the same mouth as rest"))
    outside_face = None
    if portrait is not None:
        ratio, n = _diff_ratio(rest, portrait, exclude=face)
        outside_face = round(ratio, 4)
        if ratio > limits["outsideFace"]:
            pct = round(ratio * 100, 1)
            warnings.append(tx(f"Identidade instável: {pct}% dos pixels fora do rosto diferem do retrato aprovado", f"Unstable identity: {pct}% of pixels outside the face differ from the approved portrait"))
        rest_mouth, _ = _diff_ratio(rest, portrait, exclude=mouth)
        frames[frame_ids.index(recipe["restId"])].update(outsideFace=outside_face, outsideMouthVsPortrait=round(rest_mouth, 4))
    # Prévia de revisão: folha ampliada com rosto e boca marcados em cada célula.
    zoom = recipe["zoom"]
    preview = _zoom(sheet, zoom)
    draw = ImageDraw.Draw(preview)
    for frame in frames:
        ox, oy = frame["rect"][0], frame["rect"][1]
        _outline(draw, [ox + face[0], oy + face[1], face[2], face[3]], FACE_LINE, zoom)
        _outline(draw, [ox + mouth[0], oy + mouth[1], mouth[2], mouth[3]], MOUTH_LINE, zoom)
    report = {
        "grid": {"columns": cols, "rows": rows, "cell": [cw, ch]},
        "frames": frames,
        "complete": not any(f["empty"] for f in frames),
        "maxOutsideMouth": max((f.get("outsideMouth", 0.0) for f in frames), default=0.0),
        "outsideFace": outside_face,
        "thresholds": limits,
        "changeThreshold": CHANGE_THRESHOLD,
    }
    return respond([write_png(workdir, preview, "out/review.png", "review")], report, warnings)


def expression_compare(request: Json, workdir: Path) -> Json:
    """Repouso de duas expressões lado a lado; pixels alterados fora da boca destacados."""
    recipe = recipe_of(request)
    _, pa = input_by_role(request, workdir, "source")
    _, pb = input_by_role(request, workdir, "layer")
    ra, rb = recipe["rectA"], recipe["rectB"]
    if ra[2:] != rb[2:]:
        raise PipelineError("geometry_mismatch", tx("As expressões têm células de tamanhos diferentes", "The expressions have different cell sizes"))
    a = load_rgba(pa).crop((ra[0], ra[1], ra[0] + ra[2], ra[1] + ra[3]))
    b = load_rgba(pb).crop((rb[0], rb[1], rb[0] + rb[2], rb[1] + rb[3]))
    mouth = recipe["mouthRect"]
    ratio, n = _diff_ratio(a, b, exclude=mouth)
    diff = Image.new("RGBA", a.size, (0, 0, 0, 0))
    da, db, dd = a.load(), b.load(), diff.load()
    for y in range(a.height):
        for x in range(a.width):
            gray = (da[x, y][0] + da[x, y][1] + da[x, y][2]) // 3
            dd[x, y] = (gray, gray, gray, da[x, y][3] // 2)
            if not _inside(x, y, mouth) and _changed(da[x, y], db[x, y]):
                dd[x, y] = DIFF_TINT
    zoom = recipe["zoom"]
    gap = 2 * zoom
    panels = [_zoom(a, zoom), _zoom(b, zoom), _zoom(diff, zoom)]
    out = Image.new("RGBA", (sum(p.width for p in panels) + gap * 2, panels[0].height), (0, 0, 0, 0))
    for i, p in enumerate(panels):
        out.alpha_composite(p, dest=(i * (p.width + gap), 0))
    report = {"outsideMouth": round(ratio, 4), "changedPixels": n, "changeThreshold": CHANGE_THRESHOLD}
    return respond([write_png(workdir, out, "out/compare.png", "compare")], report)


# ---------------------------------------------------------------------------
# Prévia de fala (derivado)
# ---------------------------------------------------------------------------


def speech_preview(request: Json, workdir: Path) -> Json:
    """GIF animado e tira PNG a partir dos visemes aprovados; o plano temporal continua sendo a autoridade."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    atlas = load_rgba(path)
    zoom = recipe["zoom"]
    frames: list[Image.Image] = []
    durations: list[int] = []
    for f in recipe["frames"]:
        x, y, w, h = f["rect"]
        if x + w > atlas.width or y + h > atlas.height:
            raise PipelineError("geometry_mismatch", tx(f"Quadro {f['rect']} fora do atlas", f"Frame {f['rect']} outside the atlas"))
        cell = Image.new("RGBA", (w, h), (32, 32, 42, 255))
        cell.alpha_composite(atlas.crop((x, y, x + w, y + h)))
        frames.append(_zoom(cell, zoom).convert("RGB"))
        durations.append(f["durationMs"])
    gif_rel = "out/speech.gif"
    target = resolve_inside(workdir, gif_rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(target, format="GIF", save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=False, disposal=1)
    gif = {"role": "gif", "relPath": gif_rel, "mime": "image/gif", "width": frames[0].width, "height": frames[0].height, "sha256": sha256_file(target)}
    shown = frames[: recipe["stripMax"]]
    strip = Image.new("RGB", (sum(f.width for f in shown) + (len(shown) - 1) * zoom, shown[0].height), (16, 16, 20))
    for i, f in enumerate(shown):
        strip.paste(f, (i * (f.width + zoom), 0))
    report = {"frames": len(frames), "totalMs": sum(durations), "stripFrames": len(shown), "derivedPreview": True}
    return respond([gif, write_png(workdir, strip.convert("RGBA"), "out/strip.png", "strip")], report)
