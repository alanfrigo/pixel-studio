"""Kit de UI (cartão U3): guia e separação do template, recorte, folha de estados, transformações locais e foco.

Operações locais e determinísticas (plan/07 §template → split → componentes →
estados). Separar recorta pixels pelos retângulos revisados, não gera arte; a
folha de estados é conferida contra o estado-base aprovado (mesma célula,
contorno, miolo e padding) e só translação inteira é corrigida; transformações
locais (rampa, realce, deslocamento) e o overlay de foco mantêm o contorno.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from pixel_pipeline.i18n import tx
from pixel_pipeline.operations import hex_rgb, load_rgba, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, input_by_role
from pixel_pipeline.world import _checker, _zoom

Json = dict[str, Any]

PIECE_FILL = (128, 128, 136, 255)
PIECE_EDGE = (72, 72, 80, 255)
FILL_FILL = (200, 200, 206, 255)
PLACEHOLDER = (150, 150, 158, 255)
CELL_LINE = (0, 220, 255, 255)
PROPOSAL_LINE = (255, 214, 0, 255)


def _box(rect: list[int]) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    return x, y, x + w, y + h


def _inside(rect: list[int], size: tuple[int, int]) -> bool:
    x, y, w, h = rect
    return x >= 0 and y >= 0 and x + w <= size[0] and y + h <= size[1]


def _alpha_mask(img: Image.Image, threshold: int = 1) -> Image.Image:
    return img.getchannel("A").point(lambda a: 255 if a >= threshold else 0)


def _edge_band(mask: Image.Image, width: int) -> Image.Image:
    """Faixa de `width` px junto à borda da silhueta (a borda da célula conta como fora)."""
    padded = Image.new("L", (mask.width + 2, mask.height + 2), 0)
    padded.paste(mask, (1, 1))
    eroded = padded
    for _ in range(width):
        eroded = eroded.filter(ImageFilter.MinFilter(3))
    inner = eroded.crop((1, 1, mask.width + 1, mask.height + 1))
    return ImageChops.subtract(mask, inner)


# ---------------------------------------------------------------------------
# Template: guia raster e proposta de separação
# ---------------------------------------------------------------------------


def ui_template_guide(request: Json, workdir: Path) -> Json:
    """Guia do template: células cinza (peça), claras (preenchimento) ou só moldura, em fundo de cor-chave."""
    recipe = recipe_of(request)
    w, h = recipe["size"]
    scale = recipe["scale"]
    key = hex_rgb(recipe["backgroundKey"]) + (255,)
    guide = Image.new("RGBA", (w, h), key)
    draw = ImageDraw.Draw(guide)
    for cell in recipe["cells"]:
        if not _inside(cell["rect"], (w, h)):
            raise PipelineError("geometry_mismatch", tx(f"Célula {cell['localId']} fora da guia {w}×{h}", f"Cell {cell['localId']} outside the {w}×{h} guide"))
        x0, y0, x1, y1 = _box(cell["rect"])
        if cell["kind"] == "frame":
            ring = max(1, min(x1 - x0, y1 - y0) // 4)
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=PIECE_EDGE)
            draw.rectangle([x0 + ring, y0 + ring, x1 - 1 - ring, y1 - 1 - ring], fill=key)
        elif cell["kind"] == "fill":
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=FILL_FILL)
        else:
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=PIECE_FILL, outline=PIECE_EDGE)
    out = guide.resize((w * scale, h * scale), Image.Resampling.NEAREST) if scale > 1 else guide
    return respond([write_png(workdir, out, "out/guide.png", "guide")], {"size": [w, h], "scale": scale, "cells": len(recipe["cells"])})


def ui_template_split(request: Json, workdir: Path) -> Json:
    """Proposta de separação: retângulo do conteúdo dentro de cada célula, células vazias e transbordos."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    outputs = []
    cleared = 0
    if recipe.get("backgroundKey"):
        # Miolo da moldura e outras áreas fechadas na cor-chave: a remoção pela borda não as alcança.
        kr, kg, kb = hex_rgb(recipe["backgroundKey"])
        px = img.load()
        for y in range(img.height):
            for x in range(img.width):
                r, g, b, a = px[x, y]
                if a and (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2 <= 60**2:
                    px[x, y] = (0, 0, 0, 0)
                    cleared += 1
        outputs.append(write_png(workdir, img, "out/cleaned.png", "cleaned"))
    mask = _alpha_mask(img)
    warnings: list[Json] = []
    proposals = []
    covered = Image.new("L", img.size, 0)
    for cell in recipe["cells"]:
        rect = cell["rect"]
        if not _inside(rect, img.size):
            raise PipelineError("geometry_mismatch", tx(f"Célula {cell['localId']} fora do template {img.width}×{img.height}", f"Cell {cell['localId']} outside the {img.width}×{img.height} template"))
        x0, y0, x1, y1 = _box(rect)
        covered.paste(255, (x0, y0, x1, y1))
        bbox = mask.crop((x0, y0, x1, y1)).getbbox()
        if bbox is None:
            proposals.append({"localId": cell["localId"], "rect": None, "touchesCellEdge": False, "pixels": 0})
            warnings.append(tx(f"Célula {cell['localId']} vazia: o modelo não pintou a peça nela", f"Cell {cell['localId']} is empty: the model did not paint the piece there"))
            continue
        bx0, by0, bx1, by1 = bbox
        touches = bx0 == 0 or by0 == 0 or bx1 == x1 - x0 or by1 == y1 - y0
        pixels = mask.crop((x0, y0, x1, y1)).histogram()[255]
        proposals.append({"localId": cell["localId"], "rect": [x0 + bx0, y0 + by0, bx1 - bx0, by1 - by0], "touchesCellEdge": touches, "pixels": pixels})
    spill = ImageChops.subtract(mask, covered).histogram()[255]
    if spill:
        warnings.append(tx(f"{spill} px pintados fora das células declaradas (ficam fora do recorte)", f"{spill} px painted outside the declared cells (left out of the crop)"))
    zoom = recipe["zoom"]
    preview = _checker((img.width * zoom, img.height * zoom), 4 * zoom)
    preview.alpha_composite(_zoom(img, zoom))
    draw = ImageDraw.Draw(preview)
    for cell, prop in zip(recipe["cells"], proposals):
        x0, y0, x1, y1 = _box(cell["rect"])
        draw.rectangle([x0 * zoom, y0 * zoom, x1 * zoom - 1, y1 * zoom - 1], outline=CELL_LINE)
        if prop["rect"]:
            px0, py0, px1, py1 = _box(prop["rect"])
            draw.rectangle([px0 * zoom, py0 * zoom, px1 * zoom - 1, py1 * zoom - 1], outline=PROPOSAL_LINE)
    report = {"size": [img.width, img.height], "proposals": proposals, "spillPixels": spill, "keyPixelsCleared": cleared}
    return respond([*outputs, write_png(workdir, preview, "out/split-preview.png", "preview")], report, warnings)


def ui_crop(request: Json, workdir: Path) -> Json:
    """Recorte explícito por retângulo revisado; mede a cobertura de áreas que devem ficar vazias (miolo da moldura)."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    outputs = []
    crops = []
    warnings: list[Json] = []
    for crop in recipe["crops"]:
        rect = crop["rect"]
        if not _inside(rect, img.size):
            raise PipelineError("geometry_mismatch", tx(f"Recorte {crop['key']} {rect} fora da imagem {img.width}×{img.height}", f"Crop {crop['key']} {rect} outside the {img.width}×{img.height} image"))
        piece = img.crop(_box(rect))
        mask = _alpha_mask(piece)
        item: Json = {"key": crop["key"], "rect": rect, "opaquePixels": mask.histogram()[255], "emptyCoverage": None}
        if item["opaquePixels"] == 0:
            warnings.append(tx(f"Recorte {crop['key']} sem nenhum pixel visível", f"Crop {crop['key']} has no visible pixel"))
        if crop.get("emptyRect"):
            er = crop["emptyRect"]
            if not _inside(er, piece.size):
                raise PipelineError("geometry_mismatch", tx(f"Área vazia de {crop['key']} fora do recorte", f"Empty area of {crop['key']} outside the crop"))
            area = mask.crop(_box(er))
            coverage = round(area.histogram()[255] / (er[2] * er[3]), 4)
            item["emptyCoverage"] = coverage
            if coverage > 0.05:
                warnings.append(
                    tx(
                        f"{crop['key']}: {round(coverage * 100)}% da área útil coberta (a moldura esconderia o preenchimento)",
                        f"{crop['key']}: {round(coverage * 100)}% of the useful area covered (the frame would hide the fill)",
                    )
                )
        crops.append(item)
        outputs.append(write_png(workdir, piece, f"out/crop-{crop['key']}.png", "crop", key=crop["key"]))
    return respond(outputs, {"crops": crops}, warnings)


# ---------------------------------------------------------------------------
# Estados: guia da folha e conferência da folha recebida
# ---------------------------------------------------------------------------


def ui_state_guide(request: Json, workdir: Path) -> Json:
    """Folha-guia: célula 0 = estado-base aprovado (referência); demais = moldura cinza a substituir."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    base = load_rgba(path)
    w, h = recipe["sheetSize"]
    key = hex_rgb(recipe["backgroundKey"]) + (255,)
    sheet = Image.new("RGBA", (w, h), key)
    cells = recipe["cells"]
    for i, rect in enumerate(cells):
        if not _inside(rect, (w, h)):
            raise PipelineError("geometry_mismatch", tx(f"Célula {i} fora da folha {w}×{h}", f"Cell {i} outside the {w}×{h} sheet"))
        if (rect[2], rect[3]) != base.size:
            raise PipelineError("geometry_mismatch", tx(f"Célula {i} tem {rect[2]}×{rect[3]}; o estado-base tem {base.width}×{base.height}", f"Cell {i} is {rect[2]}×{rect[3]}; the base state is {base.width}×{base.height}"))
    flat = Image.new("RGBA", base.size, key)
    flat.alpha_composite(base)
    sheet.paste(flat, (cells[0][0], cells[0][1]))
    draw = ImageDraw.Draw(sheet)
    for rect in cells[1:]:
        x0, y0, x1, y1 = _box(rect)
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=PLACEHOLDER)
    scale = recipe["scale"]
    out = sheet.resize((w * scale, h * scale), Image.Resampling.NEAREST) if scale > 1 else sheet
    return respond([write_png(workdir, out, "out/state-guide.png", "guide")], {"sheetSize": [w, h], "scale": scale, "cells": len(cells)})


def _locate(mask: Image.Image, rect: list[int], search: int, cell: tuple[int, int]) -> tuple[list[int], tuple[int, int], str]:
    """Conteúdo da célula na janela de busca: só translação inteira é corrigida."""
    x, y, w, h = rect
    wx0, wy0 = max(0, x - search), max(0, y - search)
    wx1, wy1 = min(mask.width, x + w + search), min(mask.height, y + h + search)
    bbox = mask.crop((wx0, wy0, wx1, wy1)).getbbox()
    if bbox is None:
        return rect, (0, 0), "missing"
    bx0, by0, bx1, by1 = bbox[0] + wx0, bbox[1] + wy0, bbox[2] + wx0, bbox[3] + wy0
    if (bx1 - bx0, by1 - by0) == cell:
        return [bx0, by0, w, h], (bx0 - x, by0 - y), "aligned"
    return rect, (0, 0), "size_mismatch"


def _close(a: tuple[int, ...], b: tuple[int, ...], tol: int) -> bool:
    return a[3] > 0 and b[3] > 0 and all(abs(a[i] - b[i]) <= tol for i in range(3))


def ui_state_sheet(request: Json, workdir: Path) -> Json:
    """Recorta cada estado da folha e confere célula, contorno, miolo e padding contra o estado-base."""
    recipe = recipe_of(request)
    _, base_path = input_by_role(request, workdir, "source")
    _, sheet_path = input_by_role(request, workdir, "candidate")
    base = load_rgba(base_path)
    sheet = load_rgba(sheet_path)
    cell = tuple(recipe["cell"])
    if base.size != cell:
        raise PipelineError("geometry_mismatch", tx(f"Estado-base {base.width}×{base.height} difere da célula {cell[0]}×{cell[1]}", f"Base state {base.width}×{base.height} differs from the {cell[0]}×{cell[1]} cell"))
    tol = round(recipe["outlineTolerance"] * 255)
    base_mask = _alpha_mask(base, 128)
    outline = _edge_band(base_mask, 1)
    outline_px = [(x, y) for y in range(base.height) for x in range(base.width) if outline.getpixel((x, y))]
    pad = recipe.get("contentPadding")
    center = (pad["left"], pad["top"], base.width - pad["right"], base.height - pad["bottom"]) if pad else (1, 1, base.width - 1, base.height - 1)
    base_center = base_mask.crop(center).histogram()[255]
    sheet_mask = _alpha_mask(sheet, 128)
    outputs = []
    states = []
    warnings: list[Json] = []
    bp = base.load()
    for item in recipe["cells"]:
        state = item["state"]
        if not _inside(item["rect"], sheet.size):
            raise PipelineError("geometry_mismatch", tx(f"Célula de {state} fora da folha {sheet.width}×{sheet.height}", f"Cell of {state} outside the {sheet.width}×{sheet.height} sheet"))
        rect, shift, found = _locate(sheet_mask, item["rect"], recipe["searchPx"], cell)
        piece = sheet.crop(_box(rect))
        mask = _alpha_mask(piece, 128)
        inter = ImageChops.multiply(mask, base_mask).histogram()[255]
        union = ImageChops.lighter(mask, base_mask).histogram()[255]
        iou = round(inter / union, 4) if union else 0.0
        pp = piece.load()
        match = sum(1 for p in outline_px if _close(pp[p], bp[p], tol))
        outline_match = round(match / len(outline_px), 4) if outline_px else 1.0
        center_cov = round(mask.crop(center).histogram()[255] / base_center, 4) if base_center else 1.0
        checks = {"cell": found == "aligned", "silhouette": iou >= 0.95, "outline": outline_match >= 0.9, "center": center_cov >= 0.9}
        passed = all(checks.values())
        states.append({"state": state, "found": found, "shift": list(shift), "silhouetteIoU": iou, "outlineMatch": outline_match, "centerCoverage": center_cov, "checks": checks, "passed": passed})
        if found == "missing":
            warnings.append(tx(f"Estado {state}: célula vazia na folha recebida", f"State {state}: empty cell in the returned sheet"))
        elif found == "size_mismatch":
            warnings.append(tx(f"Estado {state}: peça com tamanho diferente da célula {cell[0]}×{cell[1]} (não é esticada; peça ajuste)", f"State {state}: piece size differs from the {cell[0]}×{cell[1]} cell (not stretched; request an adjustment)"))
        if found != "missing":
            if not checks["silhouette"]:
                warnings.append(tx(f"Estado {state}: silhueta diverge do estado-base (IoU {iou})", f"State {state}: silhouette differs from the base state (IoU {iou})"))
            if not checks["outline"]:
                warnings.append(tx(f"Estado {state}: contorno alterado ({round(outline_match * 100)}% igual ao base)", f"State {state}: outline changed ({round(outline_match * 100)}% equal to base)"))
            if not checks["center"]:
                warnings.append(tx(f"Estado {state}: miolo/padding com {round(center_cov * 100)}% da cobertura do base", f"State {state}: center/padding has {round(center_cov * 100)}% of the base coverage"))
        outputs.append(write_png(workdir, piece, f"out/state-{state}.png", "state", key=state))
    report = {"cell": list(cell), "states": states, "allPassed": all(s["passed"] for s in states)}
    return respond(outputs, report, warnings)


# ---------------------------------------------------------------------------
# Transformações locais explícitas e overlay de foco
# ---------------------------------------------------------------------------


def _luma(c: tuple[int, ...]) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def _chroma(c: tuple[int, ...]) -> tuple[float, float, float]:
    y = _luma(c)
    return (c[0] - y, c[1] - y, c[2] - y)


def _ramp_step(rgb: tuple[int, int, int], palette: list[tuple[int, int, int]], steps: int) -> tuple[int, int, int]:
    """Cor da paleta mais próxima e, a cada degrau, a vizinha mais clara/escura de matiz parecida (rampa, não ordem global de brilho)."""
    current = min(palette, key=lambda p: sum((rgb[i] - p[i]) ** 2 for i in range(3)))
    for _ in range(abs(steps)):
        y = _luma(current)
        side = [p for p in palette if (_luma(p) > y if steps > 0 else _luma(p) < y)]
        if not side:
            break
        cc = _chroma(current)
        current = min(side, key=lambda p: sum((cc[i] - _chroma(p)[i]) ** 2 for i in range(3)) ** 0.5 + 0.25 * abs(_luma(p) - y))
    return current


def ui_state_transform(request: Json, workdir: Path) -> Json:
    """Rampa da paleta (± degraus), realce do miolo ou deslocamento do miolo, com a faixa do contorno preservada."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    t = recipe["transform"]
    keep = _edge_band(_alpha_mask(img), recipe["keepBorderPx"]) if recipe["keepBorderPx"] else Image.new("L", img.size, 0)
    src = img.load()
    kp = keep.load()
    out = img.copy()
    op = out.load()
    warnings: list[Json] = []
    changed = 0
    w, h = img.size
    if t["kind"] == "ramp":
        palette = sorted({hex_rgb(c) for c in recipe["palette"]}, key=_luma)
        if len(palette) < 2:
            raise PipelineError("invalid_request", tx("Rampa exige a paleta do projeto (ao menos duas cores)", "Ramp requires the project palette (at least two colors)"))
        cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
        for y in range(h):
            for x in range(w):
                r, g, b, a = src[x, y]
                if a == 0 or kp[x, y]:
                    continue
                rgb = (r, g, b)
                if rgb not in cache:
                    cache[rgb] = _ramp_step(rgb, palette, t["steps"])
                nr = cache[rgb]
                if nr != rgb:
                    changed += 1
                op[x, y] = nr + (a,)
        if changed == 0:
            warnings.append(tx("A rampa não mudou nenhum pixel (cores já no extremo da paleta)", "The ramp changed no pixel (colors already at the end of the palette)"))
    elif t["kind"] == "highlight":
        amount = t["amount"]
        for y in range(h):
            for x in range(w):
                r, g, b, a = src[x, y]
                if a == 0 or kp[x, y]:
                    continue
                op[x, y] = (round(r + (255 - r) * amount), round(g + (255 - g) * amount), round(b + (255 - b) * amount), a)
                changed += 1
    else:
        dx, dy = t["dx"], t["dy"]
        for y in range(h):
            for x in range(w):
                if kp[x, y] or src[x, y][3] == 0:
                    continue
                sx, sy = x - dx, y - dy
                if 0 <= sx < w and 0 <= sy < h and not kp[sx, sy] and src[sx, sy][3] > 0:
                    if src[sx, sy] != src[x, y]:
                        changed += 1
                    op[x, y] = src[sx, sy]
    report = {"transform": t, "changedPixels": changed, "keptBorderPixels": keep.histogram()[255], "size": [w, h]}
    return respond([write_png(workdir, out, "out/state.png", "state")], report, warnings)


def ui_focus_overlay(request: Json, workdir: Path) -> Json:
    """Overlay de foco: faixa de `widthPx` na borda da silhueta, na cor de foco reservada; transparente no resto."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    band = _edge_band(_alpha_mask(img), recipe["widthPx"])
    color = hex_rgb(recipe["color"]) + (255,)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    overlay.paste(Image.new("RGBA", img.size, color), (0, 0), band)
    report = {"size": [img.width, img.height], "pixels": band.histogram()[255], "color": recipe["color"], "widthPx": recipe["widthPx"]}
    return respond([write_png(workdir, overlay, "out/focus.png", "focus")], report)
