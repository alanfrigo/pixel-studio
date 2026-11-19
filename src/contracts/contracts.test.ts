import { describe, expect, it } from "vitest";
import {
  ButtonPayload,
  DirectionSet,
  FontPayload,
  MaskDescriptor,
  MotionPayload,
  Projection,
  PythonRequest,
  StylePayload,
  canTransition,
  type ButtonPayload as ButtonPayloadT,
  type MotionPayload as MotionPayloadT,
} from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import { isoWorldToView } from "@/domain/projection";

const fixture = buildClareira();
const messages = (r: { error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];

describe("estilo", () => {
  it("aceita o estilo A da clareira", () => {
    expect(messages(StylePayload.safeParse(fixture.style))).toEqual([]);
  });

  it("exige índices de paleta contíguos (desempate estável)", () => {
    const style = structuredClone(fixture.style);
    style.palette.colors[2]!.index = 7;
    expect(messages(StylePayload.safeParse(style))).toContain("Índice da cor deve ser 2");
  });
});

describe("direção e projeção", () => {
  it.each([[["S"]], [["E", "W"]], [["N", "E", "S", "W"]], [["NE", "SE", "SW", "NW"]], [["N", "NE", "E", "SE", "S", "SW", "W", "NW"]]])(
    "aceita o conjunto %j",
    (dirs) => expect(DirectionSet.safeParse(dirs).success).toBe(true),
  );

  it.each([[["N", "E", "S"]], [["S", "S"]], [["N", "NE"]]])("rejeita o conjunto %j", (dirs) => {
    expect(DirectionSet.safeParse(dirs).success).toBe(false);
  });

  it("isométrico exige mapa mundo → vista bijetivo", () => {
    const iso = { kind: "isometric", diamond: [64, 32], elevationStepPx: 8, worldToView: isoWorldToView() };
    expect(Projection.safeParse(iso).success).toBe(true);
    const broken = { ...iso, worldToView: { ...iso.worldToView, N: "SE" } };
    expect(messages(Projection.safeParse(broken))).toContain("Mapa mundo → vista deve ser uma bijeção das 8 direções");
  });
});

describe("máscara", () => {
  it("máscara de edição binária usa branco marca / preto desmarca", () => {
    const mask = { role: "editMask", convention: "white_marks_black_unmarks", size: [128, 128], origin: "top_left", fileId: "lake-mask" };
    expect(MaskDescriptor.safeParse(mask).success).toBe(true);
    expect(messages(MaskDescriptor.safeParse({ ...mask, convention: "coverage_0_255" }))).toEqual([
      "Máscara editMask deve usar a convenção white_marks_black_unmarks",
    ]);
  });
});

describe("esqueleto de movimento (separado do rig)", () => {
  const motion = () => {
    const entry = fixture.manifest.entries.find((e) => e.family === "character" && e.kind === "motion")!;
    return structuredClone(entry.payload) as MotionPayloadT;
  };

  it("aceita o movimento do ataque", () => {
    expect(messages(MotionPayload.safeParse(motion()))).toEqual([]);
  });

  it("rejeita duas raízes", () => {
    const m = motion();
    m.skeleton.joints[1]!.parent = null;
    expect(messages(MotionPayload.safeParse(m))).toContain("Esqueleto deve ter exatamente uma raiz (encontradas 2)");
  });

  it("rejeita ciclo na hierarquia", () => {
    const m = motion();
    m.skeleton.joints[1]!.parent = "head"; // chest → head → chest
    expect(messages(MotionPayload.safeParse(m)).some((msg) => msg.startsWith("Ciclo na hierarquia"))).toBe(true);
  });

  it("rejeita pose sem um joint e coordenada fora de [0, 1]", () => {
    const m = motion();
    delete m.poses[2]!.joints.hand_l;
    m.poses[0]!.joints.hand_r!.x = 1.2;
    const msgs = messages(MotionPayload.safeParse(m));
    expect(msgs).toContain("Pose sem o joint hand_l");
    expect(msgs.some((msg) => msg.includes("<=1"))).toBe(true);
  });

  it("não aceita campos de rig (slots) dentro do movimento", () => {
    expect(MotionPayload.safeParse({ ...motion(), slots: [] }).success).toBe(false);
  });
});

describe("UI", () => {
  const button = () => {
    const entry = fixture.manifest.entries.find((e) => e.family === "ui" && e.kind === "button")!;
    return structuredClone(entry.payload) as ButtonPayloadT;
  };

  it("rejeita nine-slice sem área central", () => {
    const b = button();
    b.nineSlice = { left: 16, right: 16, top: 4, bottom: 4 };
    expect(messages(ButtonPayload.safeParse(b))).toContain("nineSlice deixa a área central sem pixels");
  });

  it("não marca completo sem um estado obrigatório", () => {
    const b = button();
    b.states = b.states.filter((s) => s.state !== "disabled");
    expect(messages(ButtonPayload.safeParse(b))).toContain("Componente marcado completo sem os estados: disabled");
  });

  it("estados mantêm a célula do tamanho lógico", () => {
    const b = button();
    b.states[1]!.rect = [32, 0, 33, 16];
    expect(messages(ButtonPayload.safeParse(b))).toContain("Cada estado deve manter a célula do tamanho lógico");
  });
});

describe("fonte", () => {
  it("bloqueia cobertura declarada sem glyph (acentos não presumidos)", () => {
    const entry = fixture.manifest.entries.find((e) => e.family === "font")!;
    const font = structuredClone(entry.payload) as Record<string, unknown> & { declaredCoverage: number[] };
    font.declaredCoverage.push("é".codePointAt(0)!);
    expect(messages(FontPayload.safeParse(font))).toEqual(["Cobertura declarada sem glyph: U+00E9 (é)"]);
  });
});

describe("protocolo Python", () => {
  it("valida a receita de fatiamento do exemplo 05", () => {
    const req = {
      protocolVersion: 1,
      jobId: "job-1",
      attemptId: "att-1",
      operation: "slice_grid",
      inputs: [{ ordinal: 0, role: "source", sha256: "b".repeat(64), relPath: "in/strip.png" }],
      recipe: {
        version: 1,
        grid: { rows: 1, columns: 4, cell: [64, 64], margin: [0, 0], spacing: [0, 0], traversal: "row_major" },
        frameIds: ["windup", "advance", "contact", "recover"],
        durationMs: [140, 80, 60, 160],
        pivot: [32, 56],
        emptyCells: [],
      },
    };
    expect(messages(PythonRequest.safeParse(req))).toEqual([]);
    expect(PythonRequest.safeParse({ ...req, protocolVersion: 2 }).success).toBe(false);
    expect(PythonRequest.safeParse({ ...req, inputs: [{ ...req.inputs[0], relPath: "../fora.png" }] }).success).toBe(false);
  });
});

describe("fila", () => {
  it("segue queued → running → succeeded e permite needs_attention", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "needs_attention")).toBe(true);
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
  });
});
