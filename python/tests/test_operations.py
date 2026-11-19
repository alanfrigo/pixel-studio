"""Amostras obrigatórias do plano 05 (§amostras), pelo protocolo real (subprocesso)."""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from PIL import Image

from pixel_pipeline.operations import composite_protected
from pixel_pipeline.protocol import PipelineError

REPO = Path(__file__).resolve().parents[2]
REQUEST_SCHEMA = json.loads((REPO / "schemas" / "v1" / "python-request.schema.json").read_text())
RESPONSE_SCHEMA = json.loads((REPO / "schemas" / "v1" / "python-response.schema.json").read_text())

GREEN = (0, 200, 0, 255)
STEEL = (180, 180, 190, 255)
RIVET = (90, 200, 10, 255)  # perto do verde, mas fora da tolerância 30


def png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


class Pipeline:
    def __init__(self, workdir: Path):
        self.workdir = workdir
        self.n = 0

    def run(self, operation: str, recipe: dict, inputs: list[tuple[str, bytes]], *, validate_request=True, input_hashes=None) -> dict:
        self.n += 1
        work = self.workdir / f"run{self.n}"
        (work / "in").mkdir(parents=True)
        entries = []
        for ordinal, (role, data) in enumerate(inputs):
            rel = f"in/{ordinal}-{role}.png"
            (work / rel).write_bytes(data)
            sha = (input_hashes or {}).get(ordinal, hashlib.sha256(data).hexdigest())
            entries.append({"ordinal": ordinal, "role": role, "sha256": sha, "relPath": rel})
        request = {"protocolVersion": 1, "jobId": "job_1", "attemptId": "att_1", "operation": operation, "inputs": entries, "recipe": {"version": 1, **recipe}}
        if validate_request:
            Draft202012Validator(REQUEST_SCHEMA).validate(request)
        proc = subprocess.run([sys.executable, "-I", "-m", "pixel_pipeline"], input=json.dumps(request).encode(), cwd=work, capture_output=True, timeout=60, check=True)
        response = json.loads(proc.stdout)
        Draft202012Validator(RESPONSE_SCHEMA).validate(response)
        response["_dir"] = work
        return response

    @staticmethod
    def image(response: dict, role: str, key: str | None = None) -> Image.Image:
        out = next(o for o in response["outputs"] if o["role"] == role and (key is None or o.get("key") == key))
        im = Image.open(response["_dir"] / out["relPath"])
        im.load()
        return im


@pytest.fixture
def pipe(tmp_path):
    return Pipeline(tmp_path)


# ---------------------------------------------------------------------------
# Escudo vazado em fundo verde
# ---------------------------------------------------------------------------


def shield() -> Image.Image:
    """16×16: fundo verde; anel de aço; vão interno verde FECHADO em (7..8, 7..8); rebite colado ao fundo em (3, 0)."""
    im = Image.new("RGBA", (16, 16), GREEN)
    for y in range(3, 13):
        for x in range(3, 13):
            im.putpixel((x, y), STEEL)
    for y in (7, 8):
        for x in (7, 8):
            im.putpixel((x, y), GREEN)  # detalhe verde isolado no centro
    im.putpixel((3, 2), GREEN)
    return im


def flood(pipe, image, seeds, keep=None, remove=None, tolerance=30):
    inputs = [("source", png(image))]
    if keep is not None:
        inputs.append(("keepMask", png(keep)))
    if remove is not None:
        inputs.append(("removeMask", png(remove)))
    return pipe.run("remove_background_flood", {"color": "#00c800", "tolerance": tolerance, "seeds": seeds, "connectivity": 4}, inputs)


def test_shield_border_flood_keeps_enclosed_detail(pipe):
    r = flood(pipe, shield(), {"borders": True, "points": []})
    assert r["status"] == "ok"
    out = Pipeline.image(r, "cutout")
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((7, 7)) == GREEN  # vão fechado não é alcançado pelo preenchimento externo
    assert out.getpixel((5, 5)) == STEEL
    assert out.getpixel((0, 0))[:3] == GREEN[:3]  # só o alfa muda


def test_shield_interior_seed_removes_only_chosen_hole(pipe):
    r = flood(pipe, shield(), {"borders": False, "points": [[7, 7]]})
    out = Pipeline.image(r, "cutout")
    assert [out.getpixel(p)[3] for p in [(7, 7), (8, 8)]] == [0, 0]
    assert out.getpixel((0, 0)) == GREEN  # fundo externo intacto
    assert r["report"]["removedPixels"] == 4


def test_keep_brush_protects_rivet_adjacent_to_background(pipe):
    image = shield()
    image.putpixel((1, 1), GREEN)
    keep = Image.new("L", (16, 16), 0)
    keep.putpixel((0, 0), 255)  # protege um pixel de fundo marcado pelo artista
    r = flood(pipe, image, {"borders": True, "points": []}, keep=keep)
    out = Pipeline.image(r, "cutout")
    assert out.getpixel((0, 0)) == GREEN
    assert out.getpixel((1, 1))[3] == 0


def test_remove_brush_and_mask_validation(pipe):
    remove = Image.new("L", (16, 16), 0)
    remove.putpixel((5, 5), 255)
    out = Pipeline.image(flood(pipe, shield(), {"borders": True, "points": []}, remove=remove), "cutout")
    assert out.getpixel((5, 5))[3] == 0
    gray = Image.new("L", (16, 16), 128)
    assert flood(pipe, shield(), {"borders": True, "points": []}, remove=gray)["error"]["code"] == "invalid_request"
    small = Image.new("L", (8, 8), 0)
    assert flood(pipe, shield(), {"borders": True, "points": []}, keep=small)["error"]["code"] == "geometry_mismatch"


# ---------------------------------------------------------------------------
# Faixa de energia com alfa parcial
# ---------------------------------------------------------------------------


def energy() -> Image.Image:
    im = Image.new("RGBA", (24, 12), (0, 0, 0, 0))
    for x in range(6, 18):
        im.putpixel((x, 5), (120, 220, 255, 255))
        im.putpixel((x, 4), (120, 220, 255, 128))
        im.putpixel((x, 6), (120, 220, 255, 64))
    im.putpixel((3, 2), (255, 255, 255, 64))  # partícula solta
    im.putpixel((20, 9), (255, 255, 255, 128))
    return im


def test_vfx_partial_alpha_survives_crop_and_compose(pipe):
    r = pipe.run("crop_to_content", {"padding": 1, "alphaThreshold": 0}, [("source", png(energy()))])
    assert r["report"]["sourceRect"] == [3, 2, 18, 8]
    assert r["report"]["sourceOffset"] == [2, 1]
    cropped = Pipeline.image(r, "cropped")
    assert cropped.getpixel((1, 1)) == (255, 255, 255, 64)
    assert cropped.getpixel((4, 3)) == (120, 220, 255, 128)

    composed = pipe.run("compose_layers", {"canvas": [24, 12], "layers": [{"inputOrdinal": 0, "offset": [2, 1]}]}, [("layer", png(cropped))])
    assert Pipeline.image(composed, "composite").tobytes() == energy().tobytes()


# ---------------------------------------------------------------------------
# Tira: salto, célula vazia intencional, margem invadida
# ---------------------------------------------------------------------------


def strip(stray=False) -> Image.Image:
    """4 células 16×16 com 2 px de espaço: pé no chão, salto, célula vazia, recuperação."""
    im = Image.new("RGBA", (16 * 4 + 2 * 3, 16), (0, 0, 0, 0))
    for cell, top in ((0, 10), (1, 4), (3, 10)):
        x0 = cell * 18
        for y in range(top, top + 5):
            for x in range(x0 + 6, x0 + 10):
                im.putpixel((x, y), (200, 60, 60, 255))
    if stray:
        im.putpixel((16, 3), (255, 255, 255, 255))  # lâmina vazou para o espaço entre células
    return im


def slice_recipe(**over):
    recipe = {
        "grid": {"rows": 1, "columns": 4, "cell": [16, 16], "margin": [0, 0], "spacing": [2, 0], "traversal": "row_major"},
        "frameIds": ["stand", "jump", "recover"],
        "durationMs": [120, 80, 140],
        "pivot": [8, 15],
        "emptyCells": [2],
    }
    recipe.update(over)
    return recipe


def test_strip_slices_keep_cell_and_pivot(pipe):
    r = pipe.run("slice_grid", slice_recipe(), [("source", png(strip()))])
    assert r["status"] == "ok"
    frames = r["report"]["frames"]
    assert [f["frameId"] for f in frames] == ["stand", "jump", "recover"]
    assert [f["rect"] for f in frames] == [[0, 0, 16, 16], [18, 0, 16, 16], [54, 0, 16, 16]]
    assert r["report"]["pivot"] == [8, 15]
    # Salto preservado: o conteúdo sobe na célula, sem recentralizar.
    assert frames[0]["contentBox"] == [6, 10, 4, 5]
    assert frames[1]["contentBox"] == [6, 4, 4, 5]
    assert all(Pipeline.image(r, "frame", f["frameId"]).size == (16, 16) for f in frames)
    assert r["report"]["emptyCells"] == [{"cell": 2, "rect": [36, 0, 16, 16], "transparent": True}]


def test_stray_pixel_in_spacing_is_diagnosed_with_coordinates(pipe):
    r = pipe.run("slice_grid", slice_recipe(), [("source", png(strip(stray=True)))])
    assert r["status"] == "needs_review"
    assert r["report"]["strayPixels"][0] == [16, 3]
    assert "(16, 3)" in r["warnings"][0]["pt-BR"] and "(16, 3)" in r["warnings"][0]["en"]


def test_wrong_grid_dimensions_are_explained(pipe):
    recipe = slice_recipe(grid={"rows": 1, "columns": 4, "cell": [16, 16], "margin": [0, 0], "spacing": [0, 0], "traversal": "row_major"})
    r = pipe.run("slice_grid", recipe, [("source", png(strip()))])
    assert r["error"]["code"] == "geometry_mismatch"
    assert "64×16" in r["error"]["message"]["pt-BR"] and "declared grid requires 64×16" in r["error"]["message"]["en"]


# ---------------------------------------------------------------------------
# Camadas que se cruzam: composição reproduz a folha achatada
# ---------------------------------------------------------------------------


def test_layer_order_reproduces_flat_sheet_and_matters(pipe):
    sleeve = Image.new("RGBA", (8, 2), (200, 0, 0, 255))
    sword = Image.new("RGBA", (2, 8), (220, 220, 230, 255))
    flat = Image.new("RGBA", (12, 12), (0, 0, 0, 0))
    flat.alpha_composite(sleeve, (2, 5))
    flat.alpha_composite(sword, (5, 2))
    layers = [("layer", png(sleeve)), ("layer", png(sword))]
    a = pipe.run("compose_layers", {"canvas": [12, 12], "layers": [{"inputOrdinal": 0, "offset": [2, 5]}, {"inputOrdinal": 1, "offset": [5, 2]}]}, layers)
    assert Pipeline.image(a, "composite").tobytes() == flat.tobytes()
    b = pipe.run("compose_layers", {"canvas": [12, 12], "layers": [{"inputOrdinal": 1, "offset": [5, 2]}, {"inputOrdinal": 0, "offset": [2, 5]}]}, layers)
    assert Pipeline.image(b, "composite").getpixel((5, 5)) == (200, 0, 0, 255)
    assert Pipeline.image(a, "composite").getpixel((5, 5)) == (220, 220, 230, 255)
    out_of_bounds = pipe.run("compose_layers", {"canvas": [12, 12], "layers": [{"inputOrdinal": 0, "offset": [6, 5]}]}, layers)
    assert out_of_bounds["error"]["code"] == "geometry_mismatch"


# ---------------------------------------------------------------------------
# Máscara assimétrica de edição: proteção exata dos 4 bytes
# ---------------------------------------------------------------------------


def test_protected_pixels_restored_exactly(pipe):
    source = Image.new("RGBA", (8, 8), (10, 20, 30, 255))
    source.putpixel((0, 7), (99, 98, 97, 0))  # RGB não zero sob alfa 0
    source.putpixel((1, 7), (50, 60, 70, 64))
    candidate = Image.new("RGBA", (8, 8), (250, 0, 250, 200))  # resposta mudou tudo
    mask = Image.new("L", (8, 8), 0)
    for x in range(4, 8):
        for y in range(0, 4):
            mask.putpixel((x, y), 255)  # só o canto superior direito
    mask.putpixel((6, 1), 0)  # buraco protegido dentro da região
    r = pipe.run("composite_protected", {"maskConvention": "white_edits_black_preserves"}, [("source", png(source)), ("candidate", png(candidate)), ("editMask", png(mask))])
    out = Pipeline.image(r, "protected")
    for y in range(8):
        for x in range(8):
            expected = candidate.getpixel((x, y)) if mask.getpixel((x, y)) == 255 else source.getpixel((x, y))
            assert out.getpixel((x, y)) == expected, (x, y)
    assert r["report"]["editedPixels"] == 15


def test_composite_rejects_corruption_in_protected_rgb_even_under_zero_alpha(tmp_path, monkeypatch):
    source = Image.new("RGBA", (2, 1), (11, 22, 33, 0))
    candidate = Image.new("RGBA", source.size, GREEN)
    mask = Image.new("L", source.size)
    mask.putpixel((1, 0), 255)
    inputs = []
    for role, image in (("source", source), ("candidate", candidate), ("editMask", mask)):
        path = tmp_path / f"{role}.png"
        image.save(path)
        inputs.append({"role": role, "relPath": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

    pillow_composite = Image.composite

    def corrupt_protected_rgb(first, second, edit_mask):
        output = pillow_composite(first, second, edit_mask)
        if edit_mask.getpixel((1, 0)) == 255:
            output.putpixel((0, 0), (55, 66, 77, 0))
        return output

    monkeypatch.setattr(Image, "composite", corrupt_protected_rgb)
    with pytest.raises(PipelineError) as raised:
        composite_protected({"recipe": {"version": 1}, "inputs": inputs}, tmp_path)
    assert raised.value.code == "internal"
    assert raised.value.message["en"] == "Protected pixels differ from the source after compositing"
    assert not (tmp_path / "out").exists()


def test_protected_composite_edge_cases(pipe):
    source = png(Image.new("RGBA", (4, 4), (1, 2, 3, 255)))
    candidate = png(Image.new("RGBA", (4, 4), (9, 9, 9, 255)))
    empty = pipe.run("composite_protected", {"maskConvention": "white_edits_black_preserves"}, [("source", source), ("candidate", candidate), ("editMask", png(Image.new("L", (4, 4), 0)))])
    assert empty["status"] == "needs_review" and empty["report"]["emptyMask"] is True
    full = pipe.run("composite_protected", {"maskConvention": "white_edits_black_preserves"}, [("source", source), ("candidate", candidate), ("editMask", png(Image.new("L", (4, 4), 255)))])
    assert full["report"]["fullMask"] is True
    off_grid = pipe.run(
        "composite_protected",
        {"maskConvention": "white_edits_black_preserves"},
        [("source", source), ("candidate", png(Image.new("RGBA", (5, 4)))), ("editMask", png(Image.new("L", (4, 4), 0)))],
    )
    assert off_grid["error"]["code"] == "geometry_mismatch"


# ---------------------------------------------------------------------------
# Paleta: desempate estável e só pixels visíveis
# ---------------------------------------------------------------------------


def test_palette_tie_breaks_by_lowest_index_on_every_run(pipe):
    image = Image.new("RGBA", (3, 1), (0, 0, 0, 0))
    image.putpixel((0, 0), (10, 10, 10, 255))  # equidistante de #000000 (0) e #141414 (1)
    image.putpixel((1, 0), (10, 10, 10, 255))
    image.putpixel((2, 0), (255, 0, 0, 0))  # invisível: não conta
    recipe = {"metric": "srgb8_squared", "tieBreak": "lowest_index", "dither": False, "colors": ["#000000", "#141414"]}
    runs = [pipe.run("apply_palette", recipe, [("source", png(image))]) for _ in range(2)]
    assert runs[0]["outputs"][0]["sha256"] == runs[1]["outputs"][0]["sha256"]
    out = Pipeline.image(runs[0], "paletted")
    assert out.getpixel((0, 0)) == (0, 0, 0, 255)
    assert out.getpixel((2, 0)) == (255, 0, 0, 0)
    assert runs[0]["report"]["visibleColorsBefore"] == 1
    assert runs[0]["report"]["usedIndices"] == [0]


def test_thumbnail_uses_integer_nearest_neighbor(pipe):
    up = pipe.run("make_thumbnail", {"maxSize": 64}, [("source", png(shield()))])
    assert up["report"] == {"factor": 4, "upscale": True, "size": [64, 64], "flattenedOnto": None}
    assert Pipeline.image(up, "thumbnail").getpixel((28, 28)) == GREEN  # vão central ampliado 4×
    down = pipe.run("make_thumbnail", {"maxSize": 16}, [("source", png(Image.new("RGBA", (100, 40), (5, 5, 5, 255))))])
    assert down["report"]["size"] == [14, 5] and down["report"]["factor"] == 7


def test_same_bytes_and_recipe_same_pixels(pipe):
    args = ("remove_background_flood", {"color": "#00c800", "tolerance": 30, "seeds": {"borders": True, "points": []}, "connectivity": 4}, [("source", png(shield()))])
    a, b = pipe.run(*args), pipe.run(*args)
    assert [o["sha256"] for o in a["outputs"]] == [o["sha256"] for o in b["outputs"]]


def test_fit_logical_exact_grid_is_lossless(pipe):
    big = shield().resize((64, 64), Image.Resampling.NEAREST)  # arte 16×16 ampliada 4×
    r = pipe.run("fit_logical", {"targetSize": [16, 16]}, [("source", png(big))])
    assert r["status"] == "ok" and r["report"]["method"] == "nearest_integer" and r["report"]["lossless"] is True
    assert Pipeline.image(r, "fitted").tobytes() == shield().tobytes()


def test_fit_logical_flags_off_grid_and_aspect(pipe):
    noisy = shield().resize((64, 64), Image.Resampling.NEAREST)
    noisy.putpixel((1, 1), (1, 2, 3, 255))  # quebra a grade 4×
    r = pipe.run("fit_logical", {"targetSize": [16, 16]}, [("source", png(noisy))])
    assert r["status"] == "needs_review" and r["report"]["lossless"] is False
    wide = pipe.run("fit_logical", {"targetSize": [16, 16]}, [("source", png(Image.new("RGBA", (100, 50), (9, 9, 9, 255))))])
    assert wide["report"]["method"] == "block_mode" and wide["report"]["fittedSize"] == [16, 8] and wide["report"]["offset"] == [0, 4]
    assert any("Proporção" in w["pt-BR"] for w in wide["warnings"])


def test_encode_mask_four_quadrants(pipe):
    """Plano 03: editar só um quadrante; OpenAI recebe alfa 0 ali, máscara P&B recebe branco ali."""
    mask = Image.new("L", (8, 8), 0)
    for y in range(0, 4):
        for x in range(4, 8):
            mask.putpixel((x, y), 255)
    openai = pipe.run("encode_mask", {"encoding": "alpha_zero_edits"}, [("editMask", png(mask))])
    alpha = Pipeline.image(openai, "remote_mask").getchannel("A")
    assert alpha.getpixel((5, 1)) == 0 and alpha.getpixel((1, 1)) == 255 and alpha.getpixel((5, 6)) == 255
    white = pipe.run("encode_mask", {"encoding": "white_edits_black_preserves"}, [("editMask", png(mask))])
    out = Pipeline.image(white, "remote_mask")
    assert out.getpixel((5, 1)) == (255, 255, 255) and out.getpixel((1, 1)) == (0, 0, 0)
    assert openai["report"]["editedPixels"] == 16


def art_28() -> Image.Image:
    """Arte 28×28 assimétrica, sem fundo uniforme: blocos de cores distintas."""
    import random

    rnd = random.Random(7)
    im = Image.new("RGBA", (28, 28))
    for y in range(28):
        for x in range(28):
            im.putpixel((x, y), (rnd.randrange(0, 256, 40), rnd.randrange(0, 256, 40), rnd.randrange(0, 256, 40), 255))
    return im


@pytest.mark.parametrize("size", [28 * 32, 1024])  # célula inteira (32) e fracionária (36,57)
def test_unzoom_recovers_native_art(pipe, size):
    big = art_28().resize((size, size), Image.Resampling.NEAREST)
    r = pipe.run("unzoom", {"minAgreement": 0.9}, [("source", png(big))])
    assert r["report"]["detected"] is True and r["report"]["grid"] == [28, 28]
    assert abs(r["report"]["cell"][0] - size / 28) < 0.01
    assert Pipeline.image(r, "native").tobytes() == art_28().tobytes()


def test_unzoom_tolerates_compression_noise(pipe):
    import random

    rnd = random.Random(1)
    big = art_28().resize((1024, 1024), Image.Resampling.NEAREST)
    px = big.load()
    for _ in range(20000):
        x, y = rnd.randrange(1024), rnd.randrange(1024)
        r, g, b, a = px[x, y]
        px[x, y] = (min(255, r + 6), max(0, g - 5), b, a)
    r = pipe.run("unzoom", {"minAgreement": 0.9}, [("source", png(big))])
    assert r["report"]["grid"] == [28, 28]
    assert Pipeline.image(r, "native").tobytes() == art_28().tobytes()


def test_unzoom_keeps_image_without_grid(pipe):
    smooth = Image.linear_gradient("L").convert("RGBA")  # sem degraus regulares
    r = pipe.run("unzoom", {"minAgreement": 0.9}, [("source", png(smooth))])
    assert r["report"]["detected"] is False
    assert Pipeline.image(r, "native").size == smooth.size


def test_hue_key_removes_key_and_its_shadow_but_not_dark_outline(pipe):
    im = Image.new("RGBA", (12, 12), (163, 22, 105, 255))  # magenta escuro real do Seedream (matiz ~324°)
    for y in range(3, 9):
        for x in range(3, 9):
            im.putpixel((x, y), (45, 8, 59, 255))  # contorno roxo-escuro (matiz ~282°, brilho ~59)
    for y in range(4, 8):
        for x in range(4, 8):
            im.putpixel((x, y), (60, 200, 90, 255))
    for x in range(9, 12):
        im.putpixel((x, 9), (141, 14, 91, 255))  # sombra projetada, magenta mais escuro
    recipe = {
        "color": "#ff00ff",
        "tolerance": 0,
        "seeds": {"borders": True, "points": []},
        "connectivity": 4,
        "match": {"mode": "hue", "hueTolerance": 25, "minSaturation": 96, "keyFrom": "border"},
    }
    r = pipe.run("remove_background_flood", recipe, [("source", png(im))])
    out = Pipeline.image(r, "cutout")
    assert r["report"]["measuredKeyHue"] in range(318, 330)
    assert out.getpixel((0, 0))[3] == 0 and out.getpixel((10, 9))[3] == 0  # fundo e sombra
    assert out.getpixel((3, 3)) == (45, 8, 59, 255)  # contorno escuro tingido preservado
    assert out.getpixel((5, 5)) == (60, 200, 90, 255)


def test_fit_logical_crops_to_content_before_reducing(pipe):
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for y in range(10, 42):
        for x in range(20, 36):
            im.putpixel((x, y), (200, 0, 0, 255))  # objeto 16×32 num canvas grande
    r = pipe.run("fit_logical", {"targetSize": [16, 16], "cropToContent": {"padding": 0}}, [("source", png(im))])
    assert r["report"]["contentRect"] == [20, 10, 16, 32]
    assert r["report"]["method"] == "nearest_integer" and r["report"]["fittedSize"] == [16, 16]
    out = Pipeline.image(r, "fitted")
    assert out.getpixel((8, 8)) == (200, 0, 0, 255) and out.getpixel((0, 8))[3] == 0


def test_unzoom_ignores_gradient_background_with_key_mask(pipe):
    """Fundo da cor-chave com degradê fora da grade não pode derrubar a detecção da arte."""
    art = art_28().resize((28 * 30, 28 * 30), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", (1400, 1400))
    px = canvas.load()
    for y in range(1400):
        for x in range(1400):
            band = ((x + 2 * y) // 7) % 2  # faixas diagonais finas fora da grade (brilho do fundo)
            px[x, y] = (200, 30, 140, 255) if band else (150, 18, 100, 255)  # família magenta
    canvas.paste(art, (280, 280))  # arte desalinhada da borda (280 = 9×30 + 10): exige estimar a fase
    plain = pipe.run("unzoom", {"minAgreement": 0.9}, [("source", png(canvas))])
    keyed = pipe.run("unzoom", {"minAgreement": 0.9, "ignoreKeyHue": {"hueTolerance": 30, "minSaturation": 96, "minValue": 100}}, [("source", png(canvas))])
    assert keyed["report"]["detected"] is True and keyed["report"]["agreementOver"] == "object"
    assert abs(keyed["report"]["cell"][0] - 30) < 1.5
    assert abs(keyed["report"]["offset"][0] - 10) < 1.5
    native = Pipeline.image(keyed, "native")
    # A arte 28×28 aparece intacta dentro da grade recuperada (a partir da célula 9).
    assert native.crop((9, 9, 37, 37)).tobytes() == art_28().tobytes()
    assert plain["report"]["detected"] is False or abs(plain["report"]["cell"][0] - 30) >= 1.5


def test_off_color_background_is_reported(pipe):
    im = Image.new("RGBA", (12, 12), (40, 80, 220, 255))  # azul em vez do magenta pedido
    im.paste((60, 200, 90, 255), (4, 4, 8, 8))
    recipe = {"color": "#ff00ff", "tolerance": 0, "seeds": {"borders": True, "points": []}, "connectivity": 4, "match": {"mode": "hue", "hueTolerance": 25, "minSaturation": 96, "keyFrom": "border"}}
    r = pipe.run("remove_background_flood", recipe, [("source", png(im))])
    assert r["status"] == "needs_review" and "outra cor" in r["warnings"][0]["pt-BR"] and "another color" in r["warnings"][0]["en"]
    assert Pipeline.image(r, "cutout").getpixel((0, 0))[3] == 0


def test_thumbnail_flattens_reference_onto_key_color(pipe):
    ref = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    ref.putpixel((3, 3), (60, 200, 90, 255))
    r = pipe.run("make_thumbnail", {"maxSize": 32, "flattenOnto": "#ff00ff"}, [("source", png(ref))])
    out = Pipeline.image(r, "thumbnail")
    assert out.getpixel((0, 0)) == (255, 0, 255, 255) and out.getpixel((13, 13)) == (60, 200, 90, 255)


def test_fit_logical_binarizes_alpha_and_ignores_faint_haze(pipe):
    im = Image.new("RGBA", (64, 64), (255, 255, 255, 12))  # névoa quase invisível no canvas inteiro
    for y in range(16, 48):
        for x in range(16, 48):
            im.putpixel((x, y), (20, 120, 220, 250))  # objeto "opaco" com alfa 250
    r = pipe.run("fit_logical", {"targetSize": [32, 32], "cropToContent": {"padding": 0}, "alphaThreshold": 128}, [("source", png(im))])
    assert r["report"]["contentRect"] == [16, 16, 32, 32]  # a névoa não alarga o recorte
    assert r["report"]["method"] == "center" and r["report"]["alphaBinarized"] == 64 * 64
    out = Pipeline.image(r, "fitted")
    assert out.getchannel("A").getextrema() == (255, 255)
    assert out.getpixel((5, 5)) == (20, 120, 220, 255)


def test_fit_logical_small_content_only_scales_by_integer(pipe):
    im = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    for y in range(5, 25):
        for x in range(5, 21):
            im.putpixel((x, y), (200, 0, 0, 255) if (x + y) % 2 else (0, 0, 200, 255))  # 16×20 em xadrez
    r = pipe.run("fit_logical", {"targetSize": [32, 32], "cropToContent": {"padding": 0}}, [("source", png(im))])
    # 32/20 = 1,6: sem ampliação fracionária; o objeto fica 1× centralizado e o aviso explica.
    assert r["report"]["method"] == "center" and r["report"]["fittedSize"] == [16, 20] and r["report"]["lossless"] is True
    assert any("ocupa 16×20" in w["pt-BR"] for w in r["warnings"])
    small = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    small.paste(Image.new("RGBA", (10, 12), (9, 99, 9, 255)), (3, 3))
    r2 = pipe.run("fit_logical", {"targetSize": [32, 32], "cropToContent": {"padding": 0}}, [("source", png(small))])
    assert r2["report"]["method"] == "nearest_upscale" and r2["report"]["fittedSize"] == [20, 24]


def test_unzoom_rejects_grid_that_leaves_object_with_too_few_cells(pipe):
    from PIL import ImageDraw

    # Arte de blocos 2×2 com um brilho de 1 célula: a grade de 2 células reproduz
    # ~98% da imagem (passa na concordância), mas perde o brilho e deixa o objeto com 13 células.
    low = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    ImageDraw.Draw(low).rectangle([4, 2, 11, 14], fill=(40, 90, 220, 255), outline=(20, 20, 30, 255))
    art = low.resize((32, 32), Image.Resampling.NEAREST)
    for y in range(6, 28):
        art.putpixel((11, y), (240, 240, 250, 255))
    big = art.resize((640, 640), Image.Resampling.NEAREST)
    plain = pipe.run("unzoom", {"minAgreement": 0.9}, [("source", png(big))])
    assert plain["report"]["grid"] == [16, 16]  # sem a guarda, a grade grossa vence
    guarded = pipe.run("unzoom", {"minAgreement": 0.9, "minContentCells": 16}, [("source", png(big))])
    assert guarded["report"]["grid"] == [32, 32] and guarded["report"]["tried"][0]["coarse"] is True
    assert Pipeline.image(guarded, "native").tobytes() == art.tobytes()


# ---------------------------------------------------------------------------
# Inpainting: máscara, guia e candidato (05 §inpainting)
# ---------------------------------------------------------------------------

MASK_RECIPE = {"maskConvention": "white_edits_black_preserves"}


def lake_mask(size=(16, 16)) -> Image.Image:
    """Máscara irregular com um buraco protegido no meio."""
    mask = Image.new("L", size, 0)
    for y in range(3, 12):
        for x in range(2 + y % 3, 13):
            mask.putpixel((x, y), 255)
    mask.putpixel((8, 7), 0)
    return mask


def test_inspect_mask_counts_region_and_rejects_bad_masks(pipe):
    source = png(Image.new("RGBA", (16, 16), (1, 2, 3, 255)))
    r = pipe.run("inspect_mask", MASK_RECIPE, [("source", source), ("editMask", png(lake_mask()))])
    assert r["status"] == "ok" and r["outputs"] == []
    assert r["report"]["editedPixels"] == lake_mask().histogram()[255]
    assert r["report"]["editRect"] == [2, 3, 11, 9] and r["report"]["emptyMask"] is False
    empty = pipe.run("inspect_mask", MASK_RECIPE, [("source", source), ("editMask", png(Image.new("L", (16, 16), 0)))])
    assert empty["report"]["emptyMask"] is True and empty["report"]["editRect"] is None
    full = pipe.run("inspect_mask", MASK_RECIPE, [("source", source), ("editMask", png(Image.new("L", (16, 16), 255)))])
    assert full["report"]["fullMask"] is True
    wrong = pipe.run("inspect_mask", MASK_RECIPE, [("source", source), ("editMask", png(Image.new("L", (15, 16), 255)))])
    assert wrong["status"] == "error" and wrong["error"]["code"] == "geometry_mismatch"
    gray = pipe.run("inspect_mask", MASK_RECIPE, [("source", source), ("editMask", png(Image.new("L", (16, 16), 128)))])
    assert gray["status"] == "error" and "cinza" in gray["error"]["message"]["pt-BR"] and "gray" in gray["error"]["message"]["en"]


def test_inpaint_guide_scales_by_integer_and_marks_region(pipe):
    source = Image.new("RGBA", (16, 16), (40, 140, 60, 255))
    source.putpixel((0, 0), (200, 10, 10, 0))  # alfa 0: achatado sobre a cor dada
    r = pipe.run("inpaint_guide", {"scale": 4, "markColor": "#ff00ff", "flattenOnto": "#808080"}, [("source", png(source)), ("editMask", png(lake_mask()))])
    context, guide = Pipeline.image(r, "context"), Pipeline.image(r, "guide")
    assert context.size == guide.size == (64, 64)
    assert context.getpixel((1, 1)) == (128, 128, 128, 255) and context.getpixel((40, 40)) == (40, 140, 60, 255)
    assert guide.getpixel((10 * 4 + 1, 5 * 4 + 1)) == (255, 0, 255, 255)  # dentro da máscara
    assert guide.getpixel((8 * 4 + 1, 7 * 4 + 1)) == (40, 140, 60, 255)  # buraco protegido fica visível
    assert guide.getpixel((0, 60)) == context.getpixel((0, 60))


def test_inpaint_acceptance_demo_protects_every_rgba_byte(pipe):
    """Demonstração de aceite: fonte assimétrica com alfa 64/128 e RGB sob alfa 0; candidato muda tudo."""
    source = Image.new("RGBA", (16, 16))
    for y in range(16):
        for x in range(16):
            source.putpixel((x, y), (x * 13 % 256, y * 17 % 256, (x * y) % 256, (0, 64, 128, 255)[(x + 2 * y) % 4]))
    candidate = Image.new("RGBA", (64, 64), (250, 0, 250, 200))  # resposta 4× e diferente em tudo
    fit = pipe.run("fit_logical", {"targetSize": [16, 16], "exactAspect": True}, [("source", png(candidate))])
    normalized = Pipeline.image(fit, "fitted")
    assert normalized.size == (16, 16)
    r = pipe.run("composite_protected", MASK_RECIPE, [("source", png(source)), ("candidate", png(normalized)), ("editMask", png(lake_mask()))])
    out = Pipeline.image(r, "protected")
    mask = lake_mask()
    for y in range(16):
        for x in range(16):
            expected = normalized.getpixel((x, y)) if mask.getpixel((x, y)) == 255 else source.getpixel((x, y))
            assert out.getpixel((x, y)) == expected, (x, y)
    assert r["report"]["protectedDiffPixels"] == 0 and r["report"]["candidateAgreement"] == 0
    assert any("emenda" in w["pt-BR"] for w in r["warnings"])  # candidato não respeitou o contexto


def test_candidate_with_wrong_aspect_fails_instead_of_stretching(pipe):
    r = pipe.run("fit_logical", {"targetSize": [16, 16], "exactAspect": True}, [("source", png(Image.new("RGBA", (64, 48), (1, 1, 1, 255))))])
    assert r["status"] == "error" and r["error"]["code"] == "geometry_mismatch" and "fora da grade" in r["error"]["message"]["pt-BR"]


def test_off_grid_candidate_uses_block_majority(pipe):
    # Candidato 4× com ruído no centro de cada bloco: a amostra do centro erra, a maioria acerta.
    art = Image.new("RGBA", (8, 8), (40, 140, 60, 255))
    big = art.resize((32, 32), Image.Resampling.NEAREST)
    for y in range(8):
        for x in range(8):
            big.putpixel((x * 4 + 2, y * 4 + 2), (250, 0, 0, 255))
    r = pipe.run("fit_logical", {"targetSize": [8, 8], "exactAspect": True}, [("source", png(big))])
    assert r["report"]["method"] == "block_mode"
    assert Pipeline.image(r, "fitted").tobytes() == art.tobytes()
    assert any("cor majoritária" in w["pt-BR"] for w in r["warnings"])


@pytest.mark.parametrize(
    ("operation", "recipe", "role", "code", "message"),
    [
        ("crop_to_content", {"version": 2, "padding": 0, "alphaThreshold": 0}, "source", "invalid_request", "Recipe requires version = 1"),
        ("crop_to_content", {"padding": 0, "alphaThreshold": 0}, "source", "decode_failed", "Could not read 0-source.png:"),
    ],
)
def test_invalid_recipe_or_unreadable_input_is_reported(pipe, operation, recipe, role, code, message):
    result = pipe.run(operation, recipe, [(role, b"not a PNG")], validate_request=recipe.get("version") != 2)
    assert result["status"] == "error"
    assert result["error"]["code"] == code
    assert result["error"]["message"]["en"].startswith(message)


def test_inspect_mask_reports_decode_failure_with_role(pipe):
    result = pipe.run("inspect_mask", MASK_RECIPE, [
        ("source", png(Image.new("RGBA", (2, 2)))), ("editMask", b"not a PNG"),
    ])
    assert result["error"]["code"] == "decode_failed"
    assert result["error"]["message"]["en"].startswith("editMask unreadable:")


@pytest.mark.parametrize(
    ("mask", "message"),
    [
        (Image.new("RGBA", (2, 1), (255, 255, 255, 254)), "editMask has transparency; use opaque black and white"),
        (Image.new("RGB", (2, 1), (255, 255, 0)), "editMask is in color; use only black (0) and white (255)"),
    ],
)
def test_masks_require_opaque_grayscale(pipe, mask, message):
    result = pipe.run("encode_mask", {"encoding": "alpha_zero_edits"}, [("editMask", png(mask))])
    assert result["error"]["code"] == "invalid_request"
    assert result["error"]["message"]["en"] == message


def test_opaque_rgba_mask_is_binary_by_rgb_not_alpha(pipe):
    mask = Image.new("RGBA", (2, 1), (0, 0, 0, 255))
    mask.putpixel((1, 0), (255, 255, 255, 255))
    result = pipe.run("encode_mask", {"encoding": "alpha_zero_edits"}, [("editMask", png(mask))])
    assert result["report"]["editedPixels"] == 1
    assert Pipeline.image(result, "remote_mask").getchannel("A").tobytes() == bytes([255, 0])


@pytest.mark.parametrize(
    ("ordinal", "hashes", "message"),
    [
        (2, None, "Layer 0 references missing input 2"),
        (0, {0: "0" * 64}, "Input in/0-layer.png missing or with a mismatched hash"),
    ],
)
def test_composite_rejects_invalid_layer_references(pipe, ordinal, hashes, message):
    result = pipe.run(
        "compose_layers", {"canvas": [2, 2], "layers": [{"inputOrdinal": ordinal, "offset": [0, 0]}]},
        [("layer", png(Image.new("RGBA", (2, 2))))], input_hashes=hashes,
    )
    assert result["error"]["code"] == "invalid_request"
    assert result["error"]["message"]["en"] == message


def test_slice_grid_diagnoses_empty_leftover_and_stray_content(pipe):
    image = Image.new("RGBA", (18, 4))
    image.paste(STEEL, (0, 0, 18, 1))
    image.paste(STEEL, (0, 1, 2, 2))
    image.putpixel((7, 2), STEEL)
    image.putpixel((10, 2), RIVET)
    recipe = slice_recipe(
        grid={"rows": 1, "columns": 4, "cell": [2, 2], "margin": [2, 1], "spacing": [2, 0], "traversal": "row_major"},
        frameIds=["empty"], durationMs=[80], pivot=[1, 1], emptyCells=[1],
    )
    result = pipe.run("slice_grid", recipe, [("source", png(image))])
    expected = [
        "Frame empty is empty; declare the cell empty if that is intentional",
        "Cell 1 declared empty has content at (7, 2)",
        "Cell 2 has content but received no frame (leftover in the grid)",
    ]
    assert result["status"] == "needs_review"
    assert [w["en"] for w in result["warnings"][:3]] == expected
    assert result["report"]["emptyCells"] == [{"cell": 1, "rect": [6, 1, 2, 2], "transparent": False}]
    assert result["report"]["strayPixels"] == [[x, 0] for x in range(18)] + [[0, 1], [1, 1]]
    assert Pipeline.image(result, "frame", "empty").getbbox() is None


def test_slice_grid_rejects_more_frames_than_available_cells(pipe):
    result = pipe.run("slice_grid", slice_recipe(emptyCells=[0, 2]), [("source", png(strip()))])
    assert result["error"]["code"] == "geometry_mismatch"
    assert result["error"]["message"]["en"] == "3 frames for 2 available cells"


def test_flood_seed_outside_image_is_rejected(pipe):
    result = flood(pipe, shield(), {"borders": False, "points": [[16, 0]]})
    assert result["error"]["code"] == "geometry_mismatch"
    assert result["error"]["message"]["en"] == "Seed (16, 0) outside the 16×16 image"


def test_flood_crosses_transparent_pixels_and_keep_wins_brush_overlap(pipe):
    image = Image.new("RGBA", (5, 1), GREEN)
    image.putpixel((1, 0), (23, 25, 27, 0))
    image.putpixel((4, 0), STEEL)
    keep = Image.new("L", image.size)
    keep.putpixel((3, 0), 255)
    remove = keep.copy()
    remove.putpixel((4, 0), 255)
    result = flood(pipe, image, {"borders": False, "points": [[0, 0], [0, 0], [3, 0]]}, keep=keep, remove=remove)
    assert [w["en"] for w in result["warnings"]] == [
        "Seed (3, 0) does not have the background color or is protected; ignored",
        "1 pixels marked by both brushes; protection won",
    ]
    assert {k: result["report"][k] for k in ("removedPixels", "removedByBrush", "keptByBrush")} == {
        "removedPixels": 3, "removedByBrush": 1, "keptByBrush": 1,
    }
    assert Pipeline.image(result, "cutout").getpixel((1, 0)) == (23, 25, 27, 0)
    assert Pipeline.image(result, "removed_mask").tobytes() == bytes([255, 255, 255, 0, 255])


def test_hue_cleanup_removes_key_fringe_and_small_specks_but_respects_keep_mask(pipe):
    image = Image.new("RGBA", (24, 24), (0, 200, 0, 255))
    image.paste(STEEL, (2, 2, 20, 20))
    fringe = (130, 170, 130, 255)
    image.paste(fringe, (2, 2, 20, 4))
    speck = (200, 40, 140, 255)
    image.putpixel((21, 4), speck)
    image.putpixel((22, 9), speck)
    image.putpixel((7, 8), fringe)
    keep = Image.new("L", image.size)
    keep.putpixel((22, 9), 255)
    result = pipe.run("remove_background_flood", {
        "color": "#00c800", "tolerance": 0, "connectivity": 4, "seeds": {"borders": True, "points": []},
        "match": {"mode": "hue", "keyFrom": "border", "hueTolerance": 20, "minSaturation": 96, "minValue": 100, "cleanup": True},
    }, [("source", png(image)), ("keepMask", png(keep))])
    output = Pipeline.image(result, "cutout")
    assert result["report"]["measuredKeyHue"] == 120
    assert output.getpixel((10, 3)) == (*fringe[:3], 0)
    assert output.getpixel((7, 8)) == fringe
    assert output.getpixel((21, 4)) == (*speck[:3], 0)
    assert output.getpixel((22, 9)) == speck
    assert output.getchannel("A").histogram()[255] == 18 * 16 + 1


def test_hue_flood_without_saturated_border_uses_requested_key(pipe):
    image = Image.new("RGBA", (5, 5), STEEL)
    image.putpixel((2, 2), GREEN)
    result = pipe.run("remove_background_flood", {
        "color": "#00c800", "tolerance": 0, "connectivity": 4, "seeds": {"borders": True, "points": [[2, 2]]},
        "match": {"mode": "hue", "keyFrom": "border", "hueTolerance": 20, "minSaturation": 96, "cleanup": False},
    }, [("source", png(image))])
    assert result["report"]["measuredKeyHue"] is None
    assert result["report"]["removedPixels"] == 1
    cutout = Pipeline.image(result, "cutout")
    assert cutout.getpixel((2, 2)) == (*GREEN[:3], 0)
    assert cutout.getpixel((0, 0)) == STEEL


@pytest.mark.parametrize(
    ("operation", "recipe", "color", "message"),
    [
        ("crop_to_content", {"padding": 1, "alphaThreshold": 64}, (9, 8, 7, 64), "Image has no visible content to crop"),
        ("fit_logical", {"targetSize": [2, 2], "cropToContent": {"padding": 0}}, (9, 8, 7, 0), "Nothing visible after background removal"),
        ("fit_logical", {"targetSize": [2, 2], "measureGround": True}, (9, 8, 7, 0), "Nothing visible in the fitted character base"),
        ("fit_logical", {"targetSize": [2, 2], "measureGround": True}, (9, 8, 7, 255), "The character base needs a transparent background"),
    ],
)
def test_empty_content_or_opaque_character_reports_distinct_failure(pipe, operation, recipe, color, message):
    result = pipe.run(operation, recipe, [("source", png(Image.new("RGBA", (2, 2), color)))])
    assert result["error"]["code"] == "unsupported_input"
    assert result["error"]["message"]["en"] == message


@pytest.mark.parametrize("policy", ["strict", "guided"])
@pytest.mark.parametrize("off_palette", [True, False])
def test_fit_logical_origin_uses_feet_and_palette_controls_rgb(pipe, policy, off_palette):
    image = Image.new("RGBA", (6, 6))
    color = (204, 2, 3) if off_palette else (200, 0, 0)
    image.paste((*color, 255), (0, 1, 6, 2))  # wide hat
    image.paste((*color, 80), (0, 2, 1, 3))  # below threshold
    image.paste((*color, 210), (1, 3, 3, 5))  # narrower feet, off-center
    result = pipe.run("fit_logical", {
        "targetSize": [6, 6], "measureGround": True, "alphaThreshold": 200,
        "palette": {"policy": policy, "colors": ["#c80000"]},
    }, [("source", png(image))])
    assert result["report"]["groundOrigin"] == [2, 5]
    assert result["report"]["method"] == "identity"
    assert result["report"]["alphaBinarized"] == 5
    assert result["report"]["palette"] == {
        "policy": policy, "visiblePixels": 10, "visibleColorsBefore": 1,
        "offPalettePixels": 10 if off_palette else 0, "offPaletteColorCount": int(off_palette),
        "offPaletteColors": ["#cc0203"] if off_palette else [],
        "changedPixels": 10 if off_palette and policy == "strict" else 0,
        "usedIndices": [] if off_palette and policy == "guided" else [0],
    }
    output = Pipeline.image(result, "fitted")
    assert output.getpixel((0, 2)) == (0, 0, 0, 0)
    assert output.getpixel((1, 4)) == (*(color if policy == "guided" else (200, 0, 0)), 255)
    if off_palette:
        assert result["status"] == "needs_review"
        assert result["warnings"][0]["en"] == {
            "strict": "Strict palette: 10 of 10 visible pixels were mapped to project colors.",
            "guided": "Guided palette: 10 of 10 visible pixels are outside the project palette. Colors were kept.",
        }[policy]
    else:
        assert result["status"] == "ok"


def test_fit_logical_upscales_full_canvas_by_integer_with_nearest_pixels(pipe):
    source = Image.new("RGBA", (2, 1), GREEN)
    source.putpixel((1, 0), RIVET)
    result = pipe.run("fit_logical", {"targetSize": [6, 3]}, [("source", png(source))])
    assert result["report"]["factor"] == pytest.approx(1 / 3)
    assert result["report"]["method"] == "nearest_upscale"
    output = Pipeline.image(result, "fitted")
    assert output.crop((0, 0, 3, 3)).tobytes() == Image.new("RGBA", (3, 3), GREEN).tobytes()
    assert output.crop((3, 0, 6, 3)).tobytes() == Image.new("RGBA", (3, 3), RIVET).tobytes()


def test_inpaint_guide_preserves_alpha_without_flatten_color(pipe):
    source = Image.new("RGBA", (2, 1), (80, 90, 100, 42))
    mask = Image.new("L", source.size)
    mask.putpixel((1, 0), 255)
    result = pipe.run("inpaint_guide", {"scale": 2, "markColor": "#ff00ff"}, [
        ("source", png(source)), ("editMask", png(mask)),
    ])
    assert Pipeline.image(result, "context").tobytes() == Image.new("RGBA", (4, 2), (80, 90, 100, 42)).tobytes()
    guide = Pipeline.image(result, "guide")
    assert guide.getpixel((1, 1)) == (80, 90, 100, 42)
    assert guide.getpixel((2, 1)) == (255, 0, 255, 255)


def test_unzoom_reports_coarse_only_grid_and_falls_back_from_achromatic_key(pipe):
    art = Image.new("RGBA", (6, 2))
    for x in range(6):
        art.paste((255, 255, 255, 255) if x % 2 else (28, 28, 28, 255), (x, 0, x + 1, 2))
    source = art.resize((48, 16), Image.Resampling.NEAREST)
    result = pipe.run("unzoom", {
        "minAgreement": 1, "ignoreKeyHue": {"hueTolerance": 15, "minSaturation": 96}, "minContentCells": 13,
    }, [("source", png(source))])
    assert result["status"] == "needs_review"
    assert result["report"]["agreementOver"] == "image"
    assert result["report"]["grid"] == [6, 2]
    assert result["report"]["agreement"] == 1
    assert result["report"]["tried"][0] == {"cell": 8, "agreement": 1, "coarse": True}
    assert result["warnings"][0]["en"] == "Only a coarse grid (8.0 px) reproduces the image: the object ends up with fewer than 13 cells — review the result"
    assert Pipeline.image(result, "native").tobytes() == art.tobytes()


def test_unzoom_keeps_original_if_key_mask_covers_entire_image(pipe):
    art = Image.new("RGBA", (6, 2))
    for x in range(6):
        art.paste((0, 255 if x % 2 else 128, 0, 255), (x, 0, x + 1, 2))
    source = art.resize((48, 16), Image.Resampling.NEAREST)
    result = pipe.run("unzoom", {
        "minAgreement": 1, "minContentCells": 4, "ignoreKeyHue": {"hueTolerance": 15, "minSaturation": 96},
    }, [("source", png(source))])
    assert result["status"] == "needs_review"
    assert result["report"]["detected"] is False
    assert result["report"]["tried"][0] == {"cell": 8, "agreement": 0}
    assert result["warnings"][0]["en"] == "No pixel art grid recognized; image kept without reduction"
    assert Pipeline.image(result, "native").tobytes() == source.tobytes()


def test_unzoom_skips_candidate_period_that_would_leave_only_one_row(pipe):
    source = Image.new("RGBA", (48, 8), (24, 24, 24, 255))
    for x in (8, 24, 40):
        source.paste((240, 240, 240, 255), (x, 0, x + 8, 8))
    result = pipe.run("unzoom", {"minAgreement": 1}, [("source", png(source))])
    assert result["status"] == "ok"
    assert result["report"]["cell"] == [4, 4]
    assert result["report"]["grid"] == [12, 2]
    assert result["report"]["tried"] == [{"cell": 4, "agreement": 1}]
    assert Pipeline.image(result, "native").resize(source.size, Image.Resampling.NEAREST).tobytes() == source.tobytes()
