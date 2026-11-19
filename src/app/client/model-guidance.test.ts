import { describe, expect, it } from "vitest";
import { type CreationProfile, recommendCreation } from "./model-guidance";

const profile = (id: string, model: string | null, overrides: Partial<CreationProfile> = {}): CreationProfile => ({
  id, model, name: id, transport: "openrouter_images", simulated: false,
  capabilities: { generate_asset: ["text_to_image", "image_references"] }, unavailable: null, ...overrides,
});
const mini = profile("mini", "openai/gpt-image-1-mini");
const flare = profile("flare", "openai/gpt-image-2.6-flare");
const gemini = profile("gemini", "google/gemini-3.1-flash-image", { maxReferences: 14 });
const local = profile("local", null, { transport: "simulated", simulated: true });

const profiles = [local, mini, flare, gemini];

describe("automatic creation model", () => {
  it("picks by task and switches when an image is attached", () => {
    expect(recommendCreation(profiles, "character", 0).recommended).toBe(flare);
    expect(recommendCreation(profiles, "item", 0).recommended).toBe(mini);
    expect(recommendCreation(profiles, "item", 1).recommended).toBe(gemini);
    expect(recommendCreation(profiles, "character", 15).recommended).toBe(flare);
  });

  it("ignores disconnected and incompatible manual options before falling back to simulation", () => {
    const codex = profile("codex", null, { transport: "codex_cli", unavailable: "Not signed in" });
    const textOnly = profile("text", "google/gemini-3.1-flash-image", { capabilities: { generate_asset: ["text_to_image"] } });
    expect(recommendCreation([codex, local, textOnly], "item", 1).available).toEqual([local]);
    expect(recommendCreation([codex, local, textOnly], "item", 0).recommended).toBe(textOnly);
  });
});
