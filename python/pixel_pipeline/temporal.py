"""Estados e edição temporal (cartão S3): quadros congelados, folhas casadas, espelho e canvas.

- `compose_frames`: recompõe cada quadro a partir das camadas congeladas no plano
  (arquivo, retângulo e posição na célula) e, opcionalmente, monta a folha de
  referência ampliada por fator inteiro, achatada numa cor-chave quando a rota
  não tem alfa. Os mesmos bytes + a mesma receita dão os mesmos pixels.
- `sheet_match`: folha de uma rota genérica com a MESMA disposição da
  referência (edição de trecho, roupa, estado). A escala vem do tamanho da folha
  (a referência foi enviada numa grade conhecida), não da altura do conteúdo:
  um baú aberto é mais alto que o fechado e não deve encolher. Cada célula é
  assentada pelo apoio do quadro original correspondente (base e x do pé), o
  que preserva saltos e recuos desenhados no original.
- `mirror_frames`: espelho horizontal explícito e a medida de assimetria da vista
  frontal (sujeito assimétrico não é espelhado sem confirmação).
- `canvas_fit`: muda a tela sem gerar pixels; recortar pixel visível falha.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from pixel_pipeline.animation import _binary, _feet_x, _paste_clipped, _scale, crossing_warning, grid_crossings
from pixel_pipeline.i18n import tx
from pixel_pipeline.operations import hex_rgb, inputs_by_ordinal, load_rgba, optional_input, recipe_of, respond, write_png
from pixel_pipeline.protocol import PipelineError, Text, input_by_role, rgba_sha256

Json = dict[str, Any]


def _box(image: Image.Image) -> list[int] | None:
    box = image.getchannel("A").getbbox()
    return None if box is None else [box[0], box[1], box[2] - box[0], box[3] - box[1]]


def compose_frames(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cw, ch = recipe["cell"]
    sources = {k: load_rgba(p) for k, p in inputs_by_ordinal(request, workdir, "layer").items()}
    outputs: list[Json] = []
    frames: list[Json] = []
    composed: list[Image.Image] = []
    for index, frame in enumerate(recipe["frames"]):
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        for n, layer in enumerate(frame["layers"]):
            image = sources.get(layer["input"])
            if image is None:
                raise PipelineError("invalid_request", tx(f"Quadro {frame['key']}: camada {n} cita a entrada {layer['input']} inexistente", f"Frame {frame['key']}: layer {n} references missing input {layer['input']}"))
            x, y, w, h = layer["rect"]
            if x + w > image.width or y + h > image.height:
                raise PipelineError("geometry_mismatch", tx(f"Quadro {frame['key']}: retângulo {layer['rect']} fora do arquivo {image.width}×{image.height}", f"Frame {frame['key']}: rectangle {layer['rect']} outside the {image.width}×{image.height} file"))
            ox, oy = layer["offset"]
            if ox < 0 or oy < 0 or ox + w > cw or oy + h > ch:
                raise PipelineError("geometry_mismatch", tx(f"Quadro {frame['key']}: camada {w}×{h} em {ox},{oy} excede a célula {cw}×{ch}", f"Frame {frame['key']}: {w}×{h} layer at {ox},{oy} exceeds the {cw}×{ch} cell"))
            canvas.alpha_composite(image.crop((x, y, x + w, y + h)), dest=(ox, oy))
        composed.append(canvas)
        frames.append({"key": frame["key"], "contentBox": _box(canvas), "rgbaSha256": rgba_sha256(canvas)})
        if recipe["emitFrames"]:
            outputs.append(write_png(workdir, canvas, f"out/frames/{index:03d}.png", "frame", key=frame["key"]))
    sheet_report = None
    sheet = recipe["sheet"]
    if sheet:
        cols, rows, k = sheet["columns"], sheet["rows"], sheet["scale"]
        if len(composed) > cols * rows:
            raise PipelineError("geometry_mismatch", tx(f"{len(composed)} quadros para {cols * rows} células", f"{len(composed)} frames for {cols * rows} cells"))
        flat = sheet["flattenOnto"]
        background = (*hex_rgb(flat), 255) if flat else (0, 0, 0, 0)
        big = Image.new("RGBA", (cols * cw * k, rows * ch * k), background)
        for i, canvas in enumerate(composed):
            r, c = divmod(i, cols)
            big.alpha_composite(canvas.resize((cw * k, ch * k), Image.Resampling.NEAREST), dest=(c * cw * k, r * ch * k))
        outputs.append(write_png(workdir, big, "out/sheet.png", "sheet"))
        sheet_report = {"grid": [cols, rows], "scale": k, "size": list(big.size), "flattenedOnto": flat}
    return respond(outputs, {"cell": [cw, ch], "frames": frames, "sheet": sheet_report})


def sheet_match(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    cols, rows = recipe["columns"], recipe["rows"]
    frame_ids: list[str] = recipe["frameIds"]
    cw, ch = recipe["cell"]
    threshold = recipe["alphaThreshold"]
    _, sheet_path = input_by_role(request, workdir, "candidate")
    sheet = _binary(load_rgba(sheet_path), threshold)
    by_ordinal = inputs_by_ordinal(request, workdir, "layer")
    originals = [_binary(load_rgba(by_ordinal[k]), threshold) for k in sorted(by_ordinal)]
    if len(originals) != len(frame_ids):
        raise PipelineError("invalid_request", tx(f"{len(frame_ids)} quadros pedidos e {len(originals)} originais", f"{len(frame_ids)} frames requested and {len(originals)} originals"))
    for i, original in enumerate(originals):
        if original.size != (cw, ch):
            raise PipelineError("geometry_mismatch", tx(f"Original {frame_ids[i]} tem {original.width}×{original.height}; a célula é {cw}×{ch}", f"Original {frame_ids[i]} is {original.width}×{original.height}; the cell is {cw}×{ch}"))

    sw, sh = sheet.size
    xs = [round(i * sw / cols) for i in range(cols + 1)]
    ys = [round(j * sh / rows) for j in range(rows + 1)]
    scale_by = recipe.get("scaleBy", "sheet")
    # A referência foi enviada exatamente nesta grade: a escala é a da folha inteira...
    factor = ((cols * cw) / sw + (rows * ch) / sh) / 2
    if scale_by == "width":
        # ...ou, quando o modelo não mantém o enquadramento, a largura mediana do sujeito em relação ao original
        # (estado, roupa e correção conservam a largura do corpo; a altura pode mudar, como a tampa aberta).
        ratios = []
        for index in range(min(cols * rows, len(frame_ids))):
            r, c = divmod(index, cols)
            box = sheet.crop((xs[c], ys[r], xs[c + 1], ys[r + 1])).getchannel("A").getbbox()
            obox = originals[index].getchannel("A").getbbox()
            if box and obox and box[2] > box[0]:
                ratios.append((obox[2] - obox[0]) / (box[2] - box[0]))
        if ratios:
            ratios.sort()
            factor = ratios[len(ratios) // 2] if len(ratios) % 2 else (ratios[len(ratios) // 2 - 1] + ratios[len(ratios) // 2]) / 2
    resampled = abs(factor - 1) > recipe["scaleTolerance"]
    if not resampled:
        factor = 1.0
    warnings: list[Text] = []
    crossings = grid_crossings(sheet, xs, ys)
    if crossings:
        warnings.append(crossing_warning(crossings))
    if resampled:
        warnings.append(tx(f"Folha {sw}×{sh} fora da grade {cols * cw}×{rows * ch}: escala comum de {factor:.3f}× ({'maioria de bloco' if factor < 1 else 'vizinho mais próximo'}); revise contornos", f"Sheet {sw}×{sh} off the {cols * cw}×{rows * ch} grid: common {factor:.3f}× scale ({'block majority' if factor < 1 else 'nearest neighbor'}); review outlines"))

    # Apoio típico dos originais: usado quando o original de uma célula está vazio.
    anchors = []
    for original in originals:
        box = original.getchannel("A").getbbox()
        anchors.append(None if box is None else (_feet_x(original, box), box[3]))
    known = [a for a in anchors if a is not None]
    fallback = (sum(a[0] for a in known) / len(known), max(a[1] for a in known)) if known else (cw / 2, ch)

    outputs: list[Json] = []
    frames: list[Json] = []
    strip = Image.new("RGBA", (cw * len(frame_ids), ch), (0, 0, 0, 0))
    for index in range(cols * rows):
        r, c = divmod(index, cols)
        region = sheet.crop((xs[c], ys[r], xs[c + 1], ys[r + 1]))
        box = region.getchannel("A").getbbox()
        if index >= len(frame_ids):
            if box is not None:
                warnings.append(tx(f"Célula {index + 1} da folha tem conteúdo mas não corresponde a nenhum quadro pedido", f"Sheet cell {index + 1} has content but matches no requested frame"))
            continue
        frame_id = frame_ids[index]
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        entry: Json = {"frameId": frame_id, "cell": index, "regionRect": [xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]]}
        if box is None:
            warnings.append(tx(f"Quadro {frame_id} veio vazio na folha", f"Frame {frame_id} came out empty in the sheet"))
            entry.update(empty=True, offset=None, clippedPixels=0)
        else:
            content = _binary(_scale(region.crop(box), factor), threshold)
            local = content.getchannel("A").getbbox() or (0, 0, content.width, content.height)
            feet_x, ground = anchors[index] or fallback
            dx = round(feet_x - _feet_x(content, local))
            dy = ground - local[3]
            _paste_clipped(canvas, content, dx, dy)
            visible_in = sum(1 for a in canvas.getchannel("A").getdata() if a)
            visible_total = sum(1 for a in content.getchannel("A").getdata() if a)
            clipped = visible_total - visible_in
            if clipped:
                warnings.append(tx(f"Quadro {frame_id}: {clipped} pixel(s) ficaram fora da célula {cw}×{ch}; amplie o canvas", f"Frame {frame_id}: {clipped} pixel(s) fell outside the {cw}×{ch} cell; enlarge the canvas"))
            entry.update(empty=False, offset=[dx, dy], clippedPixels=clipped, anchoredTo="original" if anchors[index] else "typical")
        strip.alpha_composite(canvas, dest=(len(frames) * cw, 0))
        outputs.append(write_png(workdir, canvas, f"out/frames/{len(frames):03d}.png", "frame", key=frame_id))
        frames.append(entry)
    outputs.append(write_png(workdir, strip, "out/strip.png", "strip"))
    report = {"sheetSize": [sw, sh], "grid": [cols, rows], "cell": [cw, ch], "scale": {"factor": round(factor, 4), "resampled": resampled, "scaleBy": scale_by}, "frames": frames}
    return respond(outputs, report, warnings)


def _asymmetry(image: Image.Image) -> float:
    """Fração dos pixels opacos (na imagem ou no espelho) cuja cor diverge do espelho em mais de 24 por canal."""
    mirrored = ImageOps.mirror(image)
    a, b = image.load(), mirrored.load()
    opaque = differ = 0
    for y in range(image.height):
        for x in range(image.width):
            p, q = a[x, y], b[x, y]
            if p[3] == 0 and q[3] == 0:
                continue
            opaque += 1
            if (p[3] == 0) != (q[3] == 0) or max(abs(p[i] - q[i]) for i in range(4)) > 24:
                differ += 1
    return differ / opaque if opaque else 0.0


def mirror_frames(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    layers = inputs_by_ordinal(request, workdir, "layer")
    if not layers:
        raise PipelineError("invalid_request", tx("Espelho exige ao menos uma imagem (papel layer)", "Mirror requires at least one image (layer role)"))
    outputs = []
    for ordinal in sorted(layers):
        image = load_rgba(layers[ordinal])
        outputs.append(write_png(workdir, ImageOps.mirror(image), f"out/mirrored/{ordinal:03d}.png", "mirrored", key=str(ordinal)))
    probe = optional_input(request, workdir, "source")
    report: Json = {"mirrored": len(outputs), "asymmetry": None, "asymmetric": None}
    if probe is not None:
        score = _asymmetry(load_rgba(probe))
        report.update(asymmetry=round(score, 4), asymmetric=score > recipe["asymmetryThreshold"], threshold=recipe["asymmetryThreshold"])
    return respond(outputs, report)


def canvas_fit(request: Json, workdir: Path) -> Json:
    recipe = recipe_of(request)
    _, source_path = input_by_role(request, workdir, "source")
    source = load_rgba(source_path)
    w, h = recipe["size"]
    dx, dy = recipe["offset"]
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    _paste_clipped(canvas, source, dx, dy)
    visible_in = sum(1 for a in canvas.getchannel("A").getdata() if a)
    visible_total = sum(1 for a in source.getchannel("A").getdata() if a)
    if visible_in != visible_total:
        raise PipelineError("geometry_mismatch", tx(f"A tela {w}×{h} com deslocamento {dx},{dy} recortaria {visible_total - visible_in} pixel(s) visíveis", f"The {w}×{h} canvas with offset {dx},{dy} would clip {visible_total - visible_in} visible pixel(s)"))
    report = {"sourceSize": list(source.size), "size": [w, h], "offset": [dx, dy], "visiblePixels": visible_total, "contentBox": _box(canvas)}
    return respond([write_png(workdir, canvas, "out/fitted.png", "fitted")], report)
