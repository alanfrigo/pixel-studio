import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipPayload, GridPoint, ManifestEntry, Offset, Rect, Size, VfxPayload } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";
import { DomainFailure } from "../../errors";
import { slugify } from "../../util";
import type { PackageFile } from "../package";
import type { ExportTarget, TargetInput } from "../target";

type Format = "aseprite" | "gif";
interface Drawable {
  partId: string;
  fileId: string;
  rect: Rect;
  offset: Offset;
}
interface Frame {
  durationMs: number;
  layers: Drawable[];
}
interface RasterDocument {
  name: string;
  size: Size;
  pivot: GridPoint;
  playback: ClipPayload["playback"];
  blendMode: VfxPayload["blendMode"];
  frames: Frame[];
}

function still(name: string, size: Size, pivot: GridPoint, layer: Drawable): RasterDocument {
  return { name, size, pivot, playback: "once", blendMode: "normal", frames: [{ durationMs: 100, layers: [layer] }] };
}

function documents(entry: ManifestEntry, format: Format): RasterDocument[] {
  if (entry.family === "character" && entry.kind === "clip") {
    const p = entry.payload;
    return [{
      name: `${p.action}-${p.direction.toLowerCase()}`,
      size: p.logicalSize,
      pivot: p.pivot,
      playback: p.playback,
      blendMode: "normal",
      frames: p.frames.map(({ durationMs, layers }) => ({ durationMs, layers })),
    }];
  }
  if (entry.family === "vfx") {
    const p = entry.payload;
    return [{
      name: entry.kind,
      size: p.logicalSize,
      pivot: p.pivot,
      playback: p.loop ? "loop" : "once",
      blendMode: p.blendMode,
      frames: p.frames.map(({ durationMs, fileId, rect, sourceOffset }) => ({
        durationMs,
        layers: fileId !== null && rect !== null ? [{ partId: "vfx", fileId, rect, offset: sourceOffset }] : [],
      })),
    }];
  }
  if (format === "aseprite" && entry.family === "character" && entry.kind === "base") {
    const p = entry.payload;
    return p.views.map((view) => still(`${p.state}-${view.direction.toLowerCase()}`, p.logicalSize, p.groundOrigin, {
      partId: "base", fileId: view.fileId, rect: view.rect, offset: view.sourceOffset,
    }));
  }
  if (format === "aseprite" && entry.family === "item") {
    return entry.payload.representations.map((rep) => still(`${rep.role}-${rep.state}`, rep.logicalSize, rep.pivot, {
      partId: rep.role, fileId: rep.fileId, rect: rep.rect, offset: rep.sourceOffset,
    }));
  }
  return [];
}

/** Fixed editable layers across the timeline; cel z-indices account for per-frame reordering. */
function asepriteStack(frames: Frame[]) {
  const indexes = new Map<string, number>();
  const layerNames: string[] = [];
  const celFrames = frames.map((frame) => {
    const occurrences = new Map<string, number>();
    const indices = frame.layers.map(({ partId }) => {
      const count = (occurrences.get(partId) ?? 0) + 1;
      occurrences.set(partId, count);
      const key = `${partId}:${count}`;
      const existing = indexes.get(key);
      if (existing !== undefined) return existing;
      const index = layerNames.length;
      indexes.set(key, index);
      layerNames.push(count === 1 ? partId : `${partId} [${count}]`);
      return index;
    });
    // The sorted occupied slots retain natural z=0 wherever the source order agrees.
    const slots = indices.toSorted((a, b) => a - b);
    return {
      durationMs: frame.durationMs,
      layers: frame.layers.map((layer, i) => ({ ...layer, layerIndex: indices[i]!, zIndex: slots[i]! - indices[i]! })),
    };
  });
  return { layerNames: layerNames.length ? layerNames : ["vfx"], frames: celFrames };
}

function problem(entry: ManifestEntry, format: Format): LocalizedText | null {
  const docs = documents(entry, format);
  const label = format === "aseprite" ? "Aseprite" : "GIF";
  if (!docs.length) return tx(`${label} não converte ${entry.family}/${entry.kind}.`, `${label} does not convert ${entry.family}/${entry.kind}.`);
  for (const doc of docs) {
    if (doc.size.some((dimension) => dimension > 0xffff)) {
      return tx(`${label} aceita telas de até 65.535 pixels por lado.`, `${label} supports canvases up to 65,535 pixels per side.`);
    }
    if (format === "aseprite") {
      if (doc.frames.some((frame) => frame.layers.some(({ offset }) => offset.some((axis) => axis > 0x7fff)))) {
        return tx("O Aseprite só representa posições de cels até 32.767 pixels por eixo.", "Aseprite only represents cel positions up to 32,767 pixels on each axis.");
      }
      const stack = asepriteStack(doc.frames);
      if (stack.layerNames.length > 0x10000 || stack.frames.some((frame) => frame.layers.some(({ zIndex }) => zIndex < -0x8000 || zIndex > 0x7fff))) {
        return tx("A quantidade ou a ordem das camadas excede os limites de índice do Aseprite.", "The layer count or drawing order exceeds Aseprite's index limits.");
      }
    }
    // Portable-v1 caps durations at 60,000 ms: they fit both the ASE WORD
    // (milliseconds) and GIF WORD (centiseconds) without a further limit.
  }
  return null;
}

function runExporter(input: TargetInput, format: Format, cwd: string, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(input.python, ["-I", "-m", "pixel_pipeline.export_animation", format], {
    cwd,
    signal,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "", PIXEL_PIPELINE_MAX_CPU_SECONDS: String(Math.ceil(input.timeoutMs / 1000)) },
  }, (error, _stdout, stderr) => {
    if (!error) resolve();
    else reject(new DomainFailure("internal", tx("O exportador raster local falhou", "The local raster exporter failed"), {
      format, cause: stderr.trim().slice(-2000) || error.message,
    }));
  });
  return promise;
}

async function build(input: TargetInput, format: Format): Promise<PackageFile[]> {
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const signal = AbortSignal.any([input.signal, deadline]);
  input.signal.throwIfAborted();
  const docs: RasterDocument[] = [];
  const outputs: string[] = [];
  const occupied = new Set(input.sourceFiles.map((file) => file.path.toLowerCase()));
  for (const entry of input.manifest.entries) {
    if (!input.selected.has(entry.revisionId)) continue;
    const renderables = documents(entry, format);
    if (!renderables.length) {
      throw new DomainFailure("internal", tx("Seleção sem conversor raster", "Selection has no raster converter"), { revisionId: entry.revisionId, format });
    }
    for (const doc of renderables) {
      const stem = `${format}/${slugify(entry.name ?? entry.assetId)}-${slugify(doc.name)}`;
      let output = `${stem}.${format}`;
      for (let suffix = 2; occupied.has(output); suffix++) output = `${stem}-${suffix}.${format}`;
      occupied.add(output);
      docs.push(doc);
      outputs.push(output);
    }
  }

  const ids = new Map<string, number>();
  for (const doc of docs) {
    for (const frame of doc.frames) {
      for (const layer of frame.layers) {
        if (!ids.has(layer.fileId)) ids.set(layer.fileId, ids.size);
      }
    }
  }
  const manifestFiles = new Map(input.manifest.files.map((file) => [file.fileId, file.path]));
  const sourceFiles = new Map(input.sourceFiles.map((file) => [file.path, file.bytes]));
  const work = await mkdtemp(path.join(input.workDir, `${format}-`));
  try {
    for (const [id, index] of ids) {
      const sourcePath = manifestFiles.get(id);
      const bytes = sourcePath === undefined ? undefined : sourceFiles.get(sourcePath);
      if (!bytes) throw new DomainFailure("internal", tx("Fonte raster ausente no pacote", "Raster source missing from package"), { fileId: id });
      await writeFile(path.join(work, `source-${index}.png`), bytes, { signal });
    }
    const spec = {
      sources: Object.fromEntries(ids),
      documents: format === "aseprite" ? docs.map((doc) => ({ ...doc, ...asepriteStack(doc.frames) })) : docs,
    };
    await writeFile(path.join(work, "request.json"), JSON.stringify(spec), { signal });
    await runExporter(input, format, work, signal);
    const files: PackageFile[] = [];
    for (const [index, output] of outputs.entries()) {
      const bytes = await readFile(path.join(work, `output-${index}.${format}`), { signal });
      files.push({ path: output, bytes, compress: false });
    }
    return files;
  } catch (error) {
    input.signal.throwIfAborted();
    if (deadline.aborted) throw new DomainFailure("internal", tx("A exportação raster excedeu o tempo limite", "Raster export exceeded the time limit"), { format });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export const asepriteTarget: ExportTarget = {
  problem: (entry) => problem(entry, "aseprite"),
  build: (input) => build(input, "aseprite"),
};

export const gifTarget: ExportTarget = {
  problem: (entry) => problem(entry, "gif"),
  build: (input) => build(input, "gif"),
};
