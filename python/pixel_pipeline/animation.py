"""Animação (cartão S1, plan/05 §normalização de tira): folha → quadros na célula da base.

Uma rota genérica de imagem devolve uma folha com os quadros numa grade
declarada no plano (colunas × linhas, leitura da esquerda para a direita e de
cima para baixo). Aqui:

1. a folha é dividida em regiões proporcionais à grade (o modelo raramente acerta
   o pixel exato da divisão, mas respeita a ordem);
2. o conteúdo de cada região é medido com alfa binário;
3. UM fator de escala comum leva a altura mediana dos quadros à altura da base
   (nada de escala por quadro, que faria a figura pulsar);
4. cada quadro é assentado pelo apoio: em cada linha da folha o quadro mais
   baixo pisa na linha de chão da base, e o pé fica no x do pivô; a altura
   desenhada acima do chão (salto) é preservada e, em ações não cíclicas, também
   o deslocamento horizontal (recuo) — não se recentraliza pela caixa do conteúdo.

Entradas: `candidate` (folha já normalizada) e `source` (vista aprovada da base,
na célula lógica). Saídas: um PNG por quadro (`frame`, chave = ID do quadro) e
a tira horizontal (`strip`).
"""

from __future__ import annotations

from pathlib import Path
from statistics import median
from typing import Any

from PIL import Image

from pixel_pipeline.operations import _block_mode, inputs_by_ordinal, load_rgba, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, input_by_role

Json = dict[str, Any]

FEET_BAND = 0.12


def _binary(image: Image.Image, threshold: int) -> Image.Image:
    alpha = image.getchannel("A").point(lambda a: 255 if a >= threshold else 0)
    out = Image.composite(image, Image.new("RGBA", image.size, (0, 0, 0, 0)), alpha)
    out.putalpha(alpha)
    return out


def _feet_x(image: Image.Image, box: tuple[int, int, int, int]) -> float:
    """Centro horizontal dos pixels opacos na faixa inferior do conteúdo (o apoio)."""
    left, top, right, bottom = box
    band = max(1, round((bottom - top) * FEET_BAND))
    alpha = image.getchannel("A")
    xs: list[int] = []
    for y in range(bottom - band, bottom):
        for x in range(left, right):
            if alpha.getpixel((x, y)):
                xs.append(x)
    return sum(xs) / len(xs) if xs else (left + right) / 2


def _scale(image: Image.Image, factor: float) -> Image.Image:
    if factor == 1:
        return image
    size = (max(1, round(image.width * factor)), max(1, round(image.height * factor)))
    if factor < 1:
        # Redução sem cores novas: maioria do bloco (contornos finos podem afinar; o relatório avisa).
        return _block_mode(image, size)
    return image.resize(size, Image.Resampling.NEAREST)


def _paste_clipped(canvas: Image.Image, content: Image.Image, dx: int, dy: int) -> None:
    """Compõe `content` em `(dx, dy)` descartando o que sair da tela (contado à parte no relatório)."""
    left, top = max(0, dx), max(0, dy)
    right, bottom = min(canvas.width, dx + content.width), min(canvas.height, dy + content.height)
    if right <= left or bottom <= top:
        return
    piece = content.crop((left - dx, top - dy, right - dx, bottom - dy))
    canvas.alpha_composite(piece, dest=(left, top))


def animation_sheet(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cols, rows = recipe["columns"], recipe["rows"]
    frame_ids: list[str] = recipe["frameIds"]
    cw, ch = recipe["cell"]
    threshold = recipe["alphaThreshold"]
    tolerance = recipe["scaleTolerance"]
    _, sheet_path = input_by_role(request, workdir, "candidate")
    _, base_path = input_by_role(request, workdir, "source")
    sheet = _binary(load_rgba(sheet_path), threshold)
    base = _binary(load_rgba(base_path), threshold)
    if base.size != (cw, ch):
        raise PipelineError("geometry_mismatch", f"A vista da base tem {base.width}×{base.height}; a célula declarada é {cw}×{ch}")
    base_box = base.getchannel("A").getbbox()
    if base_box is None:
        raise PipelineError("unsupported_input", "A vista da base está vazia")
    base_height = base_box[3] - base_box[1]
    base_bottom = base_box[3]
    base_feet = _feet_x(base, base_box)
    if len(frame_ids) > cols * rows:
        raise PipelineError("geometry_mismatch", f"{len(frame_ids)} quadros para {cols * rows} células")

    sw, sh = sheet.size
    xs = [round(i * sw / cols) for i in range(cols + 1)]
    ys = [round(j * sh / rows) for j in range(rows + 1)]
    regions: list[Json] = []
    warnings: list[str] = []
    for index in range(cols * rows):
        r, c = divmod(index, cols)
        rect = (xs[c], ys[r], xs[c + 1], ys[r + 1])
        region = sheet.crop(rect)
        box = region.getchannel("A").getbbox()
        if index >= len(frame_ids):
            if box is not None:
                warnings.append(f"Célula {index + 1} da folha tem conteúdo mas não corresponde a nenhum quadro pedido (sobra na grade)")
            continue
        regions.append({"index": index, "rect": rect, "image": region, "box": box})

    measured = [g for g in regions if g["box"] is not None]
    if not measured:
        raise PipelineError("unsupported_input", "Nenhum quadro com conteúdo na folha")
    heights = [g["box"][3] - g["box"][1] for g in measured]
    median_height = median(heights)
    factor = base_height / median_height if median_height else 1.0
    resampled = abs(factor - 1) > tolerance
    if not resampled:
        factor = 1.0
    elif factor < 1:
        warnings.append(f"Folha desenhada maior que a base: redução comum de {factor:.3f}× por maioria de bloco; revise contornos finos")
    else:
        warnings.append(f"Folha desenhada menor que a base: ampliação comum de {factor:.3f}× por vizinho mais próximo; revise a grade")

    # Referências do quadro típico: folga entre o pé e o fundo da região e posição do pé no centro da região.
    for g in measured:
        left, top, right, bottom = g["box"]
        rw = g["rect"][2] - g["rect"][0]
        g["gap"] = (g["rect"][3] - g["rect"][1]) - bottom
        g["feetOffset"] = _feet_x(g["image"], g["box"]) - rw / 2
    # Chão por linha da folha: o quadro mais baixo de cada linha toca o chão (o modelo nem sempre
    # alinha as linhas entre si); os outros sobem o quanto foram desenhados acima dele (salto preservado).
    keep_x = recipe["keepHorizontalOffsets"]
    ground_gap: dict[int, float] = {}
    typical_feet: dict[int, float] = {}
    for row in {g["index"] // cols for g in measured}:
        same = [g for g in measured if g["index"] // cols == row]
        ground_gap[row] = min(g["gap"] for g in same)
        typical_feet[row] = median(g["feetOffset"] for g in same)

    outputs: list[Json] = []
    frames: list[Json] = []
    strip = Image.new("RGBA", (cw * len(frame_ids), ch), (0, 0, 0, 0))
    for k, g in enumerate(regions):
        frame_id = frame_ids[k]
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        entry: Json = {"frameId": frame_id, "cell": k, "regionRect": [g["rect"][0], g["rect"][1], g["rect"][2] - g["rect"][0], g["rect"][3] - g["rect"][1]]}
        if g["box"] is None:
            warnings.append(f"Quadro {frame_id} veio vazio na folha")
            entry.update(empty=True, contentBox=None, offset=None, clippedPixels=0, lift=0, shift=0)
        else:
            content = _scale(g["image"].crop(g["box"]), factor)
            content = _binary(content, threshold)
            local_box = content.getchannel("A").getbbox() or (0, 0, content.width, content.height)
            feet = _feet_x(content, local_box)
            # Deslocamento intencional relativo ao quadro típico (salto sobe, recuo anda), na escala comum.
            row = g["index"] // cols
            lift = round((g["gap"] - ground_gap[row]) * factor)
            shift = round((g["feetOffset"] - typical_feet[row]) * factor) if keep_x else 0
            dx = round(base_feet + shift - feet)
            dy = base_bottom - lift - local_box[3]
            _paste_clipped(canvas, content, dx, dy)
            visible_in = sum(1 for a in canvas.getchannel("A").getdata() if a)
            visible_total = sum(1 for a in content.getchannel("A").getdata() if a)
            clipped = visible_total - visible_in
            if clipped:
                warnings.append(f"Quadro {frame_id}: {clipped} pixel(s) ficaram fora da célula {cw}×{ch}; amplie a célula ou as margens")
            entry.update(
                empty=False,
                contentBox=[g["box"][0], g["box"][1], g["box"][2] - g["box"][0], g["box"][3] - g["box"][1]],
                offset=[dx, dy],
                clippedPixels=clipped,
                lift=lift,
                shift=shift,
            )
        strip.alpha_composite(canvas, dest=(k * cw, 0))
        outputs.append(write_png(workdir, canvas, f"out/frames/{k:03d}.png", "frame", key=frame_id))
        frames.append(entry)
    outputs.append(write_png(workdir, strip, "out/strip.png", "strip"))
    report = {
        "sheetSize": [sw, sh],
        "grid": [cols, rows],
        "cell": [cw, ch],
        "base": {"contentBox": [base_box[0], base_box[1], base_box[2] - base_box[0], base_box[3] - base_box[1]], "feetX": round(base_feet, 2), "ground": base_bottom},
        "scale": {"factor": round(factor, 4), "resampled": resampled, "medianHeight": median_height, "baseHeight": base_height},
        "frames": frames,
    }
    return respond(outputs, report, warnings)


def animation_contact_sheet(request: Json, workdir: Path) -> Json:
    """Quadros lado a lado em zoom inteiro (vizinho mais próximo) sobre fundo chapado ou quadriculado."""
    recipe = recipe_of(request)
    cw, ch = recipe["cell"]
    zoom, cols, gap = recipe["zoom"], recipe["columns"], recipe["gap"]
    layers = inputs_by_ordinal(request, workdir, "layer")
    if not layers:
        raise PipelineError("invalid_request", "Folha de contato exige ao menos um quadro (papel layer)")
    frames = [load_rgba(layers[i]) for i in sorted(layers)]
    for i, frame in enumerate(frames):
        if frame.size != (cw, ch):
            raise PipelineError("geometry_mismatch", f"Quadro {i + 1} tem {frame.width}×{frame.height}; a célula é {cw}×{ch}")
    n = len(frames)
    used_cols = min(cols, n)
    rows = (n + cols - 1) // cols
    tile_w, tile_h = cw * zoom, ch * zoom
    width = used_cols * tile_w + (used_cols + 1) * gap
    height = rows * tile_h + (rows + 1) * gap
    background = recipe["background"]
    if background:
        rgb = tuple(int(background[i : i + 2], 16) for i in (1, 3, 5))
        sheet = Image.new("RGBA", (width, height), (*rgb, 255))
    else:
        sheet = Image.new("RGBA", (width, height), (255, 255, 255, 255))
        square = max(4, zoom * 2)
        light, dark = (236, 236, 232, 255), (204, 204, 198, 255)
        for y in range(0, height, square):
            for x in range(0, width, square):
                if (x // square + y // square) % 2:
                    sheet.paste(dark, (x, y, min(width, x + square), min(height, y + square)))
                else:
                    sheet.paste(light, (x, y, min(width, x + square), min(height, y + square)))
    for i, frame in enumerate(frames):
        r, c = divmod(i, cols)
        big = frame.resize((tile_w, tile_h), Image.Resampling.NEAREST)
        sheet.alpha_composite(big, dest=(gap + c * (tile_w + gap), gap + r * (tile_h + gap)))
    report = {"frames": n, "zoom": zoom, "grid": [used_cols, rows], "size": [width, height]}
    return respond([write_png(workdir, sheet, "out/contact.png", "contact")], report)
