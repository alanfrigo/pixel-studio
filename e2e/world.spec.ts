import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { readZip } from "../src/lib/zip";
import { approve, seedTileset } from "./tileset-fixture";

test("paint corner terrain, undo a collision, reopen the saved map and export it to Tiled", async ({ page }) => {
  test.setTimeout(60_000);
  const name = "Lake trail";
  const project = await page.request.post("/api/v1/projects", { data: { name: "Terrain workshop" } });
  await expect(project).toBeOK();
  const { project: { id } } = await project.json();
  const projectUrl = `/api/v1/projects/${id}`;
  const { revisionId: tileset } = await seedTileset(page.request, projectUrl);

  await page.goto(`/projects/${id}/world?tab=maps`);
  const main = page.getByRole("main");
  const form = main.getByRole("heading", { name: "New map", exact: true }).locator("..");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByRole("combobox", { name: "Tileset", exact: true }).selectOption(tileset);
  await form.getByRole("spinbutton", { name: "Columns", exact: true }).fill("2");
  await form.getByRole("spinbutton", { name: "Rows", exact: true }).fill("2");
  await form.getByRole("button", { name: "Create", exact: true }).click();

  const editor = main.getByRole("heading", { name: /^Lake trail · 2×2 cells/ }).locator("../..");
  const canvas = editor.locator("canvas");
  await expect(canvas).toHaveAttribute("width", "128");
  await editor.getByRole("button", { name: "Paint Água", exact: true }).click();
  await canvas.click({ position: { x: 64, y: 64 } });
  const collision = editor.getByText(/^celulas: /);
  await editor.getByRole("button", { name: "Collision per cell", exact: true }).click();
  await canvas.click({ position: { x: 32, y: 96 } });
  await canvas.click({ position: { x: 96, y: 32 } });
  await expect(collision).toHaveText("celulas: 2 cells");
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(collision).toHaveText("celulas: 1 cell");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor.getByText(/^Draft saved \(version \d+\)\.$/)).toBeVisible();

  await page.reload();
  await main.getByRole("button", { name, exact: true }).click();
  await expect(collision).toHaveText("celulas: 1 cell");
  await editor.getByRole("button", { name: "Select / inspect", exact: true }).click();
  await canvas.click({ position: { x: 32, y: 32 } });
  await expect(editor.getByText("Cell (0, 0): mask 4 → grass-water-4 · walkable", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Publish revision", exact: true }).click();
  await expect(editor.getByText("r1 candidate", { exact: false })).toBeVisible();

  const response = await page.request.get(`${projectUrl}/assets?family=map`);
  await expect(response).toBeOK();
  const { assets } = await response.json();
  expect(assets).toMatchObject([{ name }]);
  await approve(page.request, projectUrl, assets[0].id);

  await page.getByRole("navigation", { name: "Project workspace" }).getByRole("link", { name: "Export", exact: true }).click();
  await main.getByRole("combobox", { name: "Export format", exact: true }).selectOption("tiled-v1");
  await main.getByRole("checkbox", { name, exact: true }).check();
  await main.getByRole("button", { name: "Export ZIP", exact: true }).click();
  const link = main.getByRole("link", { name: /^Download .+\.zip$/ });
  await expect(link).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const zip = readZip(await readFile(await download.path()));
  const maps = zip.paths.filter((path) => path.endsWith(".tmj"));
  expect(maps).toHaveLength(1);
  const map = JSON.parse(new TextDecoder().decode(zip.read(maps[0]!)));
  expect(map).toMatchObject({ width: 2, height: 2, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1 }] });
  expect(map.layers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Terrain", data: [5, 9, 3, 2] }),
    expect.objectContaining({ name: "Collisions", objects: [expect.objectContaining({ x: 0, y: 32, width: 32, height: 32 })] }),
  ]));
});
