import { readFile } from "node:fs/promises";
import { expect, type APIRequestContext } from "@playwright/test";
import { Manifest } from "../src/contracts/manifest";
import { writeZip } from "../src/lib/zip";

const tilesetName = "Grama ↔ água";

export async function approve(request: APIRequestContext, projectUrl: string, assetId: string) {
  const assetUrl = `${projectUrl}/assets/${assetId}`;
  const response = await request.get(assetUrl);
  await expect(response).toBeOK();
  const { revisions } = await response.json();
  expect(revisions).toMatchObject([{ status: "candidate" }]);
  const approved = await request.post(`${assetUrl}/reviews`, {
    data: { revisionId: revisions[0].id, decision: "approve", expectedActiveRevisionId: null },
  });
  await expect(approved).toBeOK();
  return revisions[0].id as string;
}

export async function seedTileset(request: APIRequestContext, projectUrl: string) {
  const fixture = "fixtures/clareira/package";
  const manifest = Manifest.parse(JSON.parse(await readFile(`${fixture}/manifest.json`, "utf8")));
  const entries = manifest.entries.filter((entry) => entry.revisionId === "grass-water-v1");
  const files = manifest.files.filter((file) => file.fileId === "grass-water-atlas");
  const atlas = files[0]!;
  const buffer = Buffer.from(writeZip([
    { path: "manifest.json", bytes: Buffer.from(JSON.stringify({ ...manifest, entries, files, attributions: [] })), compress: true },
    { path: atlas.path, bytes: await readFile(`${fixture}/${atlas.path}`), compress: false },
  ]));
  const upload = await request.post(`${projectUrl}/uploads`, {
    multipart: { file: { name: "terrain.zip", mimeType: "application/zip", buffer } },
  });
  await expect(upload).toBeOK();
  const { job } = await upload.json();
  await expect.poll(async () => {
    const response = await request.get(`${projectUrl}/jobs/${job.id}`);
    const { state, error } = (await response.json()).job;
    return { state, error };
  }, { timeout: 15_000 }).toMatchObject({ state: "succeeded" });
  const response = await request.get(`${projectUrl}/assets?family=tileset`);
  await expect(response).toBeOK();
  const { assets } = await response.json() as { assets: { id: string; name: string }[] };
  expect(assets).toMatchObject([{ name: tilesetName }]);
  return { assetId: assets[0]!.id, revisionId: await approve(request, projectUrl, assets[0]!.id), fileKey: atlas.fileId };
}
