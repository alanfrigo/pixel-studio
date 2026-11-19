import { api, json } from "@/server/http";
import { jobView } from "@/server/services";

export const POST = api<{ projectId: string; jobId: string }>(async (_req, { params, studio }) =>
  json({ job: jobView(studio, studio.queue.requestCancel(params.projectId, params.jobId)) }),
);
