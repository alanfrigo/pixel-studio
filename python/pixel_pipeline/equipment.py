"""Roupas e equipamentos (cartão S2, plan/04 §criar uma roupa; plan/05 §composição).

Quatro operações locais, determinísticas e sem rede:

- `equipment_compose`: compõe camadas já resolvidas (base, partes da peça e
  vistas rígidas) de trás para frente, com offsets inteiros e espelho
  autorizado; devolve uma prévia por frame e a folha achatada (frames lado a
  lado). Confere nos pixels se cada empunhadura caiu no socket esperado.
- `equipment_extract`: recupera a peça de um candidato vestido (guerreiro
  inteiro devolvido pela geração, clipe vestido ou imagem importada): registra
  o candidato contra a base limpa por deslocamento inteiro, e só DENTRO da zona
  autorizada de cada parte, fora das proteções (olhos, mãos), copia os pixels
  que diferem da base. Valida as bordas da zona e o que mudou fora dela.
- `equipment_guide`: referências da geração (frames da base em grade e a mesma
  grade com a zona autorizada pintada de cor chapada).
- `equipment_region_hashes`: hash RGBA canônico de regiões (digest de geometria).
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageOps

from pixel_pipeline.operations import hex_rgb, inputs_by_ordinal, load_rgba, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, rgba_sha256

Json = dict[str, Any]
Rect = list[int]


def _crop(image: Image.Image, rect: Rect, label: str) -> Image.Image:
    x, y, w, h = rect
    if x < 0 or y < 0 or x + w > image.width or y + h > image.height:
        raise PipelineError("geometry_mismatch", f"{label}: retângulo {rect} fora da imagem {image.width}×{image.height}")
    return image.crop((x, y, x + w, y + h))


def _place(canvas: Image.Image, image: Image.Image, x: int, y: int) -> dict[str, int]:
    """Cola com recorte nas bordas e devolve o quanto passou de cada lado (contorno cortado)."""
    over = {
        "left": max(0, -x),
        "top": max(0, -y),
        "right": max(0, x + image.width - canvas.width),
        "bottom": max(0, y + image.height - canvas.height),
    }
    left, top = over["left"], over["top"]
    right, bottom = image.width - over["right"], image.height - over["bottom"]
    if right > left and bottom > top:
        canvas.alpha_composite(image.crop((left, top, right, bottom)), dest=(max(0, x), max(0, y)))
    return over


def _load_inputs(request: Json, workdir: Path, role: str) -> dict[int, Image.Image]:
    return {ordinal: load_rgba(path) for ordinal, path in inputs_by_ordinal(request, workdir, role).items()}


# ---------------------------------------------------------------------------
# Compositor
# ---------------------------------------------------------------------------


def equipment_compose(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cw, ch = recipe["cell"]
    tolerance = int(recipe["tolerancePx"])
    images = _load_inputs(request, workdir, "layer")
    frames = recipe["frames"]
    sheet = Image.new("RGBA", (cw * len(frames), ch), (0, 0, 0, 0))
    outputs: list[Json] = []
    report_frames: list[Json] = []
    warnings: list[str] = []
    for index, frame in enumerate(frames):
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        placed: list[Json] = []
        grips: list[Json] = []
        for layer in frame["layers"]:
            source = images.get(layer["inputOrdinal"])
            if source is None:
                raise PipelineError("invalid_request", f"Camada {layer['key']} cita entrada {layer['inputOrdinal']} inexistente")
            image = _crop(source, layer["rect"], layer["key"])
            if layer["mirrored"]:
                image = ImageOps.mirror(image)
            ox, oy = layer["offset"]
            over = _place(canvas, image, ox, oy)
            clipped = any(over.values())
            placed.append({"key": layer["key"], "offset": [ox, oy], "size": [image.width, image.height], "overflow": over, "clipped": clipped})
            if clipped:
                warnings.append(f"{frame['frameId']}: contorno cortado em {layer['key']} ({', '.join(f'{k} {v} px' for k, v in over.items() if v)})")
            for grip in layer.get("grips") or []:
                gx, gy = grip["at"]
                if layer["mirrored"]:
                    gx = image.width - 1 - gx  # índice de pixel: W − 1 − x
                drawn = [ox + gx, oy + gy]
                ex, ey = grip["expected"]
                deviation = max(abs(drawn[0] - ex), abs(drawn[1] - ey))
                on_art = 0 <= gx < image.width and 0 <= gy < image.height and image.getpixel((gx, gy))[3] > 0
                grips.append({"key": layer["key"], "socketId": grip["socketId"], "drawnAt": drawn, "expected": [ex, ey], "deviation": deviation, "exceeds": deviation > tolerance, "onArt": on_art})
                if deviation > tolerance:
                    warnings.append(f"{frame['frameId']}: {grip['socketId']} a {deviation} px da empunhadura de {layer['key']} (tolerância {tolerance} px)")
        sheet.alpha_composite(canvas, dest=(index * cw, 0))
        out = write_png(workdir, canvas, f"out/frames/{index:02d}.png", "frame", key=frame["frameId"])
        outputs.append(out)
        report_frames.append({"frameId": frame["frameId"], "rgbaSha256": out["rgbaSha256"], "rect": [index * cw, 0, cw, ch], "layers": placed, "grips": grips})
    outputs.append(write_png(workdir, sheet, "out/sheet.png", "sheet"))
    return respond(outputs, {"cell": [cw, ch], "frames": report_frames, "sheetSize": [sheet.width, sheet.height]}, warnings)


# ---------------------------------------------------------------------------
# Extração de cobertura
# ---------------------------------------------------------------------------


def _mask_of(size: tuple[int, int], rects: list[Rect]) -> Image.Image:
    mask = Image.new("L", size, 0)
    for x, y, w, h in rects:
        mask.paste(255, (x, y, x + w, y + h))
    return mask


def _shifted(image: Image.Image, dx: int, dy: int) -> Image.Image:
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    _place(out, image, dx, dy)
    return out


def _same_mask(a: Image.Image, b: Image.Image, tolerance: int) -> Image.Image:
    """255 onde os dois pixels são "iguais": ambos transparentes, ou diferença ≤ tolerância nos 4 canais."""
    bands = ImageChops.difference(a, b).split()
    worst = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), ImageChops.lighter(bands[2], bands[3]))
    close = worst.point(lambda v: 255 if v <= tolerance else 0)
    both_clear = ImageChops.multiply(a.getchannel("A").point(lambda v: 255 if v == 0 else 0), b.getchannel("A").point(lambda v: 255 if v == 0 else 0))
    return ImageChops.lighter(close, both_clear)


def _count(mask: Image.Image) -> int:
    return mask.histogram()[255]


def _register(base: Image.Image, candidate: Image.Image, outside: Image.Image, tolerance: int, max_shift: int) -> tuple[int, int, float]:
    """Deslocamento inteiro que maximiza a concordância com a base FORA das zonas autorizadas."""
    relevant = ImageChops.multiply(outside, ImageChops.lighter(base.getchannel("A"), candidate.getchannel("A")).point(lambda v: 255 if v > 0 else 0))
    total = max(1, _count(relevant))
    best = (0, 0, -1.0)
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            moved = _shifted(candidate, dx, dy)
            score = _count(ImageChops.multiply(_same_mask(base, moved, tolerance), relevant)) / total
            better = score > best[2] + 1e-9 or (abs(score - best[2]) <= 1e-9 and abs(dx) + abs(dy) < abs(best[0]) + abs(best[1]))
            if better:
                best = (dx, dy, score)
    return best


def _components(mask: Image.Image, min_px: int) -> Image.Image:
    """Remove componentes (8-vizinhança) menores que `min_px`."""
    if min_px <= 1:
        return mask
    w, h = mask.size
    px = mask.load()
    seen = bytearray(w * h)
    out = Image.new("L", mask.size, 0)
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] != 255 or seen[y * w + x]:
                continue
            comp = []
            queue = deque([(x, y)])
            seen[y * w + x] = 1
            while queue:
                cx, cy = queue.popleft()
                comp.append((cx, cy))
                for nx in (cx - 1, cx, cx + 1):
                    for ny in (cy - 1, cy, cy + 1):
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] == 255:
                            seen[ny * w + nx] = 1
                            queue.append((nx, ny))
            if len(comp) >= min_px:
                for cx, cy in comp:
                    opx[cx, cy] = 255
    return out


def _fill_holes(changed: Image.Image, allowed: Image.Image) -> Image.Image:
    """Pixels autorizados iguais à base mas cercados pela peça (furos) entram na camada: peça sólida, não rendada."""
    w, h = changed.size
    cpx, apx = changed.load(), allowed.load()
    reach = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for y in range(h):
        for x in range(w):
            if apx[x, y] == 255 and cpx[x, y] != 255:
                border = x in (0, w - 1) or y in (0, h - 1) or any(apx[nx, ny] != 255 for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
                if border:
                    reach[y * w + x] = 1
                    queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not reach[ny * w + nx] and apx[nx, ny] == 255 and cpx[nx, ny] != 255:
                reach[ny * w + nx] = 1
                queue.append((nx, ny))
    out = changed.copy()
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if apx[x, y] == 255 and cpx[x, y] != 255 and not reach[y * w + x]:
                opx[x, y] = 255
    return out


def _edge_touches(layer_mask: Image.Image, zone: Image.Image, outside_changed: Image.Image) -> list[list[int]]:
    """Pixels da peça na borda da zona cujo vizinho FORA da zona também mudou: a peça continua além da zona."""
    w, h = layer_mask.size
    lpx, zpx, opx = layer_mask.load(), zone.load(), outside_changed.load()
    hits: list[list[int]] = []
    for y in range(h):
        for x in range(w):
            if lpx[x, y] != 255:
                continue
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and zpx[nx, ny] != 255 and opx[nx, ny] == 255:
                    hits.append([x, y])
                    break
    return hits


def _hue_near(image: Image.Image, rgb: tuple[int, int, int], hue_tol: int = 12, min_sat: int = 150, min_val: int = 140) -> Image.Image:
    """Máscara 255 dos pixels com o matiz da cor-chave, saturados e claros (só para chaves saturadas).

    O matiz do Pillow vai de 0 a 255 (12 ≈ 17°). Cores da arte longe da chave (pele,
    couro, azul da túnica) não passam: a chave é escolhida fora da paleta do estilo.
    """
    key = Image.new("RGB", (1, 1), rgb).convert("HSV").getpixel((0, 0))
    if key[1] < min_sat:
        return Image.new("L", image.size, 0)
    h, sat, val = image.convert("RGB").convert("HSV").split()
    dist = h.point(lambda v: min(abs(v - key[0]), 256 - abs(v - key[0])))
    hue_ok = dist.point(lambda v: 255 if v <= hue_tol else 0)
    sat_ok = sat.point(lambda v: 255 if v >= min_sat else 0)
    val_ok = val.point(lambda v: 255 if v >= min_val else 0)
    return ImageChops.multiply(ImageChops.multiply(hue_ok, sat_ok), val_ok)


def equipment_extract(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cw, ch = recipe["cell"]
    tolerance = int(recipe["tolerance"])
    threshold = int(recipe["alphaThreshold"])
    max_shift = int(recipe["maxShift"])
    min_px = int(recipe["minComponentPx"])
    bases = _load_inputs(request, workdir, "layer")
    candidates = _load_inputs(request, workdir, "candidate")
    outputs: list[Json] = []
    report: list[Json] = []
    warnings: list[str] = []
    for frame in recipe["frames"]:
        fid = frame["frameId"]
        base = bases.get(frame["baseOrdinal"])
        source = candidates.get(frame["candidateOrdinal"])
        if base is None or source is None:
            raise PipelineError("invalid_request", f"Frame {fid}: base ou candidato ausente")
        if base.size != (cw, ch):
            raise PipelineError("geometry_mismatch", f"Frame {fid}: base {base.width}×{base.height}, célula {cw}×{ch}")
        candidate = _crop(source, frame["candidateRect"], f"candidato de {fid}")
        if candidate.size != (cw, ch):
            raise PipelineError("geometry_mismatch", f"Frame {fid}: candidato fora da grade ({candidate.width}×{candidate.height}, célula {cw}×{ch})")
        # Alfa binário no candidato (pixel art): abaixo do limiar vira transparente.
        alpha = candidate.getchannel("A").point(lambda a: 255 if a >= threshold else 0)
        # Resíduo da cor-chave ou da cor da guia nunca é peça: vira transparente e é relatado.
        forbidden = 0
        for hexcolor in recipe.get("forbidColors") or []:
            r, g, b = hex_rgb(hexcolor)
            tol = int(recipe.get("forbidTolerance", 40))
            bands = ImageChops.difference(candidate.convert("RGB"), Image.new("RGB", candidate.size, (r, g, b))).split()
            near = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), bands[2]).point(lambda v: 255 if v <= tol else 0)
            # Bordas suavizadas do modelo escapam da distância por canal (ex.: 245,26,214 contra
            # a chave 255,0,255): também é resíduo o pixel saturado e claro com o matiz da chave.
            near = ImageChops.lighter(near, _hue_near(candidate, (r, g, b)))
            near = ImageChops.multiply(near, alpha)
            forbidden += _count(near)
            alpha = ImageChops.subtract(alpha, near)
        candidate = Image.composite(candidate, Image.new("RGBA", candidate.size, (0, 0, 0, 0)), alpha)
        candidate.putalpha(alpha)
        if forbidden:
            warnings.append(f"{fid}: {forbidden} px com a cor-chave ou da guia descartados do candidato")

        zones_all = _mask_of((cw, ch), [r for part in frame["parts"] for r in part["zones"]])
        protect = _mask_of((cw, ch), frame["protect"])
        outside = ImageChops.invert(zones_all)
        dx, dy, agreement = _register(base, candidate, outside, tolerance, max_shift)
        moved = _shifted(candidate, dx, dy)
        differs = ImageChops.invert(_same_mask(base, moved, tolerance))
        outside_changed = ImageChops.multiply(differs, outside)
        base_opaque = _count(base.getchannel("A").point(lambda v: 255 if v > 0 else 0))
        frame_report: Json = {
            "frameId": fid,
            "shift": [dx, dy],
            "agreementOutside": round(agreement, 4),
            "outsideChangedPixels": _count(outside_changed),
            "parts": [],
        }
        if dx or dy:
            warnings.append(f"{fid}: candidato realinhado em ({dx}, {dy}) px contra a base")
        if base_opaque and _count(outside_changed) > 0.05 * base_opaque:
            warnings.append(f"{fid}: o candidato mudou {_count(outside_changed)} px da base fora da zona; descartados (a base limpa prevalece)")
        claimed = Image.new("L", (cw, ch), 0)
        preview = base.copy()
        for part in frame["parts"]:
            pid = part["partId"]
            zone = _mask_of((cw, ch), part["zones"])
            # Zonas de partes diferentes não disputam pixel: a primeira parte da lista fica com a interseção.
            allowed = ImageChops.subtract(ImageChops.subtract(zone, protect), claimed)
            visible = moved.getchannel("A").point(lambda v: 255 if v > 0 else 0)
            changed = ImageChops.multiply(ImageChops.multiply(differs, allowed), visible)
            changed = _fill_holes(changed, ImageChops.multiply(allowed, visible))
            changed = _components(changed, min_px)
            erased = _count(ImageChops.multiply(ImageChops.multiply(allowed, base.getchannel("A").point(lambda v: 255 if v > 0 else 0)), ImageChops.invert(visible)))
            protected_changed = _count(ImageChops.multiply(ImageChops.multiply(zone, protect), differs))
            touches = _edge_touches(changed, zone, outside_changed)
            claimed = ImageChops.lighter(claimed, changed)
            layer = Image.composite(moved, Image.new("RGBA", (cw, ch), (0, 0, 0, 0)), changed)
            bbox = changed.getbbox()
            part_report: Json = {
                "partId": pid,
                "pixels": _count(changed),
                "empty": bbox is None,
                "erasedPixels": erased,
                "protectedKept": protected_changed,
                "edgeTouches": len(touches),
                "edgeSample": touches[:8],
            }
            if bbox is None:
                part_report.update(rect=None, offset=None)
                warnings.append(f"{fid}/{pid}: nada da peça dentro da zona; se a pose a encobre, marque a célula vazia")
            else:
                x0, y0, x1, y1 = bbox
                cropped = layer.crop(bbox)
                out = write_png(workdir, cropped, f"out/{fid}--{pid}.png", "layer", key=f"{fid}|{pid}")
                outputs.append(out)
                part_report.update(rect=[0, 0, x1 - x0, y1 - y0], offset=[x0, y0], sha256=out["sha256"], rgbaSha256=out["rgbaSha256"])
                preview.alpha_composite(cropped, dest=(x0, y0))
            if touches:
                warnings.append(f"{fid}/{pid}: a peça encosta na borda da zona em {len(touches)} px e continua fora dela (ex.: {touches[0]}); amplie a zona se ela foi cortada")
            if erased:
                warnings.append(f"{fid}/{pid}: o candidato apagou {erased} px da base dentro da zona; uma camada só acrescenta pixels, revise a silhueta")
            frame_report["parts"].append(part_report)
        outputs.append(write_png(workdir, preview, f"out/{fid}--preview.png", "preview", key=fid))
        outputs.append(write_png(workdir, moved, f"out/{fid}--candidate.png", "aligned", key=fid))
        report.append(frame_report)
    return respond(outputs, {"cell": [cw, ch], "frames": report}, warnings)


# ---------------------------------------------------------------------------
# Referências da geração
# ---------------------------------------------------------------------------


def equipment_guide(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cw, ch = recipe["cell"]
    gw, gh = recipe["canvas"]
    frames = recipe["frames"]
    bases = _load_inputs(request, workdir, "layer")
    flatten = recipe.get("flattenOnto")
    background = (*hex_rgb(flatten), 255) if flatten else (0, 0, 0, 0)
    grid = Image.new("RGBA", (gw, gh), background)
    zone = Image.new("L", grid.size, 0)
    for frame in frames:
        base = bases.get(frame["baseOrdinal"])
        if base is None or base.size != (cw, ch):
            raise PipelineError("geometry_mismatch", f"Frame {frame['frameId']}: base ausente ou fora da célula {cw}×{ch}")
        ox, oy = frame["at"]
        if ox < 0 or oy < 0 or ox + cw > gw or oy + ch > gh:
            raise PipelineError("geometry_mismatch", f"Frame {frame['frameId']}: célula em ({ox}, {oy}) fora da tela {gw}×{gh}")
        grid.alpha_composite(base, dest=(ox, oy))
        cell_zone = ImageChops.subtract(_mask_of((cw, ch), frame["zones"]), _mask_of((cw, ch), frame["protect"]))
        zone.paste(cell_zone, (ox, oy))
    k = int(recipe["scale"])
    size = (grid.width * k, grid.height * k)
    context = grid.resize(size, Image.Resampling.NEAREST)
    guide = context.copy()
    guide.paste((*hex_rgb(recipe["markColor"]), 255), (0, 0), zone.resize(size, Image.Resampling.NEAREST))
    report = {"scale": k, "size": list(size), "canvas": [gw, gh], "zonePixels": _count(zone), "markColor": recipe["markColor"]}
    return respond([write_png(workdir, context, "out/context.png", "context"), write_png(workdir, guide, "out/guide.png", "guide")], report)


def equipment_region_hashes(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    images = _load_inputs(request, workdir, "layer")
    hashes: dict[str, str] = {}
    boxes: dict[str, list[int] | None] = {}
    for region in recipe["regions"]:
        source = images.get(region["inputOrdinal"])
        if source is None:
            raise PipelineError("invalid_request", f"Região {region['key']} cita entrada {region['inputOrdinal']} inexistente")
        crop = _crop(source, region["rect"], region["key"])
        hashes[region["key"]] = rgba_sha256(crop)
        bbox = crop.getchannel("A").getbbox()
        boxes[region["key"]] = None if bbox is None else [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]]
    return respond([], {"hashes": hashes, "contentBoxes": boxes})
