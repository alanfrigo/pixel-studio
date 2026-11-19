"""Write native animation files from validated, staged portable-v1 raster regions."""

from __future__ import annotations

import json
import struct
import sys
import zlib
from functools import lru_cache
from itertools import chain
from pathlib import Path
from typing import BinaryIO, Callable

from PIL import GifImagePlugin, Image, ImageChops

from pixel_pipeline.protocol import Json, apply_resource_limits

# Aseprite file layout: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
ASE_BLEND = {"normal": 0, "multiply": 1, "screen": 2, "additive": 16}
GIF_TRANSPARENT = 255
GIF_ALPHA_LUT = (0,) * 128 + (255,) * 128
Crop = Callable[[Json], Image.Image]


def _file_crop(sources: dict[str, int]) -> Crop:
    @lru_cache(maxsize=4)
    def atlas(index: int) -> Image.Image:
        with Image.open(f"source-{index}.png", formats=["PNG"]) as image:
            return image.convert("RGBA")

    def crop(layer: Json) -> Image.Image:
        x, y, width, height = layer["rect"]
        image = atlas(sources[layer["fileId"]])
        if x + width > image.width or y + height > image.height:
            raise ValueError(f"Source rectangle outside PNG {layer['fileId']}")
        return image.crop((x, y, x + width, y + height))

    return crop


def _ase_string(text: str) -> bytes:
    data = text.encode("utf-8")
    return struct.pack("<H", len(data)) + data


def _ase_chunk(fp: BinaryIO, kind: int, *parts: bytes) -> None:
    fp.write(struct.pack("<IH", 6 + sum(map(len, parts)), kind))
    fp.writelines(parts)


def _ase_document_chunks(fp: BinaryIO, doc: Json) -> int:
    names = doc["layerNames"]
    for name in names:
        layer = struct.pack("<6HB3x", 3, 0, 0, 0, 0, ASE_BLEND[doc["blendMode"]], 255)
        _ase_chunk(fp, 0x2004, layer, _ase_string(name))

    direction = 2 if doc["playback"] == "ping_pong" else 0
    repeats = 1 if doc["playback"] == "once" else 0
    tag = struct.pack("<H8xHHBH6x3Bx", 1, 0, len(doc["frames"]) - 1, direction, repeats, 96, 170, 251)
    _ase_chunk(fp, 0x2018, tag, _ase_string(doc["name"]))

    # A full-canvas slice with a single key preserves the grid pivot, including edge points.
    key = struct.pack("<IiiIIii", 0, 0, 0, *doc["size"], *doc["pivot"])
    _ase_chunk(fp, 0x2022, struct.pack("<III", 1, 2, 0), _ase_string("pivot"), key)
    return len(names) + 2


def write_aseprite(fp: BinaryIO, doc: Json, crop: Crop) -> None:
    frames = doc["frames"]
    fp.seek(128)  # Header includes the final file size, filled after writing the frames.
    for index, frame in enumerate(frames):
        start = fp.tell()
        fp.seek(start + 16)
        chunks = _ase_document_chunks(fp, doc) if index == 0 else 0
        for layer in frame["layers"]:
            image = crop(layer)
            cel = struct.pack(
                "<HhhBHh5xHH", layer["layerIndex"], *layer["offset"], 255, 2, layer["zIndex"], *image.size,
            )
            _ase_chunk(fp, 0x2005, cel, zlib.compress(image.tobytes()))
            chunks += 1
        end = fp.tell()
        if end > 0xFFFFFFFF:
            raise ValueError("Aseprite file exceeds its 32-bit file size limit")
        fp.seek(start)
        fp.write(struct.pack("<IHHH2xI", end - start, 0xF1FA, min(chunks, 0xFFFF), frame["durationMs"], chunks))
        fp.seek(end)
    size = fp.tell()
    fp.seek(0)
    fp.write(struct.pack("<I5HIH12xHBB92x", size, 0xA5E0, len(frames), *doc["size"], 32, 1, frames[0]["durationMs"], 0, 1, 1))


def _gif_canvas(size: tuple[int, int], frame: Json, crop: Crop) -> Image.Image:
    canvas = Image.new("RGBA", size)
    for index, layer in enumerate(frame["layers"]):
        image = crop(layer)
        pos = tuple(layer["offset"])
        if index == 0:
            canvas.paste(image, pos)
        else:
            canvas.alpha_composite(image, dest=pos)
    return canvas


def _gif_palette(canvas: Image.Image) -> Image.Image:
    visible = canvas.getchannel("A").point(GIF_ALPHA_LUT)
    bbox = visible.getbbox()
    if bbox is None:
        indexed = Image.new("P", canvas.size, GIF_TRANSPARENT)
        indexed.putpalette(bytes(768))
        return indexed

    rgb = canvas.convert("RGB")
    invisible = None
    if visible.getextrema()[0] == 0:
        # Hide RGB from alpha=0 pixels during quantization, without spending a
        # palette entry on a color that is not already present in the visible art.
        left, top, right, _ = bbox
        row = visible.crop((left, top, right, top + 1)).getbbox()
        assert row is not None
        invisible = ImageChops.invert(visible)
        rgb.paste(rgb.getpixel((left + row[0], top)), (0, 0, *canvas.size), invisible)
    indexed = rgb.quantize(colors=GIF_TRANSPARENT, method=Image.Quantize.MEDIANCUT)
    if invisible is not None:
        indexed.paste(GIF_TRANSPARENT, (0, 0, *canvas.size), invisible)
    # Slot 255 is transparent in both the global and every local palette. Keep
    # it reserved even in opaque frames so disposal consistently clears to alpha 0.
    palette = bytes(indexed.getpalette()[: 3 * GIF_TRANSPARENT])
    indexed.putpalette(palette.ljust(768, b"\0"))
    return indexed


def write_gif(fp: BinaryIO, doc: Json, crop: Crop) -> None:
    frames = doc["frames"]
    playback = doc["playback"]
    reverse = range(len(frames) - 2, 0, -1) if playback == "ping_pong" else ()
    for index, ordinal in enumerate(chain(range(len(frames)), reverse)):
        frame = frames[ordinal]
        image = _gif_palette(_gif_canvas(tuple(doc["size"]), frame, crop))
        if index == 0:
            info = {"background": GIF_TRANSPARENT, "transparency": GIF_TRANSPARENT}
            if playback != "once":
                info["loop"] = 0
            header, _ = GifImagePlugin.getheader(image, info=info)
            fp.writelines(header)
        # Use Pillow's single-frame encoder explicitly: save_all collapses
        # identical frames, and may encode diff rectangles that retain old pixels.
        fp.writelines(GifImagePlugin.getdata(
            image,
            duration=max(1, (frame["durationMs"] + 5) // 10) * 10,
            transparency=GIF_TRANSPARENT,
            disposal=2,
            include_color_table=index != 0,
        ))
    fp.write(b";")


def main() -> None:
    [format_name] = sys.argv[1:]
    write = {"aseprite": write_aseprite, "gif": write_gif}[format_name]
    apply_resource_limits()
    with Path("request.json").open(encoding="utf-8") as request_file:
        request = json.load(request_file)
    crop = _file_crop(request["sources"])
    for index, document in enumerate(request["documents"]):
        with Path(f"output-{index}.{format_name}").open("wb") as output:
            write(output, document, crop)


if __name__ == "__main__":
    main()
