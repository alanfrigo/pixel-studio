import { api, json } from "@/server/http";
import { health } from "@/server/services";

export const dynamic = "force-dynamic";

export const GET = api(async (_req, { studio }) => json(await health(studio)));
