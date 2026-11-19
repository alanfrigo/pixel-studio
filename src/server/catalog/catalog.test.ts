import { afterEach, describe, expect, it } from "vitest";
import { DomainFailure } from "../errors";
import { makeTestStudio, type TestStudio } from "../testing";
import {
  type BlobRecord,
  createAsset,
  createProject,
  getAsset,
  getBlob,
  getDraft,
  getProject,
  getStyleRevision,
  listRevisions,
  publishRevision,
  recordBlob,
  reviewRevision,
  revisionDependents,
  saveDraft,
} from "./catalog";

let studio: TestStudio;
afterEach(() => studio.cleanup());

const blob = (sha: string, width = 16, height = 16): BlobRecord => ({
  sha256: sha.repeat(64).slice(0, 64),
  bytes: 100,
  mime: "image/png",
  modality: "raster",
  metadata: { width, height },
});

const iconPayload = (size = 16) => ({
  itemKey: "potion",
  representations: [{ role: "icon", state: "default", fileId: "image", rect: [0, 0, size, size], sourceOffset: [0, 0], logicalSize: [size, size], pivot: [8, 8] }],
});

function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Clareira" });
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Poção" });
  const publish = (sha = "a", payload: unknown = iconPayload()) =>
    publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: asset.id,
      payload,
      origin: "import",
      styleRevisionId: project.activeStyleRevisionId,
      files: [{ fileKey: "image", role: "normalized", idx: 0, blob: blob(sha) }],
    });
  const approve = (revisionId: string, expected: string | null) =>
    reviewRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: asset.id,
      revisionId,
      decision: "approve",
      reason: null,
      expectedActiveRevisionId: expected,
    });
  return { project, asset, publish, approve };
}

describe("projetos", () => {
  it("nasce com estilo inicial aprovado e ativo", () => {
    const { project } = setup();
    const style = getStyleRevision(studio.db, project.id, project.activeStyleRevisionId!);
    expect(style).toMatchObject({ number: 1, status: "approved" });
    expect(style.payload.camera.projection.kind).toBe("top_down");
  });
});

describe("revisões", () => {
  it("publica candidatas imutáveis numeradas, sem mudar a revisão ativa", () => {
    const { project, asset, publish } = setup();
    const r1 = publish("a");
    const r2 = publish("b");
    expect([r1.number, r2.number]).toEqual([1, 2]);
    expect(r2.status).toBe("candidate");
    expect(getAsset(studio.db, project.id, asset.id).approvedRevisionId).toBeNull();
  });

  it("recusa payload incompatível com o tipo do asset", () => {
    const { publish } = setup();
    expect(() => publish("a", { itemKey: "x" })).toThrow(/Payload incompatível/);
  });

  it("recusa payload que cita arquivo sem vínculo", () => {
    const { project, asset } = setup();
    expect(() =>
      publishRevision(studio.db, studio.clock, {
        projectId: project.id,
        assetId: asset.id,
        payload: iconPayload(),
        origin: "import",
        styleRevisionId: null,
        files: [],
      }),
    ).toThrow(/arquivo sem vínculo: image/);
  });

  it("recusa retângulo maior que a imagem vinculada", () => {
    const { project, asset } = setup();
    expect(() =>
      publishRevision(studio.db, studio.clock, {
        projectId: project.id,
        assetId: asset.id,
        payload: iconPayload(16),
        origin: "import",
        styleRevisionId: null,
        files: [{ fileKey: "image", role: "normalized", idx: 0, blob: blob("c", 8, 8) }],
      }),
    ).toThrow(/excede 8×8/);
  });

  it("publicação inválida não deixa nada gravado (transação)", () => {
    const { project, asset, publish } = setup();
    expect(() => publish("a", { itemKey: "x" })).toThrow();
    expect(listRevisions(studio.db, project.id, asset.id)).toEqual([]);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n).toBe(0);
  });

  it("vínculo com revisão de outro projeto é bloqueado pela FK composta", () => {
    const { project, asset, publish } = setup();
    const other = createProject(studio.db, studio.clock, { name: "Deserto" });
    const otherAsset = createAsset(studio.db, studio.clock, { projectId: other.id, family: "item", kind: "consumable", name: "Duna" });
    const foreign = publishRevision(studio.db, studio.clock, {
      projectId: other.id,
      assetId: otherAsset.id,
      payload: iconPayload(),
      origin: "import",
      styleRevisionId: null,
      files: [{ fileKey: "image", role: "normalized", idx: 0, blob: blob("d") }],
    });
    publish("a");
    expect(() =>
      publishRevision(studio.db, studio.clock, {
        projectId: project.id,
        assetId: asset.id,
        payload: iconPayload(),
        origin: "composition",
        styleRevisionId: null,
        files: [{ fileKey: "image", role: "normalized", idx: 0, blob: blob("a") }],
        edges: [{ toRevisionId: foreign.id, role: "reference", ordinal: 0, runtime: false }],
      }),
    ).toThrow(/inexistente neste projeto/);
    // Segunda linha de defesa: a FK composta recusa a aresta mesmo sem a checagem do domínio.
    const mine = listRevisions(studio.db, project.id, asset.id)[0]!;
    expect(() =>
      studio.db.run(
        `INSERT INTO revision_edges (from_revision_id, to_revision_id, project_id, role, ordinal, runtime)
         VALUES (:from, :to, :p, 'reference', 0, 0)`,
        { from: mine.id, to: foreign.id, p: project.id },
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("dependências do payload viram arestas runtime automaticamente", () => {
    const { project } = setup();
    const font = createAsset(studio.db, studio.clock, { projectId: project.id, family: "font", kind: "bitmap", name: "Fonte" });
    const fontRev = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: font.id,
      payload: {
        nativeGlyphPx: 7,
        metrics: { ascent: 8, descent: 2, lineHeight: 10, spaceAdvance: 4 },
        glyphs: [{ codepoint: 85, fileId: "atlas", rect: [0, 0, 6, 10], bearingX: 0, bearingY: -8, advanceX: 6, origin: "generated" }],
        kerning: [],
        declaredCoverage: [85],
        missingGlyph: { policy: "report" },
        ttf: null,
        license: { name: "CC0-1.0", provenance: "teste" },
      },
      origin: "import",
      styleRevisionId: null,
      files: [{ fileKey: "atlas", role: "atlas", idx: 0, blob: blob("f", 6, 10) }],
    });
    expect(revisionDependents(studio.db, project.id, fontRev.id)).toEqual([]);
    const button = createAsset(studio.db, studio.clock, { projectId: project.id, family: "ui", kind: "button", name: "Botão" });
    const btn = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: button.id,
      payload: {
        logicalSize: [32, 16],
        states: [{ state: "normal", fileId: "atlas", rect: [0, 0, 32, 16] }],
        requiredStates: ["normal"],
        focus: null,
        nineSlice: { left: 4, right: 4, top: 4, bottom: 4 },
        contentPadding: { left: 7, right: 7, top: 5, bottom: 5 },
        stretch: { center: "stretch", edges: "stretch" },
        interactiveRect: null,
        text: { key: "inventory.use", sample: "Usar", align: "center", verticalAlign: "middle", wrap: "none", overflow: "grow", fontRevisionId: fontRev.id },
        accessibleName: null,
        complete: true,
      },
      origin: "import",
      styleRevisionId: null,
      files: [{ fileKey: "atlas", role: "atlas", idx: 0, blob: blob("b", 32, 16) }],
    });
    expect(revisionDependents(studio.db, project.id, fontRev.id)).toEqual([expect.objectContaining({ revisionId: btn.id, role: "font", runtime: 1 })]);
  });
});

describe("pareceres", () => {
  it("aprovar move o ponteiro; outra aba com revisão esperada antiga recebe 409", () => {
    const { project, asset, publish, approve } = setup();
    const r1 = publish("a");
    const r2 = publish("b");
    approve(r1.id, null);
    try {
      approve(r2.id, null); // a segunda aba ainda acha que não há revisão ativa
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainFailure);
      expect((err as DomainFailure).status).toBe(409);
      expect((err as DomainFailure).details).toMatchObject({ currentActiveRevisionId: r1.id });
    }
    approve(r2.id, r1.id);
    expect(getAsset(studio.db, project.id, asset.id).approvedRevisionId).toBe(r2.id);
  });

  it("reprovar exige motivo e preserva a candidata", () => {
    const { project, asset, publish } = setup();
    const r1 = publish("a");
    const review = (reason: string | null) =>
      reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, revisionId: r1.id, decision: "reject", reason, expectedActiveRevisionId: null });
    expect(() => review(null)).toThrow(/motivo/);
    expect(review("contorno grosso demais").revision.status).toBe("rejected");
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(1);
  });

  it("promover versão antiga gera parecer e lista derivados afetados", () => {
    const { project, asset, publish, approve } = setup();
    const r1 = publish("a");
    const r2 = publish("b");
    approve(r1.id, null);
    approve(r2.id, r1.id);
    const icon = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Ícone derivado" });
    const derived = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: icon.id,
      payload: iconPayload(),
      origin: "edit",
      styleRevisionId: null,
      files: [{ fileKey: "image", role: "normalized", idx: 0, blob: blob("e") }],
      edges: [{ toRevisionId: r2.id, role: "source", ordinal: 0, runtime: false }],
    });
    expect(revisionDependents(studio.db, project.id, r2.id)).toEqual([expect.objectContaining({ revisionId: derived.id })]);
    const result = reviewRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: asset.id,
      revisionId: r1.id,
      decision: "promote",
      reason: "voltar à versão anterior",
      expectedActiveRevisionId: r2.id,
    });
    expect(result.asset.approvedRevisionId).toBe(r1.id);
    expect(result.affectedDependents).toEqual([expect.objectContaining({ revisionId: derived.id, role: "source" })]);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")?.n).toBe(3);
  });

  it("não encontra asset de outro projeto", () => {
    const { asset } = setup();
    const other = createProject(studio.db, studio.clock, { name: "Outro" });
    expect(() => getAsset(studio.db, other.id, asset.id)).toThrow(/não encontrado/);
    expect(getProject(studio.db, other.id).name).toBe("Outro");
  });
});

describe("blobs", () => {
  it("mescla metadados medidos depois quando o mesmo conteúdo reaparece", () => {
    setup();
    const sha = "9".repeat(64);
    recordBlob(studio.db, studio.clock, { sha256: sha, bytes: 10, mime: "image/png", modality: "raster", metadata: { format: "png" } });
    recordBlob(studio.db, studio.clock, { sha256: sha, bytes: 10, mime: "image/png", modality: "raster", metadata: { width: 16, height: 16 } });
    expect(getBlob(studio.db, sha)?.metadata).toEqual({ format: "png", width: 16, height: 16 });
  });
});

describe("rascunhos", () => {
  it("versão esperada divergente (duas abas) é conflito", () => {
    const { project, asset } = setup();
    const save = (expectedVersion: number, payload: unknown) => saveDraft(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, expectedVersion, payload });
    expect(save(0, { a: 1 }).version).toBe(1);
    expect(() => save(0, { a: 2 })).toThrow(/outra aba/);
    expect(save(1, { a: 3 }).version).toBe(2);
    expect(getDraft(studio.db, project.id, asset.id)).toEqual({ version: 2, payload: { a: 3 } });
  });
});
