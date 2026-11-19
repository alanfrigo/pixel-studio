import { expect, test, type Locator } from "@playwright/test";
import { createImage, encodePng, fillRect, getPixel } from "../src/lib/media/png";
import { decodePng } from "../src/server/equipment/png";

async function readPreview(image: Locator) {
  const src = await image.getAttribute("src");
  if (!src?.startsWith("data:image/png;base64,")) throw new Error(`Expected a PNG preview, got ${src}`);
  return decodePng(Buffer.from(src.slice("data:image/png;base64,".length), "base64"));
}

test("import and approve a bitmap font, report empty glyph cells and render at integer zoom without AI", async ({ page }) => {
  const created = await page.request.post("/api/v1/projects", { data: { name: "Font workshop" } });
  await expect(created).toBeOK();
  const { project: { id } } = await created.json();
  await page.goto(`/projects/${id}/dialogue?tab=font`);

  const main = page.getByRole("main");
  const inputs = main.getByRole("heading", { name: "Import an existing atlas (separate path)" }).locator("..");
  const atlas = createImage(12, 10);
  fillRect(atlas, 2, 2, 2, 1, [255, 255, 255, 255]);
  fillRect(atlas, 1, 3, 1, 4, [255, 255, 255, 255]);
  fillRect(atlas, 4, 3, 1, 4, [255, 255, 255, 255]);
  fillRect(atlas, 2, 5, 2, 1, [255, 255, 255, 255]);
  await inputs.getByLabel("Atlas PNG").setInputFiles({ name: "Tiny pixel.png", mimeType: "image/png", buffer: Buffer.from(encodePng(atlas)) });
  for (const [name, value] of Object.entries({ Columns: "2", Rows: "1", "Cell W": "6", "Cell H": "10", "Baseline (row below the body)": "7", "Cap height": "6" })) {
    await inputs.getByRole("spinbutton", { name, exact: true }).fill(value);
  }
  await inputs.getByRole("textbox", { name: "Characters in cell order (space = empty)" }).fill("AB");
  await inputs.getByRole("textbox", { name: "License", exact: true }).fill("CC0-1.0");
  const submit = inputs.getByRole("button", { name: "Import", exact: true });
  await expect(submit).toBeDisabled();
  await inputs.getByRole("textbox", { name: "Provenance" }).fill("Hand-drawn test atlas with an empty second cell");
  await submit.click();

  await expect(main.getByText("Origin: 0 generated · 0 extended · 1 imported")).toBeVisible({ timeout: 20_000 });
  await main.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(main.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await main.getByRole("button", { name: "Text bench", exact: true }).click();
  const bench = main.getByRole("heading", { name: "Text bench · r1" }).locator("..");
  await bench.getByRole("button", { name: /^Kit: basic \+ Portuguese/ }).click();
  await expect(bench.getByText(/^Coverage: 1\/\d+ glyphs required by the project$/)).toBeVisible();
  await expect(bench.getByText(/^Missing \(listed, never substituted\):.*\bB\b/)).toBeVisible();
  await bench.getByRole("textbox", { name: "Test strings (one per line)" }).fill("A\nAB");
  await bench.getByRole("button", { name: "Render", exact: true }).click();
  await expect(bench.getByText("Missing glyph: B", { exact: true })).toBeVisible({ timeout: 15_000 });
  const one = await readPreview(bench.getByRole("img", { name: "A", exact: true }).nth(0));
  const zoomed = await readPreview(bench.getByRole("img", { name: "A", exact: true }).nth(1));
  const missing = await readPreview(bench.getByRole("img", { name: "AB", exact: true }).nth(0));
  expect([zoomed.width, zoomed.height]).toEqual([one.width * 3, one.height * 3]);
  const countColor = ({ data }: typeof one, r: number, g: number, b: number) => {
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === 255) count++;
    }
    return count;
  };
  expect(countColor(one, 255, 255, 255)).toBe(12);
  expect(countColor(missing, 255, 255, 255)).toBe(12);
  expect(countColor(missing, 255, 0, 80)).toBeGreaterThan(0);
  for (let y = 0; y < zoomed.height; y++) for (let x = 0; x < zoomed.width; x++) {
    expect(getPixel(zoomed, x, y)).toEqual(getPixel(one, Math.floor(x / 3), Math.floor(y / 3)));
  }

  const jobsResponse = await page.request.get(`/api/v1/projects/${id}/jobs`);
  await expect(jobsResponse).toBeOK();
  const { jobs } = await jobsResponse.json() as { jobs: { kind: string }[] };
  expect(jobs.map(({ kind }) => kind)).toEqual(["ingest"]);
});
