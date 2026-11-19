import { seedEquipmentDemo } from "@/server/equipment/demo";
import { api, json } from "@/server/http";

/** Semeia o caso do guerreiro (arte sintética local, aprovada) neste projeto. Idempotente. */
export const POST = api<{ projectId: string }>(async (_req, { params, studio }) => json(await seedEquipmentDemo(studio, params.projectId), 201));
