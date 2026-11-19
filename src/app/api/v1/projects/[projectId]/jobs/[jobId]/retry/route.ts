import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { jobView } from "@/server/services";

export const POST = api<{ projectId: string; jobId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, z.strictObject({ acknowledgePossibleCharge: z.boolean().default(false) }));
  return json({ job: jobView(studio, studio.queue.retry(params.projectId, params.jobId, body)) });
});
