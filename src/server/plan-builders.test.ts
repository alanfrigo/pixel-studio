import { describe, expect, it } from "vitest";
import { PLAN_BUILDERS, PlanRequest } from "./plan-builders";

describe("registro de construtores de plano", () => {
  it("uma entrada por operação, união discriminada aceita cada uma e recusa operação desconhecida", () => {
    const ops = PLAN_BUILDERS.map((b) => b.operation);
    expect(new Set(ops).size).toBe(ops.length);
    expect(
      PlanRequest.parse({ operation: "generate_asset", providerProfileId: "simulated", brief: "poção", params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 } }),
    ).toMatchObject({ operation: "generate_asset" });
    expect(
      PlanRequest.parse({ operation: "inpaint", providerProfileId: "simulated", sourceRevisionId: "rev_1", sourceFileKey: "image", maskUploadId: "upl_1", instruction: "x", mode: "native-mask" }),
    ).toMatchObject({ operation: "inpaint" });
    expect(() => PlanRequest.parse({ operation: "nao_existe" })).toThrow();
  });
});
