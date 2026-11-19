import { type RoomDoor, RoomPayload, type RoomProjection } from "@/contracts";
import { doorGeometry, gridWalkable } from "@/domain/scenes/room";

/**
 * Payload local da sala a partir da planta declarada: portas, grade e piso
 * caminhável derivados da grade em que a guia raster foi desenhada (ou da
 * grade revisada na importação).
 */

type PlanDoor = Pick<RoomDoor, "doorId" | "cell" | "side">;

export function genericRoomPayload(o: {
  params: { theme: string; projection: RoomProjection; tileSize: number; doors: PlanDoor[]; floorPlan: RoomPayload["floorPlan"]; styleRoomRevisionId: string | null };
  grid: { pictureSize: [number, number]; cellPx: [number, number]; gridOrigin: [number, number] };
  route?: "generic_image_references" | "imported";
  fileId?: string;
}): RoomPayload {
  const { params, grid } = o;
  const geo = { projection: params.projection, cellPx: grid.cellPx, gridOrigin: grid.gridOrigin, floorPlan: params.floorPlan };
  return RoomPayload.parse({
    projection: params.projection,
    theme: params.theme,
    floorPlan: params.floorPlan,
    doors: params.doors.map((d) => ({ ...d, ...doorGeometry(geo, d) })),
    tileSize: params.tileSize,
    cellPx: grid.cellPx,
    gridOrigin: grid.gridOrigin,
    picture: { fileId: o.fileId ?? "picture", rect: [0, 0, grid.pictureSize[0], grid.pictureSize[1]] },
    background: null,
    overlay: null,
    walkable: gridWalkable(geo),
    route: o.route ?? "generic_image_references",
    styleRoomRevisionId: params.styleRoomRevisionId,
    sourceRoomRevisionId: null,
    connections: [],
    furniture: [],
    exposedAreas: [],
  });
}
