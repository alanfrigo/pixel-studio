import { describe, expect, it } from "vitest";
import type { Manifest } from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import { validateManifest } from "./validate";

const nominal = () => structuredClone(buildClareira().manifest) as Manifest;
const codes = (input: unknown) => validateManifest(input).issues.map((i) => i.code);

/** Exemplo literal do contrato 02a §formato portátil v1. */
const PLAN_EXAMPLE = {
  schemaVersion: 1,
  projectId: "clareira",
  profile: "portable-v1",
  files: [
    {
      fileId: "spark-texture",
      path: "textures/spark.png",
      mime: "image/png",
      width: 16,
      height: 8,
      bytes: 588,
      sha256: "9958156615c1b4afce4321cdc608270530d08a689d0008a6cb495760b045cdf8",
    },
  ],
  entries: [
    {
      assetId: "spark",
      revisionId: "spark-v1",
      family: "vfx",
      kind: "burst",
      dependencies: [],
      payload: {
        logicalSize: [8, 8],
        pivot: [3, 4],
        loop: false,
        blendMode: "normal",
        frames: [
          { frameId: "rise", fileId: "spark-texture", rect: [0, 0, 8, 8], sourceOffset: [0, 0], durationMs: 80 },
          { frameId: "fade", fileId: "spark-texture", rect: [8, 0, 8, 8], sourceOffset: [0, 0], durationMs: 120 },
        ],
      },
    },
  ],
};

describe("validateManifest · caso nominal", () => {
  it("aceita o exemplo literal do plano 02a", () => {
    const result = validateManifest(PLAN_EXAMPLE);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("aceita o pacote completo da clareira sem nenhuma pendência", () => {
    const result = validateManifest(nominal());
    expect(result.issues).toEqual([]);
  });

  it("aceita pacote mínimo só de áudio, sem dimensões raster", () => {
    // Pacote montado à mão por outro agente: nenhum campo width/height no som.
    const audioOnly = {
      schemaVersion: 1,
      projectId: "clareira",
      profile: "portable-v1",
      files: [
        {
          fileId: "ambience",
          path: "audio/forest.ogg",
          mime: "audio/ogg",
          bytes: 48_213,
          sha256: "a".repeat(64),
          durationMs: 12_000,
          sampleRate: 44_100,
          channels: 2,
          frameCount: 529_200,
          codec: "vorbis",
        },
      ],
      entries: [
        {
          assetId: "forest-ambience",
          revisionId: "forest-ambience-v1",
          family: "audio",
          kind: "music",
          dependencies: [],
          payload: { fileId: "ambience", loop: { startFrame: 0, endFrame: 529_200 }, vocal: false, lyrics: null },
        },
      ],
    };
    expect(validateManifest(audioOnly).issues).toEqual([]);
  });
});

describe("validateManifest · dependências", () => {
  it("acusa dependência declarada ausente do pacote", () => {
    const m = nominal();
    m.entries = m.entries.filter((e) => e.revisionId !== "spark-v1");
    const issues = validateManifest(m).issues;
    expect(issues.find((i) => i.code === "dependency_missing")).toMatchObject({
      revisionId: "warrior-attack-osh-s-v1",
      message: expect.stringContaining("spark-v1"),
    });
  });

  it("acusa uso runtime sem declaração em dependencies", () => {
    const m = nominal();
    const clip = m.entries.find((e) => e.revisionId === "warrior-attack-osh-s-v1")!;
    clip.dependencies = clip.dependencies.filter((d) => d.revisionId !== "hit-sfx-v1");
    expect(codes(m)).toEqual(["undeclared_dependency"]);
  });

  it("acusa dependência de tipo errado", () => {
    const m = nominal();
    const loadout = m.entries.find((e) => e.revisionId === "warrior-loadout-osh-v1")!;
    if (loadout.family !== "equipment" || loadout.kind !== "loadout") throw new Error("fixture");
    loadout.payload.overlayRevisionIds = ["spark-v1"];
    loadout.dependencies.push({ revisionId: "spark-v1", role: "overlay" });
    expect(codes(m)).toContain("dependency_kind_mismatch");
  });

  it("acusa ciclo de composição", () => {
    const m = nominal();
    m.entries.find((e) => e.revisionId === "warrior-rig-v1")!.dependencies.push({ revisionId: "chainmail-v1", role: "cosmetic" });
    const issue = validateManifest(m).issues.find((i) => i.code === "dependency_cycle");
    expect(issue?.message).toMatch(/warrior-rig-v1.*chainmail-v1/);
  });
});

describe("validateManifest · enum e grade inválidos", () => {
  it("rejeita família desconhecida", () => {
    const m = nominal() as unknown as { entries: { family: string }[] };
    m.entries[0]!.family = "creature";
    expect(validateManifest(m).issues[0]).toMatchObject({ code: "schema_invalid", path: ["entries", 0, "family"] });
  });

  it("rejeita direção inválida", () => {
    const m = nominal() as unknown as { entries: { payload: { direction?: string } }[] };
    const clip = m.entries.find((e) => e.payload.direction)!;
    clip.payload.direction = "NNE";
    expect(codes(m)).toEqual(["schema_invalid"]);
  });

  it("rejeita retângulo fora do atlas", () => {
    const m = nominal();
    const spark = m.entries.find((e) => e.revisionId === "spark-v1")!;
    if (spark.family !== "vfx") throw new Error("fixture");
    spark.payload.frames[1]!.rect = [12, 0, 8, 8];
    const issue = validateManifest(m).issues.find((i) => i.code === "rect_out_of_bounds");
    expect(issue).toMatchObject({ fileId: "spark-texture", path: ["entries", 3, "payload", "frames", 1] });
  });

  it("rejeita tile com célula diferente da grade do tileset", () => {
    const m = nominal();
    const ts = m.entries.find((e) => e.family === "tileset")!;
    if (ts.family !== "tileset" || ts.kind !== "corner") throw new Error("fixture");
    ts.payload.tiles[3]!.rect = [96, 0, 32, 31];
    expect(codes(m)).toEqual(["schema_invalid"]);
  });

  it("rejeita tileset completo sem as 16 máscaras", () => {
    const m = nominal();
    const ts = m.entries.find((e) => e.family === "tileset")!;
    if (ts.family !== "tileset" || ts.kind !== "corner") throw new Error("fixture");
    ts.payload.tiles = ts.payload.tiles.filter((t) => t.mask !== 9);
    expect(validateManifest(m).issues[0]?.message).toContain("máscaras: 9");
  });

  it("rejeita versão principal desconhecida antes de importar", () => {
    expect(validateManifest({ ...nominal(), schemaVersion: 2 }).issues).toEqual([
      expect.objectContaining({ code: "unsupported_version" }),
    ]);
  });
});

describe("validateManifest · arquivos e caminhos", () => {
  it.each([
    ["/etc/passwd"],
    ["../fora.png"],
    ["sprites/../../fora.png"],
    ["C:/jogo/x.png"],
    ["sprites\\x.png"],
  ])("rejeita caminho inseguro %s", (badPath) => {
    const m = nominal();
    m.files[0]!.path = badPath;
    expect(codes(m)).toEqual(["schema_invalid"]);
  });

  it("acusa caminhos que colidem sem diferenciar maiúsculas", () => {
    const m = nominal();
    m.files[1]!.path = m.files[0]!.path.toUpperCase();
    expect(codes(m)).toContain("duplicate_path");
  });

  it("acusa arquivo de modalidade errada", () => {
    const m = nominal();
    const sfx = m.entries.find((e) => e.family === "audio")!;
    if (sfx.family !== "audio") throw new Error("fixture");
    sfx.payload.fileId = "spark-texture";
    expect(codes(m)).toEqual(["file_modality_mismatch"]);
  });

  it("acusa loop de áudio além do arquivo", () => {
    const m = nominal();
    const sfx = m.entries.find((e) => e.family === "audio")!;
    if (sfx.family !== "audio") throw new Error("fixture");
    sfx.payload.loop = { startFrame: 0, endFrame: 2206 };
    expect(codes(m)).toEqual(["audio_loop_out_of_range"]);
  });
});

describe("validateManifest · coerência entre peças", () => {
  it("aponta peça, clipe e frame quando a cobertura cita frame inexistente", () => {
    const m = nominal();
    const mail = m.entries.find((e) => e.revisionId === "chainmail-v1")!;
    if (mail.family !== "equipment" || mail.kind !== "overlay") throw new Error("fixture");
    mail.payload.parts[1]!.coverage[2]!.frameId = "follow-through";
    const issue = validateManifest(m).issues.find((i) => i.code === "unknown_frame");
    expect(issue).toMatchObject({
      revisionId: "chainmail-v1",
      path: ["entries", 6, "payload", "parts", 1, "coverage", 2, "frameId"],
    });
  });

  it("acusa slots em conflito no conjunto equipado", () => {
    const m = nominal();
    const second = structuredClone(m.entries.find((e) => e.revisionId === "chainmail-v1")!);
    second.revisionId = "chainmail-v2";
    m.entries.push(second);
    const loadout = m.entries.find((e) => e.revisionId === "warrior-loadout-osh-v1")!;
    if (loadout.family !== "equipment" || loadout.kind !== "loadout") throw new Error("fixture");
    loadout.payload.overlayRevisionIds.push("chainmail-v2");
    loadout.dependencies.push({ revisionId: "chainmail-v2", role: "overlay" });
    expect(codes(m)).toEqual(["slot_conflict"]);
  });

  it("acusa socket que não existe no rig", () => {
    const m = nominal();
    const clip = m.entries.find((e) => e.revisionId === "warrior-attack-osh-s-v1")!;
    if (clip.family !== "character" || clip.kind !== "clip") throw new Error("fixture");
    clip.payload.frames[0]!.sockets[0]!.socketId = "tail_tip";
    expect(codes(m)).toEqual(["unknown_socket"]);
  });

  it("acusa célula do clipe incoerente com rig + margens", () => {
    const m = nominal();
    const clip = m.entries.find((e) => e.revisionId === "warrior-attack-osh-s-v1")!;
    if (clip.family !== "character" || clip.kind !== "clip") throw new Error("fixture");
    clip.payload.margins.right = 16;
    expect(codes(m)).toEqual(["cell_mismatch"]);
  });
});
