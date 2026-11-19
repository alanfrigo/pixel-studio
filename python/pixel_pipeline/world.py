"""Mundo (cartão T1): emendas de textura, gabaritos de tileset e losangos isométricos.

Operações locais e determinísticas (plan/06 §repetição verificável, §como
gerar e validar um autotile, §payload isométrico). Medem e desenham; não
inventam conteúdo. Mesmas entradas + mesma receita → mesmos bytes.
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from pixel_pipeline.i18n import tx
from pixel_pipeline.operations import inputs_by_ordinal, load_rgba, optional_input, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, Text, input_by_role

Json = dict[str, Any]
Rgba = tuple[int, int, int, int]

SEAM_LINE = (0, 220, 255, 255)
FLAG = (255, 0, 200, 255)
GAP = (230, 40, 40, 255)

# Bits do terreno B por canto (06 §autotile): NO=1, NE=2, SE=4, SO=8.
NW, NE, SE, SW = 1, 2, 4, 8


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def _canon(p: Rgba) -> Rgba:
    """RGB oculto sob alfa zero não conta (06 §verificações de emenda)."""
    return (0, 0, 0, 0) if p[3] == 0 else p


def _dist(a: Rgba, b: Rgba) -> float:
    a, b = _canon(a), _canon(b)
    return (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2]) + abs(a[3] - b[3])) / 4


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _p90(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(math.ceil(0.9 * len(ordered))) - 1)]


def _r(v: float) -> float:
    return round(v, 3)


def _hash01(*parts: object) -> float:
    """Ruído determinístico em [-1, 1] a partir de uma chave (sem depender de random)."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:4], "big") / 0xFFFFFFFF * 2 - 1


def _smooth_noise_1d(seed: int, key: str, length: int, t_index: float, spacing: float = 4.0) -> float:
    """Ruído de valor 1D com nós a cada `spacing` px, interpolado (contínuo ao longo do lado)."""
    pos = t_index / spacing
    i0 = math.floor(pos)
    f = pos - i0
    f = f * f * (3 - 2 * f)
    a = _hash01(seed, key, i0)
    b = _hash01(seed, key, i0 + 1)
    return a + (b - a) * f


def _smooth_noise_2d(seed: int, key: str, x: float, y: float, spacing: float = 5.0) -> float:
    gx, gy = x / spacing, y / spacing
    x0, y0 = math.floor(gx), math.floor(gy)
    fx, fy = gx - x0, gy - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    n00 = _hash01(seed, key, x0, y0)
    n10 = _hash01(seed, key, x0 + 1, y0)
    n01 = _hash01(seed, key, x0, y0 + 1)
    n11 = _hash01(seed, key, x0 + 1, y0 + 1)
    top = n00 + (n10 - n00) * fx
    bottom = n01 + (n11 - n01) * fx
    return top + (bottom - top) * fy


def _layers(request: Json, workdir: Path, needed: int) -> list[Image.Image]:
    found = inputs_by_ordinal(request, workdir, "layer")
    if len(found) < needed:
        raise PipelineError("invalid_request", tx(f"Operação exige {needed} entrada(s) com papel 'layer'", f"Operation requires {needed} input(s) with role 'layer'"))
    return [load_rgba(found[k]) for k in sorted(found)]


def _crop(image: Image.Image, rect: list[int]) -> Image.Image:
    x, y, w, h = rect
    if x + w > image.width or y + h > image.height:
        raise PipelineError("geometry_mismatch", tx(f"Retângulo [{x}, {y}, {w}, {h}] excede {image.width}×{image.height}", f"Rectangle [{x}, {y}, {w}, {h}] exceeds {image.width}×{image.height}"))
    return image.crop((x, y, x + w, y + h))


def _zoom(image: Image.Image, k: int) -> Image.Image:
    return image.resize((image.width * k, image.height * k), Image.Resampling.NEAREST) if k > 1 else image.copy()


def _checker(size: tuple[int, int], cell: int = 8) -> Image.Image:
    bg = Image.new("RGBA", size, (200, 200, 200, 255))
    draw = ImageDraw.Draw(bg)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(160, 160, 160, 255))
    return bg


def _runs(indices: list[int], values: list[float]) -> list[Json]:
    """Índices marcados → trechos contíguos com o pior valor."""
    runs: list[Json] = []
    for i in indices:
        if runs and runs[-1]["end"] == i - 1:
            runs[-1]["end"] = i
            runs[-1]["maxDelta"] = max(runs[-1]["maxDelta"], _r(values[i]))
        else:
            runs.append({"start": i, "end": i, "maxDelta": _r(values[i])})
    return runs


# ---------------------------------------------------------------------------
# Textura repetível
# ---------------------------------------------------------------------------


def _mean_color(pixels: list[Rgba]) -> tuple[float, float, float, float]:
    canon = [_canon(p) for p in pixels]
    n = len(canon)
    return tuple(sum(c[i] for c in canon) / n for i in range(4))  # type: ignore[return-value]


def _axis_seams(px, w: int, h: int, axis: str, threshold: float, material_problems: list[Text]) -> Json:
    """Junção das bordas opostas (coluna W−1 com 0, ou linha H−1 com 0) × vizinhos internos.

    Dois testes, ambos com o limiar declarado do material:
    - pixel a pixel: diferença média e p90 na junção × entre vizinhos internos;
    - perfil: cor média de cada coluna (eixo x) ou linha (eixo y). Uma borda
      discrepante ou um degradê de luz mudam a média da linha inteira, mesmo
      quando o ruído do material esconde a diferença pixel a pixel.
    """
    if axis == "x":
        seam = [_dist(px[w - 1, y], px[0, y]) for y in range(h)]
        interior = [_dist(px[x, y], px[x + 1, y]) for y in range(h) for x in range(w - 1)]
        profile = [_mean_color([px[x, y] for y in range(h)]) for x in range(w)]
    else:
        seam = [_dist(px[x, h - 1], px[x, 0]) for x in range(w)]
        interior = [_dist(px[x, y], px[x, y + 1]) for x in range(w) for y in range(h - 1)]
        profile = [_mean_color([px[x, y] for x in range(w)]) for y in range(h)]
    seam_mean, interior_mean = _mean(seam), _mean(interior)
    seam_p90, interior_p90 = _p90(seam), _p90(interior)
    ratio = seam_mean / max(interior_mean, 1.0)
    limit = threshold * max(interior_p90, 1.0)
    flagged = [i for i, d in enumerate(seam) if d > limit]

    pdist = lambda a, b: sum(abs(a[i] - b[i]) for i in range(4)) / 4  # noqa: E731
    profile_deltas = [pdist(profile[i], profile[i + 1]) for i in range(len(profile) - 1)]
    profile_seam = pdist(profile[-1], profile[0])
    profile_limit = threshold * max(_p90(profile_deltas), 2.0)
    profile_ok = profile_seam <= profile_limit

    runs = _runs(flagged, seam)
    if not profile_ok:
        # A emenda inteira destoa na média (borda discrepante, degradê): destaca a junção toda.
        runs = [{"start": 0, "end": len(seam) - 1, "maxDelta": _r(max(seam))}]
    passed = ratio <= threshold and seam_p90 <= limit and profile_ok and not material_problems
    return {
        "seamDelta": _r(seam_mean),
        "interiorDelta": _r(interior_mean),
        "ratio": _r(ratio),
        "seamP90": _r(seam_p90),
        "interiorP90": _r(interior_p90),
        "pixelLimit": _r(limit),
        "profileSeamDelta": _r(profile_seam),
        "profileLimit": _r(profile_limit),
        "profilePassed": profile_ok,
        "passed": passed,
        "flagged": runs,
        "flaggedPixels": len(flagged),
    }


def _material_problems(image: Image.Image) -> tuple[list[Text], Json]:
    """Material vai de borda a borda: transparência ou imagem chapada não demonstram repetição."""
    alpha = image.getchannel("A").histogram()
    total = image.width * image.height
    opaque = sum(alpha[250:]) / total
    colors = len({_canon(p) for p in image.get_flattened_data()})
    problems: list[Text] = []
    if opaque < 0.99:
        problems.append(tx(f"Material com transparência: só {opaque:.0%} dos pixels são opacos", f"Material has transparency: only {opaque:.0%} of the pixels are opaque"))
    if colors <= 2:
        problems.append(tx(f"Material chapado ({colors} cor(es)): a repetição é trivial e não demonstra emenda", f"Flat material ({colors} color(s)): repetition is trivial and does not prove the seam"))
    return problems, {"opaqueFraction": round(opaque, 4), "distinctColors": colors}


def texture_seams(request: Json, workdir: Path) -> Json:
    """Mede a emenda por eixo pedido e desenha o mosaico (3 cópias por eixo pedido) em 1× e ampliado com linhas."""
    recipe = recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    image = load_rgba(source_path)
    w, h = image.size
    if w < 2 or h < 2:
        raise PipelineError("unsupported_input", tx("Textura precisa de ao menos 2×2 px", "Texture must be at least 2×2 px"))
    axes = recipe["axes"]
    if not axes["x"] and not axes["y"]:
        raise PipelineError("invalid_request", tx("Informe ao menos um eixo de repetição", "Specify at least one repeat axis"))
    threshold = float(recipe["threshold"])
    px = image.load()
    problems, material = _material_problems(image)
    report: Json = {"size": [w, h], "threshold": threshold, "method": "rgba_mean_ratio_p90_profile_v2", "material": {**material, "problems": problems}}
    for axis in ("x", "y"):
        report[axis] = _axis_seams(px, w, h, axis, threshold, problems) if axes[axis] else None
    cols = 3 if axes["x"] else 1
    rows = 3 if axes["y"] else 1
    report["mosaicGrid"] = [cols, rows]

    mosaic = Image.new("RGBA", (w * cols, h * rows), (0, 0, 0, 0))
    for j in range(rows):
        for i in range(cols):
            mosaic.paste(image, (i * w, j * h))
    k = int(recipe["zoom"])
    lines = _checker(mosaic.size, 4)
    lines.alpha_composite(mosaic)
    lines = _zoom(lines, k)
    draw = ImageDraw.Draw(lines)
    for i in range(1, cols):
        x = i * w * k
        draw.line([(x, 0), (x, lines.height - 1)], fill=SEAM_LINE, width=1)
        # Trechos discrepantes da junção vertical (eixo x) em destaque.
        for run in (report["x"] or {}).get("flagged", []):
            for j in range(rows):
                y0 = (j * h + run["start"]) * k
                y1 = (j * h + run["end"] + 1) * k - 1
                draw.rectangle([x - 2, y0, x + 1, y1], fill=FLAG)
    for j in range(1, rows):
        y = j * h * k
        draw.line([(0, y), (lines.width - 1, y)], fill=SEAM_LINE, width=1)
        for run in (report["y"] or {}).get("flagged", []):
            for i in range(cols):
                x0 = (i * w + run["start"]) * k
                x1 = (i * w + run["end"] + 1) * k - 1
                draw.rectangle([x0, y - 2, x1, y + 1], fill=FLAG)

    # Bancada: deslocamento cíclico de meio período traz as emendas para o centro.
    dx = w // 2 if axes["x"] else 0
    dy = h // 2 if axes["y"] else 0
    shifted = Image.new("RGBA", (w, h))
    for y in range(h):
        for x in range(w):
            shifted.putpixel(((x + dx) % w, (y + dy) % h), px[x, y])
    report["shift"] = [dx, dy]
    passed_axes = [a for a in ("x", "y") if report[a] is not None and report[a]["passed"]]
    failed_axes = [a for a in ("x", "y") if report[a] is not None and not report[a]["passed"]]
    report["passedAxes"] = passed_axes
    warnings = [
        *problems,
        *(
            tx(
                f"Emenda discrepante no eixo {a}: candidata não é repetível nesse eixo; revise ou corrija por inpainting",
                f"Seam mismatch on axis {a}: the candidate does not repeat on that axis; review it or fix it with inpainting",
            )
            for a in failed_axes
        ),
    ]
    outputs = [
        write_png(workdir, mosaic, "out/mosaic.png", "mosaic"),
        write_png(workdir, lines, "out/mosaic-lines.png", "mosaic_lines"),
        write_png(workdir, shifted, "out/shifted.png", "shifted"),
    ]
    return respond(outputs, report, warnings)


# ---------------------------------------------------------------------------
# Gabaritos por cantos (16 máscaras)
# ---------------------------------------------------------------------------


def _corner_bits(mask: int) -> tuple[int, int, int, int]:
    return (1 if mask & NW else 0, 1 if mask & NE else 0, 1 if mask & SE else 0, 1 if mask & SW else 0)


def _edge_value(seed: int, axis: str, a: int, b: int, index: int, length: int) -> float:
    """Perfil do lado: só depende do eixo, dos dois terrenos ordenados no lado e da posição.

    Lados horizontais são lidos da esquerda para a direita e verticais de cima para baixo,
    inclusive na célula vizinha; por isso os dois tiles que dividem o lado concordam.
    """
    t = (index + 0.5) / length
    base = (1 - t) * a + t * b
    if a == b:
        return float(a)
    return base + 0.18 * _smooth_noise_1d(seed, f"{axis}{a}{b}", length, index)


def _corner_material(mask: int, x: int, y: int, w: int, h: int, band: int, seed: int, diagonals: Json) -> int:
    c_nw, c_ne, c_se, c_sw = _corner_bits(mask)
    cx, cy = x + 0.5, y + 0.5
    dl, dr, dt, db = cx, w - cx, cy, h - cy
    near_l, near_r, near_t, near_b = dl < band, dr < band, dt < band, db < band
    if (near_l or near_r) and (near_t or near_b):
        # Canto: o mesmo terreno para os quatro tiles que dividem o vértice.
        return c_nw if near_t and near_l else c_ne if near_t else c_sw if near_l else c_se
    edges = [
        (dt, lambda: _edge_value(seed, "h", c_nw, c_ne, x, w)),
        (db, lambda: _edge_value(seed, "h", c_sw, c_se, x, w)),
        (dl, lambda: _edge_value(seed, "v", c_nw, c_sw, y, h)),
        (dr, lambda: _edge_value(seed, "v", c_ne, c_se, y, h)),
    ]
    dmin, edge_fn = min(edges, key=lambda e: e[0])
    edge = edge_fn()
    if dmin < band:
        return 1 if edge > 0.5 else 0
    u, v = cx / w, cy / h
    f = (1 - u) * (1 - v) * c_nw + u * (1 - v) * c_ne + u * v * c_se + (1 - u) * v * c_sw
    if mask in (5, 10):
        connected = diagonals["mask5" if mask == 5 else "mask10"] == "connected"
        f += (0.35 if connected else -0.35) * 16 * u * (1 - u) * v * (1 - v)
    if 0 < mask < 15:
        f += 0.14 * _smooth_noise_2d(seed, f"i{mask}", x, y)
    weight = min(1.0, (dmin - band) / max(1.0, band))
    value = weight * f + (1 - weight) * edge
    return 1 if value > 0.5 else 0


def _mix(a: Rgba, b: Rgba, t: float) -> Rgba:
    return (round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t), round(a[2] + (b[2] - a[2]) * t), 255)


def corner_guides(request: Json, workdir: Path) -> Json:
    """Atlas 4×4 das 16 máscaras compondo A e B com gabaritos de lado comuns (não é geração nativa)."""
    recipe = recipe_of(request)
    tex_a, tex_b = _layers(request, workdir, 2)[:2]
    w, h = recipe["cellSize"]
    band = int(recipe["bandPx"])
    if 2 * band >= min(w, h):
        raise PipelineError("invalid_request", tx(f"Faixa de {band} px grande demais para a célula {w}×{h}", f"{band} px band too large for the {w}×{h} cell"))
    seed = int(recipe["seed"])
    diagonals = recipe["diagonals"]
    pa, pb = tex_a.load(), tex_b.load()
    atlas = Image.new("RGBA", (w * 4, h * 4))
    terrain = Image.new("RGBA", (w * 4, h * 4))
    out, tout = atlas.load(), terrain.load()
    tiles: list[Json] = []
    corners_ok = True
    for mask in range(16):
        ox, oy = (mask % 4) * w, (mask // 4) * h
        grid = [[_corner_material(mask, x, y, w, h, band, seed, diagonals) for x in range(w)] for y in range(h)]
        b_pixels = 0
        for y in range(h):
            for x in range(w):
                m = grid[y][x]
                b_pixels += m
                a_col = _canon(pa[x % tex_a.width, y % tex_a.height])
                b_col = _canon(pb[x % tex_b.width, y % tex_b.height])
                color = b_col if m else a_col
                # Margem: pixel de B encostado em A (dentro do tile) recebe a mistura dos dois.
                neighbors = [grid[yy][xx] for xx, yy in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)) if 0 <= xx < w and 0 <= yy < h]
                shore = m == 1 and any(n == 0 for n in neighbors)
                if shore:
                    color = _mix(b_col, a_col, 0.5)
                out[ox + x, oy + y] = color
                tout[ox + x, oy + y] = (60, 110, 220, 255) if m else (90, 170, 70, 255)
                if shore:
                    tout[ox + x, oy + y] = (230, 230, 230, 255)
        bits = _corner_bits(mask)
        corner_px = (grid[0][0], grid[0][w - 1], grid[h - 1][w - 1], grid[h - 1][0])
        if corner_px != bits:
            corners_ok = False
        tiles.append({"mask": mask, "rect": [ox, oy, w, h], "bPixels": b_pixels})
    warnings: list[Text] = []
    for name, tex in (("A", tex_a), ("B", tex_b)):
        if tex.size != (w, h):
            warnings.append(tx(f"Textura {name} tem {tex.width}×{tex.height}, a célula {w}×{h}: a continuidade entre tiles depende da textura repetir nesse período", f"Texture {name} is {tex.width}×{tex.height}, the cell {w}×{h}: continuity between tiles depends on the texture repeating at that period"))
    report = {"cellSize": [w, h], "bandPx": band, "seed": seed, "diagonals": diagonals, "tiles": tiles, "cornerAgreement": corners_ok, "method": "corner_template_v1"}
    if not corners_ok:
        raise PipelineError("internal", tx("Os gabaritos não concordam no pixel de canto", "The templates disagree on the corner pixel"))
    return respond(
        [write_png(workdir, atlas, "out/atlas.png", "atlas"), write_png(workdir, terrain, "out/terrain.png", "terrain")],
        report,
        warnings,
    )


# ---------------------------------------------------------------------------
# Tabela lateral (plataformas)
# ---------------------------------------------------------------------------

SIDE_EXPOSURE: dict[str, str] = {
    "surface_middle": "T",
    "surface_left": "TL",
    "surface_right": "TR",
    "surface_single": "TLR",
    "interior": "",
    "wall_left": "L",
    "wall_right": "R",
    "column_middle": "LR",
    "ceiling_middle": "B",
    "ceiling_left": "BL",
    "ceiling_right": "BR",
    "column_bottom": "BLR",
    "thin_middle": "TB",
    "thin_left": "TBL",
    "thin_right": "TBR",
    "block_single": "TBLR",
    "inner_corner_left": "i",
    "inner_corner_right": "j",
}


def _shade(c: Rgba, f: float) -> Rgba:
    return (round(c[0] * f), round(c[1] * f), round(c[2] * f), c[3])


def _side_tile(config: str, body: Image.Image, surface: Image.Image, w: int, h: int, depth: int) -> Image.Image:
    exp = SIDE_EXPOSURE[config]
    tile = Image.new("RGBA", (w, h))
    out = tile.load()
    pb, ps = body.load(), surface.load()
    for y in range(h):
        for x in range(w):
            c = _canon(pb[x % body.width, y % body.height])
            if "T" in exp and y < depth:
                c = _canon(ps[x % surface.width, y % surface.height])
                if y == 0:
                    c = _shade(c, 1.2) if c[3] else c
            if "L" in exp and x < 2:
                c = _shade(c, 0.55 if x == 0 else 0.75)
            if "R" in exp and x >= w - 2:
                c = _shade(c, 0.55 if x == w - 1 else 0.75)
            if "B" in exp and y >= h - 2:
                c = _shade(c, 0.5 if y == h - 1 else 0.7)
            if exp == "i" and x < 2 and y < depth:
                c = _shade(c, 0.55 if x == 0 else 0.75)
            if exp == "j" and x >= w - 2 and y < depth:
                c = _shade(c, 0.55 if x == w - 1 else 0.75)
            out[x, y] = (min(255, c[0]), min(255, c[1]), min(255, c[2]), c[3])
    # Cantos arredondados expostos ficam transparentes (ar), sem RGB escondido.
    for cx, cy, need in ((0, 0, "TL"), (w - 1, 0, "TR"), (0, h - 1, "BL"), (w - 1, h - 1, "BR")):
        if all(ch in exp for ch in need):
            out[cx, cy] = (0, 0, 0, 0)
    return tile


def side_guides(request: Json, workdir: Path) -> Json:
    """Atlas da tabela lateral: corpo + superfície por faces expostas (tabela própria, sem bits de canto)."""
    recipe = recipe_of(request)
    body, surface = _layers(request, workdir, 2)[:2]
    w, h = recipe["cellSize"]
    depth = int(recipe["surfaceDepthPx"])
    if depth >= h:
        raise PipelineError("invalid_request", tx("Superfície mais funda que a célula", "Surface deeper than the cell"))
    configs = recipe["configurations"]
    cols = int(recipe["columns"])
    rows = math.ceil(len(configs) / cols)
    atlas = Image.new("RGBA", (w * cols, h * rows), (0, 0, 0, 0))
    tiles = []
    for i, config in enumerate(configs):
        if config not in SIDE_EXPOSURE:
            raise PipelineError("invalid_request", tx(f"Configuração lateral desconhecida: {config}", f"Unknown side configuration: {config}"))
        ox, oy = (i % cols) * w, (i // cols) * h
        atlas.paste(_side_tile(config, body, surface, w, h, depth), (ox, oy))
        tiles.append({"configuration": config, "rect": [ox, oy, w, h], "exposed": SIDE_EXPOSURE[config]})
    report = {"cellSize": [w, h], "surfaceDepthPx": depth, "walkableLineY": 0, "tiles": tiles, "method": "side_template_v1"}
    return respond([write_png(workdir, atlas, "out/atlas.png", "atlas")], report)


# ---------------------------------------------------------------------------
# Emendas do tileset e amostra montada
# ---------------------------------------------------------------------------


def _tile_interior(px, w: int, h: int) -> float:
    diffs = [_dist(px[x, y], px[x + 1, y]) for y in range(h) for x in range(w - 1)]
    diffs += [_dist(px[x, y], px[x, y + 1]) for x in range(w) for y in range(h - 1)]
    return _mean(diffs)


def _pair_seam(left, right, w: int, h: int, axis: str) -> float:
    if axis == "x":
        return _mean([_dist(left[w - 1, y], right[0, y]) for y in range(h)])
    return _mean([_dist(left[x, h - 1], right[x, 0]) for x in range(w)])


def _corner_pairs(tiles: list[Json]) -> list[tuple[str, Json, Json]]:
    """Pares compatíveis: lado comum com os mesmos terrenos (64 por eixo com um tile por máscara)."""
    pairs = []
    for a in tiles:
        for b in tiles:
            ma, mb = a["mask"], b["mask"]
            # Horizontal: NE/SE de A = NO/SO de B.
            if bool(ma & NE) == bool(mb & NW) and bool(ma & SE) == bool(mb & SW):
                pairs.append(("x", a, b))
            # Vertical: SO/SE de A (em cima) = NO/NE de B.
            if bool(ma & SW) == bool(mb & NW) and bool(ma & SE) == bool(mb & NE):
                pairs.append(("y", a, b))
    return pairs


def _frame_ratio(px, x0: int, y0: int, w: int, h: int, band: int) -> float:
    """Linha `band − 1` (última da faixa, ou a borda do tile com band = 1) × linha `band`, por lado,
    contra a variação entre linhas paralelas mais para dentro (média da linha: o ruído some)."""
    trim = max(band, 1)

    def line(side: str, depth: int) -> tuple[float, float, float, float]:
        if side in ("top", "bottom"):
            y = depth if side == "top" else h - 1 - depth
            return _mean_color([px[x0 + x, y0 + y] for x in range(trim, w - trim)])
        x = depth if side == "left" else w - 1 - depth
        return _mean_color([px[x0 + x, y0 + y] for y in range(trim, h - trim)])

    pdist = lambda a, b: sum(abs(a[i] - b[i]) for i in range(4)) / 4  # noqa: E731
    worst = 0.0
    for side in ("top", "bottom", "left", "right"):
        span = (h if side in ("top", "bottom") else w) // 2
        inner = [line(side, d) for d in range(band, span)]
        if len(inner) < 3:
            continue
        ref = max(_p90([pdist(inner[i], inner[i + 1]) for i in range(len(inner) - 1)]), 2.0)
        worst = max(worst, pdist(line(side, band - 1), inner[0]) / ref)
    return worst


def tileset_seams(request: Json, workdir: Path) -> Json:
    """Emendas de todos os pares compatíveis (cantos) ou vizinhos da amostra (lateral), borda travada e amostra."""
    recipe = recipe_of(request)
    _, atlas_path = input_by_role(request, workdir, "source")
    atlas = load_rgba(atlas_path)
    w, h = recipe["cellSize"]
    threshold = float(recipe["threshold"])
    tiles: list[Json] = recipe["tiles"]
    crops: dict[str, Image.Image] = {}
    for t in tiles:
        if t["rect"][2] != w or t["rect"][3] != h:
            raise PipelineError("geometry_mismatch", tx(f"Tile {t['key']} não tem o tamanho da célula", f"Tile {t['key']} does not have the cell size"))
        crops[t["key"]] = _crop(atlas, t["rect"])
    loaded = {k: im.load() for k, im in crops.items()}
    interior = {k: _tile_interior(loaded[k], w, h) for k in crops}
    report: Json = {"layout": recipe["layout"], "cellSize": [w, h], "threshold": threshold, "method": "pair_seam_ratio_v1"}

    sample_w, sample_h = recipe["sample"]["size"]
    cells: list[str] = recipe["sample"]["cells"]
    if len(cells) != sample_w * sample_h:
        raise PipelineError("invalid_request", tx("Amostra com número de células diferente do tamanho", "Sample cell count differs from its size"))

    if recipe["layout"] == "corner":
        pairs = _corner_pairs([t for t in tiles if "mask" in t])
        present = {t["mask"] for t in tiles if "mask" in t}
        report["missingMasks"] = [m for m in range(16) if m not in present]
    else:
        seen = set()
        pairs = []
        by_key = {t["key"]: t for t in tiles}
        for j in range(sample_h):
            for i in range(sample_w):
                k = cells[j * sample_w + i]
                if k not in by_key:
                    continue
                for axis, ni, nj in (("x", i + 1, j), ("y", i, j + 1)):
                    if ni < sample_w and nj < sample_h:
                        nk = cells[nj * sample_w + ni]
                        if nk in by_key and (axis, k, nk) not in seen:
                            seen.add((axis, k, nk))
                            pairs.append((axis, by_key[k], by_key[nk]))
        report["gaps"] = sorted({c[1:] for c in cells if c.startswith("!")})

    flagged = []
    measured = []
    for axis, a, b in pairs:
        seam = _pair_seam(loaded[a["key"]], loaded[b["key"]], w, h, axis)
        ref = max(1.0, (interior[a["key"]] + interior[b["key"]]) / 2)
        ratio = seam / ref
        item = {"axis": axis, "a": a["key"], "b": b["key"], "seamDelta": _r(seam), "interiorDelta": _r(ref), "ratio": _r(ratio)}
        measured.append(item)
        if ratio > threshold:
            flagged.append(item)
    report["pairs"] = {"x": sum(1 for p in pairs if p[0] == "x"), "y": sum(1 for p in pairs if p[0] == "y")}
    # Linha de borda: a linha externa de cada tile × a seguinte. Um sulco claro/escuro dos dois
    # lados da emenda é contínuo (o par passa) mas desenha a grade no mosaico.
    atlas_px = atlas.load()
    edge = {t["key"]: _r(_frame_ratio(atlas_px, t["rect"][0], t["rect"][1], w, h, 1)) for t in tiles}
    report["edgeLines"] = {"flagged": sorted(k for k, v in edge.items() if v > threshold), "maxRatio": max(edge.values(), default=0.0), "tiles": edge}
    report["flagged"] = sorted(flagged, key=lambda f: -f["ratio"])
    report["worst"] = sorted(measured, key=lambda f: -f["ratio"])[:8]
    report["maxRatio"] = max((m["ratio"] for m in measured), default=0.0)

    band = int(recipe["lockedBandPx"])
    guide_path = optional_input(request, workdir, "layer")
    if band > 0 and guide_path is not None:
        guide = load_rgba(guide_path)
        if guide.size != atlas.size:
            raise PipelineError("geometry_mismatch", tx("Gabarito e atlas com tamanhos diferentes", "Template and atlas have different sizes"))
        gp = guide.load()
        ap = atlas.load()
        locked = []
        for t in tiles:
            x0, y0, tw, th = t["rect"]
            diff = 0
            for y in range(th):
                for x in range(tw):
                    if x < band or y < band or x >= tw - band or y >= th - band:
                        if _canon(ap[x0 + x, y0 + y]) != _canon(gp[x0 + x, y0 + y]):
                            diff += 1
            # Moldura: cor média da última linha da faixa travada × primeira linha do miolo, em cada
            # lado, contra a variação entre linhas paralelas mais para dentro. Se o modelo pintou o
            # miolo com outro acabamento, a faixa vira um quadro visível: as emendas entre tiles
            # continuam perfeitas, mas o mosaico mostra a grade.
            frame_ratio = _frame_ratio(ap, x0, y0, tw, th, band)
            locked.append({"key": t["key"], "bandDiffPixels": diff, "frameRatio": _r(frame_ratio)})
        frames = [item for item in locked if item["frameRatio"] > threshold]
        report["locked"] = {
            "bandPx": band,
            "tiles": locked,
            "passed": all(item["bandDiffPixels"] == 0 for item in locked),
            "frameFlagged": [item["key"] for item in frames],
            "maxFrameRatio": max((item["frameRatio"] for item in locked), default=0.0),
        }
    else:
        report["locked"] = None

    # Amostra montada pelas chaves (lago com ilha, canal, diagonais / plataforma, vão, degrau).
    sample = Image.new("RGBA", (sample_w * w, sample_h * h), (0, 0, 0, 0))
    for j in range(sample_h):
        for i in range(sample_w):
            k = cells[j * sample_w + i]
            if k in crops:
                sample.paste(crops[k], (i * w, j * h))
    k = int(recipe["zoom"])
    zoomed = _checker(sample.size, 4)
    zoomed.alpha_composite(sample)
    zoomed = _zoom(zoomed, k)
    draw = ImageDraw.Draw(zoomed)
    for j in range(sample_h):
        for i in range(sample_w):
            key = cells[j * sample_w + i]
            if key.startswith("!"):
                x0, y0 = i * w * k, j * h * k
                draw.rectangle([x0, y0, x0 + w * k - 1, y0 + h * k - 1], outline=GAP, width=max(1, k))
                draw.line([(x0, y0), (x0 + w * k - 1, y0 + h * k - 1)], fill=GAP, width=max(1, k))
    flagged_keys = {(f["axis"], f["a"], f["b"]) for f in flagged}
    for j in range(sample_h):
        for i in range(sample_w):
            a = cells[j * sample_w + i]
            if i + 1 < sample_w and ("x", a, cells[j * sample_w + i + 1]) in flagged_keys:
                x = (i + 1) * w * k
                draw.rectangle([x - 2, j * h * k, x + 1, (j + 1) * h * k - 1], fill=FLAG)
            if j + 1 < sample_h and ("y", a, cells[(j + 1) * sample_w + i]) in flagged_keys:
                y = (j + 1) * h * k
                draw.rectangle([i * w * k, y - 2, (i + 1) * w * k - 1, y + 1], fill=FLAG)
    outputs = [write_png(workdir, sample, "out/sample.png", "sample"), write_png(workdir, zoomed, "out/sample-zoom.png", "sample_zoom")]

    # Folha dos piores pares, lado a lado e ampliados.
    worst = report["worst"]
    if worst:
        cell_w = (2 * w) * k
        cell_h = (2 * h) * k
        sheet = Image.new("RGBA", (len(worst) * (cell_w + 4 * k), cell_h), (32, 32, 40, 255))
        for n, item in enumerate(worst):
            pair = Image.new("RGBA", (2 * w, 2 * h), (0, 0, 0, 0))
            pair.paste(crops[item["a"]], (0, 0))
            pair.paste(crops[item["b"]], (w, 0) if item["axis"] == "x" else (0, h))
            pz = _zoom(pair, k)
            if item in flagged:
                d = ImageDraw.Draw(pz)
                if item["axis"] == "x":
                    d.rectangle([w * k - 1, 0, w * k, h * k - 1], fill=FLAG)
                else:
                    d.rectangle([0, h * k - 1, w * k - 1, h * k], fill=FLAG)
            sheet.alpha_composite(pz, (n * (cell_w + 4 * k), 0))
        outputs.append(write_png(workdir, sheet, "out/pairs.png", "pairs"))

    warnings = []
    if flagged:
        warnings.append(tx(f"{len(flagged)} par(es) com emenda discrepante (razão > {threshold}); revise antes de aprovar", f"{len(flagged)} pair(s) with a mismatched seam (ratio > {threshold}); review before approving"))
    if report["edgeLines"]["flagged"]:
        warnings.append(tx(f"Linha de borda visível em {len(report['edgeLines']['flagged'])} tile(s): a borda externa destoa do miolo e desenha a grade no mosaico", f"Visible edge line on {len(report['edgeLines']['flagged'])} tile(s): the outer edge clashes with the interior and draws the grid on the mosaic"))
    if report.get("missingMasks"):
        warnings.append(tx(f"Máscaras ausentes: {', '.join(str(m) for m in report['missingMasks'])}; o conjunto não está completo", f"Missing masks: {', '.join(str(m) for m in report['missingMasks'])}; the set is not complete"))
    if report.get("gaps"):
        warnings.append(tx(f"Configurações ausentes usadas na amostra: {', '.join(report['gaps'])}", f"Missing configurations used in the sample: {', '.join(report['gaps'])}"))
    if report["locked"] and not report["locked"]["passed"]:
        warnings.append(tx("A faixa de borda travada diverge do gabarito em algum tile", "The locked edge band differs from the template on some tile"))
    if report["locked"] and report["locked"]["frameFlagged"]:
        warnings.append(
            tx(
                f"Moldura visível em {len(report['locked']['frameFlagged'])} tile(s): o miolo gerado tem acabamento diferente da faixa travada "
                "(as emendas encaixam, mas o mosaico mostra a grade); tente faixa menor/modo livre ou edite só a peça",
                f"Visible border on {len(report['locked']['frameFlagged'])} tile(s): the generated interior has a different finish from the locked band "
                "(the seams fit, but the mosaic shows the grid); try a smaller band or free mode, or edit only the piece",
            )
        )
    return respond(outputs, report, warnings)


def tile_edit_mask(request: Json, workdir: Path) -> Json:
    """255 no miolo de cada região (sem a faixa travada) onde o gabarito é visível; 0 no resto."""
    recipe = recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    guide = load_rgba(source_path)
    alpha = guide.getchannel("A").load()
    w, h = guide.size
    edge = int(recipe["alphaEdgePx"])
    mask = Image.new("L", guide.size, 0)
    mp = mask.load()
    for region in recipe["regions"]:
        x0, y0, rw, rh = region["rect"]
        band = int(region["bandPx"])
        if x0 + rw > w or y0 + rh > h:
            raise PipelineError("geometry_mismatch", tx("Região fora do gabarito", "Region outside the template"))
        for y in range(y0 + band, y0 + rh - band):
            for x in range(x0 + band, x0 + rw - band):
                if alpha[x, y] == 0:
                    continue
                if edge and any(
                    not (x0 <= xx < x0 + rw and y0 <= yy < y0 + rh) or alpha[xx, yy] == 0
                    for xx in range(x - edge, x + edge + 1)
                    for yy in range(y - edge, y + edge + 1)
                ):
                    continue
                mp[x, y] = 255
    edited = mask.histogram()[255]
    if edited == 0:
        raise PipelineError("invalid_request", tx("Nenhum pixel editável: a faixa travada cobre as regiões inteiras", "No editable pixel: the locked band covers the whole regions"))
    out = Image.merge("RGB", (mask, mask, mask))
    return respond([write_png(workdir, out, "out/edit-mask.png", "edit_mask")], {"editedPixels": edited, "protectedPixels": w * h - edited, "size": [w, h]})


# ---------------------------------------------------------------------------
# Isométrico
# ---------------------------------------------------------------------------


def _in_diamond(x: int, y: int, top_x: float, top_y: float, dw: int, dh: int, fw: int = 1, fh: int = 1) -> bool:
    """Centro do pixel dentro do losango do footprint com vértice superior em (top_x, top_y).

    Regra do centro: o centro (meio-inteiro) nunca cai sobre a fronteira, então
    losangos vizinhos particionam o plano sem buraco nem sobreposição.
    """
    px, py = x + 0.5 - top_x, y + 0.5 - top_y
    # Coordenadas do mundo (células) a partir da tela: u = py/H + px/W, v = py/H − px/W.
    u = py / dh + px / dw
    v = py / dh - px / dw
    return 0 < u < fw and 0 < v < fh


def iso_pieces(request: Json, workdir: Path) -> Json:
    """Chão e bloco com a textura aprovada projetada no losango, e prop opcional no mesmo atlas."""
    recipe = recipe_of(request)
    layers = _layers(request, workdir, 1)
    texture = layers[0]
    prop = layers[1] if len(layers) > 1 else None
    dw, dh = recipe["diamond"]
    if dw % 2 or dh % 2:
        raise PipelineError("invalid_request", tx("Losango deve ter largura e altura pares", "Diamond must have even width and height"))
    bh = int(recipe["blockHeightPx"])
    tp = texture.load()
    tw, th = texture.size

    def sample(x: int, y: int, top_y: float) -> Rgba:
        px, py = x + 0.5 - dw / 2, y + 0.5 - top_y
        u = py / dh + px / dw
        v = py / dh - px / dw
        return _canon(tp[int(u * tw) % tw, int(v * th) % th])

    floor = Image.new("RGBA", (dw, dh), (0, 0, 0, 0))
    fp = floor.load()
    for y in range(dh):
        for x in range(dw):
            if _in_diamond(x, y, dw / 2, 0, dw, dh):
                fp[x, y] = sample(x, y, 0)
    block = Image.new("RGBA", (dw, dh + bh), (0, 0, 0, 0))
    bp = block.load()
    for y in range(dh + bh):
        for x in range(dw):
            if _in_diamond(x, y, dw / 2, 0, dw, dh):
                bp[x, y] = sample(x, y, 0)
            else:
                # Faces laterais: entre o contorno inferior do topo e o mesmo contorno bh px abaixo.
                for k in range(1, bh + 1):
                    if _in_diamond(x, y - k, dw / 2, 0, dw, dh):
                        base = sample(x, y - k, 0)
                        bp[x, y] = _shade(base, 0.72 if x < dw / 2 else 0.55)
                        break
    pieces = [
        {"key": "floor", "kind": "floor", "rect": [0, 0, dw, dh], "groundOrigin": [dw // 2, 0], "supportPoint": [dw // 2, dh // 2], "footprintCells": [1, 1], "elevation": 0},
        {"key": "block", "kind": "block", "rect": [dw, 0, dw, dh + bh], "groundOrigin": [dw // 2, bh], "supportPoint": [dw // 2, bh + dh // 2], "footprintCells": [1, 1], "elevation": 1 if bh else 0},
    ]
    width = 2 * dw + (prop.width if prop else 0)
    height = max(dh + bh, prop.height if prop else 0)
    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    atlas.paste(floor, (0, 0))
    atlas.paste(block, (dw, 0))
    if prop is not None:
        atlas.paste(prop, (2 * dw, 0))
        base = _visual_base(prop)
        # Sugestão de apoio: base visual (linha opaca mais baixa, centro das 3 linhas de baixo).
        pieces.append({"key": "prop", "kind": "prop", "rect": [2 * dw, 0, prop.width, prop.height], "visualBase": [int(base[0]), base[1]] if base else None})
    report = {"diamond": [dw, dh], "blockHeightPx": bh, "pieces": pieces, "method": "iso_projection_v1", "textureSize": [tw, th]}
    return respond([write_png(workdir, atlas, "out/atlas.png", "atlas")], report)


def _visual_base(piece: Image.Image) -> tuple[float, int] | None:
    """Base visual de um prop: linha opaca mais baixa e o centro horizontal das 3 linhas de baixo."""
    alpha = piece.getchannel("A").load()
    w, h = piece.size
    bottom = None
    for y in range(h - 1, -1, -1):
        if any(alpha[x, y] for x in range(w)):
            bottom = y
            break
    if bottom is None:
        return None
    xs = [x for y in range(max(0, bottom - 2), bottom + 1) for x in range(w) if alpha[x, y]]
    return (sum(xs) / len(xs) + 0.5, bottom + 1)


def iso_check(request: Json, workdir: Path) -> Json:
    """Losango de cada chão, retalho sem buraco/sobreposição, apoio do prop e ordem de desenho."""
    recipe = recipe_of(request)
    _, atlas_path = input_by_role(request, workdir, "source")
    atlas = load_rgba(atlas_path)
    dw, dh = recipe["diamond"]
    step = int(recipe["elevationStepPx"])
    pieces = {p["key"]: p for p in recipe["pieces"]}
    crops = {k: _crop(atlas, p["rect"]) for k, p in pieces.items()}

    floors = []
    for key, p in pieces.items():
        if p["kind"] != "floor":
            continue
        im = crops[key]
        alpha = im.getchannel("A").load()
        gx, gy = p["groundOrigin"]
        inside = outside = missing = 0
        for y in range(im.height):
            for x in range(im.width):
                expected = _in_diamond(x, y, gx, gy, dw, dh)
                opaque = alpha[x, y] > 0
                inside += expected and opaque
                outside += (not expected) and opaque
                missing += expected and not opaque
        union = inside + outside + missing
        iou = inside / union if union else 0.0
        floors.append({"key": key, "iou": _r(iou), "outsidePixels": outside, "missingPixels": missing, "ok": iou >= 0.97})

    props = []
    for key, p in pieces.items():
        if p["kind"] != "prop":
            continue
        base = _visual_base(crops[key])
        sx, sy = p["supportPoint"]
        if base is None:
            props.append({"key": key, "ok": False, "reason": tx("prop sem pixels visíveis", "prop has no visible pixels")})
            continue
        dx, dy = _r(base[0] - sx), base[1] - sy
        ok = abs(dy) <= 2 and abs(dx) <= max(2.0, crops[key].width / 8)
        props.append({"key": key, "supportPoint": [sx, sy], "visualBase": [_r(base[0]), base[1]], "dx": dx, "dy": dy, "ok": ok})

    # Retalho: posições na tela pelas mesmas fórmulas do domínio (06 §perspectivas).
    patch = recipe["patch"]
    cols, rows = patch["size"]
    if len(patch["cells"]) != cols * rows:
        raise PipelineError("invalid_request", tx("Retalho com número de células diferente do tamanho", "Patch cell count differs from its size"))

    def top(i: int, j: int) -> tuple[float, float]:
        return ((i - j) * dw / 2, (i + j) * dh / 2)

    items = []  # (profundidade, elevação, ordem, imagem, x, y, rótulo)
    for j in range(rows):
        for i in range(cols):
            cell = patch["cells"][j * cols + i]
            if cell["key"] is None:
                continue
            p = pieces[cell["key"]]
            top_x, top_y = top(i, j)
            x = top_x - p["groundOrigin"][0]
            y = top_y - p["groundOrigin"][1] - cell["elevation"] * step
            items.append((i + j, cell["elevation"], 0 if p["kind"] == "floor" else 1, crops[cell["key"]], x, y, ("cell", i, j, cell["elevation"])))
    placements = []
    for pr in patch["props"]:
        p = pieces[pr["key"]]
        i, j = pr["cell"]
        fw, fh = p["footprintCells"]
        top_x, top_y = top(i, j)
        elevation = patch["cells"][j * cols + i]["elevation"] if i < cols and j < rows else 0
        center = (top_x + (fw - fh) * dw / 4, top_y + (fw + fh) * dh / 4 - elevation * step)
        x, y = center[0] - p["supportPoint"][0], center[1] - p["supportPoint"][1]
        items.append((i + j + fw - 1 + fh - 1, elevation, 2, crops[pr["key"]], x, y, ("prop", pr["key"])))
        placements.append({"key": pr["key"], "cell": [i, j], "drawAt": [_r(x), _r(y)], "cellCenter": [_r(center[0]), _r(center[1])]})
    # Personagem de teste: alto o bastante para cruzar a base do prop vindo de trás ou da frente.
    probe = Image.new("RGBA", (max(6, dw // 6), max(12, dh * 3 // 2)), (0, 0, 0, 0))
    ImageDraw.Draw(probe).rectangle([0, 0, probe.width - 1, probe.height - 1], fill=(250, 210, 60, 255), outline=(20, 20, 28, 255))
    for (i, j) in patch["probes"]:
        top_x, top_y = top(i, j)
        elevation = patch["cells"][j * cols + i]["elevation"] if i < cols and j < rows else 0
        cx, cy = top_x, top_y + dh / 2 - elevation * step
        items.append((i + j, elevation, 1.5, probe, cx - probe.width / 2, cy - probe.height, ("probe", i, j)))

    xs = [it[4] for it in items] + [it[4] + it[3].width for it in items]
    ys = [it[5] for it in items] + [it[5] + it[3].height for it in items]
    ox, oy = -math.floor(min(xs)) + 2, -math.floor(min(ys)) + 2
    size = (math.ceil(max(xs)) + ox + 2, math.ceil(max(ys)) + oy + 2)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    coverage = [[0] * size[0] for _ in range(size[1])]
    for it in sorted(items, key=lambda t: (t[0], t[1], t[2])):
        im, x, y = it[3], int(round(it[4] + ox)), int(round(it[5] + oy))
        canvas.alpha_composite(im, (x, y))
        if it[6][0] == "cell" and pieces[patch["cells"][it[6][2] * cols + it[6][1]]["key"]]["kind"] == "floor" and it[6][3] == 0:
            alpha = im.getchannel("A").load()
            for yy in range(im.height):
                for xx in range(im.width):
                    if alpha[xx, yy]:
                        coverage[y + yy][x + xx] += 1
    # Buracos/sobreposições só dentro da união dos losangos de chão em elevação 0.
    holes = overlaps = 0
    floor_cells = [(i, j) for j in range(rows) for i in range(cols) if patch["cells"][j * cols + i]["key"] is not None and pieces[patch["cells"][j * cols + i]["key"]]["kind"] == "floor" and patch["cells"][j * cols + i]["elevation"] == 0]
    for yy in range(size[1]):
        for xx in range(size[0]):
            inside = any(_in_diamond(xx, yy, top(i, j)[0] + ox, top(i, j)[1] + oy, dw, dh) for (i, j) in floor_cells)
            if inside and coverage[yy][xx] == 0:
                holes += 1
            if coverage[yy][xx] > 1:
                overlaps += 1
    for pl in placements:
        # Use the same quantization as the composited patch, not the ideal placement.
        x, y = pl["drawAt"]
        sx, sy = pieces[pl["key"]]["supportPoint"]
        pl["supportScreen"] = [round(x + ox) + sx, round(y + oy) + sy]
        pl["cellCenter"] = [_r(pl["cellCenter"][0] + ox), _r(pl["cellCenter"][1] + oy)]
        pl["ok"] = pl["supportScreen"] == pl["cellCenter"]

    k = int(recipe["zoom"])
    zoomed = _checker(canvas.size, 4)
    zoomed.alpha_composite(canvas)
    zoomed = _zoom(zoomed, k)
    draw = ImageDraw.Draw(zoomed)
    for j in range(rows):
        for i in range(cols):
            top_x, top_y = top(i, j)
            top_x, top_y = (top_x + ox) * k, (top_y + oy) * k
            outline = [(top_x, top_y), (top_x + dw / 2 * k, top_y + dh / 2 * k), (top_x, top_y + dh * k), (top_x - dw / 2 * k, top_y + dh / 2 * k), (top_x, top_y)]
            draw.line(outline, fill=SEAM_LINE, width=1)
    for pl in placements:
        sx, sy = pl["supportScreen"][0] * k, pl["supportScreen"][1] * k
        draw.ellipse([sx - 3, sy - 3, sx + 3, sy + 3], outline=FLAG, width=2)

    report = {
        "diamond": [dw, dh],
        "elevationStepPx": step,
        "floors": floors,
        "props": props,
        "patch": {"size": [cols, rows], "holes": holes, "overlaps": overlaps, "origin": [ox, oy], "canvas": list(size)},
        "placements": placements,
        "sortRule": "depth_ij_elevation_v1",
    }
    warnings = []
    if any(not f["ok"] for f in floors):
        warnings.append(tx("Peça de chão não cobre o losango (um PNG quadrado com prompt 'isométrico' não basta)", "Floor piece does not cover the diamond (a square PNG with an 'isometric' prompt is not enough)"))
    if any(not p["ok"] for p in props):
        warnings.append(tx("Base visual do prop longe do ponto de apoio declarado", "Prop's visual base is far from the declared support point"))
    if holes or overlaps:
        warnings.append(tx(f"Retalho com {holes} buraco(s) e {overlaps} sobreposição(ões) entre losangos", f"Patch with {holes} hole(s) and {overlaps} overlap(s) between diamonds"))
    if any(not pl["ok"] for pl in placements):
        warnings.append(tx("Apoio do prop fora do centro da célula", "Prop support point off the cell center"))
    return respond(
        [write_png(workdir, canvas, "out/patch.png", "patch"), write_png(workdir, zoomed, "out/patch-zoom.png", "patch_zoom")],
        report,
        warnings,
    )
