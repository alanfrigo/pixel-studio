import { api, json } from "@/server/http";
import { jobView } from "@/server/services";

export const GET = api<{ projectId: string; jobId: string }>(async (_req, { params, studio }) =>
  json({ job: jobView(studio, studio.queue.getForProject(params.projectId, params.jobId)) }),
);
