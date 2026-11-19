"""Cenas e salas (cartão T2): planos de paralaxe, câmera, guia da planta e recorte de móveis.

Operações locais e determinísticas (plan/06 §cenas, salas e texturas como
saídas próprias; §perspectivas). Medem, compõem e recortam pelo que foi
declarado (máscara, grade, offsets); não inventam conteúdo: a área antes
oculta por um móvel é medida e entregue como máscara para inpainting (E1).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from pixel_pipeline.operations import _block_mode, binary_mask, hex_rgb, inputs_by_ordinal, load_rgba, optional_input, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, input_by_role
from pixel_pipeline.world import _axis_seams, _checker, _zoom

Json = dict[str, Any]

SEAM_LINE = (0, 220, 255, 255)
AREA_TINT = (255, 0, 200, 150)
FRAME_LINE = (255, 255, 255, 255)
SEAM_METHOD = "rgba-mean-ratio-p90-v1"


# ---------------------------------------------------------------------------
# Paralaxe: mesma regra de `src/domain/scenes/parallax.ts`
# ---------------------------------------------------------------------------


def _origin(layer: Json, size: tuple[int, int], camera: tuple[int, int]) -> tuple[int, int]:
    ox, oy = layer["offset"]
    return ox - math.floor(camera[0] * layer["parallax"]["x"]), oy - math.floor(camera[1] * layer["parallax"]["y"])


def _axis_copies(origin: int, period: int, repeat: bool, viewport: int) -> list[int]:
    if not repeat:
        return [origin]
    first = origin - period * math.ceil(origin / period)
    return list(range(first, viewport, period))


def _place(canvas: Image.Image, img: Image.Image, x: int, y: int) -> None:
    """Cola com recorte nas bordas (planos e móveis podem passar da tela)."""
    left, top = max(0, -x), max(0, -y)
    right, bottom = min(img.width, canvas.width - x), min(img.height, canvas.height - y)
    if left >= right or top >= bottom:
        return
    canvas.alpha_composite(img.crop((left, top, right, bottom)), dest=(max(0, x), max(0, y)))


def _frame(canvas_size: tuple[int, int], layers: list[tuple[Json, Image.Image]], camera: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    for layer, img in layers:
        ox, oy = _origin(layer, img.size, camera)
        for y in _axis_copies(oy, img.height, layer["repeat"]["y"], canvas_size[1]):
            for x in _axis_copies(ox, img.width, layer["repeat"]["x"], canvas_size[0]):
                _place(canvas, img, x, y)
    return canvas


def scene_layer_check(request: Json, workdir: Path) -> Json:
    """Continuidade da repetição de um plano por eixo pedido, mosaico 3× com linhas e linha do chão."""
    recipe = recipe_of(request)
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    w, h = img.size
    px = img.load()
    axes = recipe["axes"]
    threshold = recipe["threshold"]
    report: Json = {"size": [w, h], "threshold": threshold, "method": SEAM_METHOD, "x": None, "y": None, "ground": None}
    warnings: list[str] = []
    for axis in ("x", "y"):
        if axes[axis]:
            r = _axis_seams(px, w, h, axis, threshold, [])
            report[axis] = r
            if not r["passed"]:
                warnings.append(f"Emenda em {axis.upper()} reprovada (emenda/interior {r['ratio']} > {threshold}): o plano não repete nesse eixo")
    alpha = img.getchannel("A")
    hist = alpha.histogram()
    report["opaqueFraction"] = round(sum(hist[250:]) / (w * h), 4)
    # Primeira linha (de cima) opaca de borda a borda: topo do chão/morros (a faixa pode não ir até a base).
    apx = alpha.load()
    report["solidFromY"] = next((y for y in range(h) if all(apx[x, y] > 0 for x in range(w))), None)
    bbox = alpha.getbbox()
    report["contentRows"] = [bbox[1], bbox[3] - 1] if bbox else None
    gy = recipe.get("groundLineY")
    if gy is not None:
        if gy >= h:
            raise PipelineError("geometry_mismatch", f"Linha do chão {gy} fora do plano de {h} px")
        row = [px[x, gy][3] for x in range(w)]
        gaps = [x for x, a in enumerate(row) if a == 0]
        continuous = not gaps and (not axes["x"] or (row[0] > 0 and row[-1] > 0))
        report["ground"] = {"y": gy, "gaps": len(gaps), "firstGap": gaps[0] if gaps else None, "continuous": continuous}
        if not continuous:
            warnings.append(f"Linha do chão (y={gy}) interrompida em {len(gaps)} px")
    nx = 3 if axes["x"] else 1
    ny = 3 if axes["y"] else 1
    mosaic = Image.new("RGBA", (w * nx, h * ny), (0, 0, 0, 0))
    for j in range(ny):
        for i in range(nx):
            mosaic.alpha_composite(img, dest=(i * w, j * h))
    zoom = recipe["zoom"]
    lines = _checker((mosaic.width * zoom, mosaic.height * zoom), 8 * zoom)
    lines.alpha_composite(_zoom(mosaic, zoom))
    draw = ImageDraw.Draw(lines)
    for i in range(1, nx):
        draw.line([(i * w * zoom, 0), (i * w * zoom, lines.height - 1)], fill=SEAM_LINE)
    for j in range(1, ny):
        draw.line([(0, j * h * zoom), (lines.width - 1, j * h * zoom)], fill=SEAM_LINE)
    if gy is not None:
        draw.line([(0, gy * zoom), (lines.width - 1, gy * zoom)], fill=(255, 200, 0, 255))
    return respond([write_png(workdir, mosaic, "out/mosaic.png", "mosaic"), write_png(workdir, lines, "out/mosaic-lines.png", "mosaic_lines")], report, warnings)


def scene_compose(request: Json, workdir: Path) -> Json:
    """Planos com a câmera: imagem na origem, tira de quadros pela rolagem, buracos e continuidade do chão."""
    recipe = recipe_of(request)
    found = inputs_by_ordinal(request, workdir, "layer")
    cw, ch = recipe["canvas"]
    layers: list[tuple[Json, Image.Image]] = []
    for n, layer in enumerate(recipe["layers"]):
        path = found.get(layer["inputOrdinal"])
        if path is None:
            raise PipelineError("invalid_request", f"Plano {n} cita entrada {layer['inputOrdinal']} inexistente")
        layers.append((layer, load_rgba(path)))
    span, steps = recipe["spanPx"], recipe["steps"]
    stops = [round(span * i / steps) for i in range(steps + 1)]
    gy = recipe.get("groundLineY")
    if gy is not None and gy >= ch:
        raise PipelineError("geometry_mismatch", f"Linha do chão {gy} fora da cena de {ch} px")
    frames = []
    images = []
    for cam in stops:
        img = _frame((cw, ch), layers, (cam, 0))
        alpha = img.getchannel("A")
        uncovered = sum(alpha.histogram()[:255])
        ground_gaps = sum(1 for x in range(cw) if img.getpixel((x, gy))[3] == 0) if gy is not None else None
        frames.append({"camera": cam, "uncoveredPixels": uncovered, "groundGaps": ground_gaps})
        images.append(img)
    zoom = recipe["zoom"]
    strip = Image.new("RGBA", (cw * zoom, (ch * zoom + 2) * len(images)), (0, 0, 0, 0))
    for i, img in enumerate(images):
        cell = _checker((cw * zoom, ch * zoom), 8 * zoom)
        cell.alpha_composite(_zoom(img, zoom))
        strip.alpha_composite(cell, dest=(0, i * (ch * zoom + 2)))
    report = {
        "canvas": [cw, ch],
        "spanPx": span,
        "steps": steps,
        "frames": frames,
        "uncoveredFrames": sum(1 for f in frames if f["uncoveredPixels"] > 0),
        "groundContinuous": None if gy is None else all(f["groundGaps"] == 0 for f in frames),
    }
    warnings = []
    if report["uncoveredFrames"]:
        warnings.append(f"{report['uncoveredFrames']} quadro(s) da rolagem deixam pixels sem nenhum plano (buraco no fundo)")
    if report["groundContinuous"] is False:
        warnings.append("A linha do chão se interrompe em algum quadro da rolagem")
    return respond([write_png(workdir, images[0], "out/image.png", "image"), write_png(workdir, strip, "out/strip.png", "strip")], report, warnings)


def scene_overlay(request: Json, workdir: Path) -> Json:
    """Personagem pousado (pivô) em cada ponto de apoio, na escala 1× da cena, e ampliado."""
    recipe = recipe_of(request)
    _, scene_path = input_by_role(request, workdir, "source")
    found = inputs_by_ordinal(request, workdir, "layer")
    if not found:
        raise PipelineError("invalid_request", "Sobreposição exige o personagem como entrada 'layer'")
    scene = load_rgba(scene_path)
    spec = recipe["character"]
    sheet = load_rgba(found[min(found)])
    rx, ry, rw, rh = spec["rect"]
    if rx + rw > sheet.width or ry + rh > sheet.height:
        raise PipelineError("geometry_mismatch", f"Vista [{rx}, {ry}, {rw}, {rh}] fora do arquivo do personagem {sheet.width}×{sheet.height}")
    character = Image.new("RGBA", tuple(spec["logicalSize"]), (0, 0, 0, 0))
    character.alpha_composite(sheet.crop((rx, ry, rx + rw, ry + rh)), dest=tuple(spec["offset"]))
    px, py = spec["pivot"]
    out = scene.copy()
    for x, y in recipe["points"]:
        _place(out, character, x - px, y - py)
    bbox = character.getchannel("A").getbbox()
    zoom = recipe["zoom"]
    report = {
        "sceneSize": list(scene.size),
        "characterSize": list(character.size),
        "characterHeightPx": (bbox[3] - bbox[1]) if bbox else 0,
        "points": recipe["points"],
    }
    return respond([write_png(workdir, out, "out/overlay.png", "overlay"), write_png(workdir, _zoom(out, zoom), "out/overlay-zoom.png", "overlay_zoom")], report)


# ---------------------------------------------------------------------------
# Salas
# ---------------------------------------------------------------------------


def _floor(cells: list[bool], cols: int, rows: int, c: int, r: int) -> bool:
    return 0 <= c < cols and 0 <= r < rows and bool(cells[r * cols + c])


def room_guide(request: Json, workdir: Path) -> Json:
    """Guia raster da planta na grade declarada: piso claro, paredes escuras, rocha na cor-chave e portas marcadas."""
    recipe = recipe_of(request)
    pw, ph = recipe["pictureSize"]
    cw, ch = recipe["cellPx"]
    ox, oy = recipe["gridOrigin"]
    cols, rows = recipe["size"]
    cells = recipe["cells"]
    if len(cells) != cols * rows:
        raise PipelineError("invalid_request", f"Planta deve ter {cols * rows} células")
    colors = {k: (*hex_rgb(v), 255) for k, v in recipe["colors"].items()}
    img = Image.new("RGBA", (pw, ph), colors["rock"])
    draw = ImageDraw.Draw(img)
    projection = recipe["projection"]
    floor_count = 0

    def diamond(c: int, r: int) -> list[tuple[float, float]]:
        tx, ty = ox + (c - r) * cw / 2, oy + (c + r) * ch / 2
        return [(tx, ty), (tx + cw / 2, ty + ch / 2), (tx, ty + ch), (tx - cw / 2, ty + ch / 2)]

    for r in range(rows):
        for c in range(cols):
            if not _floor(cells, cols, rows, c, r):
                continue
            floor_count += 1
            if projection == "isometric":
                # Paredes N e W altas; S e E muretas baixas (schema: n/w tall, s/e low curbs).
                # Losango: d[0] topo, d[1] direita, d[2] base, d[3] esquerda; N = d0–d1, W = d3–d0.
                d = diamond(c, r)
                lift = 3 * ch
                if not _floor(cells, cols, rows, c, r - 1):
                    draw.polygon([d[0], d[1], (d[1][0], d[1][1] - lift), (d[0][0], d[0][1] - lift)], fill=colors["wall"])
                if not _floor(cells, cols, rows, c - 1, r):
                    draw.polygon([d[3], d[0], (d[0][0], d[0][1] - lift), (d[3][0], d[3][1] - lift)], fill=colors["wall"])
            else:
                x0, y0 = ox + c * cw, oy + r * ch
                wall_h = ch if projection == "top_down" else ch // 2
                if not _floor(cells, cols, rows, c, r - 1):
                    draw.rectangle([x0 - cw // 2, y0 - wall_h, x0 + cw + cw // 2 - 1, y0 - 1], fill=colors["wall"])
                for dc in (-1, 1):
                    if not _floor(cells, cols, rows, c + dc, r):
                        xs = x0 - cw // 2 if dc < 0 else x0 + cw
                        draw.rectangle([xs, y0 - (wall_h if projection == "oblique" else 0), xs + cw // 2 - 1, y0 + ch - 1], fill=colors["wall"])
                if not _floor(cells, cols, rows, c, r + 1):
                    draw.rectangle([x0 - cw // 2, y0 + ch, x0 + cw + cw // 2 - 1, y0 + ch + cw // 2 - 1], fill=colors["wall"])
    for r in range(rows):
        for c in range(cols):
            if _floor(cells, cols, rows, c, r):
                if projection == "isometric":
                    draw.polygon(diamond(c, r), fill=colors["floor"])
                else:
                    draw.rectangle([ox + c * cw, oy + r * ch, ox + (c + 1) * cw - 1, oy + (r + 1) * ch - 1], fill=colors["floor"])
    for door in recipe["doors"]:
        c, r = door["cell"]
        side = door["side"]
        tall = 2 if side in ("E", "W") else 1
        if projection == "isometric":
            d = diamond(c, r)
            edge = {"N": (d[0], d[1]), "W": (d[3], d[0]), "S": (d[2], d[3]), "E": (d[1], d[2])}[side]
            draw.line([edge[0], edge[1]], fill=colors["door"], width=max(2, ch // 3))
            continue
        x0, y0 = ox + c * cw, oy + r * ch
        thick = max(4, cw // 4)
        if side == "N":
            draw.rectangle([x0 + cw // 4, y0 - thick * 2, x0 + cw - cw // 4 - 1, y0 - 1], fill=colors["door"])
        elif side == "S":
            draw.rectangle([x0 + cw // 4, y0 + ch, x0 + cw - cw // 4 - 1, y0 + ch + thick - 1], fill=colors["door"])
        elif side == "W":
            draw.rectangle([x0 - thick, y0 + ch // 4, x0 - 1, y0 + tall * ch - ch // 4 - 1], fill=colors["door"])
        else:
            draw.rectangle([x0 + cw, y0 + ch // 4, x0 + cw + thick - 1, y0 + tall * ch - ch // 4 - 1], fill=colors["door"])
    report = {"pictureSize": [pw, ph], "floorCells": floor_count, "doors": len(recipe["doors"]), "projection": projection}
    return respond([write_png(workdir, img, "out/guide.png", "guide")], report)


def _mask_or_empty(path: Path | None, size: tuple[int, int], role: str) -> Image.Image:
    return binary_mask(path, size, role) if path else Image.new("L", size, 0)


def room_cutout(request: Json, workdir: Path) -> Json:
    """Peça pela máscara explícita, sombra separada estimada, máscara da área exposta e medidas do contorno."""
    recipe = recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    _, mask_path = input_by_role(request, workdir, "editMask")
    room = load_rgba(source_path)
    size = room.size
    alpha = room.getchannel("A")
    solid = alpha.point(lambda a: 255 if a >= recipe["alphaThreshold"] else 0)
    piece_mask = ImageChops.multiply(binary_mask(mask_path, size, "editMask"), solid)
    bbox = piece_mask.getbbox()
    if not bbox:
        raise PipelineError("geometry_mismatch", "Máscara da peça vazia (ou só sobre pixels transparentes): nada a recortar")
    shadow_path = optional_input(request, workdir, "removeMask")
    painted = alpha.point(lambda a: 255 if a > 0 else 0)
    shadow_mask = ImageChops.subtract(ImageChops.multiply(_mask_or_empty(shadow_path, size, "removeMask"), painted), piece_mask)

    piece = Image.new("RGBA", size, (0, 0, 0, 0))
    piece.paste(room, (0, 0), piece_mask)
    piece = piece.crop(bbox)
    outputs = [write_png(workdir, piece, "out/piece.png", "piece")]
    shadow_bbox = shadow_mask.getbbox()
    if shadow_bbox:
        # A pintura não separa a sombra do piso: sombra estimada (escura translúcida) na máscara revisada.
        shadow = Image.new("RGBA", size, (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 96), (0, 0), shadow_mask)
        outputs.append(write_png(workdir, shadow.crop(shadow_bbox), "out/shadow.png", "shadow"))

    union = ImageChops.lighter(piece_mask, shadow_mask)
    dilate = recipe["dilatePx"]
    area = union.filter(ImageFilter.MaxFilter(2 * dilate + 1)) if dilate else union
    area = ImageChops.multiply(area, painted)
    ring_px = recipe["contextRingPx"]
    ring = ImageChops.subtract(area.filter(ImageFilter.MaxFilter(2 * ring_px + 1)), area)
    ring_total = ring.histogram()[255]
    ring_opaque = ImageChops.multiply(ring, solid).histogram()[255]
    context_opaque = round(ring_opaque / ring_total, 4) if ring_total else 0.0
    outputs.append(write_png(workdir, area, "out/area-mask.png", "area_mask"))
    holed = room.copy()
    holed.putalpha(ImageChops.subtract(alpha, area))
    outputs.append(write_png(workdir, holed, "out/holed.png", "holed"))
    preview = room.copy()
    preview.paste(AREA_TINT, (0, 0), area)
    outputs.append(write_png(workdir, preview, "out/area-preview.png", "area_preview"))

    # Apoio sugerido: linha opaca mais baixa da peça e centro horizontal das 3 linhas de baixo.
    local = piece.getchannel("A")
    lw, lh = local.size
    lp = local.load()
    foot = max(y for y in range(lh) for x in range(lw) if lp[x, y] > 0)
    xs = [x for y in range(max(0, foot - 2), foot + 1) for x in range(lw) if lp[x, y] > 0]
    support = [math.floor(sum(xs) / len(xs) + 0.5), foot + 1] if xs else [lw // 2, lh]
    area_bbox = area.getbbox()
    report = {
        "roomSize": list(size),
        "pieceRect": [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]],
        "piecePixels": piece_mask.histogram()[255],
        "shadowRect": [shadow_bbox[0], shadow_bbox[1], shadow_bbox[2] - shadow_bbox[0], shadow_bbox[3] - shadow_bbox[1]] if shadow_bbox else None,
        "shadowOffset": [shadow_bbox[0] - bbox[0], shadow_bbox[1] - bbox[1]] if shadow_bbox else None,
        "shadowMethod": "estimated_dark_on_reviewed_mask" if shadow_bbox else None,
        "footY": foot,
        "suggestedSupport": support,
        "areaPixels": area.histogram()[255],
        "areaRect": [area_bbox[0], area_bbox[1], area_bbox[2] - area_bbox[0], area_bbox[3] - area_bbox[1]] if area_bbox else None,
        "contextOpaque": context_opaque,
        "needsReconstruction": context_opaque >= 0.25,
    }
    warnings = []
    if report["needsReconstruction"]:
        warnings.append(
            f"O contorno da peça é {context_opaque:.0%} piso/parede pintados: a área que ela cobria nunca foi pintada e precisa ser reconstruída por inpainting (apagar o alfa não basta)"
        )
    return respond(outputs, report, warnings)


def room_compose(request: Json, workdir: Path) -> Json:
    """Fundo da sala e itens (sombras e móveis já na ordem de desenho) com recorte nas bordas."""
    recipe = recipe_of(request)
    _, base_path = input_by_role(request, workdir, "source")
    found = inputs_by_ordinal(request, workdir, "layer")
    base = load_rgba(base_path)
    cw, ch = recipe["canvas"]
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    _place(canvas, base, 0, 0)
    cache: dict[int, Image.Image] = {}
    for n, item in enumerate(recipe["items"]):
        path = found.get(item["inputOrdinal"])
        if path is None:
            raise PipelineError("invalid_request", f"Item {n} cita entrada {item['inputOrdinal']} inexistente")
        img = cache.setdefault(item["inputOrdinal"], load_rgba(path))
        _place(canvas, img, item["at"][0], item["at"][1])
    zoom = recipe["zoom"]
    shown = _checker((cw * zoom, ch * zoom), 8 * zoom)
    shown.alpha_composite(_zoom(canvas, zoom))
    return respond([write_png(workdir, canvas, "out/room.png", "room"), write_png(workdir, shown, "out/room-zoom.png", "room_zoom")], {"canvas": [cw, ch], "items": len(recipe["items"])})


def scene_fit(request: Json, workdir: Path) -> Json:
    """Tamanho lógico sem faixas: recorte central na proporção do alvo e redução inteira ou por maioria do bloco."""
    recipe = recipe_of(request)
    tw, th = recipe["targetSize"]
    _, path = input_by_role(request, workdir, "source")
    img = load_rgba(path)
    w, h = img.size
    warnings: list[str] = []
    crop = [0, 0, w, h]
    if abs((w / h) / (tw / th) - 1) > 0.01:
        # Proporção diferente da pedida: recorta o centro (nunca estica nem põe faixas).
        if w / h > tw / th:
            cw = round(h * tw / th)
            crop = [(w - cw) // 2, 0, cw, h]
        else:
            ch = round(w * th / tw)
            crop = [0, (h - ch) // 2, w, ch]
        img = img.crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
        warnings.append(f"Resposta {w}×{h} em outra proporção: recorte central {crop[2]}×{crop[3]} antes de reduzir para {tw}×{th}; revise o enquadramento")
    sw, sh = img.size
    if (sw, sh) == (tw, th):
        out, method = img, "identity"
    elif sw % tw == 0 and sh % th == 0 and sw // tw == sh // th:
        k = sw // tw
        out = img.resize((tw, th), Image.Resampling.NEAREST)
        method = "nearest_integer"
        if out.resize((sw, sh), Image.Resampling.NEAREST).tobytes() != img.tobytes():
            out, method = _block_mode(img, (tw, th)), "block_mode"
            warnings.append(f"Imagem fora de uma grade exata de {k} px: cada pixel recebe a cor majoritária do bloco; revise")
    else:
        out, method = _block_mode(img, (tw, th)), "block_mode"
        warnings.append(f"Fator {sw / tw:.2f} não inteiro: cada pixel recebe a cor majoritária do seu bloco; contornos finos podem sumir — revise")
    threshold = recipe.get("alphaThreshold")
    if threshold is not None:
        out = out.copy()
        out.putalpha(out.getchannel("A").point(lambda a: 255 if a >= threshold else 0))
    report = {"sourceSize": [w, h], "cropRect": crop, "targetSize": [tw, th], "method": method}
    return respond([write_png(workdir, out, "out/fitted.png", "fitted")], report, warnings)
