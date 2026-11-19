# World, tilemaps, scenes, and rooms

Paths in the inventory are relative to `/api/v1`. All operations in the two tables are local: no provider call or generation charge. Preview/check routes do not publish; some other local operations persist files, uploads, or candidates. Actual generation and inpainting go through the shared generation-plan/job workflow, not through these routes.

```sh
API=http://127.0.0.1:3000/api/v1
P="$API/projects/$PROJECT"
```

Use JSON for POST bodies. Replace example IDs with real IDs from the same project. A `target` is exactly `{"name":"New asset name"}` or `{"assetId":"EXISTING_ASSET_ID"}` (must match family/kind); use `revision.id` for a revision reference and `revision.assetId` for its asset. An `image` reference is exactly one of `{"from":"upload","uploadId":"READY_UPLOAD_ID"}`, `{"from":"revision","revisionId":"REVISION_ID","fileKey":"image"}`, or `{"from":"job_output","jobId":"LOCAL_JOB_ID","outputIndex":0}`. A revision's `files[].fileKey` selects a file within that revision; `files[].id` is a media ID, not a file key or an upload ID. Masks are upload IDs, not hashes. Geometry rectangles are `[x,y,width,height]`; dimensions are positive integer pairs. Publish operations produce candidate revisions, not approvals. Approve required source revisions in the shared revision workflow.

## World inventory

| Method | Path | Purpose and response |
| --- | --- | --- |
| GET | /projects/{projectId}/world | `textures`, `tilesets`, `objects`, `maps`; each entry has `asset` and `revisions`, with summaries for maps. |
| POST | /projects/{projectId}/world/textures/check | Test repeat axes; `report`, `warnings`, `verdict`, mosaic/line/shifted `previews`. |
| POST | /projects/{projectId}/world/textures | Publish `texture/material`; `revision`, `report`, `verdict`. |
| POST | /projects/{projectId}/world/tilesets/check | Recheck a tileset revision; `kind`, `report`, `warnings`, `previews`. |
| POST | /projects/{projectId}/world/tilesets/import | Import an atlas with explicitly declared layout; `revision`, `check`. |
| POST | /projects/{projectId}/world/tilesets/template | Build an atlas locally from materials; `revision`, `check`, `routeLabel`. |
| POST | /projects/{projectId}/world/objects | Publish `map/object` with reviewed geometry; `revision`. |
| POST | /projects/{projectId}/world/maps | Create map asset and initial `draft`; returns both, not a revision. |
| GET | /projects/{projectId}/world/maps/{assetId} | Open draft by default, latest revision if no draft, or `?revision=REVISION_ID` belonging to this asset. |
| POST | /projects/{projectId}/world/maps/{assetId}/copy | Copy a revision into a new `asset` and `draft`. |
| POST | /projects/{projectId}/world/maps/{assetId}/publish | Publish submitted payload; `revision`, `passages`, `missing`. |

### Material, prop, and tileset bodies

- **`textures/check`**: `image`, `axes:{x,y}` (booleans, at least one true), optional `threshold` (>0, ≤20). **`textures`**: `target`, `texture:{image,material,axes,threshold?,sourceRevisionId?,unshift?}`. `material` is a nonempty label; `unshift` defaults false and undoes a half-period shift after seam repair (use even dimensions on the requested axes). Failed axes are not marked repeatable.
- **`objects`**: `target`, `object:{image,supportPoint,projection?,footprintCells?,collision?,occlusionAboveY?}`. Projection is `top_down` (default), `three_quarter`, or `side`; support point is `[x,y]` in image pixels; footprint defaults to `[1,1]` cells; collision is an array of up to 16 image-local rectangles (default `[]`); occlusion Y defaults `null`. Supply geometry yourself, even if the image was generated.
- **`tilesets/check`**: `revisionId` and optional `threshold` (>0, ≤20). Inspects seams, coverage and/or diamond/foot geometry based on kind.
- **`tilesets/import`**: `target`, `kind` (`corner`, `sidescroller`, `isometric`), `atlas:{image,payload}`. The server rewrites `payload.atlas.fileId` to `atlas` and defaults margin and spacing to zero. Declare rects in atlas pixels. `corner` uses `cellSize`, two `terrains`, diagonal policies and mask variants (B bits: NW=1, NE=2, SE=4, SW=8); `complete:true` requires all 16 masks. `sidescroller` uses `projection:"side"`, `cellSize`, `platformMaterial`, `surfaceMaterial`, `walkableLineY`, `requiredConfigurations`, `tiles` with `configuration` instead of `mask`, and `complete`. `isometric` uses `projection:"isometric"`, `groundDiamondSize` (both even), `logicalCellSize`, `elevationStepPx`, `sortRule:"depth_ij_elevation_v1"`, and `pieces` with kinds `floor|block|prop`; support must be centered on the footprint diamond. For complete field definitions and geometry constraints, use [`CornerTilesetPayload`, `SideTilesetPayload`, `IsoTilesetPayload` and `SIDE_CONFIGURATIONS`](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/world.ts).
- **`tilesets/template`**: `target`, `template` discriminated by `kind`. `corner`: `materialA`, `materialB` (same-size approved texture revision IDs), `terrains:[{terrainId,name,color},{terrainId,name,color}]` (distinct slugs and `#RRGGBB` colors), optional `projection` (`top_down|three_quarter`), `diagonals:{mask5,mask10}` (`connected|separate`), `bandPx` (1–8), `seed` (0–1000000). `sidescroller`: `body` and `surface` (approved texture revision IDs), `requiredConfigurations?`, `configurations?` (defaults to all configurations), `surfaceDepthPx?` (1–64). `isometric`: `floor` (approved texture revision ID), `diamond?` (defaults `[64,32]`, even dimensions), `blockHeightPx?` (0–128, default 16), `prop?` (`null` or `{image,name,supportPoint?,occluderRect?,blocksMovement?}`; support defaults to measured visual base, occluder defaults null, blocking defaults true). See [`TilesetTemplateInput`](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/world/tilesets.ts).

Example **`tilesets/import`** body for an uploaded 32×32 floor tile. This is deliberately incomplete rather than claiming transition coverage it does not have:

```json
{
  "target": {"name":"Grass and rock"},
  "kind":"corner",
  "atlas": {
    "image":{"from":"upload","uploadId":"ATLAS_UPLOAD_ID"},
    "payload": {
      "projection":"top_down","cellSize":[32,32],
      "terrains":[{"terrainId":"grass","name":"Grass","color":"#457444"},{"terrainId":"rock","name":"Rock","color":"#87858A"}],
      "diagonals":{"mask5":"separate","mask10":"separate"},
      "tiles":[{"tileKey":"grass-0","mask":0,"variant":0,"weight":1,"rect":[0,0,32,32],"frames":[]}],
      "complete":false
    }
  }
}
```

### Edit and publish maps

1. Create with `{"name":"Courtyard","tilesetRevisionId":"TILESET_REVISION_ID","size":[12,8],"seed":1,"walkable":[true,false]}`. Only the first two fields are required; the example shows the defaults for the rest. Each axis is 1–128 cells; seed is 0–1000000; `walkable` sets the corner-terrain flags for A and B. Creation chooses terrain mode from tileset kind.
2. Open by **asset ID**. The response contains `asset`, `source` (draft version or revision ID/number), `draftVersion`, `payload`, `tileset` (including `atlasMediaId`), `objects` (by revision ID, with media IDs), `available` (object and same-kind tileset choices) and revision summaries. Edit the returned `payload`. To persist work in progress, use the shared asset draft `PUT $P/assets/$MAP_ASSET/draft` with `{expectedVersion,payload}`; `expectedVersion` is the current draft version, not the revision number. Publishing submits the payload independently; it is not a draft save.
3. Keep the full [`TilemapPayload`](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/world.ts) intact: `projection,size,cellSize,seed,units,terrain,objects,collisions,regions,entrances,passages`. Terrain is row-major: `corner`/`corner-v1` uses `(cols+1)*(rows+1)` binary `vertices`, `walkable`, and `overrides:[{cell,tileKey}]`; `side`/`side-v1` uses `cols*rows` binary `solid`; both include `resolved` with one entry per cell (recomputed on publish). `isometric`/`iso-v1` uses `cols*rows` `cells:[{pieceKey,elevation}]`, with `pieceKey:null` for empty and elevation in steps. Each terrain has `tilesetRevisionId`. Places use `{objectId,objectRevisionId,pieceKey,cell,offsetPx,label?}` with exactly one non-null revision ID or isometric prop key. Regions and entrances use cell coordinates; collision coordinates depend on the variant (`cells` or `polygon` in pixels). Passages are `{from,to}` of entrance IDs.
4. Post `{"payload": …,"allowBrokenPassages":false}` to `maps/$MAP_ASSET/publish`. The server recomputes terrain, warns about missing cases and an unapproved tileset, and rejects blocked required passages on supported projections unless explicitly overridden. Review `missing` and `passages` before approval. This command publishes the open payload without changing it:

```sh
curl -fsS "$P/world/maps/$MAP_ASSET" |
  jq -c '{payload, allowBrokenPassages:false}' |
  curl -fsS -H 'Content-Type: application/json' --data-binary @- \
    "$P/world/maps/$MAP_ASSET/publish"
```

For **copy**, post `{"revisionId":"SOURCE_MAP_REVISION_ID","name":"Courtyard variant","tilesetRevisionId":"OTHER_TILESET_REVISION_ID"}` to `maps/$MAP_ASSET/copy`. The source is a revision of the URL's asset, not its draft; omit `tilesetRevisionId` to keep the tileset. A replacement must have the same kind; the original layout and placements are copied into the new draft.

## Scenes inventory

| Method | Path | Purpose and response |
| --- | --- | --- |
| GET | /projects/{projectId}/scenes | `scenes`, `layers`, `rooms`, `objects`, `characters`, `cornerTilesets`, `isoMaps`. |
| POST | /projects/{projectId}/scenes/layers/check | Measure seams/ground; `report`, `warnings`, `verdict`, `previews.mosaicLines`. |
| POST | /projects/{projectId}/scenes/layers | Publish `map/scene_layer`; `revision`, `report`, `verdict`. |
| POST | /projects/{projectId}/scenes/layers/cut | Cut a plane from an approved flat scene; `pieceUploadId`, `areaMaskUploadId`, `layer.offset`, `inpaint`, report and previews. |
| POST | /projects/{projectId}/scenes/layers/shift | Publish half-width shifted layer step; `revision`, `maskUploadId`, `inpaint`, `previews.shifted`. |
| POST | /projects/{projectId}/scenes/compose/preview | Test composition and camera; `report`, `cameraTest`, `warnings`, image and strip previews. |
| POST | /projects/{projectId}/scenes/compose | Publish layered `map/scene`; `revision`, `cameraTest`, `report`. |
| POST | /projects/{projectId}/scenes/review/preview | Test character scale at support points; `report`, `view`, overlay/zoom previews. |
| POST | /projects/{projectId}/scenes/review | Publish support points and character scale on same scene asset; `revision`, `report`. |
| POST | /projects/{projectId}/scenes/rooms/import | Publish room with declared floor plan, doors and grid; `revision`. |
| POST | /projects/{projectId}/scenes/rooms/edit | Publish successor with room geometry/links/furniture changes; `revision`, `furniture`, `connections`. |
| GET | /projects/{projectId}/scenes/rooms/{revisionId}/preview | Render ordered room assembly; `furniture`, `previews.room`, `previews.zoom`. |
| POST | /projects/{projectId}/scenes/rooms/link | Check/preview a door pair without saving connection records; `link`, `preview` (null on incompatibility). |
| POST | /projects/{projectId}/scenes/rooms/cutout/preview | Inspect mask cutout without publishing; `report`, `warnings`, `routeLabel`, piece/shadow/area previews. |
| POST | /projects/{projectId}/scenes/rooms/cutout | Publish extracted prop candidate; `object` (its revision), `areaMaskUploadId`, `needsReconstruction`, `inpaint`, report/warnings. |
| POST | /projects/{projectId}/scenes/rooms/compose | Place an extracted prop back over repaired background; `revision` of same room asset. |
| GET | /projects/{projectId}/scenes/rooms/{revisionId}/kit | Inspect local room picture sheet; `sheets`, `grid`, `projection`. |
| POST | /projects/{projectId}/scenes/rooms/kit-map | Declare picture-sheet keys; `tileset` revision, `missing`, `complete`, `doors` with side/revision, `check`. |
| POST | /projects/{projectId}/scenes/rooms/to-map | Rebuild top-down room as tilemap draft; `asset`, `draft`, `passages`, `openUrl`, `label`. |
| POST | /projects/{projectId}/scenes/objects/review | Publish revised object geometry without losing source/shadow; `revision`. |

### Layers and scale

- **`layers/check`**: `image`, optional `repeatX` (true), `groundLineY` (nonnegative pixel Y or null), `ground` (false).
- **`layers`**: `target`, `layer:{image,depth,repeatX?,groundLineY?,unshift?,sourceRevisionId?,derivation?}`. Depth is `sky|far|mid|near|ground`; repeat X defaults true, ground line null. The checker marks only passing requested axes repeatable (this endpoint tests X, not Y). Optional `derivation:{sourceRevisionId,maskUploadId,hiddenAreas,inpaintRevisionId?}` refers to a flat scene and ready mask. `hiddenAreas` is `transparent_reviewed` or `reconstructed_inpaint`; the latter requires an approved inpaint of that exact source revision and mask.
- **`layers/cut`**: `sceneRevisionId`, `maskUploadId`, `dilatePx?` (0–8, default 1). Use an approved `flat_image` scene and an image-sized reviewed mask. For the returned piece, use `pieceUploadId` as an upload image reference and `layer.offset` as a placement offset; `areaMaskUploadId` is for reconstructing the newly exposed area via inpaint, with the returned `inpaint.sourceRevisionId` and `sourceFileKey`. Neither upload ID is a layer revision: publish the layer first.
- **`layers/shift`**: `layerRevisionId` (approved, even image width), `bandPx?` (1–32, default 6). The resulting revision is a repair intermediate that does not tile. Approve this intermediate as the inpaint source, not for use in composition. Use `inpaint` and `maskUploadId` for the seam repair, then publish with `layer.unshift:true` to return the seam to the edges before checking it.
- **`compose/preview`** takes the raw scene object below. **`compose`** takes `{target,scene}` with the same object as `scene`. Each `layerRevisionId` must be an approved `map/scene_layer`. Supply 2–16 back-to-front placements with slug `layerId`, `name`, `parallax` factors in [0,4], optional integer-pixel `offset` (default `[0,0]`) and `repeat` (default `{x:true,y:false}`); requesting repeats not validated by the layer is an error. `logicalSize` axes are 32–1024; optional `projection` is `side` (default), `top_down`, `three_quarter`, or `isometric`; `groundLineY` defaults null; `steps` defaults 8 (2–32). Check `cameraTest` for uncovered frames, loop and ground continuity. A layered scene is not an editable collision map.

```json
{
  "logicalSize":[240,160],
  "layers":[
    {"layerId":"sky","name":"Sky","layerRevisionId":"SKY_LAYER_REVISION_ID","parallax":{"x":0,"y":0},"repeat":{"x":false,"y":false}},
    {"layerId":"ground","name":"Ground","layerRevisionId":"GROUND_LAYER_REVISION_ID","offset":[0,112],"parallax":{"x":1,"y":0},"repeat":{"x":true,"y":false}}
  ],
  "groundLineY":112,
  "steps":8
}
```

For **`review/preview`** and **`review`**, use `{"sceneRevisionId":"SCENE_REVISION_ID","characterRevisionId":"APPROVED_CHARACTER_BASE_REVISION_ID","direction":"E","supportPoints":[{"pointId":"entrance","label":"Entrance","at":[64,112]}]}`. `direction` is optional (`N|NE|E|SE|S|SW|W|NW`); defaults to E for side scenes and S otherwise, with fallback to the first available view. Supply 1–16 support points in scene pixels. Review annotates the scene without changing its base art or adding collision. See [scene input validators](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/scenes/scenes.ts).

### Rooms: import, connect, cut, and rebuild

**Import.** Send `{target,room}`. `room` requires `image,theme,floorPlan,doors`, accepts `projection` (`top_down` default, `isometric`, `oblique`), `tileSize` (16,24,32 default,48,64) and optional `grid:{cellPx,gridOrigin}`. Floor is connected by edge adjacency and limited to 7×6; booleans are row-major (`true` floor, `false` rock). Provide 1–8 unique doors on walls next to floor. East/west doors occupy the given cell and the cell below. Example (use an image that matches your declared grid):

```json
{
  "target":{"name":"Library"},
  "room":{
    "image":{"from":"upload","uploadId":"ROOM_UPLOAD_ID"},
    "theme":"Stone library",
    "tileSize":32,
    "floorPlan":{"size":[3,2],"cells":[true,true,true,true,true,true]},
    "doors":[{"doorId":"north","cell":[1,0],"side":"N"},{"doorId":"south","cell":[1,1],"side":"S"}],
    "grid":{"cellPx":[32,32],"gridOrigin":[32,32]}
  }
}
```

**Link.** Preview with `{"aRevisionId":"ROOM_A_REVISION_ID","aDoorId":"north","bRevisionId":"ROOM_B_REVISION_ID","bDoorId":"south"}`. Rooms must match projection, `cellPx` and `tileSize`, and the doors must face opposite ways. Inspect `link.ok`, `link.problems`, `link.offsetPx` and `link.method` (`anchors` or `grid` on success). Persist a directed connection by sending `{"baseRevisionId":"ROOM_A_REVISION_ID","connections":[{"doorId":"north","toRoomRevisionId":"ROOM_B_REVISION_ID","toDoorId":"south"}]}` to `rooms/edit`. This replaces that revision's connection array; it does not edit room B. If a return link is needed, edit B separately and target the intended A revision. The edit body also accepts `cellPx?`, `gridOrigin?`, `doors?`, `walkable?` (up to 64 rectangles), `furniture?`, `note?`. Edited doors are full records `{doorId,cell,side,anchorPx,triggerPx,arrivePx}`; the last three are required keys but can be null. Furniture placements are `{placementId,objectRevisionId,supportAtPx,label?}`; room-space support coordinates must place a correctly projected/scaled prop on the floor. Copy untouched records from the base revision payload before replacing an array. Room preview and kit routes use a **room revision ID** in the path, not the asset ID.

**Cut out furniture.** Start with an approved non-oblique room; the current base image is `background` if present, otherwise `picture`. Create an image-sized mask for the piece, and optionally a separate shadow mask. For `rooms/cutout/preview` use `{"roomRevisionId":"ROOM_REVISION_ID","maskUploadId":"PIECE_MASK_UPLOAD_ID","shadowMaskUploadId":null,"dilatePx":1}`. Shadow defaults null; dilation defaults 1 (0–8). Inspect `suggestedSupport`, `pieceRect`, and `needsReconstruction` in the report. For `rooms/cutout`, add required `name` and optionally `supportPoint` (defaults to suggestion), `footprintCells` (default `[1,1]`), `collision` (up to 16 image-local rectangles, default `[]`) and `occlusionAboveY` (default null). The original room is unchanged. The response's `object.id` is the new prop revision ID, while `areaMaskUploadId` is the registered exposed-area mask with cutout provenance. Shadows from a mask are estimated, not recovered as an original separate layer.

**Reassemble.** When `needsReconstruction` is true, inpaint using the returned `inpaint` fields (`sourceRevisionId`, `sourceFileKey`, `maskUploadId`), then approve the result. Send the body below to `rooms/compose` with the *original cutout room revision* and exact area mask from the cutout, not the input piece mask. The inpaint revision must be an approved successor of the same source using that exact mask and editing the base image. Use `{"kind":"transparent"}` only when the report says reconstruction is not needed; deleting alpha is not floor/wall reconstruction. Optional `supportAtPx` overrides the original placement and optional `placementId` sets its ID; the prop revision is derived from the area's provenance. The new revision contains the repaired background and the separately placed prop.

```json
{
  "roomRevisionId":"ROOM_REVISION_ID",
  "areaMaskUploadId":"AREA_MASK_UPLOAD_ID",
  "reconstruction":{"kind":"inpaint","inpaintRevisionId":"APPROVED_INPAINT_REVISION_ID"}
}
```

**Review props.** `scenes/objects/review` takes `{"baseRevisionId":"OBJECT_REVISION_ID","supportPoint":[16,32],"footprintCells":[1,1],"collision":[[12,24,8,8]],"occlusionAboveY":24}` (example for a 32×32 prop). All fields required, with `null` allowed for `occlusionAboveY` and `[]` for collision. Use the returned prop revision ID in new placements; existing placements are pinned.

**Rebuild an editable map.** Get `rooms/$ROOM_REVISION/kit` first, then POST `rooms/kit-map` with `roomRevisionId,name,cell,keys`; optional `sheetId` is only `picture` (default), `origin` defaults `[0,0]`, `spacing` defaults 0. `keys` are in row-major sheet order, 1–512, no more than the available grid cells, with at least one mask. For example, for a sheet with at least three full 32×32 cells:

```json
{"roomRevisionId":"ROOM_REVISION_ID","name":"Library kit","cell":[32,32],"keys":[{"kind":"mask","mask":0},{"kind":"door","side":"N"},{"kind":"ignore"}]}
```

`mask` is 0–15, `side` is `N|E|S|W`. Supply all masks for a complete kit; `missing` reports coverage gaps. Oblique rooms cannot be mapped to the corner kit. Next post `{"roomRevisionId":"TOP_DOWN_ROOM_REVISION_ID","tilesetRevisionId":"CORNER_KIT_REVISION_ID","name":"Library map","doorObjects":{"N":"DOOR_OBJECT_REVISION_ID"}}` to `rooms/to-map`; `doorObjects` is an optional side-to-prop-revision mapping. Only top-down rooms convert here. The output maps floor/wall to terrain, doors to entrances and furniture to objects, with passage results. Open/edit/publish the new map asset through the world workflow. See [room request validators](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/scenes/rooms.ts) and [room payload contracts](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/scenes.ts) for the complete geometry and provenance fields.

## Provider-backed alternatives

The shared `POST $P/generation-plans` endpoint accepts the operation bodies below. Preview the plan and estimate first; provider-backed execution via jobs is the potentially paid step. Preparing/checking/importing a PNG or generating a **local template** does not mean native generation occurred. Use an active project style, ready provider profile and appropriate approved references. Language where accepted is `pt-BR|en`.

| Operation | Input beyond `operation` and `providerProfileId` |
| --- | --- |
| `generate_texture` | `materialBrief`, `logicalSize` (each 8–256), `repeatAxes:{x,y}` (at least one true); `seamThreshold?`, `referenceRevisionIds?` (up to 4 approved textures), `variants?` (1–4), `language?`. |
| `generate_tileset` | `guideRevisionId` (approved tileset revision of the result asset), `instruction`; `lockedBandPx?` (0–8, default 4, forced to 0 for isometric), `materialRevisionIds?` (up to 3 approved textures, also subject to provider reference limit), `language?`. Requires the provider's `image_references` and `image_edit` capabilities. |
| `generate_scene` | `brief`; optional `composition`, `lighting`, `requiredElements` (up to 8 strings), `projection`, `logicalSize` (default `[240,160]`, each 32–512), `layer:{name,depth,repeatX?,transparent?}` to generate **one** plane rather than a flat scene, `referenceRevisionIds` (up to 4), `variants` (1–4), `language`. |
| `generate_room` | `theme`, `doors` (same input shape as room import); `projection?`, `tileSize?`, `floorPlan?`, `styleRoomRevisionId?` (approved compatible room or null), `language?`. |
| `generate_map_object` | `brief`; `projection?` (`top_down|three_quarter|side`), `logicalSize?` (default `[64,64]`, each 16–400), `variants?` (1–4), `language?`. Review geometry separately. |

Submission targets: `texture/material` for a texture; the preview's `targetAssetId` for a tileset; `map/scene` for a flat scene or `map/scene_layer` for one plane; `map/room` for a room; `map/object` for a prop. Use the returned `plan` and `digest` with the shared jobs route documented in [Core API](core.md).

```json
{"operation":"generate_tileset","providerProfileId":"READY_PROFILE_ID","guideRevisionId":"APPROVED_TILESET_REVISION_ID","instruction":"Add wear to the stone while keeping transitions aligned","lockedBandPx":4}
```

After generation, inspect the resulting candidate revision and technical checks; it is not approved automatically. For scene/room reconstruction use the shared `inpaint` operation with the exact source file and mask returned by the cut/shift workflow. See the [tileset plan builder](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/world/tilesets.ts), [texture plan builder](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/world/textures.ts) and [scene/room/object plan builders](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/scenes/plans.ts) for provider-specific guards.

Example repair plan body (use the response's cut/shift IDs and exact file key; `sourceRevisionId` must already be approved):

```json
{"operation":"inpaint","providerProfileId":"READY_PROFILE_ID","sourceRevisionId":"SOURCE_REVISION_ID","sourceFileKey":"picture","maskUploadId":"AREA_MASK_UPLOAD_ID","instruction":"Continue the existing floor through the exposed area","mode":"native-mask"}
```

`mode` is required: `native-mask` uses provider-native masking; `candidate-composite` explicitly requests an edited candidate with a local masked composite. See the [inpaint validator](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/inpaint.ts).
