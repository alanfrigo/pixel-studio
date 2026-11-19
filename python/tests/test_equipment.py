"""Equipamentos (S2): compositor com espelho e empunhaduras, extração de cobertura, guia e digests."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from tests.test_operations import Pipeline, png

SKIN = (224, 172, 105, 255)
TUNIC = (60, 90, 160, 255)
MAIL = (140, 140, 152, 255)
MAIL_DARK = (100, 100, 112, 255)
STEEL = (200, 200, 212, 255)
WOOD = (150, 90, 40, 255)
KEY = (255, 0, 255, 255)


@pytest.fixture
def pipe(tmp_path: Path) -> Pipeline:
    return Pipeline(tmp_path)


def base_frame(lean: int = 0) -> Image.Image:
    """Base limpa 32×32: cabeça, tronco de túnica, olho e mão marcados."""
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((12 + lean, 2, 19 + lean, 8), fill=SKIN)  # cabeça
    img.putpixel((14 + lean, 4), (20, 20, 28, 255))  # olho
    d.rectangle((11 + lean, 9, 20 + lean, 20), fill=TUNIC)  # tronco
    d.rectangle((12, 21, 19, 29), fill=TUNIC)  # pernas
    img.putpixel((21 + lean, 15), SKIN)  # mão
    return img


def dressed(lean: int = 0, shift: tuple[int, int] = (0, 0), spill: bool = False) -> Image.Image:
    """Candidato vestido: cota sobre o tronco (com um furo da cor da túnica), mão intacta e, opcionalmente, ruído fora da zona."""
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    img.alpha_composite(base_frame(lean), dest=shift)
    d = ImageDraw.Draw(img)
    sx, sy = shift
    d.rectangle((11 + lean + sx, 9 + sy, 20 + lean + sx, 17 + sy), fill=MAIL)
    for y in range(10, 17, 2):
        img.putpixel((13 + lean + sx, y + sy), MAIL_DARK)
    img.putpixel((16 + lean + sx, 13 + sy), TUNIC)  # furo igual à base, cercado pela peça
    img.putpixel((21 + lean + sx, 15 + sy), (255, 0, 0, 255))  # o modelo "pintou" a mão: protegida
    if spill:
        d.rectangle((12 + sx, 25 + sy, 19 + sx, 27 + sy), fill=MAIL)  # mudou a perna (fora da zona)
        d.rectangle((11 + lean + sx, 18 + sy, 20 + lean + sx, 20 + sy), fill=MAIL)  # continua além da zona
    return img


def test_extract_recovers_only_the_piece_inside_the_zone(pipe):
    zone = [[10, 9, 12, 9]]  # tronco até y = 17 (exclusivo 18)
    res = pipe.run(
        "equipment_extract",
        {
            "cell": [32, 32],
            "frames": [
                {"frameId": "windup", "baseOrdinal": 0, "candidateOrdinal": 1, "candidateRect": [0, 0, 32, 32], "parts": [{"partId": "torso", "zones": zone}], "protect": [[20, 14, 3, 3]]},
            ],
            "tolerance": 0,
            "alphaThreshold": 128,
            "maxShift": 2,
            "minComponentPx": 2,
        },
        [("layer", png(base_frame())), ("candidate", png(dressed()))],
    )
    assert res["status"] == "ok", res.get("warnings")
    part = res["report"]["frames"][0]["parts"][0]
    assert part["offset"] == [11, 9] and part["rect"] == [0, 0, 10, 9]
    layer = pipe.image(res, "layer", "windup|torso")
    assert layer.getpixel((0, 0)) == MAIL
    # Furo da cor da túnica, cercado pela cota, entra na camada (peça sólida).
    assert layer.getpixel((16 - 11, 13 - 9)) == TUNIC
    # Prévia = base + peça; a mão protegida continua da base e o olho também.
    preview = pipe.image(res, "preview", "windup")
    assert preview.getpixel((21, 15)) == SKIN
    assert preview.getpixel((14, 4)) == (20, 20, 28, 255)
    # Mão protegida (3 × 3): a cota não a cobre nem onde o modelo a desenhou por cima.
    assert part["protectedKept"] == 4
    assert preview.getpixel((20, 15)) == TUNIC


def test_extract_registers_shift_and_flags_spill_and_edge(pipe):
    zone = [[10, 9, 12, 9]]
    res = pipe.run(
        "equipment_extract",
        {
            "cell": [32, 32],
            "frames": [
                {"frameId": "f1", "baseOrdinal": 0, "candidateOrdinal": 1, "candidateRect": [0, 0, 32, 32], "parts": [{"partId": "torso", "zones": zone}], "protect": []},
            ],
            "tolerance": 0,
            "alphaThreshold": 128,
            "maxShift": 3,
            "minComponentPx": 2,
        },
        [("layer", png(base_frame())), ("candidate", png(dressed(shift=(2, -1), spill=True)))],
    )
    frame = res["report"]["frames"][0]
    assert frame["shift"] == [-2, 1]
    assert res["status"] == "needs_review"
    assert any("realinhado" in w["pt-BR"] for w in res["warnings"])
    assert any("borda da zona" in w["pt-BR"] and "zone edge" in w["en"] for w in res["warnings"])
    assert frame["outsideChangedPixels"] > 0
    # Nada fora da zona vira peça: a perna continua da base.
    assert pipe.image(res, "preview", "f1").getpixel((14, 26)) == TUNIC


def test_extract_drops_key_and_guide_color_residue(pipe):
    cand = dressed()
    cand.putpixel((12, 12), (250, 5, 250, 255))  # resíduo magenta (cor-chave) dentro da zona
    cand.putpixel((13, 12), (245, 26, 214, 255))  # borda suavizada: fora da tolerância por canal, mesmo matiz
    res = pipe.run(
        "equipment_extract",
        {
            "cell": [32, 32],
            "frames": [{"frameId": "f", "baseOrdinal": 0, "candidateOrdinal": 1, "candidateRect": [0, 0, 32, 32], "parts": [{"partId": "torso", "zones": [[10, 9, 12, 9]]}], "protect": []}],
            "tolerance": 0,
            "alphaThreshold": 128,
            "maxShift": 0,
            "minComponentPx": 0,
            "forbidColors": ["#ff00ff", "#00ffff"],
            "forbidTolerance": 40,
        },
        [("layer", png(base_frame())), ("candidate", png(cand))],
    )
    assert any("cor-chave" in w["pt-BR"] and "key color" in w["en"] for w in res["warnings"])
    # O pixel residual não vira peça: a base aparece ali na prévia.
    assert pipe.image(res, "preview", "f").getpixel((12, 12)) == TUNIC
    assert pipe.image(res, "preview", "f").getpixel((13, 12)) == TUNIC


def test_extract_two_parts_from_a_strip_and_rejects_wrong_grid(pipe):
    strip = Image.new("RGBA", (64, 32), KEY[:3] + (0,))
    strip.alpha_composite(dressed(), dest=(0, 0))
    strip.alpha_composite(dressed(lean=1), dest=(32, 0))
    recipe = {
        "cell": [32, 32],
        "frames": [
            {"frameId": "a", "baseOrdinal": 0, "candidateOrdinal": 2, "candidateRect": [0, 0, 32, 32], "parts": [{"partId": "torso", "zones": [[10, 9, 12, 5]]}, {"partId": "belly", "zones": [[10, 9, 12, 9]]}], "protect": []},
            {"frameId": "b", "baseOrdinal": 1, "candidateOrdinal": 2, "candidateRect": [32, 0, 32, 32], "parts": [{"partId": "torso", "zones": [[11, 9, 12, 5]]}, {"partId": "belly", "zones": [[11, 9, 12, 9]]}], "protect": []},
        ],
        "tolerance": 0,
        "alphaThreshold": 128,
        "maxShift": 0,
        "minComponentPx": 0,
    }
    res = pipe.run("equipment_extract", recipe, [("layer", png(base_frame())), ("layer", png(base_frame(1))), ("candidate", png(strip))])
    parts = {(f["frameId"], p["partId"]): p for f in res["report"]["frames"] for p in f["parts"]}
    # A primeira parte fica com a interseção das zonas; a segunda só com o resto.
    assert parts[("a", "torso")]["offset"] == [11, 9] and parts[("a", "torso")]["rect"][3] == 5
    assert parts[("a", "belly")]["offset"] == [11, 14]
    assert parts[("b", "torso")]["offset"] == [12, 9]

    bad = dict(recipe, frames=[dict(recipe["frames"][0], candidateRect=[0, 0, 30, 32])])
    wrong = pipe.run("equipment_extract", bad, [("layer", png(base_frame())), ("layer", png(base_frame(1))), ("candidate", png(strip))])
    assert wrong["status"] == "error" and wrong["error"]["code"] == "geometry_mismatch"


def sword() -> Image.Image:
    """Espada 5×12 assimétrica: lâmina, guarda e cabo; empunhadura em (1, 10)."""
    img = Image.new("RGBA", (5, 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((1, 0, 2, 7), fill=STEEL)
    d.rectangle((0, 8, 4, 8), fill=WOOD)
    d.rectangle((1, 9, 1, 11), fill=WOOD)
    return img


def test_compose_layers_mirror_grips_and_flattened_sheet(pipe):
    body = base_frame()
    arm = Image.new("RGBA", (4, 4), SKIN)
    atlas = Image.new("RGBA", (40, 32), (0, 0, 0, 0))
    atlas.alpha_composite(body, dest=(0, 0))
    atlas.alpha_composite(sword(), dest=(32, 0))
    recipe = {
        "cell": [32, 32],
        "frames": [
            {
                "frameId": "hold",
                "layers": [
                    {"key": "base:body", "inputOrdinal": 0, "rect": [0, 0, 32, 32], "offset": [0, 0], "mirrored": False},
                    # Mão (22, 16) − empunhadura (1, 10) = origem (21, 6).
                    {"key": "rigid:sword", "inputOrdinal": 0, "rect": [32, 0, 5, 12], "offset": [21, 6], "mirrored": False, "grips": [{"socketId": "hand_right", "at": [1, 10], "expected": [22, 16]}, {"socketId": "hand_left", "at": [1, 11], "expected": [24, 17]}]},
                    {"key": "base:arm", "inputOrdinal": 1, "rect": [0, 0, 4, 4], "offset": [21, 15], "mirrored": False},
                ],
            },
            {
                "frameId": "mirror",
                "layers": [
                    # Espelho: empunhadura x=1 numa vista de 5 px vira 5−1−1 = 3 → origem (22−3, 16−10) = (19, 6).
                    {"key": "rigid:sword", "inputOrdinal": 0, "rect": [32, 0, 5, 12], "offset": [19, 6], "mirrored": True, "grips": [{"socketId": "hand_right", "at": [1, 10], "expected": [22, 16]}]},
                    {"key": "rigid:tip", "inputOrdinal": 0, "rect": [32, 0, 5, 12], "offset": [29, -3], "mirrored": False},
                ],
            },
        ],
        "tolerancePx": 1,
    }
    res = pipe.run("equipment_compose", recipe, [("layer", png(atlas)), ("layer", png(arm))])
    assert res["status"] == "needs_review"
    frames = {f["frameId"]: f for f in res["report"]["frames"]}
    grips = {g["socketId"]: g for g in frames["hold"]["grips"]}
    assert grips["hand_right"]["drawnAt"] == [22, 16] and grips["hand_right"]["deviation"] == 0 and grips["hand_right"]["onArt"]
    assert grips["hand_left"]["deviation"] == 2 and grips["hand_left"]["exceeds"]
    assert frames["mirror"]["grips"][0]["drawnAt"] == [22, 16]
    tip = next(layer for layer in frames["mirror"]["layers"] if layer["key"] == "rigid:tip")
    assert tip["clipped"] and tip["overflow"] == {"left": 0, "top": 3, "right": 2, "bottom": 0}
    hold = pipe.image(res, "frame", "hold")
    assert hold.getpixel((22, 16)) == SKIN  # a mão (desenhada depois) cobre a empunhadura
    assert hold.getpixel((22, 6)) == STEEL
    sheet = pipe.image(res, "sheet")
    assert sheet.size == (64, 32)
    # Folha achatada = frames lado a lado, pixel a pixel.
    assert sheet.crop((0, 0, 32, 32)).tobytes() == hold.convert("RGBA").tobytes()
    assert sheet.crop((32, 0, 64, 32)).tobytes() == pipe.image(res, "frame", "mirror").convert("RGBA").tobytes()


def test_swapping_two_opaque_layers_changes_the_intersection_pixel(pipe):
    """05 §amostras: inverter a ordem de duas camadas opacas que se cruzam muda o pixel da interseção."""
    red = Image.new("RGBA", (6, 2), (200, 30, 30, 255))
    blue = Image.new("RGBA", (2, 6), (30, 30, 200, 255))
    atlas = Image.new("RGBA", (8, 6), (0, 0, 0, 0))
    atlas.alpha_composite(red, dest=(0, 0))
    atlas.alpha_composite(blue, dest=(6, 0))
    a = {"key": "a", "inputOrdinal": 0, "rect": [0, 0, 6, 2], "offset": [0, 2], "mirrored": False}
    b = {"key": "b", "inputOrdinal": 0, "rect": [6, 0, 2, 6], "offset": [2, 0], "mirrored": False}
    one = pipe.run("equipment_compose", {"cell": [6, 6], "frames": [{"frameId": "x", "layers": [a, b]}], "tolerancePx": 1}, [("layer", png(atlas))])
    two = pipe.run("equipment_compose", {"cell": [6, 6], "frames": [{"frameId": "x", "layers": [b, a]}], "tolerancePx": 1}, [("layer", png(atlas))])
    assert pipe.image(one, "frame", "x").getpixel((2, 2)) == (30, 30, 200, 255)
    assert pipe.image(two, "frame", "x").getpixel((2, 2)) == (200, 30, 30, 255)
    assert one["report"]["frames"][0]["rgbaSha256"] != two["report"]["frames"][0]["rgbaSha256"]


def test_guide_paints_zone_minus_protect_and_hashes_regions(pipe):
    res = pipe.run(
        "equipment_guide",
        {
            "cell": [32, 32],
            "canvas": [64, 32],
            "frames": [
                {"frameId": "a", "baseOrdinal": 0, "at": [0, 0], "zones": [[10, 9, 12, 9]], "protect": [[20, 14, 3, 3]]},
                {"frameId": "b", "baseOrdinal": 1, "at": [32, 0], "zones": [[11, 9, 12, 9]], "protect": []},
            ],
            "scale": 4,
            "markColor": "#ff00ff",
            "flattenOnto": "#00ff00",
        },
        [("layer", png(base_frame())), ("layer", png(base_frame(1)))],
    )
    context, guide = pipe.image(res, "context"), pipe.image(res, "guide")
    assert context.size == (256, 128)
    assert context.getpixel((0, 0)) == (0, 255, 0, 255)
    assert guide.getpixel((12 * 4, 10 * 4)) == (255, 0, 255, 255)
    assert guide.getpixel((21 * 4, 15 * 4)) == SKIN  # mão protegida não é pintada
    assert guide.getpixel((32 * 4 + 12 * 4, 10 * 4)) == (255, 0, 255, 255)

    atlas = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    atlas.alpha_composite(base_frame(), dest=(0, 0))
    atlas.alpha_composite(base_frame(), dest=(32, 0))
    hashes = pipe.run("equipment_region_hashes", {"regions": [{"key": "a", "inputOrdinal": 0, "rect": [0, 0, 32, 32]}, {"key": "b", "inputOrdinal": 0, "rect": [32, 0, 32, 32]}]}, [("layer", png(atlas))])
    assert hashes["report"]["hashes"]["a"] == hashes["report"]["hashes"]["b"]
    assert hashes["report"]["contentBoxes"]["a"] == [11, 2, 11, 28]
