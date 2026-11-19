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
import sys
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


def clip_frames(images: Images, clip: dict, out: Path, rid: str, overlays: list[dict] | None = None) -> list[dict]:
    frames = []
    for frame in clip["frames"]:
        layers = [(i, layer["partId"], images.crop(layer["fileId"], layer["rect"]), layer["offset"]) for i, layer in enumerate(frame["layers"])]
        for ov in overlays or []:
            for part in ov["parts"]:
                for cell in part["coverage"]:
                    if cell["clipRevisionId"] == rid and cell["frameId"] == frame["frameId"] and cell["layer"]:
                        lay = cell["layer"]
                        layers.append((cell["drawIndex"], part["partId"], images.crop(lay["fileId"], lay["rect"]), lay["offset"]))
        layers.sort(key=lambda t: t[0])  # ordem de desenho; sort é estável para empates
        img = compose(clip["logicalSize"], [(im, off) for _, _, im, off in layers])
        frames.append({
            "frameId": frame["frameId"],
            "durationMs": frame["durationMs"],
            "layers": [name for _, name, _, _ in layers],
            "sockets": {s["socketId"]: s["at"] for s in frame["sockets"]},
            "file": save(img, out, rid if overlays is None else f"loadout-{rid}", f"{frame['frameId']}.png"),
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
        elif e["family"] == "equipment" and e["kind"] == "loadout":
            overlays = [entries[o]["payload"] for o in p["overlayRevisionIds"]]
            item["clips"] = []
            for c in p["clips"]:
                clip = entries[c["clipRevisionId"]]["payload"]
                item["clips"].append({"action": c["action"], "direction": c["direction"], "pivot": clip["pivot"], "frames": clip_frames(images, clip, out, c["clipRevisionId"], overlays)})
        elif e["family"] == "item":
            item["representations"] = [
                {"role": r["role"], "state": r["state"], "pivot": r["pivot"], "file": save(compose(r["logicalSize"], [(images.crop(r["fileId"], r["rect"]), r["sourceOffset"])]), out, rid, f"{r['role']}-{r['state']}.png")}
                for r in p["representations"]
            ]
        elif e["family"] == "ui" and e["kind"] == "button":
            item["states"] = {s["state"]: save(images.crop(s["fileId"], s["rect"]), out, rid, f"{s['state']}.png") for s in p["states"]}
            item.update(nineSlice=p["nineSlice"], contentPadding=p["contentPadding"], focus=(p["focus"] or {}).get("mode"), textKey=(p["text"] or {}).get("key"))
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
            item.update(supportPoint=p["supportPoint"], footprintCells=p["footprintCells"], collision=p["collision"])
        elif e["family"] == "map" and e["kind"] == "tilemap":
            item.update(reconstruct_tilemap(images, entries, rid, p, out))
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
