import { z } from "zod";
import { createProject, listProjects } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";

export const GET = api(async (_req, { studio }) => json({ projects: listProjects(studio.db) }));

export const POST = api(async (req, { studio }) => {
  const body = await readJson(req, z.strictObject({ name: z.string().trim().min(1).max(120) }));
  return json({ project: createProject(studio.db, studio.clock, body) }, 201);
});
