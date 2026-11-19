import { describe, expect, it } from "vitest";
import { GenerationPlan } from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences, type PlanLookup } from "./references";

const fixture = buildClareira();
const lookup: PlanLookup = {
  revision: (id) => fixture.catalog.revisions.find((r) => r.revisionId === id),
  upload: (id) => fixture.catalog.uploads.find((u) => u.fileId === id),
};
const plan = (name: string) => structuredClone(fixture.plans[name]!) as GenerationPlan;

describe("planos de exemplo da clareira", () => {
  it.each(Object.keys(fixture.plans))("%s passa no schema e nas referências", (name) => {
    const parsed = GenerationPlan.safeParse(plan(name));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(validatePlanReferences(parsed.data!, lookup)).toEqual([]);
  });

  it("geração só por texto não exige referências", () => {
    expect(plan("potion-text").sources).toEqual([]);
  });

  it("o digest do plano muda com a ordem das referências, não com a ordem das chaves", () => {
    const a = plan("chainmail-two-refs");
    const reordered = { ...a, sources: [...a.sources].reverse() };
    const sameKeys = Object.fromEntries(Object.entries(a).reverse());
    expect(canonicalDigest(sameKeys)).toBe(canonicalDigest(a));
    expect(canonicalDigest(reordered)).not.toBe(canonicalDigest(a));
  });
});

describe("validatePlanReferences", () => {
  it("bloqueia referência cruzada entre projetos", () => {
    const p = plan("chainmail-two-refs");
    const dune = fixture.catalog.revisions.find((r) => r.revisionId === "deserto-dune-v1")!;
    p.sources[1] = { ordinal: 1, revisionId: dune.revisionId, fileId: "dune-ref", sha256: dune.files["dune-ref"]!.sha256, role: "material" };
    expect(validatePlanReferences(p, lookup)).toEqual([
      expect.objectContaining({ code: "cross_project_reference", revisionId: "deserto-dune-v1", path: ["sources", 1, "revisionId"] }),
    ]);
  });

  it("bloqueia estilo de outro projeto", () => {
    const p = { ...plan("potion-text"), styleRevisionId: "deserto-dune-v1" };
    expect(validatePlanReferences(p, lookup).map((i) => i.code)).toEqual(["cross_project_reference"]);
  });

  it("exige fonte aprovada", () => {
    const p = plan("chainmail-two-refs");
    const cand = fixture.catalog.revisions.find((r) => r.revisionId === "potion-v2-candidate")!;
    p.sources[1] = { ordinal: 1, revisionId: cand.revisionId, fileId: "potion-sheet", sha256: cand.files["potion-sheet"]!.sha256, role: "material" };
    expect(validatePlanReferences(p, lookup).map((i) => i.code)).toEqual(["source_not_approved"]);
  });

  it("detecta hash congelado divergente", () => {
    const p = plan("chainmail-two-refs");
    p.sources[0]!.sha256 = "0".repeat(64);
    expect(validatePlanReferences(p, lookup).map((i) => i.code)).toEqual(["source_file_mismatch"]);
  });

  it("detecta movimento alterado depois do plano", () => {
    const p = plan("attack-skeleton");
    p.sources[1]!.sha256 = canonicalDigest({ changed: true });
    expect(validatePlanReferences(p, lookup).map((i) => i.code)).toEqual(["source_file_mismatch"]);
  });

  it("detecta máscara com grade diferente da fonte", () => {
    const smallMask: PlanLookup = {
      ...lookup,
      upload: (id) => {
        const u = lookup.upload(id);
        return u && { ...u, width: 64, height: 64 };
      },
    };
    expect(validatePlanReferences(plan("inpaint-lake"), smallMask).map((i) => i.code)).toEqual(["mask_size_mismatch"]);
  });

  it("acusa revisão inexistente", () => {
    const p = plan("rotate-views");
    if (p.operation !== "rotate_views") throw new Error("fixture");
    p.params.identityRevisionId = "warrior-base-v9";
    expect(validatePlanReferences(p, lookup)).toEqual([expect.objectContaining({ code: "not_found", path: ["params", "identityRevisionId"] })]);
  });
});

describe("GenerationPlan · invariantes do schema", () => {
  const issues = (value: unknown) => GenerationPlan.safeParse(value).error?.issues.map((i) => i.message) ?? [];

  it("inpainting nativo exige a capacidade native_mask", () => {
    const p = plan("inpaint-lake");
    p.requiredCapabilities = ["image_edit"];
    expect(issues(p)).toContain("Operação inpaint exige a capacidade native_mask");
  });

  it("modo candidato recortado é escolha explícita com image_edit", () => {
    const p = plan("inpaint-lake");
    if (p.operation !== "inpaint") throw new Error("fixture");
    p.params.mode = "candidate-composite";
    p.requiredCapabilities = ["image_edit"];
    expect(issues(p)).toEqual([]);
  });

  it("rejeita convenção de máscara diferente da interna", () => {
    const p = plan("inpaint-lake") as unknown as { params: { maskConvention: string } };
    p.params.maskConvention = "alpha_zero_edits";
    expect(issues(p).length).toBeGreaterThan(0);
  });

  it("esqueleto exige keypoints e o movimento congelado nas fontes", () => {
    const p = plan("attack-skeleton");
    p.sources = p.sources.slice(0, 1);
    p.requiredCapabilities = ["text_animation"];
    expect(issues(p)).toEqual([
      "Operação animate_skeleton exige a capacidade skeleton_keypoints",
      "Revisão de movimento deve estar congelada nas fontes",
    ]);
  });

  it("não regera vistas já aprovadas", () => {
    const p = plan("rotate-views");
    if (p.operation !== "rotate_views") throw new Error("fixture");
    p.params.requestedViews = ["N", "S"];
    expect(issues(p)).toContain("Vistas já aprovadas não são regeradas: S");
  });

  it("rejeita estimativa acima do teto autorizado", () => {
    const p = plan("chainmail-two-refs");
    p.limits.costCeiling = { amount: 0.05, unit: "USD" };
    expect(issues(p)).toContain("Estimativa excede o teto autorizado");
  });

  it("exige ordinais contíguos na ordem das fontes", () => {
    const p = plan("chainmail-two-refs");
    p.sources[1]!.ordinal = 2;
    expect(issues(p)).toContain("Ordinal deve ser 1, recebido 2");
  });
});
