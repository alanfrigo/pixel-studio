#!/usr/bin/env python3
"""Leitor independente do pacote portátil v1 do Pixel Studio.

Não importa nada do Studio: só a biblioteca padrão e Pillow. Serve como
consumidor mínimo (plan/08 · X1): extrai o ZIP numa pasta limpa, confere
versão, caminhos, hashes, tamanhos e dimensões, resolve dependências e
reconstrói os frames na célula lógica, com pivô e duração.

Uso: python read_portable.py pacote.zip pasta_de_saida
Saída: pasta_de_saida/frames/... (PNGs reconstruídos) e summary.json.
Código de saída 0 = pacote utilizável; 2 = pacote recusado (motivos no stderr).
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
import unicodedata
import wave
import zipfile
from pathlib import Path, PurePosixPath

from PIL import Image

SUPPORTED_MAJOR = 1


class Rejected(Exception):
    pass


def safe_extract(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=False)
    root = dest.resolve()
    seen: set[str] = set()
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            if name.startswith("/") or "\\" in name or ".." in parts or (parts and ":" in parts[0]):
                raise Rejected(f"caminho inseguro no ZIP: {name!r}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise Rejected(f"link simbólico recusado: {name!r}")
            if name.lower() in seen:
                raise Rejected(f"caminho duplicado: {name!r}")
            seen.add(name.lower())
            target = (dest / name).resolve()
            if not target.is_relative_to(root):
                raise Rejected(f"caminho fora da pasta: {name!r}")
            if name.endswith("/"):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))  # zipfile confere o CRC


def load_manifest(root: Path) -> dict:
    path = root / "manifest.json"
    if not path.is_file():
        raise Rejected("manifest.json ausente na raiz")
    manifest = json.loads(path.read_text("utf-8"))
    version = manifest.get("schemaVersion")
    if version != SUPPORTED_MAJOR:
        raise Rejected(f"versão {version!r} do manifesto não suportada; este leitor entende a versão {SUPPORTED_MAJOR}")
    return manifest


def verify_files(root: Path, manifest: dict) -> dict[str, dict]:
    files: dict[str, dict] = {}
    for f in manifest["files"]:
        if f["fileId"] in files:
            raise Rejected(f"fileId duplicado: {f['fileId']}")
        p = root / f["path"]
        if not p.is_file():
            raise Rejected(f"arquivo ausente: {f['path']}")
        data = p.read_bytes()
        if len(data) != f["bytes"]:
            raise Rejected(f"{f['path']}: {len(data)} bytes, manifesto diz {f['bytes']}")
        if hashlib.sha256(data).hexdigest() != f["sha256"]:
            raise Rejected(f"{f['path']}: SHA-256 diverge")
        if f["mime"] == "image/png":
            with Image.open(p) as im:
                if im.size != (f["width"], f["height"]):
                    raise Rejected(f"{f['path']}: PNG {im.size}, manifesto {f['width']}×{f['height']}")
        elif f["mime"] == "audio/wav":
            with wave.open(str(p)) as w:
                if (w.getframerate(), w.getnchannels(), w.getnframes()) != (f["sampleRate"], f["channels"], f["frameCount"]):
                    raise Rejected(f"{f['path']}: metadados de áudio divergem")
        files[f["fileId"]] = {**f, "abs": p}
    return files


def check_dependencies(manifest: dict) -> dict[str, dict]:
    entries = {}
    for e in manifest["entries"]:
        if e["revisionId"] in entries:
            raise Rejected(f"revisionId duplicado: {e['revisionId']}")
        entries[e["revisionId"]] = e
    for e in entries.values():
        for d in e["dependencies"]:
            if d["revisionId"] not in entries:
                raise Rejected(f"{e['revisionId']} depende de {d['revisionId']} ({d['role']}), ausente")
    state: dict[str, str] = {}

    def visit(rid: str) -> None:
        if state.get(rid) == "done":
            return
        if state.get(rid) == "visiting":
            raise Rejected(f"ciclo de dependências em {rid}")
        state[rid] = "visiting"
        for d in entries[rid]["dependencies"]:
            visit(d["revisionId"])
        state[rid] = "done"

    for rid in entries:
        visit(rid)
    return entries


class Images:
    def __init__(self, files: dict[str, dict]):
        self.files = files
        self.cache: dict[str, Image.Image] = {}

    def crop(self, file_id: str, rect: list[int]) -> Image.Image:
        if file_id not in self.cache:
            with Image.open(self.files[file_id]["abs"]) as im:
                self.cache[file_id] = im.convert("RGBA")
        x, y, w, h = rect
        img = self.cache[file_id]
        if x + w > img.width or y + h > img.height:
            raise Rejected(f"retângulo {rect} fora de {file_id} ({img.width}×{img.height})")
        return img.crop((x, y, x + w, y + h))


def compose(size: list[int], layers: list[tuple[Image.Image, list[int]]]) -> Image.Image:
    canvas = Image.new("RGBA", tuple(size), (0, 0, 0, 0))
    for img, (ox, oy) in layers:
        canvas.alpha_composite(img, dest=(ox, oy))
    return canvas


def save(img: Image.Image, out: Path, *parts: str) -> str:
    path = out.joinpath("frames", *parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    return str(path.relative_to(out))


def clip_frames(images: Images, clip: dict, out: Path, rid: str, overlays: list[dict] | None = None, overlay_ids: list[str] | None = None, loadout: dict | None = None) -> list[dict]:
    frames = []
    for frame in clip["frames"]:
        layers = [(i, layer["partId"], images.crop(layer["fileId"], layer["rect"]), layer["offset"], ("base", layer["partId"])) for i, layer in enumerate(frame["layers"])]
        sockets = {s["socketId"]: s["at"] for s in frame["sockets"]}
        for oi, ov in enumerate(overlays or []):
            oid = overlay_ids[oi] if overlay_ids else str(oi)
            for part in ov["parts"]:
                for cell in part["coverage"]:
                    if cell["clipRevisionId"] == rid and cell["frameId"] == frame["frameId"] and cell["layer"]:
                        lay = cell["layer"]
                        layers.append((cell["drawIndex"], part["partId"], images.crop(lay["fileId"], lay["rect"]), lay["offset"], ("part", oid, part["partId"])))
            # S2: vista rígida usada no frame; origem = socket − empunhadura (espelho: índice W − 1 − x).
            views = {v["viewId"]: v for v in ov.get("rigidViews", [])}
            for pl in ov.get("rigidPlacements", []):
                if pl["clipRevisionId"] == rid and pl["frameId"] == frame["frameId"] and pl["viewId"] is not None:
                    view = views[pl["viewId"]]
                    img = images.crop(view["fileId"], view["rect"])
                    gx, gy = next(g["at"] for g in view["grips"] if g["socketId"] == pl["anchorSocketId"])
                    if pl.get("mirrored"):
                        img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                        gx = img.width - 1 - gx
                    sx, sy = sockets[pl["anchorSocketId"]]
                    layers.append((pl["drawIndex"], f"rigid:{pl['viewId']}", img, [sx - gx, sy - gy], ("rigid", oid)))
        layers.sort(key=lambda t: t[0])  # ordem de desenho; sort é estável para empates
        order = next((o["layers"] for o in (loadout or {}).get("drawOrder", []) if o["clipRevisionId"] == rid and o["frameId"] == frame["frameId"]), None)
        if order:  # S2: override explícito da ordem neste frame
            key_of = lambda ref: ("base", ref["partId"]) if ref["kind"] == "base" else ("part", ref["overlayRevisionId"], ref["partId"]) if ref["kind"] == "part" else ("rigid", ref["overlayRevisionId"])  # noqa: E731
            rank = {key_of(ref): n for n, ref in enumerate(order)}
            layers.sort(key=lambda t: rank.get(t[4], len(rank)))
        if loadout is None:
            img = compose(clip["logicalSize"], [(im, off) for _, _, im, off, _ in layers])
        else:
            img = Image.new("RGBA", tuple(clip["logicalSize"]), (0, 0, 0, 0))
            for _, _, im, (ox, oy), _ in layers:
                place(img, im, ox, oy)
        frames.append({
            "frameId": frame["frameId"],
            "durationMs": frame["durationMs"],
            "layers": [name for _, name, _, _, _ in layers],
            "sockets": sockets,
            "file": save(img, out, rid if overlays is None else f"loadout-{rid}", f"{frame['frameId']}.png"),
            **({"_image": img} if loadout is not None else {}),
        })
    return frames


def place(canvas: Image.Image, img: Image.Image, x: int, y: int) -> None:
    """Cola com recorte nas bordas (objetos podem passar da borda do mapa)."""
    left, top = max(0, -x), max(0, -y)
    if left >= img.width or top >= img.height:
        return
    canvas.alpha_composite(img.crop((left, top, img.width, img.height)), dest=(max(0, x), max(0, y)))


def reconstruct_tilemap(images: Images, entries: dict[str, dict], rid: str, p: dict, out: Path) -> dict:
    """Mapa editável (T1): monta o terreno pelas CHAVES do tileset (não pela posição no atlas) e os objetos pelo apoio."""
    t = p["terrain"]
    ts = entries[t["tilesetRevisionId"]]["payload"]
    cols, rows = p["size"]
    cw, ch = p["cellSize"]
    missing = 0
    if t["mode"] == "isometric":
        pieces = {pc["pieceKey"]: pc for pc in ts["pieces"]}
        canvas = Image.new("RGBA", ((cols + rows) * cw // 2, (cols + rows) * ch // 2 + 4 * ch), (0, 0, 0, 0))
        ox, oy = rows * cw // 2, 4 * ch
        items = []
        for i, cell in enumerate(t["cells"]):
            if cell["pieceKey"] is None:
                continue
            pc = pieces.get(cell["pieceKey"])
            if pc is None:
                missing += 1
                continue
            cx, cy = i % cols, i // cols
            items.append((cx + cy, cell["elevation"], 0, pc, cx, cy, cell["elevation"]))
        for o in p["objects"]:
            if o["pieceKey"]:
                pc = pieces[o["pieceKey"]]
                items.append((o["cell"][0] + o["cell"][1], 0, 2, pc, o["cell"][0], o["cell"][1], 0))
        for _, _, _, pc, cx, cy, elev in sorted(items, key=lambda it: it[:3]):
            fw, fh = pc["footprintCells"]
            sx = ox + (cx - cy) * cw / 2 + (fw - fh) * cw / 4
            sy = oy + (cx + cy) * ch / 2 + (fw + fh) * ch / 4 - elev * ts["elevationStepPx"]
            place(canvas, images.crop(ts["atlas"]["fileId"], pc["rect"]), int(sx - pc["supportPoint"][0]), int(sy - pc["supportPoint"][1]))
    else:
        if t["mode"] == "corner":
            by_key = {tile["tileKey"]: tile for tile in ts["tiles"]}
            keys = t["resolved"]
        else:
            by_key = {tile["configuration"]: tile for tile in sorted(ts["tiles"], key=lambda x: -x["variant"])}
            keys = t["resolved"]
        canvas = Image.new("RGBA", (cols * cw, rows * ch), (0, 0, 0, 0))
        for i, key in enumerate(keys):
            if key is None:
                continue
            tile = by_key.get(key)
            if tile is None:
                missing += 1
                continue
            canvas.alpha_composite(images.crop(ts["atlas"]["fileId"], tile["rect"]), dest=((i % cols) * cw, (i // cols) * ch))
        placed = []
        for o in p["objects"]:
            obj = entries[o["objectRevisionId"]]["payload"]
            fw, fh = obj["footprintCells"]
            ax = (o["cell"][0] + fw / 2) * cw + o["offsetPx"][0]
            ay = (o["cell"][1] + fh / 2) * ch + o["offsetPx"][1]
            placed.append((ay, obj, int(ax - obj["supportPoint"][0]), int(ay - obj["supportPoint"][1])))
        for _, obj, x, y in sorted(placed, key=lambda it: it[0]):
            # T2: sombra separada desenhada antes do objeto, no offset declarado.
            if obj.get("shadow"):
                sh = obj["shadow"]
                place(canvas, images.crop(sh["fileId"], sh["rect"]), x + sh["offset"][0], y + sh["offset"][1])
            place(canvas, images.crop(obj["fileId"], obj["rect"]), x, y)
    return {
        "projection": p["projection"],
        "size": p["size"],
        "objects": len(p["objects"]),
        "entrances": [en["entranceId"] for en in p["entrances"]],
        "passages": p["passages"],
        "missingTiles": missing,
        "file": save(canvas, out, rid, "map.png"),
    }


def scene_frame(images: Images, entries: dict[str, dict], p: dict, camera: int) -> Image.Image:
    """Cena em camadas (T2): cada plano em offset − ⌊câmera × fator⌋, repetido por eixo (trás → frente)."""
    w, h = p["logicalSize"]
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for layer in p["layers"]:
        lp = entries[layer["layerRevisionId"]]["payload"]
        img = images.crop(lp["fileId"], lp["rect"])
        ox = layer["offset"][0] - math.floor(camera * layer["parallax"]["x"])
        oy = layer["offset"][1]
        xs = [ox] if not layer["repeat"]["x"] else list(range(ox - img.width * math.ceil(ox / img.width), w, img.width))
        ys = [oy] if not layer["repeat"]["y"] else list(range(oy - img.height * math.ceil(oy / img.height), h, img.height))
        for y in ys:
            for x in xs:
                place(canvas, img, x, y)
    return canvas


def reconstruct_scene(images: Images, entries: dict[str, dict], rid: str, p: dict, out: Path) -> dict:
    """Cena ilustrada (T2): imagem plana sem mapa, ou planos recompostos pela câmera."""
    image = images.crop(p["image"]["fileId"], p["image"]["rect"])
    result = {"outputKind": p["outputKind"], "editable": p["editable"], "supportPoints": [sp["at"] for sp in p["supportPoints"]], "file": save(image, out, rid, "scene.png")}
    if p["outputKind"] == "layers":
        frame0 = scene_frame(images, entries, p, 0)
        span = p["cameraTest"]["spanPx"]
        result.update(
            layers=[{"layerId": la["layerId"], "parallax": la["parallax"], "repeat": la["repeat"], "offset": la["offset"]} for la in p["layers"]],
            matchesImage=frame0.tobytes() == image.tobytes(),
            cameraSpan=span,
            frames=[save(scene_frame(images, entries, p, cam), out, rid, f"camera-{cam}.png") for cam in (0, span // 2, span)],
        )
    return result


def reconstruct_room(images: Images, entries: dict[str, dict], rid: str, p: dict, out: Path) -> dict:
    """Sala (T2): fundo sem móveis (ou a pintura), sombras e móveis pelo apoio de trás para a frente, muretas por cima."""
    base = p["background"] or p["picture"]
    canvas = Image.new("RGBA", (p["picture"]["rect"][2], p["picture"]["rect"][3]), (0, 0, 0, 0))
    place(canvas, images.crop(base["fileId"], base["rect"]), 0, 0)
    for f in sorted(p["furniture"], key=lambda f: (f["supportAtPx"][1], f["supportAtPx"][0], f["placementId"])):
        obj = entries[f["objectRevisionId"]]["payload"]
        x, y = f["supportAtPx"][0] - obj["supportPoint"][0], f["supportAtPx"][1] - obj["supportPoint"][1]
        if obj.get("shadow"):
            sh = obj["shadow"]
            place(canvas, images.crop(sh["fileId"], sh["rect"]), x + sh["offset"][0], y + sh["offset"][1])
        place(canvas, images.crop(obj["fileId"], obj["rect"]), x, y)
    if p["overlay"]:
        place(canvas, images.crop(p["overlay"]["fileId"], p["overlay"]["rect"]), 0, 0)
    return {
        "projection": p["projection"],
        "floorPlan": p["floorPlan"]["size"],
        "floorCells": sum(1 for c in p["floorPlan"]["cells"] if c),
        "doors": {d["doorId"]: d["side"] for d in p["doors"]},
        "furniture": [f["placementId"] for f in p["furniture"]],
        "exposedAreas": [a["status"] for a in p["exposedAreas"]],
        "connections": [[c["doorId"], c["toRoomRevisionId"], c["toDoorId"]] for c in p["connections"]],
        "file": save(canvas, out, rid, "room.png"),
    }


# D1: fala = sequência de visemes da expressão com `durationMs` inteiro por passo (o plano é a autoridade).
def reconstruct_speech(images: Images, entries: dict[str, dict], rid: str, p: dict, out: Path) -> dict:
    expression = entries[p["expressionRevisionId"]]["payload"]
    frames = {v["visemeId"]: v for v in expression["visemes"]}
    saved: dict[str, str] = {}
    sequence = []
    at = 0
    for step in p["timeline"]:
        v = frames.get(step["visemeId"])
        if v is None:
            raise Rejected(f"{rid}: viseme {step['visemeId']} ausente na expressão {p['expressionRevisionId']}")
        if step["visemeId"] not in saved:
            saved[step["visemeId"]] = save(images.crop(v["fileId"], v["rect"]), out, rid, f"viseme-{step['visemeId']}.png")
        sequence.append({"visemeId": step["visemeId"], "startMs": at, "durationMs": step["durationMs"], "textPosition": step["textPosition"], "file": saved[step["visemeId"]]})
        at += step["durationMs"]
    return {"textKey": p["textKey"], "language": p["language"], "text": p["sampleText"], "expression": p["expressionRevisionId"], "timing": p.get("timing"), "sequence": sequence, "totalMs": at}


# D1: fonte bitmap = atlas + métricas; glyph ausente vira caixa de diagnóstico, nunca outro glyph.
FONT_TEST_STRINGS = ["Ação, Poção, Coração — ÁRVORE", "Inventário", "0123456789", ".,;:!?'\"-()/…%+="]


def render_text(images: Images, p: dict, text: str) -> tuple[Image.Image, dict]:
    glyphs = {g["codepoint"]: g for g in p["glyphs"]}
    kerning = {(k["left"], k["right"]): k["amount"] for k in p["kerning"]}
    m = p["metrics"]
    box = max(3, m["spaceAdvance"])
    lines: list[list[tuple[str, int, dict | None]]] = [[]]
    widths = [0]
    missing = []
    prev = None
    for pos, ch in enumerate(unicodedata.normalize("NFC", text)):
        if ch == "\n":
            lines.append([])
            widths.append(0)
            prev = None
            continue
        if ch == " ":
            widths[-1] += m["spaceAdvance"]
            prev = None
            continue
        cp = ord(ch)
        g = glyphs.get(cp)
        if prev is not None:
            widths[-1] += kerning.get((prev, cp), 0)
        if g is None:
            missing.append({"char": ch, "position": pos})
            lines[-1].append(("missing", widths[-1], None))
            widths[-1] += box + 1
        else:
            lines[-1].append(("glyph", widths[-1] + g["bearingX"], g))
            widths[-1] += g["advanceX"]
        prev = cp
    canvas = Image.new("RGBA", (max(1, max(widths)), len(lines) * m["lineHeight"]), (0, 0, 0, 0))
    for li, line in enumerate(lines):
        top = li * m["lineHeight"]
        for kind, x, g in line:
            if g is None:
                for yy in range(top, top + m["ascent"]):
                    for xx in (x, x + box - 1):
                        canvas.putpixel((xx, yy), (255, 0, 80, 255))
                continue
            canvas.alpha_composite(images.crop(g["fileId"], g["rect"]), dest=(x, top + m["ascent"] + g["bearingY"]))
    return canvas, {"width": max(widths), "lines": len(lines), "missing": missing}


def reconstruct_font(images: Images, rid: str, p: dict, out: Path) -> dict:
    present = {g["codepoint"] for g in p["glyphs"]}
    unbacked = [c for c in p["declaredCoverage"] if c not in present]
    if unbacked:
        raise Rejected(f"{rid}: cobertura declarada sem glyph: {unbacked[:8]}")
    renders = []
    for i, text in enumerate(FONT_TEST_STRINGS):
        img, info = render_text(images, p, text)
        zoom = img.resize((img.width * 3, img.height * 3), Image.Resampling.NEAREST)
        renders.append({"text": text, **info, "file": save(img, out, rid, f"text-{i}.png"), "zoom3": save(zoom, out, rid, f"text-{i}-x3.png"), "size": [img.width, img.height]})
    origins: dict[str, int] = {}
    for g in p["glyphs"]:
        origins[g["origin"]] = origins.get(g["origin"], 0) + 1
    return {"metrics": p["metrics"], "nativeGlyphPx": p["nativeGlyphPx"], "glyphs": len(p["glyphs"]), "origins": origins, "ttfCoverage": (p["ttf"] or {}).get("inspectedCoverage"), "missingGlyph": p["missingGlyph"]["policy"], "renders": renders}


# ---------------------------------------------------------------------------
# UI (U3): nine-slice, barra, slot e tela com âncoras
# ---------------------------------------------------------------------------


def js_round(v: float) -> int:
    """Arredondamento de `Math.round` (meio para cima), o mesmo do Studio."""
    return math.floor(v + 0.5)


def nine_slice(img: Image.Image, insets: dict | None, size: tuple[int, int]) -> Image.Image:
    """Cantos intactos; bordas esticam num eixo e o centro nos dois (vizinho mais próximo)."""
    tw, th = size
    if not insets or (tw, th) == img.size:
        return img if (tw, th) == img.size else img.resize((tw, th), Image.Resampling.NEAREST)
    sw, sh = img.size
    sx = [0, insets["left"], sw - insets["right"], sw]
    sy = [0, insets["top"], sh - insets["bottom"], sh]
    dx = [0, insets["left"], tw - insets["right"], tw]
    dy = [0, insets["top"], th - insets["bottom"], th]
    canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    for j in range(3):
        for i in range(3):
            src = (sx[i], sy[j], sx[i + 1], sy[j + 1])
            w, h = dx[i + 1] - dx[i], dy[j + 1] - dy[j]
            if src[2] <= src[0] or src[3] <= src[1] or w <= 0 or h <= 0:
                continue
            canvas.alpha_composite(img.crop(src).resize((w, h), Image.Resampling.NEAREST), dest=(dx[i], dy[j]))
    return canvas


def meter_fill(value: float, rng: dict, useful: list[int], axis: str, direction: str) -> list[int]:
    t = min(1.0, max(0.0, (value - rng["min"]) / (rng["max"] - rng["min"])))
    x, y, w, h = useful
    if axis == "horizontal":
        fw = math.floor(w * t)
        return [x, y, fw, h] if direction == "forward" else [x + w - fw, y, fw, h]
    fh = math.floor(h * t)
    return [x, y + h - fh, w, fh] if direction == "forward" else [x, y, w, fh]


def render_meter(images: Images, p: dict, value: float) -> tuple[Image.Image, int]:
    """Trilho, a parte visível do preenchimento (arredondada para baixo) e a moldura inteira por cima."""
    canvas = Image.new("RGBA", tuple(p["logicalSize"]), (0, 0, 0, 0))
    canvas.alpha_composite(images.crop(p["track"]["fileId"], p["track"]["rect"]))
    vx, vy, vw, vh = meter_fill(value, p["range"], p["usefulRect"], p["axis"], p["direction"])
    fx, fy = p["fill"]["offset"]
    fr = p["fill"]["rect"]
    x0, y0, x1, y1 = max(vx, fx), max(vy, fy), min(vx + vw, fx + fr[2]), min(vy + vh, fy + fr[3])
    visible = 0
    if x1 > x0 and y1 > y0:
        part = images.crop(p["fill"]["fileId"], [fr[0] + x0 - fx, fr[1] + y0 - fy, x1 - x0, y1 - y0])
        canvas.alpha_composite(part, dest=(x0, y0))
        visible = (x1 - x0) if p["axis"] == "horizontal" else (y1 - y0)
    canvas.alpha_composite(images.crop(p["frame"]["fileId"], p["frame"]["rect"]))
    return canvas, visible


def state_image(images: Images, p: dict, state: str | None, fallback: str) -> tuple[Image.Image, str]:
    by = {s["state"]: s for s in p["states"]}
    chosen = state if state in by else fallback if fallback in by else p["states"][0]["state"]
    s = by[chosen]
    return images.crop(s["fileId"], s["rect"]), chosen


def instance_art(images: Images, entries: dict[str, dict], inst: dict, size: tuple[int, int]) -> tuple[Image.Image | None, str | None]:
    """Arte de uma instância no tamanho do retângulo (componentes) ou na origem (imagens)."""
    rid = inst["componentRevisionId"]
    if rid is None:
        return None, None
    e = entries[rid]
    p = e["payload"]
    ov = inst["overrides"]
    if e["family"] == "ui" and e["kind"] == "menu_item":
        e = entries[p["buttonRevisionId"]]
        p = e["payload"]
    if e["family"] == "ui" and e["kind"] == "button":
        img, state = state_image(images, p, ov.get("state"), "normal")
        return nine_slice(img, p["nineSlice"], size) if p["nineSlice"] else img, state
    if e["family"] == "ui" and e["kind"] == "panel":
        return nine_slice(images.crop(p["image"]["fileId"], p["image"]["rect"]), p["nineSlice"], size), None
    if e["family"] == "ui" and e["kind"] == "slot":
        default = "occupied" if ov.get("iconRevisionId") else "empty"
        img, state = state_image(images, p, ov.get("state"), default)
        img = img.copy()
        icon_rid = ov.get("iconRevisionId")
        if icon_rid:
            rep = entries[icon_rid]["payload"]["representations"][0]
            icon = images.crop(rep["fileId"], rep["rect"])
            ix, iy, iw, ih = p["iconRect"]
            place(img, icon, ix + (iw - icon.width) // 2, iy + (ih - icon.height) // 2)
        return img, state
    if e["family"] == "ui" and e["kind"] == "meter":
        img, _ = render_meter(images, p, ov.get("value", p["range"]["max"]))
        return img, None
    if e["family"] == "item":
        rep = p["representations"][0]
        return images.crop(rep["fileId"], rep["rect"]), None
    if e["family"] == "character" and e["kind"] == "base":
        v = p["views"][0]
        return images.crop(v["fileId"], v["rect"]), None
    if e["family"] == "portrait" and "fileId" in p:
        return images.crop(p["fileId"], p["rect"]), None
    return None, None


def layout_screen(p: dict, resolution: tuple[int, int]) -> list[tuple[dict, list[int], bool]]:
    """Hierarquia → retângulos: lado = origem do pai + fração × dimensão do pai + deslocamento (pais antes dos filhos)."""
    index = {inst["instanceId"]: n for n, inst in enumerate(p["instances"])}
    children: dict[str | None, list[dict]] = {}
    for inst in p["instances"]:
        children.setdefault(inst["parentId"], []).append(inst)
    for lst in children.values():
        lst.sort(key=lambda i: (i["order"], index[i["instanceId"]]))
    out: list[tuple[dict, list[int], bool]] = []

    def visit(inst: dict, parent: list[int], visible: bool) -> None:
        px, py, pw, ph = parent
        a, o = inst["anchors"], inst["offsets"]
        left = js_round(px + a["left"] * pw + o["left"])
        right = js_round(px + a["right"] * pw + o["right"])
        top = js_round(py + a["top"] * ph + o["top"])
        bottom = js_round(py + a["bottom"] * ph + o["bottom"])
        rect = [left, top, max(0, right - left), max(0, bottom - top)]
        vis = visible and not inst["hidden"]
        out.append((inst, rect, vis))
        for child in children.get(inst["instanceId"], []):
            visit(child, rect, vis)

    for root in children.get(None, []):
        visit(root, [0, 0, resolution[0], resolution[1]], True)
    return out


def reconstruct_screen(images: Images, entries: dict[str, dict], rid: str, p: dict, out: Path) -> dict:
    resolutions = p.get("testedResolutions") or [p["referenceResolution"]]
    layouts: dict[str, dict] = {}
    files: dict[str, str] = {}
    states: dict[str, str] = {}
    bg = p["background"]
    for res in resolutions:
        key = f"{res[0]}x{res[1]}"
        canvas = Image.new("RGBA", (res[0], res[1]), (0, 0, 0, 0))
        if bg and bg["exported"] and bg["revisionId"] in entries:
            be = entries[bg["revisionId"]]
            region = be["payload"].get("image") or be["payload"]
            if "fileId" in region:
                place(canvas, images.crop(region["fileId"], region["rect"]), 0, 0)
        rects = {}
        for inst, rect, visible in layout_screen(p, (res[0], res[1])):
            rects[inst["instanceId"]] = rect
            if not visible or rect[2] <= 0 or rect[3] <= 0:
                continue
            art, state = instance_art(images, entries, inst, (rect[2], rect[3]))
            if state:
                states[inst["instanceId"]] = state
            if art is not None:
                place(canvas, art, rect[0], rect[1])
        layouts[key] = rects
        files[key] = save(canvas, out, rid, f"screen-{key}.png")
    catalog = p.get("textCatalog") or {"languages": [], "entries": []}
    return {
        "referenceResolution": p["referenceResolution"],
        "background": bg,
        "hierarchy": [
            {
                "instanceId": i["instanceId"],
                "parentId": i["parentId"],
                "role": i.get("role"),
                "componentRevisionId": i["componentRevisionId"],
                "kind": entries[i["componentRevisionId"]]["kind"] if i["componentRevisionId"] else ("text" if i.get("text") else "group"),
                "order": i["order"],
                "hidden": i["hidden"],
                "textKey": i["overrides"].get("textKey") or (i.get("text") or {}).get("key"),
                "grid": i.get("layout"),
                "overrides": i["overrides"],
            }
            for i in p["instances"]
        ],
        "layouts": layouts,
        "states": states,
        "focusOrder": p["focusOrder"],
        "languages": catalog["languages"],
        "textKeys": [en["key"] for en in catalog["entries"]],
        "files": files,
    }


def reconstruct_ui(images: Images, entries: dict[str, dict], rid: str, kind: str, p: dict, out: Path) -> dict:
    if kind == "panel":
        img = images.crop(p["image"]["fileId"], p["image"]["rect"])
        grown = nine_slice(img, p["nineSlice"], (p["logicalSize"][0] * 3, p["logicalSize"][1] * 2))
        return {"nineSlice": p["nineSlice"], "contentPadding": p["contentPadding"], "minSize": p["minSize"], "file": save(img, out, rid, "panel.png"), "grown": save(grown, out, rid, "panel-grown.png")}
    if kind == "slot":
        return {
            "states": {s["state"]: save(images.crop(s["fileId"], s["rect"]), out, rid, f"{s['state']}.png") for s in p["states"]},
            "origins": {s["state"]: (s.get("origin") or {}).get("kind") for s in p["states"]},
            "iconRect": p["iconRect"],
            "counterAnchor": p["counterAnchor"],
            "complete": p["complete"],
        }
    if kind == "meter":
        fills = {}
        for value in (p["range"]["min"], p["range"]["min"] + (p["range"]["max"] - p["range"]["min"]) / 4, p["range"]["max"]):
            img, visible = render_meter(images, p, value)
            fills[str(round(value))] = {"visiblePx": visible, "file": save(img, out, rid, f"value-{round(value)}.png")}
        return {"axis": p["axis"], "direction": p["direction"], "range": p["range"], "usefulRect": p["usefulRect"], "fills": fills}
    if kind == "menu_item":
        return {"actionId": p["actionId"], "textKey": p["text"]["key"], "sample": p["text"]["sample"], "shortcut": p["shortcut"], "selectable": p["selectable"], "button": p["buttonRevisionId"]}
    if kind == "screen":
        return reconstruct_screen(images, entries, rid, p, out)
    return {}


def reconstruct(entries: dict[str, dict], files: dict[str, dict], out: Path) -> list[dict]:
    images = Images(files)
    summary = []
    for rid, e in entries.items():
        p = e["payload"]
        item: dict = {"revisionId": rid, "family": e["family"], "kind": e["kind"], "name": e.get("name")}
        if e["family"] == "vfx":
            frames = []
            for f in p["frames"]:
                layers = [] if f["fileId"] is None else [(images.crop(f["fileId"], f["rect"]), f["sourceOffset"])]
                frames.append({"frameId": f["frameId"], "durationMs": f["durationMs"], "file": save(compose(p["logicalSize"], layers), out, rid, f"{f['frameId']}.png")})
            item.update(logicalSize=p["logicalSize"], pivot=p["pivot"], loop=p["loop"], blendMode=p["blendMode"], frames=frames)
        elif e["family"] == "character" and e["kind"] == "clip":
            item.update(logicalSize=p["logicalSize"], pivot=p["pivot"], action=p["action"], direction=p["direction"], frames=clip_frames(images, p, out, rid))
            item["events"] = [{"frameId": ev["frameId"], "vfx": (ev["vfx"] or {}).get("revisionId"), "audio": (ev["audio"] or {}).get("revisionId")} for ev in p["events"]]
            # S3: estado (ex.: baú `closed`), repetição e quantos ms o clipe dura.
            item.update(state=p["state"], playback=p["playback"], totalMs=sum(f["durationMs"] for f in p["frames"]))
        elif e["family"] == "character" and e["kind"] == "base":
            # S3: vistas por direção do estado/objeto, reconstruídas na célula lógica com o apoio no chão.
            views = {v["direction"]: save(compose(p["logicalSize"], [(images.crop(v["fileId"], v["rect"]), v["sourceOffset"])]), out, rid, f"view-{v['direction']}.png") for v in p["views"]}
            item.update(logicalSize=p["logicalSize"], groundOrigin=p["groundOrigin"], state=p["state"], subject=p.get("subject", "character"), predecessor=p["predecessorRevisionId"], views=views)
        elif e["family"] == "equipment" and e["kind"] == "loadout":
            overlays = [entries[o]["payload"] for o in p["overlayRevisionIds"]]
            item["clips"] = []
            item["sheets"] = []
            for c in p["clips"]:
                clip = entries[c["clipRevisionId"]]["payload"]
                frames = clip_frames(images, clip, out, c["clipRevisionId"], overlays, p["overlayRevisionIds"], p)
                # S2: a folha achatada precisa ser a recomposição exata das camadas, pixel a pixel.
                sheet = next((s for s in p.get("sheets", []) if s["clipRevisionId"] == c["clipRevisionId"]), None)
                if sheet:
                    rendered = {f["frameId"]: f["_image"] for f in frames}
                    bad = [sf["frameId"] for sf in sheet["frames"] if images.crop(sheet["fileId"], sf["rect"]).tobytes() != rendered[sf["frameId"]].tobytes()]
                    item["sheets"].append({"clipRevisionId": c["clipRevisionId"], "frames": len(sheet["frames"]), "matches": not bad, "mismatchedFrames": bad})
                for f in frames:
                    f.pop("_image", None)
                item["clips"].append({"action": c["action"], "direction": c["direction"], "pivot": clip["pivot"], "logicalSize": clip["logicalSize"], "frames": frames})
            item.update(stance=p["stance"], omitted=p.get("omitted", []))
        elif e["family"] == "item":
            item["representations"] = [
                {"role": r["role"], "state": r["state"], "pivot": r["pivot"], "file": save(compose(r["logicalSize"], [(images.crop(r["fileId"], r["rect"]), r["sourceOffset"])]), out, rid, f"{r['role']}-{r['state']}.png")}
                for r in p["representations"]
            ]
        elif e["family"] == "ui" and e["kind"] == "button":
            item["states"] = {s["state"]: save(images.crop(s["fileId"], s["rect"]), out, rid, f"{s['state']}.png") for s in p["states"]}
            item.update(nineSlice=p["nineSlice"], contentPadding=p["contentPadding"], focus=(p["focus"] or {}).get("mode"), textKey=(p["text"] or {}).get("key"))
            # U3: origem de cada aparência (recorte do template, referência, transformação local) e completude.
            item.update(origins={s["state"]: (s.get("origin") or {}).get("kind") for s in p["states"]}, complete=p["complete"], requiredStates=p["requiredStates"])
        elif e["family"] == "ui":
            # U3: painel, slot, barra, item de menu e tela reconstruídos pelas mesmas regras do Studio.
            item.update(reconstruct_ui(images, entries, rid, e["kind"], p, out))
        elif e["family"] == "tileset" and e["kind"] == "isometric":
            item.update(diamond=p["groundDiamondSize"], pieces={pc["pieceKey"]: {"kind": pc["kind"], "supportPoint": pc["supportPoint"], "footprintCells": pc["footprintCells"]} for pc in p["pieces"]})
        elif e["family"] == "tileset" and e["kind"] == "sidescroller":
            configs = sorted({t["configuration"] for t in p["tiles"]})
            missing = [c for c in p["requiredConfigurations"] if c not in configs]
            item.update(cellSize=p["cellSize"], configurations=configs, missing=missing, complete=p["complete"] and not missing)
        elif e["family"] == "tileset":
            masks = sorted({t["mask"] for t in p["tiles"]})
            item.update(cellSize=p["cellSize"], masks=masks, complete=p["complete"] and masks == list(range(16)))
        elif e["family"] == "map" and e["kind"] == "object":
            item.update(supportPoint=p["supportPoint"], footprintCells=p["footprintCells"], collision=p["collision"], shadow=bool(p.get("shadow")), sourceRoom=(p.get("sourceRoom") or {}).get("roomRevisionId"))
        elif e["family"] == "map" and e["kind"] == "tilemap":
            item.update(reconstruct_tilemap(images, entries, rid, p, out))
        elif e["family"] == "map" and e["kind"] == "scene":
            item.update(reconstruct_scene(images, entries, rid, p, out))
        elif e["family"] == "map" and e["kind"] == "scene_layer":
            item.update(depth=p["depth"], obtained=p["obtained"], repeat=p["repeat"], groundLineY=p["groundLineY"], file=save(images.crop(p["fileId"], p["rect"]), out, rid, "layer.png"))
        elif e["family"] == "map" and e["kind"] == "room":
            item.update(reconstruct_room(images, entries, rid, p, out))
        elif e["family"] == "portrait" and e["kind"] == "portrait":
            item.update(logicalSize=p["logicalSize"], faceAnchor=p["faceAnchor"], faceRect=p.get("faceRect"), mouthRect=p.get("mouthRect"), character=p["characterRevisionId"], file=save(images.crop(p["fileId"], p["rect"]), out, rid, "portrait.png"))
        elif e["family"] == "portrait" and e["kind"] == "expression":
            frames = {v["visemeId"]: save(images.crop(v["fileId"], v["rect"]), out, rid, f"{v['visemeId']}.png") for v in p["visemes"]}
            item.update(expressionKey=p["expressionKey"], portrait=p["portraitRevisionId"], visemes=[v["visemeId"] for v in p["visemes"]], visemeSet=p.get("visemeSet"), grid=p.get("grid"), frames=frames)
        elif e["family"] == "portrait" and e["kind"] == "speech":
            item.update(reconstruct_speech(images, entries, rid, p, out))
        elif e["family"] == "font":
            item.update(reconstruct_font(images, rid, p, out))
        elif e["family"] == "audio":
            f = files[p["fileId"]]
            item.update(durationMs=f["durationMs"], sampleRate=f["sampleRate"], channels=f["channels"], loop=p["loop"])
        summary.append(item)
    return summary


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 64
    zip_path, out = Path(argv[0]), Path(argv[1])
    try:
        extracted = out / "extracted"
        safe_extract(zip_path, extracted)
        manifest = load_manifest(extracted)
        files = verify_files(extracted, manifest)
        entries = check_dependencies(manifest)
        summary = reconstruct(entries, files, out)
    except (Rejected, zipfile.BadZipFile, KeyError, json.JSONDecodeError) as exc:
        print(f"pacote recusado: {exc}", file=sys.stderr)
        return 2
    report = {"schemaVersion": manifest["schemaVersion"], "projectId": manifest["projectId"], "profile": manifest["profile"], "files": len(files), "entries": summary}
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(f"ok: {len(summary)} revisões, {len(files)} arquivos verificados")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
