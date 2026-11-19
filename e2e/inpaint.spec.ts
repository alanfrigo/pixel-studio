import { expect, test } from "@playwright/test";
import { getPixel } from "../src/lib/media/png";
import { decodePng } from "../src/server/equipment/png";
import { seedTileset } from "./tileset-fixture";

test("paint a mask in the browser, reject the empty preview and preserve every unmasked pixel", async ({ page }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  const created = await page.request.post("/api/v1/projects", { data: { name: "Retouch workshop" } });
  await expect(created).toBeOK();
  const { project: { id } } = await created.json();
  const projectUrl = `/api/v1/projects/${id}`;
  const { assetId, revisionId, fileKey } = await seedTileset(page.request, projectUrl);
  const search = new URLSearchParams({ asset: assetId, revision: revisionId, file: fileKey });
  await page.goto(`/projects/${id}/inpaint?${search}`);

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: /^Inpainting · Grama ↔ água/ })).toBeVisible();
  const canvas = main.locator("canvas");
  await expect(canvas).toHaveAttribute("width", "512");
  await main.getByRole("textbox", { name: "What should be in the region" }).fill("Replace the mark with a bright blue highlight");
  const preview = main.getByRole("button", { name: "Preview plan" });
  await preview.click();
  await expect(main.getByText("Empty mask: no region to edit. Nothing was sent.")).toBeVisible({ timeout: 20_000 });
  const generations = async () => {
    const response = await page.request.get(`${projectUrl}/jobs`);
    await expect(response).toBeOK();
    const { jobs } = await response.json() as { jobs: { kind: string }[] };
    return jobs.filter(({ kind }) => kind === "generation");
  };
  expect(await generations()).toEqual([]);
  await main.getByRole("combobox", { name: "Brush" }).selectOption("4");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Mask editor is not visible");
  // Click logical pixel (20, 23) in the displayed canvas, not its larger backing buffer.
  await canvas.click({ position: { x: 20.5 * bounds.width / 128, y: 23.5 * bounds.height / 128 } });
  await preview.click();
  await expect(main.getByRole("strong").filter({ hasText: /^Inpainting with a native mask$/ })).toBeVisible({ timeout: 20_000 });
  expect(await generations()).toEqual([]);
  await main.getByRole("button", { name: "Run", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Result · r2 (candidate)" })).toBeVisible({ timeout: 25_000 });
  await expect(main.getByText("0 differences outside the mask", { exact: true })).toBeVisible();
  await expect(main.getByText(/16 pixels edited · 16368 protected/)).toBeVisible();
  await expect(main.getByText(/^16 of 16384 pixels differ/)).toBeVisible();
  expect(await generations()).toHaveLength(1);

  const response = await page.request.get(`${projectUrl}/assets/${assetId}`);
  await expect(response).toBeOK();
  const { revisions } = await response.json() as { revisions: { id: string; status: string; files: { id: string; fileKey: string }[] }[] };
  expect(revisions.map(({ status }) => status)).toEqual(["candidate", "approved"]);
  expect(revisions[1]!.id).toBe(revisionId);
  const load = async (index: number, key: string) => {
    const file = revisions[index]!.files.find((f) => f.fileKey === key)!;
    const media = await page.request.get(`${projectUrl}/media/${file.id}`);
    await expect(media).toBeOK();
    return decodePng(await media.body());
  };
  const [source, result, candidate, mask] = await Promise.all([
    load(1, fileKey), load(0, fileKey), load(0, "inpaint-candidate"), load(0, "inpaint-mask"),
  ]);
  let changedInside = 0;
  let changedOutside = 0;
  let candidateMismatch = 0;
  let misplacedMask = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const edit = x >= 19 && x < 23 && y >= 22 && y < 26;
      const output = getPixel(result, x, y);
      const changed = output.some((channel, i) => channel !== getPixel(source, x, y)[i]);
      if (getPixel(mask, x, y)[0] !== (edit ? 255 : 0)) misplacedMask++;
      if (!edit && changed) changedOutside++;
      if (edit && changed) changedInside++;
      if (edit && output.some((channel, i) => channel !== getPixel(candidate, x, y)[i])) candidateMismatch++;
    }
  }
  expect({ misplacedMask, changedOutside, candidateMismatch }).toEqual({ misplacedMask: 0, changedOutside: 0, candidateMismatch: 0 });
  expect(changedInside).toBeGreaterThan(0);
});
