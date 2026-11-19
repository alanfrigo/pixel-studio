"""Operações raster locais (plan/05 §receitas e decisões visuais).

Todas recebem entradas já normalizadas (PNG sRGB RGBA), validam geometria
antes de tocar em pixels, gravam PNG com parâmetros fixos (mesmos bytes +
mesma receita → mesmos bytes) e relatam medidas e alertas revisáveis.
"""

from __future__ import annotations

import math
from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops

from pixel_pipeline import PROTOCOL_VERSION
from pixel_pipeline.protocol import PipelineError, input_by_role, resolve_inside, rgba_sha256, sha256_file

Json = dict[str, Any]

# Limite de segurança para entradas já normalizadas (a ingestão aplica os limites do projeto).
Image.MAX_IMAGE_PIXELS = 8192 * 8192


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def recipe_of(request: Json) -> Json:
    recipe = request.get("recipe") or {}
    if recipe.get("version") != 1:
        raise PipelineError("invalid_request", "Receita exige version = 1")
    return recipe


def load_rgba(path: Path) -> Image.Image:
    try:
        with Image.open(path) as im:
            im.load()
            return im.convert("RGBA")
    except (OSError, SyntaxError, ValueError) as exc:
        raise PipelineError("decode_failed", f"Não foi possível ler {path.name}: {exc}") from exc


def optional_input(request: Json, workdir: Path, role: str) -> Path | None:
    matches = [i for i in request.get("inputs", []) if i.get("role") == role]
    if not matches:
        return None
    return input_by_role(request, workdir, role)[1]


def inputs_by_ordinal(request: Json, workdir: Path, role: str) -> dict[int, Path]:
    found: dict[int, Path] = {}
    for entry in request.get("inputs", []):
        if entry.get("role") == role:
            path = resolve_inside(workdir, entry.get("relPath", ""))
            if not path.is_file() or sha256_file(path) != entry.get("sha256"):
                raise PipelineError("invalid_request", f"Entrada {entry.get('relPath')} ausente ou com hash divergente")
            found[int(entry["ordinal"])] = path
    return found


def binary_mask(path: Path, size: tuple[int, int], role: str) -> Image.Image:
    """Máscara binária na grade da fonte: 255 = marcado, 0 = desmarcado; sem cinza nem alfa intermediário."""
    try:
        with Image.open(path) as im:
            im.load()
            mask = im.copy()
    except (OSError, SyntaxError, ValueError) as exc:
        raise PipelineError("decode_failed", f"{role} ilegível: {exc}") from exc
    if mask.size != size:
        raise PipelineError("geometry_mismatch", f"{role} tem {mask.size[0]}×{mask.size[1]}, a fonte tem {size[0]}×{size[1]}")
    if mask.mode in ("RGBA", "LA", "PA") or (mask.mode == "P" and "transparency" in mask.info):
        alpha = mask.convert("RGBA").getchannel("A")
        if alpha.getextrema() != (255, 255):
            raise PipelineError("invalid_request", f"{role} tem transparência; use preto e branco opacos")
    if mask.mode in ("RGB", "RGBA", "P"):
        rgb = mask.convert("RGB")
        r, g, b = rgb.split()
        if ImageChops.difference(r, g).getbbox() or ImageChops.difference(g, b).getbbox():
            raise PipelineError("invalid_request", f"{role} é colorida; use apenas preto (0) e branco (255)")
    gray = mask.convert("L")
    hist = gray.histogram()
    if sum(hist[1:255]) > 0:
        raise PipelineError("invalid_request", f"{role} tem cinza intermediário; a convenção é binária (0 ou 255)")
    return gray


def write_png(workdir: Path, image: Image.Image, rel_path: str, role: str, key: str | None = None) -> Json:
    target = resolve_inside(workdir, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Parâmetros fixos: a mesma imagem produz os mesmos bytes.
    image.save(target, format="PNG", compress_level=6, optimize=False)
    output: Json = {
        "role": role,
        "relPath": rel_path,
        "mime": "image/png",
        "width": image.width,
        "height": image.height,
        "sha256": sha256_file(target),
    }
    if image.mode == "RGBA":
        output["rgbaSha256"] = rgba_sha256(image)
    if key is not None:
        output["key"] = key
    return output


def respond(outputs: list[Json], report: Json, warnings: list[str] | None = None) -> Json:
    if warnings:
        return {"protocolVersion": PROTOCOL_VERSION, "status": "needs_review", "outputs": outputs, "report": report, "warnings": warnings}
    return {"protocolVersion": PROTOCOL_VERSION, "status": "ok", "outputs": outputs, "report": report}


def hex_rgb(value: str) -> tuple[int, int, int]:
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


# ---------------------------------------------------------------------------
# Fatiar folha em grade
# ---------------------------------------------------------------------------


def slice_grid(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    grid = recipe["grid"]
    _, source = input_by_role(request, workdir, "source")
    sheet = load_rgba(source)
    cols, rows = grid["columns"], grid["rows"]
    cw, ch = grid["cell"]
    mx, my = grid["margin"]
    sx, sy = grid["spacing"]
    expected = (2 * mx + cols * cw + (cols - 1) * sx, 2 * my + rows * ch + (rows - 1) * sy)
    if sheet.size != expected:
        raise PipelineError(
            "geometry_mismatch",
            f"Folha {sheet.width}×{sheet.height}; a grade declarada exige {expected[0]}×{expected[1]} "
            "(2×margem + colunas×célula + (colunas−1)×espaço)",
        )

    cells: list[tuple[int, int]] = (
        [(r, c) for r in range(rows) for c in range(cols)] if grid["traversal"] == "row_major" else [(r, c) for c in range(cols) for r in range(rows)]
    )
    frame_ids: list[str] = recipe["frameIds"]
    durations: list[int] = recipe["durationMs"]
    empty = set(recipe.get("emptyCells", []))
    if len(frame_ids) > len(cells) - len(empty & set(range(len(cells)))):
        raise PipelineError("geometry_mismatch", f"{len(frame_ids)} frames para {len(cells) - len(empty)} células disponíveis")

    alpha = sheet.getchannel("A")
    outputs: list[Json] = []
    frames: list[Json] = []
    warnings: list[str] = []
    empty_report: list[Json] = []
    k = 0
    for index, (r, c) in enumerate(cells):
        rect = [mx + c * (cw + sx), my + r * (ch + sy), cw, ch]
        box = (rect[0], rect[1], rect[0] + cw, rect[1] + ch)
        content = alpha.crop(box).getbbox()
        if index in empty:
            empty_report.append({"cell": index, "rect": rect, "transparent": content is None})
            if content is not None:
                warnings.append(f"Célula {index} declarada vazia tem conteúdo em ({rect[0] + content[0]}, {rect[1] + content[1]})")
            continue
        if k >= len(frame_ids):
            if content is not None:
                warnings.append(f"Célula {index} tem conteúdo mas não recebeu frame (sobra na grade)")
            continue
        frame_id = frame_ids[k]
        frame = sheet.crop(box)
        outputs.append(write_png(workdir, frame, f"out/frames/{k:03d}.png", "frame", key=frame_id))
        frames.append(
            {
                "frameId": frame_id,
                "durationMs": durations[k],
                "rect": rect,
                "contentBox": None if content is None else [content[0], content[1], content[2] - content[0], content[3] - content[1]],
            }
        )
        if content is None:
            warnings.append(f"Frame {frame_id} está vazio; declare a célula vazia se for intencional")
        k += 1

    # Conteúdo nas zonas de margem/espaçamento (ex.: lâmina que vazou da célula).
    outside = alpha.copy()
    for r in range(rows):
        for c in range(cols):
            x, y = mx + c * (cw + sx), my + r * (ch + sy)
            outside.paste(0, (x, y, x + cw, y + ch))
    stray: list[list[int]] = []
    if outside.getbbox():
        width = outside.width
        for i, a in enumerate(outside.tobytes()):
            if a:
                stray.append([i % width, i // width])
                if len(stray) >= 20:
                    break
        warnings.append(f"Conteúdo fora das células (margem/espaçamento) a partir de ({stray[0][0]}, {stray[0][1]}); amplie a célula ou corrija a folha")

    report = {"sheetSize": list(sheet.size), "cell": [cw, ch], "pivot": recipe["pivot"], "frames": frames, "emptyCells": empty_report, "strayPixels": stray}
    return respond(outputs, report, warnings)


# ---------------------------------------------------------------------------
# Fundo uniforme por preenchimento
# ---------------------------------------------------------------------------


def remove_background_flood(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    w, h = image.size
    keep_path = optional_input(request, workdir, "keepMask")
    remove_path = optional_input(request, workdir, "removeMask")
    keep = binary_mask(keep_path, image.size, "keepMask").tobytes() if keep_path else None
    remove = binary_mask(remove_path, image.size, "removeMask").tobytes() if remove_path else None

    raw = image.tobytes()
    cr, cg, cb = hex_rgb(recipe["color"])
    tol = recipe["tolerance"]
    match = recipe.get("match") or {"mode": "rgb"}
    hsv = image.convert("RGB").convert("HSV").tobytes() if match["mode"] == "hue" else b""
    key_hue = Image.new("RGB", (1, 1), (cr, cg, cb)).convert("HSV").getpixel((0, 0))[0]
    hue_tol = round(match.get("hueTolerance", 20) * 255 / 360)
    min_sat = match.get("minSaturation", 96)
    min_val = match.get("minValue", 100)
    measured_key = None
    pre_warnings: list[str] = []
    if match["mode"] == "hue" and match.get("keyFrom") == "border":
        # O modelo raramente obedece a cor pedida: mede a matiz real do fundo na borda.
        border = [i for i in range(w)] + [(h - 1) * w + i for i in range(w)] + [j * w for j in range(h)] + [j * w + w - 1 for j in range(h)]
        hues = sorted(hsv[i * 3] for i in border if raw[i * 4 + 3] and hsv[i * 3 + 1] >= min_sat)
        if hues:
            requested = round(key_hue * 360 / 255)
            key_hue = hues[len(hues) // 2]
            measured_key = round(key_hue * 360 / 255)
            if min(abs(measured_key - requested), 360 - abs(measured_key - requested)) > 40:
                pre_warnings.append(f"O fundo veio em outra cor (matiz {measured_key}°, pedido {requested}°); confira a remoção")

    def background(i: int) -> bool:
        o = i * 4
        if raw[o + 3] == 0:
            return True  # já transparente: atravessável
        if match["mode"] == "hue":
            # Mesma família de cor da chave, em qualquer brilho (pega a sombra), sem tocar cinzas e contornos escuros.
            h, sat, val = hsv[i * 3], hsv[i * 3 + 1], hsv[i * 3 + 2]
            dh = min(abs(h - key_hue), 256 - abs(h - key_hue))
            # Piso de brilho: contornos escuros puxados para a cor-chave ficam.
            return dh <= hue_tol and sat >= min_sat and val >= min_val
        return abs(raw[o] - cr) <= tol and abs(raw[o + 1] - cg) <= tol and abs(raw[o + 2] - cb) <= tol

    visited = bytearray(w * h)
    queue: deque[int] = deque()
    warnings: list[str] = pre_warnings

    def seed(i: int) -> bool:
        if visited[i] or (keep and keep[i]) or not background(i):
            return False
        visited[i] = 1
        queue.append(i)
        return True

    seeds = recipe["seeds"]
    if seeds["borders"]:
        for x in range(w):
            seed(x)
            seed((h - 1) * w + x)
        for y in range(h):
            seed(y * w)
            seed(y * w + w - 1)
    for x, y in seeds["points"]:
        if x >= w or y >= h:
            raise PipelineError("geometry_mismatch", f"Semente ({x}, {y}) fora da imagem {w}×{h}")
        if not seed(y * w + x) and not visited[y * w + x]:
            warnings.append(f"Semente ({x}, {y}) não tem a cor do fundo ou está protegida; ignorada")

    while queue:
        i = queue.popleft()
        x, y = i % w, i // w
        if x > 0:
            seed(i - 1)
        if x < w - 1:
            seed(i + 1)
        if y > 0:
            seed(i - w)
        if y < h - 1:
            seed(i + w)

    if match["mode"] == "hue" and match.get("cleanup", True):
        _cleanup_key(visited, keep, raw, hsv, w, h, key_hue, hue_tol, min_val)

    out = bytearray(raw)
    removed_mask = bytearray(w * h)
    removed = brush_removed = brush_kept = overlap = 0
    for i in range(w * h):
        by_brush = bool(remove and remove[i])
        kept = bool(keep and keep[i])
        if kept and by_brush:
            overlap += 1
        if kept:
            if raw[i * 4 + 3] and (visited[i] or by_brush):
                brush_kept += 1
            continue
        if visited[i] or by_brush:
            removed_mask[i] = 255
            if raw[i * 4 + 3]:
                removed += 1
                if by_brush and not visited[i]:
                    brush_removed += 1
            out[i * 4 + 3] = 0  # só alfa muda; RGB preservado
    if overlap:
        warnings.append(f"{overlap} pixels marcados nos dois pincéis; a proteção prevaleceu")

    cutout = Image.frombytes("RGBA", image.size, bytes(out))
    outputs = [
        write_png(workdir, cutout, "out/cutout.png", "cutout"),
        write_png(workdir, Image.frombytes("L", image.size, bytes(removed_mask)), "out/removed-mask.png", "removed_mask"),
    ]
    report = {"removedPixels": removed, "removedByBrush": brush_removed, "keptByBrush": brush_kept, "color": recipe["color"], "tolerance": tol, "match": match["mode"], "measuredKeyHue": measured_key}
    return respond(outputs, report, warnings)


def _cleanup_key(visited: bytearray, keep: bytes | None, raw: bytes, hsv: bytes, w: int, h: int, key_hue: int, hue_tol: int, min_val: int) -> None:
    """Remove a franja tingida pela cor-chave colada ao fundo e salpicos isolados.

    Franja: pixel com matiz da chave (saturação moderada, qualquer brilho)
    vizinho de fundo removido, até 2 passadas. Salpicos: componentes visíveis
    com menos de 0,5% da maior peça e no máximo 64 px.
    """
    def keyish(i: int) -> bool:
        dh = min(abs(hsv[i * 3] - key_hue), 256 - abs(hsv[i * 3] - key_hue))
        return dh <= hue_tol + 6 and hsv[i * 3 + 1] >= 48 and hsv[i * 3 + 2] >= min_val

    for _ in range(2):
        fringe = []
        for i in range(w * h):
            if visited[i] or (keep and keep[i]) or not keyish(i):
                continue
            x, y = i % w, i // w
            if (x > 0 and visited[i - 1]) or (x < w - 1 and visited[i + 1]) or (y > 0 and visited[i - w]) or (y < h - 1 and visited[i + w]):
                fringe.append(i)
        for i in fringe:
            visited[i] = 1
    # Componentes visíveis restantes.
    label = [0] * (w * h)
    sizes: list[int] = [0]
    for i in range(w * h):
        if visited[i] or label[i] or raw[i * 4 + 3] == 0:
            continue
        sizes.append(0)
        current = len(sizes) - 1
        stack = [i]
        label[i] = current
        while stack:
            j = stack.pop()
            sizes[current] += 1
            x, y = j % w, j // w
            for n in ((j - 1) if x > 0 else -1, (j + 1) if x < w - 1 else -1, (j - w) if y > 0 else -1, (j + w) if y < h - 1 else -1):
                if n >= 0 and not label[n] and not visited[n] and raw[n * 4 + 3]:
                    label[n] = current
                    stack.append(n)
    if len(sizes) <= 2:
        return
    largest = max(sizes)
    tiny = {c for c, size in enumerate(sizes) if c and size <= 64 and size < 0.005 * largest}
    for i in range(w * h):
        if label[i] in tiny and not (keep and keep[i]):
            visited[i] = 1


# ---------------------------------------------------------------------------
# Recorte justo, miniatura
# ---------------------------------------------------------------------------


def crop_to_content(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    threshold = recipe["alphaThreshold"]
    bbox = image.getchannel("A").point(lambda a: 255 if a > threshold else 0).getbbox()
    if bbox is None:
        raise PipelineError("unsupported_input", "Imagem sem conteúdo visível para recortar")
    pad = recipe["padding"]
    x0, y0, x1, y1 = bbox
    out = Image.new("RGBA", (x1 - x0 + 2 * pad, y1 - y0 + 2 * pad), (0, 0, 0, 0))
    # paste sem máscara copia os 4 bytes de cada pixel (alfa parcial intacto).
    out.paste(image.crop(bbox), (pad, pad))
    report = {
        "sourceRect": [x0, y0, x1 - x0, y1 - y0],
        "padding": pad,
        "outputSize": list(out.size),
        # Posição do canto da saída no canvas original (pode ser negativa com padding).
        "sourceOffset": [x0 - pad, y0 - pad],
        "originalSize": list(image.size),
    }
    return respond([write_png(workdir, out, "out/cropped.png", "cropped")], report)


def make_thumbnail(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    limit = recipe["maxSize"]
    longest = max(image.size)
    if longest <= limit:
        factor = max(1, limit // longest)
        size = (image.width * factor, image.height * factor)
        upscale = True
    else:
        factor = math.ceil(longest / limit)
        size = (max(1, image.width // factor), max(1, image.height // factor))
        upscale = False
    thumb = image.resize(size, Image.Resampling.NEAREST)
    flatten = recipe.get("flattenOnto")
    if flatten:
        # Referência com transparência vira objeto sobre a cor-chave pedida ao modelo.
        base = Image.new("RGBA", thumb.size, (*hex_rgb(flatten), 255))
        base.alpha_composite(thumb)
        thumb = base
    return respond([write_png(workdir, thumb, "out/thumbnail.png", "thumbnail")], {"factor": factor, "upscale": upscale, "size": list(size), "flattenedOnto": flatten})


# ---------------------------------------------------------------------------
# Paleta
# ---------------------------------------------------------------------------


def apply_palette(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    palette = [hex_rgb(c) for c in recipe["colors"]]
    data = bytearray(image.tobytes())
    cache: dict[tuple[int, int, int], int] = {}
    visible_colors: set[tuple[int, int, int]] = set()
    used: set[int] = set()
    changed = 0
    for o in range(0, len(data), 4):
        if data[o + 3] == 0:
            continue  # invisível: não conta nem muda
        rgb = (data[o], data[o + 1], data[o + 2])
        visible_colors.add(rgb)
        index = cache.get(rgb)
        if index is None:
            best = None
            for i, (pr, pg, pb) in enumerate(palette):
                d = (rgb[0] - pr) ** 2 + (rgb[1] - pg) ** 2 + (rgb[2] - pb) ** 2
                if best is None or d < best[0]:  # estrito: empate fica com o menor índice
                    best = (d, i)
            index = best[1]  # type: ignore[index]
            cache[rgb] = index
        used.add(index)
        target = palette[index]
        if rgb != target:
            changed += 1
            data[o], data[o + 1], data[o + 2] = target
    out = Image.frombytes("RGBA", image.size, bytes(data))
    off_palette = sorted("#%02x%02x%02x" % c for c in visible_colors if c not in palette)
    report = {
        "metric": recipe["metric"],
        "tieBreak": recipe["tieBreak"],
        "visibleColorsBefore": len(visible_colors),
        "offPaletteColors": off_palette[:64],
        "changedPixels": changed,
        "usedIndices": sorted(used),
    }
    return respond([write_png(workdir, out, "out/paletted.png", "paletted")], report)


# ---------------------------------------------------------------------------
# Composição e proteção exata
# ---------------------------------------------------------------------------


def compose_layers(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cw, ch = recipe["canvas"]
    layers = inputs_by_ordinal(request, workdir, "layer")
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    placed = []
    for n, layer in enumerate(recipe["layers"]):
        path = layers.get(layer["inputOrdinal"])
        if path is None:
            raise PipelineError("invalid_request", f"Camada {n} cita entrada {layer['inputOrdinal']} inexistente")
        image = load_rgba(path)
        ox, oy = layer["offset"]
        if ox < 0 or oy < 0 or ox + image.width > cw or oy + image.height > ch:
            raise PipelineError("geometry_mismatch", f"Camada {n} ({image.width}×{image.height} em {ox},{oy}) excede a tela {cw}×{ch}")
        canvas.alpha_composite(image, dest=(ox, oy))
        placed.append({"inputOrdinal": layer["inputOrdinal"], "offset": [ox, oy], "size": list(image.size)})
    return respond([write_png(workdir, canvas, "out/composite.png", "composite")], {"canvas": [cw, ch], "layers": placed})


def composite_protected(request: Json, workdir: Path) -> Json:
    """output[p] = candidate[p] onde editMask = 255; senão source[p] — os 4 bytes RGBA."""
    recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    _, candidate_path = input_by_role(request, workdir, "candidate")
    _, mask_path = input_by_role(request, workdir, "editMask")
    source = load_rgba(source_path)
    candidate = load_rgba(candidate_path)
    if candidate.size != source.size:
        raise PipelineError(
            "geometry_mismatch",
            f"Resposta fora da grade: candidato {candidate.width}×{candidate.height}, fonte {source.width}×{source.height}",
        )
    mask = binary_mask(mask_path, source.size, "editMask")
    edited = mask.histogram()[255]
    total = source.width * source.height
    # Com máscara binária, composite copia exatamente um dos dois pixels (inclusive RGB sob alfa 0).
    out = Image.composite(candidate, source, mask)
    protected_diff = ImageChops.difference(
        Image.composite(out, Image.new("RGBA", out.size, (0, 0, 0, 0)), ImageChops.invert(mask)),
        Image.composite(source, Image.new("RGBA", out.size, (0, 0, 0, 0)), ImageChops.invert(mask)),
    ).getbbox()
    if protected_diff is not None:
        raise PipelineError("internal", "Pixels protegidos divergem da fonte após a composição")
    protected = total - edited
    # Quanto o candidato respeitou a área protegida: candidato deslocado ou redesenhado deixa emenda na borda.
    agreement = None
    if protected > 0:
        bands = ImageChops.difference(candidate, source).split()
        worst = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), ImageChops.lighter(bands[2], bands[3]))
        close = ImageChops.multiply(worst.point(lambda v: 255 if v <= 32 else 0), ImageChops.invert(mask))
        agreement = close.histogram()[255] / protected
    report = {
        "editedPixels": edited,
        "protectedPixels": protected,
        "emptyMask": edited == 0,
        "fullMask": edited == total,
        "protectedDiffPixels": 0,
        "candidateAgreement": None if agreement is None else round(agreement, 4),
    }
    warnings = ["Máscara vazia: nenhuma região a editar; resultado idêntico à fonte"] if edited == 0 else []
    if agreement is not None and edited > 0 and agreement < 0.6:
        warnings.append(
            f"O candidato mudou a área protegida (só {agreement:.0%} coincide com a fonte): pode haver emenda na borda da máscara; revise"
        )
    return respond([write_png(workdir, out, "out/protected.png", "protected")], report, warnings)


def inspect_mask(request: Json, workdir: Path) -> Json:
    """Valida a máscara de edição na grade da fonte; conta a região editável e o retângulo que a contém."""
    recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    _, mask_path = input_by_role(request, workdir, "editMask")
    with Image.open(source_path) as im:
        size = im.size
    mask = binary_mask(mask_path, size, "editMask")
    edited = mask.histogram()[255]
    total = size[0] * size[1]
    bbox = mask.getbbox()
    report = {
        "size": list(size),
        "editedPixels": edited,
        "protectedPixels": total - edited,
        "emptyMask": edited == 0,
        "fullMask": edited == total,
        "editRect": [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]] if bbox else None,
    }
    return respond([], report)


def inpaint_guide(request: Json, workdir: Path) -> Json:
    """Contexto ampliado por fator inteiro e guia com a região editável pintada de cor chapada."""
    recipe = recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    _, mask_path = input_by_role(request, workdir, "editMask")
    source = load_rgba(source_path)
    mask = binary_mask(mask_path, source.size, "editMask")
    if recipe.get("flattenOnto"):
        flat = Image.new("RGBA", source.size, (*hex_rgb(recipe["flattenOnto"]), 255))
        flat.alpha_composite(source)
        source = flat
    k = recipe["scale"]
    size = (source.width * k, source.height * k)
    context = source.resize(size, Image.Resampling.NEAREST)
    guide = context.copy()
    guide.paste((*hex_rgb(recipe["markColor"]), 255), (0, 0), mask.resize(size, Image.Resampling.NEAREST))
    report = {"scale": k, "size": list(size), "editedPixels": mask.histogram()[255], "markColor": recipe["markColor"]}
    return respond([write_png(workdir, context, "out/context.png", "context"), write_png(workdir, guide, "out/guide.png", "guide")], report)


# ---------------------------------------------------------------------------
# Escala lógica
# ---------------------------------------------------------------------------


def _block_mode(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Redução sem cores novas: cada pixel de saída é a cor mais frequente do seu bloco de origem."""
    w, h = image.size
    tw, th = size
    px = image.load()
    out = Image.new("RGBA", size)
    opx = out.load()
    for j in range(th):
        y0, y1 = int(j * h / th), max(int(j * h / th) + 1, int((j + 1) * h / th))
        for i in range(tw):
            x0, x1 = int(i * w / tw), max(int(i * w / tw) + 1, int((i + 1) * w / tw))
            votes: dict[tuple, int] = {}
            for y in range(y0, y1):
                for x in range(x0, x1):
                    c = px[x, y]
                    c = (0, 0, 0, 0) if c[3] == 0 else c
                    votes[c] = votes.get(c, 0) + 1
            opx[i, j] = max(votes.items(), key=lambda kv: kv[1])[0]
    return out


def fit_logical(request: Json, workdir: Path) -> Json:
    """Leva a imagem ao tamanho lógico preservando proporção, centralizada sobre transparente.

    Fator inteiro usa vizinho mais próximo (centro de cada bloco) e confere se a
    imagem estava de fato numa grade desse fator (ida e volta sem perda). Fator
    não inteiro reduz por média e sempre pede revisão.
    """
    recipe = recipe_of(request)
    tw, th = recipe["targetSize"]
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    warnings: list[str] = []
    threshold = recipe.get("alphaThreshold")
    binarized = 0
    if threshold is not None:
        alpha = image.getchannel("A")
        binarized = sum(alpha.histogram()[1:255])
        keep = alpha.point(lambda a: 255 if a >= threshold else 0)
        image = Image.composite(image, Image.new("RGBA", image.size, (0, 0, 0, 0)), keep)
        image.putalpha(keep)
    crop = recipe.get("cropToContent")
    cropped_from = None
    if crop is not None:
        # Objeto isolado (ícone): leva o conteúdo visível ao tamanho lógico, não o canvas inteiro.
        bbox = image.getchannel("A").point(lambda a: 255 if a > 0 else 0).getbbox()
        if bbox is None:
            raise PipelineError("unsupported_input", "Nada visível depois da remoção do fundo")
        pad = crop["padding"]
        content = image.crop(bbox)
        cropped_from = [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]]
        side_w = max(content.width + 2 * pad, 1)
        side_h = max(content.height + 2 * pad, 1)
        if side_w <= tw and side_h <= th:
            # Já cabe: só ampliação inteira (nunca fracionária, que mistura tamanhos de pixel).
            k = min(tw // side_w, th // side_h)
            scaled = content.resize((content.width * k, content.height * k), Image.Resampling.NEAREST) if k > 1 else content
            out = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
            offset = ((tw - scaled.width) // 2, (th - scaled.height) // 2)
            out.paste(scaled, offset)
            if max(side_w * k / tw, side_h * k / th) < 0.75:
                warnings.append(f"O objeto ocupa {scaled.width}×{scaled.height} de {tw}×{th}: o modelo desenhou com menos células que o tamanho pedido")
            report = {
                "sourceSize": list(image.size), "targetSize": [tw, th], "factor": 1 / k, "method": "nearest_upscale" if k > 1 else "center",
                "lossless": True, "fittedSize": list(scaled.size), "offset": list(offset), "contentRect": cropped_from, "alphaBinarized": binarized,
            }
            return respond([write_png(workdir, out, "out/fitted.png", "fitted")], report, warnings)
        # Maior que o alvo: canvas com a proporção do alvo, conteúdo centralizado, depois reduz.
        scale = max(side_w / tw, side_h / th)
        canvas = Image.new("RGBA", (max(1, round(tw * scale)), max(1, round(th * scale))), (0, 0, 0, 0))
        canvas.paste(content, ((canvas.width - content.width) // 2, (canvas.height - content.height) // 2))
        image = canvas
    w, h = image.size
    if recipe.get("exactAspect") and abs((w / h) / (tw / th) - 1) > 0.01:
        raise PipelineError("geometry_mismatch", f"Resposta fora da grade: candidato {w}×{h} não tem a proporção da fonte {tw}×{th}")
    factor = max(w / tw, h / th)
    fitted_size = (max(1, round(w / factor)), max(1, round(h / factor)))
    if recipe.get("exactAspect"):
        fitted_size = (tw, th)  # dentro da tolerância: grade exata da fonte
    integer = factor >= 1 and float(factor).is_integer() and w % int(factor) == 0 and h % int(factor) == 0
    if (w, h) == (tw, th):
        fitted, method, lossless = image, "identity", True
    elif integer:
        k = int(factor)
        fitted = image.resize(fitted_size, Image.Resampling.NEAREST)
        lossless = fitted.resize((w, h), Image.Resampling.NEAREST).tobytes() == image.tobytes()
        method = "nearest_integer"
        if not lossless and recipe.get("exactAspect"):
            # Candidato de modelo fora da grade exata: a cor majoritária do bloco resiste ao ruído do centro.
            fitted, method = _block_mode(image, fitted_size), "block_mode"
            warnings.append(f"O candidato não está numa grade exata de {k} px: cada pixel recebe a cor majoritária do seu bloco; revise")
        elif not lossless:
            warnings.append(f"A imagem não está numa grade de {k} px: a redução {k}× amostrou pixels e descartou detalhe; revise o resultado")
    elif factor < 1 and float(1 / factor).is_integer():
        fitted, method, lossless = image.resize(fitted_size, Image.Resampling.NEAREST), "nearest_upscale", True
    else:
        fitted = _block_mode(image, fitted_size)
        method, lossless = "block_mode", False
        warnings.append(f"Fator {factor:.2f} não inteiro: cada pixel recebe a cor majoritária do seu bloco; contornos finos podem sumir — revise")
    out = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    offset = ((tw - fitted.width) // 2, (th - fitted.height) // 2)
    out.paste(fitted, offset)
    if fitted.size != (tw, th):
        warnings.append(f"Proporção diferente do tamanho lógico: {fitted.width}×{fitted.height} centralizado em {tw}×{th}")
    if threshold is not None:
        # A redução por maioria pode reintroduzir alfa parcial; mantém binário.
        out.putalpha(out.getchannel("A").point(lambda a: 255 if a >= threshold else 0))
    report = {"sourceSize": [w, h], "targetSize": [tw, th], "factor": factor, "method": method, "lossless": lossless, "fittedSize": list(fitted.size), "offset": list(offset), "contentRect": cropped_from}
    if threshold is not None:
        report["alphaBinarized"] = binarized
    return respond([write_png(workdir, out, "out/fitted.png", "fitted")], report, warnings)


def encode_mask(request: Json, workdir: Path) -> Json:
    """Máscara local binária → codificação do provedor, sem inferir inversão nem escala."""
    recipe = recipe_of(request)
    _, mask_path = input_by_role(request, workdir, "editMask")
    with Image.open(mask_path) as im:
        size = im.size
    mask = binary_mask(mask_path, size, "editMask")
    if recipe["encoding"] == "alpha_zero_edits":
        out = Image.new("RGBA", size, (0, 0, 0, 255))
        out.putalpha(ImageChops.invert(mask))  # alfa 0 onde E = 255
    else:
        out = mask.convert("RGB")
    report = {"encoding": recipe["encoding"], "editedPixels": mask.histogram()[255], "size": list(size)}
    return respond([write_png(workdir, out, "out/remote-mask.png", "remote_mask")], report)


# ---------------------------------------------------------------------------
# Grade aparente (unzoom local) e fundo por matiz
# ---------------------------------------------------------------------------

EDGE_THRESHOLD = 24


def _edge_profile(image: Image.Image, axis: str) -> list[int]:
    """Fração (0–255) de linhas/colunas com troca de cor em cada fronteira entre pixels vizinhos."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    if axis == "x":
        a, b = rgb.crop((1, 0, w, h)), rgb.crop((0, 0, w - 1, h))
    else:
        a, b = rgb.crop((0, 1, w, h)), rgb.crop((0, 0, w, h - 1))
    r, g, bl = ImageChops.difference(a, b).split()
    edges = ImageChops.lighter(ImageChops.lighter(r, g), bl).point(lambda v: 255 if v > EDGE_THRESHOLD else 0)
    size = (edges.width, 1) if axis == "x" else (1, edges.height)
    return list(edges.resize(size, Image.Resampling.BOX).tobytes())


def _peaks(profile: list[int], fraction: float) -> list[int]:
    """Fronteiras fortes, com supressão de vizinhos: borda suavizada em 2–3 colunas conta uma vez."""
    if not profile or max(profile) < 8:
        return []
    threshold = max(8, max(profile) * fraction)
    candidates = sorted((v, i + 1) for i, v in enumerate(profile) if v >= threshold)
    accepted: list[int] = []
    for _, pos in reversed(candidates):
        if all(abs(pos - a) > 3 for a in accepted):
            accepted.append(pos)
    return sorted(accepted)


def _period_candidates(profile: list[int]) -> list[float]:
    """Períodos que explicam ≥ 75% dos intervalos entre fronteiras fortes (maiores primeiro)."""
    found: set[float] = set()
    for fraction in (0.2, 0.35, 0.5):
        peaks = _peaks(profile, fraction)
        gaps = [b - a for a, b in zip(peaks, peaks[1:])]
        if len(gaps) < 3:
            continue
        for s in sorted({g / k for g in gaps for k in range(1, 7) if g / k >= 4}, reverse=True):
            tolerance = max(1.5, 0.08 * s)
            fits = [g for g in gaps if round(g / s) >= 1 and abs(g - round(g / s) * s) <= tolerance]
            if len(fits) >= 0.75 * len(gaps):
                found.add(round(sum(fits) / sum(round(g / s) for g in fits), 3))
    return sorted(found, reverse=True)


def _phase(peaks: list[int], s: float) -> float:
    """Deslocamento da grade (média circular dos resíduos das fronteiras); 0 quando alinhada à borda."""
    import math

    if not peaks:
        return 0.0
    angles = [2 * math.pi * (p % s) / s for p in peaks]
    phase = (math.atan2(sum(math.sin(a) for a in angles), sum(math.cos(a) for a in angles)) % (2 * math.pi)) * s / (2 * math.pi)
    return 0.0 if min(phase, s - phase) < 1.0 else phase


def _content_span(image: Image.Image, ignore: Image.Image | None) -> int:
    """Lado maior, em px de origem, do objeto: alfa > 0 fora da máscara de fundo."""
    mask = image.getchannel("A").point(lambda a: 255 if a > 0 else 0)
    if ignore is not None:
        mask = ImageChops.multiply(mask, ImageChops.invert(ignore))
    bbox = mask.getbbox()
    return max(bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else max(image.size)


def detect_grid(image: Image.Image, min_agreement: float = 0.9, ignore: Image.Image | None = None, min_content_cells: int | None = None) -> Json | None:
    """Maior célula (quadrada, possivelmente fracionária) cuja grade reproduz a imagem.

    Candidatos vêm dos intervalos entre fronteiras fortes nos dois eixos; cada um
    é validado amostrando o centro das células e comparando com a imagem. Indo
    do maior para o menor, o primeiro aprovado evita tanto múltiplos (perdem
    detalhe e falham na concordância) quanto divisores (mais caros, mesma arte).
    Áreas chapadas grandes podem aprovar uma célula grossa demais; com
    `min_content_cells`, ela só vale se nenhuma mais fina também for aprovada.
    """
    profile_x, profile_y = _edge_profile(image, "x"), _edge_profile(image, "y")
    candidates = sorted(set(_period_candidates(profile_x) + _period_candidates(profile_y)), reverse=True)
    peaks_x, peaks_y = _peaks(profile_x, 0.35), _peaks(profile_y, 0.35)
    w, h = image.size
    span = _content_span(image, ignore) if min_content_cells else 0
    coarse: Json | None = None
    tried: list[Json] = []
    for s in candidates[:24]:
        ox, oy = _phase(peaks_x, s), _phase(peaks_y, s)
        if ox == 0 and oy == 0:
            cols, rows = round(w / s), round(h / s)
            cell = [w / max(cols, 1), h / max(rows, 1)]
        else:
            # Grade deslocada: células inteiras a partir da fase; sobras parciais nas bordas ficam de fora.
            cols, rows = int((w - ox) // s), int((h - oy) // s)
            cell = [s, s]
        if cols < 2 or rows < 2 or cols > w // 4 or rows > h // 4:
            continue
        grid = {"cell": cell, "grid": [cols, rows], "offset": [ox, oy]}
        native = _sample_native(image, grid)
        agreement = _agreement(image, native, ignore, grid)
        entry: Json = {"cell": round(w / cols, 2), "agreement": round(agreement, 4)}
        tried.append(entry)
        if agreement >= min_agreement:
            if min_content_cells and span / cell[0] < min_content_cells:
                entry["coarse"] = True  # objeto ficaria com poucas células; procura uma grade mais fina
                coarse = coarse or {**grid, "native": native, "agreement": agreement}
                continue
            return {**grid, "native": native, "agreement": agreement, "tried": tried}
    if coarse is not None:
        return {**coarse, "tried": tried, "coarseOnly": True}
    return {"native": None, "tried": tried} if tried else None


def _key_mask(image: Image.Image, hue_tolerance: float, min_saturation: int, min_value: int) -> tuple[Image.Image, int] | None:
    """Máscara (L, 255 = fundo) dos pixels na família de cor da borda; vetorizada no Pillow."""
    hsv = image.convert("RGB").convert("HSV")
    h, sat, val = hsv.split()
    w, hh = image.size
    border = [h.getpixel((x, 0)) for x in range(w)] + [h.getpixel((x, hh - 1)) for x in range(w)] + [h.getpixel((0, y)) for y in range(hh)] + [h.getpixel((w - 1, y)) for y in range(hh)]
    border_sat = [sat.getpixel((x, 0)) for x in range(w)] + [sat.getpixel((x, hh - 1)) for x in range(w)] + [sat.getpixel((0, y)) for y in range(hh)] + [sat.getpixel((w - 1, y)) for y in range(hh)]
    hues = sorted(v for v, s_ in zip(border, border_sat) if s_ >= min_saturation)
    if len(hues) < len(border) * 0.5:
        return None  # borda sem cor-chave dominante
    key = hues[len(hues) // 2]
    tol = round(hue_tolerance * 255 / 360)
    hue_ok = h.point(lambda v: 255 if min(abs(v - key), 256 - abs(v - key)) <= tol else 0)
    sat_ok = sat.point(lambda v: 255 if v >= min_saturation else 0)
    val_ok = val.point(lambda v: 255 if v >= min_value else 0)
    return ImageChops.multiply(ImageChops.multiply(hue_ok, sat_ok), val_ok), round(key * 360 / 255)


def _sample_native(image: Image.Image, grid: Json) -> Image.Image:
    cols, rows = grid["grid"]
    cw, ch = grid["cell"]
    ox, oy = grid.get("offset", [0, 0])
    px = image.load()
    out = Image.new("RGBA", (cols, rows))
    opx = out.load()
    for j in range(rows):
        for i in range(cols):
            cx = min(image.width - 1, int(ox + (i + 0.5) * cw))
            cy = min(image.height - 1, int(oy + (j + 0.5) * ch))
            # Moda de uma janela 3×3 no centro da célula: resiste a ruído de compressão.
            votes: dict[tuple, int] = {}
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    x, y = min(image.width - 1, max(0, cx + dx)), min(image.height - 1, max(0, cy + dy))
                    votes[px[x, y]] = votes.get(px[x, y], 0) + 1
            opx[i, j] = max(votes.items(), key=lambda kv: kv[1])[0]
    return out


def _agreement(image: Image.Image, native: Image.Image, ignore: Image.Image | None = None, grid: Json | None = None) -> float:
    """Fração dos pixels que a grade reproduz; com `ignore`, só sobre o objeto (fora do fundo)."""
    if grid and any(grid.get("offset", [0, 0])):
        ox, oy = grid["offset"]
        box = (int(round(ox)), int(round(oy)), int(round(ox + grid["grid"][0] * grid["cell"][0])), int(round(oy + grid["grid"][1] * grid["cell"][1])))
        image = image.crop(box)
        ignore = ignore.crop(box) if ignore is not None else None
    back = native.resize(image.size, Image.Resampling.NEAREST).convert("RGB")
    r, g, b = ImageChops.difference(back, image.convert("RGB")).split()
    bad = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > EDGE_THRESHOLD * 2 else 0)
    if ignore is None:
        return 1 - bad.histogram()[255] / (image.width * image.height)
    considered = ImageChops.invert(ignore)
    total = considered.histogram()[255]
    if total == 0:
        return 0.0
    return 1 - ImageChops.multiply(bad, considered).histogram()[255] / total


def unzoom(request: Json, workdir: Path) -> Json:
    """Recupera a arte na resolução da sua própria grade (célula pode ser fracionária, ex.: 36,6 px)."""
    recipe = recipe_of(request)
    _, source = input_by_role(request, workdir, "source")
    image = load_rgba(source)
    ignore_key = recipe.get("ignoreKeyHue")
    key = _key_mask(image, ignore_key["hueTolerance"], ignore_key["minSaturation"], ignore_key.get("minValue", 100)) if ignore_key else None
    found = detect_grid(image, recipe["minAgreement"], key[0] if key else None, recipe.get("minContentCells"))
    if not found or found.get("native") is None:
        report = {"detected": False, "cell": [1, 1], "grid": list(image.size), "agreement": 1.0, "tried": (found or {}).get("tried", [])}
        warnings = ["Nenhuma grade de pixel art reconhecida; imagem mantida sem redução"] if found else []
        return respond([write_png(workdir, image, "out/native.png", "native")], report, warnings)
    report = {
        "detected": True,
        "agreementOver": "object" if key else "image",
        "cell": [round(c, 3) for c in found["cell"]],
        "grid": found["grid"],
        "offset": [round(o, 2) for o in found.get("offset", [0, 0])],
        "agreement": round(found["agreement"], 4),
        "tried": found["tried"],
    }
    warnings = []
    if found.get("coarseOnly"):
        warnings.append(f"Só uma grade grossa ({report['cell'][0]} px) reproduz a imagem: o objeto fica com menos de {recipe['minContentCells']} células — revise o resultado")
    return respond([write_png(workdir, found["native"], "out/native.png", "native")], report, warnings)
