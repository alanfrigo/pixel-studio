import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { importRoom, RoomImportInput } from "@/server/scenes/rooms";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";

const Body = z.strictObject({ target: AssetTarget, room: RoomImportInput });

/** Sala importada com planta, portas e grade declaradas. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "map", "room");
  return json({ revision: importRoom(studio, params.projectId, asset.id, body.room) }, 201);
});
