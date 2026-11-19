import { EXPORT_PROFILES } from "@/server/export/profiles";
import { api, json } from "@/server/http";

export const GET = api(async () => json({ profiles: Object.values(EXPORT_PROFILES) }));
