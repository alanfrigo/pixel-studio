import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Manifest } from "../src/contracts/manifest";
import { readZip } from "../src/lib/zip";

async function createProject(page: Page, name: string) {
  await expect(page.getByText("Loading projects…", { exact: true })).toBeHidden();
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("complementary").getByText(name, { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1);
}

async function decodeSprite(image: Locator) {
  await image.scrollIntoViewIfNeeded();
  return image.evaluate(async (element) => {
    const img = element as HTMLImageElement;
    await img.decode();
    return { src: img.currentSrc, size: [img.naturalWidth, img.naturalHeight] };
  });
}

test("generate, review and download a text-only icon as a portable ZIP", async ({ page }) => {
  test.setTimeout(90_000);
  const iconName = "Amber compass";
  const size = 24;
  await page.goto("/");
  const projectId = await createProject(page, `Icon workshop ${randomUUID()}`);
  const main = page.getByRole("main");
  const workspace = page.getByRole("navigation", { name: "Project workspace" });

  await main.getByRole("radio", { name: /^Item icon/ }).check();
  await main.getByRole("textbox", { name: "Name", exact: true }).fill(iconName);
  await main.getByRole("textbox", { name: "Art brief", exact: true }).fill("A brass compass with an amber needle, seen from above");
  await main.getByRole("combobox", { name: "Size in pixels", exact: true }).selectOption({ label: "24 × 24" });
  await main.getByRole("combobox", { name: "Model", exact: true }).selectOption({ label: "Local simulation · No charge" });
  await main.getByRole("button", { name: "Generate icon", exact: true }).click();

  const review = main.getByRole("link", { name: "Review sprites", exact: true });
  await expect(review).toBeVisible({ timeout: 30_000 });
  const generated = await decodeSprite(main.getByRole("img", { name: iconName, exact: true }));
  expect(generated.size).toEqual([size, size]);
  await review.click();

  await expect(main.getByText("candidate", { exact: true })).toBeVisible();
  await expect(main.getByRole("img", { name: "r1 1×", exact: true })).toHaveAttribute("src", new URL(generated.src).pathname);
  const zoom = main.getByRole("combobox", { name: "Zoom", exact: true });
  const oldZoom = main.getByRole("img", { name: "r1 4×", exact: true });
  await expect(oldZoom).toBeVisible();
  await zoom.selectOption({ label: "8×" });
  await expect(oldZoom).toHaveCount(0);
  const enlarged = main.getByRole("img", { name: "r1 8×", exact: true });
  await expect(enlarged).toHaveCSS("width", `${size * 8}px`);
  await expect(enlarged).toHaveCSS("image-rendering", "pixelated");
  expect(await decodeSprite(enlarged)).toEqual(generated);

  await main.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(main.getByText("active", { exact: true })).toBeVisible();
  await expect(main.getByText("candidate", { exact: true })).toHaveCount(0);
  await workspace.getByRole("link", { name: "Export", exact: true }).click();

  const format = main.getByRole("combobox", { name: "Export format", exact: true });
  const icon = main.getByRole("checkbox", { name: iconName, exact: true });
  const exportZip = main.getByRole("button", { name: "Export ZIP", exact: true });
  await format.selectOption({ label: "GIF" });
  await expect(main.getByText("No approved revision is compatible with this format.", { exact: true })).toBeVisible();
  await expect(icon).toHaveCount(0);
  await format.selectOption({ label: "Portable ZIP v1" });
  await expect(exportZip).toBeDisabled();
  await icon.check();
  await exportZip.click();

  const downloadLink = main.getByRole("link", { name: /^Download .+\.zip$/ });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), downloadLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const zip = readZip(await readFile(await download.path()));
  const manifest = Manifest.parse(JSON.parse(new TextDecoder().decode(zip.read("manifest.json"))));
  expect(manifest).toMatchObject({ schemaVersion: 1, projectId, profile: "portable-v1" });
  expect(manifest.files).toHaveLength(1);
  const file = manifest.files[0]!;
  expect(file).toMatchObject({ mime: "image/png", width: size, height: size });
  expect(manifest.entries).toEqual([expect.objectContaining({
    name: iconName,
    family: "item",
    kind: "consumable",
    dependencies: [],
    payload: expect.objectContaining({
      representations: [{
        role: "icon", state: "default", fileId: file.fileId,
        rect: [0, 0, size, size], sourceOffset: [0, 0], logicalSize: [size, size], pivot: [size / 2, size / 2],
      }],
    }),
  })]);
  expect(zip.paths.toSorted()).toEqual(["manifest.json", file.path].sort());
  const png = Buffer.from(zip.read(file.path));
  expect(png.byteLength).toBe(file.bytes);
  expect(createHash("sha256").update(png).digest("hex")).toBe(file.sha256);
  const reviewedMedia = await page.request.get(generated.src);
  await expect(reviewedMedia).toBeOK();
  expect(png.equals(await reviewedMedia.body())).toBe(true);
});

test("onboard from a template, safely revise its plan and check localized readiness on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Examples and templates", exact: true }).click();
  await page.getByRole("link", { name: "Use template: Forest ranger", exact: true }).click();
  await expect(page.getByText("Choose a project for this template", { exact: true })).toBeVisible();
  await createProject(page, `Ranger workshop ${randomUUID()}`);

  const main = page.getByRole("main");
  const brief = main.getByRole("textbox", { name: "Art brief", exact: true });
  const size = main.getByRole("combobox", { name: "Size in pixels", exact: true });
  const templateBrief = "arqueira com capa verde de capuz e arco";
  await expect(main.getByRole("radio", { name: /^Character/ })).toBeChecked();
  await expect(main.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Forest ranger");
  await expect(size).toHaveValue("64");
  await expect(brief).toHaveValue(new RegExp(templateBrief));

  await main.getByText("Advanced options", { exact: true }).click();
  const reviewPrompt = main.getByRole("button", { name: "Review prompt and cost", exact: true });
  const preview = main.getByRole("region", { name: "Review before generating", exact: true });
  await reviewPrompt.click();
  await expect(preview).toContainText("Local simulation · 1 submission · estimate: 1 generation");
  await expect(preview).toContainText("references: none (text only)");
  await preview.getByText("View compiled prompt", { exact: true }).click();
  await expect(preview.getByText(new RegExp(templateBrief))).toBeVisible();

  const newBrief = "A forest scout with a red scarf and a walking stick";
  await brief.fill(newBrief);
  await expect(preview).toHaveCount(0);
  await size.selectOption({ label: "48 × 48" });
  await main.getByRole("combobox", { name: "Prompt language", exact: true }).selectOption("en");
  await reviewPrompt.click();
  await preview.getByText("View compiled prompt", { exact: true }).click();
  const compiled = preview.getByText(/48×48 game cell/);
  await expect(compiled).toBeVisible();
  await expect(compiled).toContainText(newBrief);
  await expect(compiled).not.toContainText(templateBrief);

  const menu = page.getByRole("button", { name: /^Project menu/ });
  const workspace = page.getByRole("navigation", { name: "Project workspace" });
  const activity = workspace.getByRole("link", { name: "Activity", exact: true });
  await expect(workspace).toBeHidden();
  await menu.click();
  await expect(activity).toBeVisible();
  await activity.press("Escape");
  await expect(menu).toBeFocused();
  await expect(workspace).toBeHidden();
  await menu.click();
  await activity.click();
  await expect(main.getByText("No jobs yet.", { exact: true })).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  await navigation.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(main.getByRole("heading", { level: 1, name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Language / Idioma", exact: true }).selectOption("pt-BR");
  const settings = main.getByRole("heading", { level: 1, name: "Configurações", exact: true });
  await expect(settings).toBeVisible();
  await page.reload();
  await expect(settings).toBeVisible();
  await main.getByText("Diagnóstico do Studio", { exact: true }).click();
  await expect(main.getByText(/^Worker ativo · Python .+ \/ Pillow .+ · SQLite /)).toBeVisible({ timeout: 20_000 });
});
