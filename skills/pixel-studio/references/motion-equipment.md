# Motion, animation, and equipment

Paths below are relative to `/api/v1`. IDs are project-local references unless noted (for example, `providerProfileId` selects a provider profile). Use revision IDs for source art, not asset IDs. Requests are JSON; the listed shapes do not accept extra keys. Directions are `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`. Playback is `loop`, `once`, or `ping_pong`; durations are positive integer milliseconds (up to 60,000 per value). Projection is `top_down`, `three_quarter`, `side`, or `isometric`. A cost ceiling is `{ "amount": 1, "unit": "credits" }` (nonnegative amount, unit `credits`, `generations`, or three uppercase currency letters). Never assume two cost units are convertible.

## Route inventory

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /projects/{projectId}/animation | Bases, clips, motions, presets, states, profile routes, and recent jobs |
| POST | /projects/{projectId}/animation/motion | Save a candidate motion revision |
| POST | /projects/{projectId}/animation/objects | Create a candidate object base from a PNG |
| POST | /projects/{projectId}/animation/states | Keep selected views and record rejected views as gaps |
| POST | /projects/{projectId}/animation/views | Pick views across revisions of a base |
| POST | /projects/{projectId}/animation/retime | Update timing without regenerating pixels |
| POST | /projects/{projectId}/animation/run | Freeze a plan and enqueue work; potentially paid |
| GET | /projects/{projectId}/equipment | Discover rigs, clips, overlays, loadouts, items, profiles, and jobs |
| POST | /projects/{projectId}/equipment/coverage/plan | Preview coverage/reuse or a rigid view, with estimated cost |
| POST | /projects/{projectId}/equipment/coverage/run | Freeze the plan and enqueue work; potentially paid |
| POST | /projects/{projectId}/equipment/extract | Extract modular coverage locally from dressed pixels |
| POST | /projects/{projectId}/equipment/overlays | Edit an overlay revision locally |
| POST | /projects/{projectId}/equipment/overlays/reuse | Apply equivalent coverage cells without generation |
| POST | /projects/{projectId}/equipment/overlays/rebind | Copy compatible coverage to a new clip revision |
| POST | /projects/{projectId}/equipment/clips/share | Share a clip with another stance explicitly |
| POST | /projects/{projectId}/equipment/cell | Expand clip cells and move associated geometry and coverage |
| POST | /projects/{projectId}/equipment/resolve | Resolve draft or published loadout without generating pixels |
| POST | /projects/{projectId}/equipment/compose | Render a flattened PNG sheet locally |
| POST | /projects/{projectId}/equipment/loadouts | Publish a candidate loadout snapshot |
| POST | /projects/{projectId}/equipment/loadouts/swap | Replace conflicting gear and publish a candidate revision |
| POST | /projects/{projectId}/equipment/demo | Seed approved synthetic equipment fixtures locally |

## Character approval → motion → animation → timing

1. Start with a character base revision and its required direction. Review it first with `POST $P/assets/$ASSET/reviews`, body `{ "revisionId": "revision-id", "decision": "approve", "expectedActiveRevisionId": null }` for an asset with no active revision. Otherwise send the actual current active revision ID. `reason` is optional and nullable. `GET $P/animation` returns `bases`, `clips`, `motions`, `presets`, `projection`, `orientation`, `states`, `imageSources`, `tags`, `profiles`, `operations`, and `jobs`; select an actual preset key and profile route from this data.
2. For authored motion, `POST $P/animation/motion` with `{baseRevisionId, motion, presetKey?}` (`presetKey` nullable, defaults to `null`). The approved base's logical size must equal `motion.generationCell`. The response is `{asset, revision}` (201); approve the motion revision before using it. Motion is pose data, not an equipment rig. The pose coordinates are normalized within the generation cell, top-left origin. A skeleton has one root, existing parents, no cycles, and 2–64 joints. Each reference/target pose has exactly the skeleton's joint IDs; `poses` has 1–64 unique `poseId`s. `anatomicalSide` is `left`, `right`, or `center`; optional `cameraSide` is `near`, `mid`, or `far`. `zIndex` is an integer; optional `depth` is 0–255. `jointSocketMap` can be empty or contain `{jointId, rigRevisionId, socketId}` links. Example body (use actual revision, cell, and projection):

   ```json
   {
     "baseRevisionId": "base-rev",
     "motion": {
       "skeleton": {"kind":"custom","joints":[
         {"jointId":"root","name":"Root","parent":null,"anatomicalSide":"center"},
         {"jointId":"tip","name":"Tip","parent":"root","anatomicalSide":"right"}
       ]},
       "generationCell":[32,32],"direction":"S","projection":"side","action":"wave",
       "referencePose":{"root":{"x":0.5,"y":0.6,"visible":true,"zIndex":0},"tip":{"x":0.7,"y":0.7,"visible":true,"zIndex":1}},
       "poses":[{"poseId":"lift","durationMs":100,"joints":{"root":{"x":0.5,"y":0.6,"visible":true,"zIndex":0},"tip":{"x":0.7,"y":0.3,"visible":true,"zIndex":1}}}],
       "loop":false,"jointSocketMap":[]
     }
   }
   ```

3. Preview the animation with `POST $P/generation-plans` and the **bare** operation object described below. This makes no paid calls. Inspect server-returned `plan`, `digest`, `destination` (`profileId`, `name`, `transport`, `simulated`), `route` (`strategy`, `label`), `summary`, and `costCheck` (`kind`, `withinCeiling`). For character clips the summary describes the direction, action, frame IDs, durations, and playback; other operations have their own summaries. Inspect `plan.limits` for the estimate, ceiling, and maximum submissions. A generic `reference_sheet` route sends references and produces a candidate to slice locally; it is not native motion, rotation, or interpolation. Native availability is operation- and profile-specific. Do not claim that a route supports custom skeletons or native masks merely because it accepts the corresponding request fields.
4. `POST $P/animation/run` takes `{plan: <same operation input>, oneClick?: false, allowUnknownCost?: false, variation?: 0}`. The flags are booleans with the shown defaults. Do **not** put the returned frozen plan in this wrapper: it takes the original operation input and rebuilds the plan. `oneClick: true` requires a known/bounded estimate within a matching ceiling or explicit acceptance of unknown cost; obtain approval for the cost before running regardless of mode. Response is 202 with `Location` pointing to the project job; body adds `job`, `created`, `targetAssetId`, `idempotencyKey` to the preview fields. The key is `animation:<plan digest>:<variation>`; an identical rebuilt plan and counter return the same job with `created: false`, no new charge. Increment the integer counter (0–999) only for a deliberate new variation. If inputs or project/provider state change, the rebuilt digest may change.
5. Poll the returned job URL, then inspect the target asset's candidate revision and technical report; a 202 is not a published clip. The main character animation pipeline publishes a `ClipPayload` with stable frame IDs, ordered frames, `durationMs`, playback, layers and file references, with individual `frame-<frameId>` files and a `strip` file on the reference-sheet route. Keep the revision's metadata with the images rather than treating a raw provider output as final. Inspect the pixels and approve the candidate. For equipped flattened sheets use `equipment/compose` or loadout `flatten` below.
6. `POST $P/animation/retime` takes `{clipRevisionId, durationsMs, playback?}` using the approved input clip and one duration per existing frame, in order (1–256 entries). Returns `{revision, unchanged}`: 200 if timing and playback already match, otherwise 201 with a candidate preserving frame IDs and blobs. Approve it; use equipment rebind to carry over matching coverage for the new revision.

Example preview and deliberate submit using a configured provider profile:

```sh
API=http://127.0.0.1:3000/api/v1
P="$API/projects/$PROJECT"
plan='{"operation":"animate_skeleton","providerProfileId":"PROFILE","baseRevisionId":"BASE_REV","motionRevisionId":"MOTION_REV","actionText":"Wave once","playback":"once"}'
curl -fsS "$P/generation-plans" -H 'Content-Type: application/json' -d "$plan"
# After reviewing the route, references, and cost:
curl -fsS -i "$P/animation/run" -H 'Content-Type: application/json' -d "$(jq -cn --argjson plan "$plan" '{plan:$plan}')"
```

### Animation operation inputs

All include required `operation` and `providerProfileId`; optional `language` (`en` or `pt-BR`) and nullable `costCeiling`. The first four also require `baseRevisionId` (approved base). Directional source views must exist. `?` marks optional keys; `Slug` values (actions, stances, slots, parts, etc.) use lowercase letters, digits, dots, underscores or hyphens and start alphanumeric.

| `operation` | Additional required keys | Optional keys and behavior |
| --- | --- | --- |
| `animate_preset` | `direction`, `presetKey` | `presetVersion` (positive integer), `durationsMs` (1–16, matching the preset frame count), `motionRevisionId` (approved; a skeleton preset can look up approved motion by base/action/direction) |
| `animate_text` | `direction`, `actionText` (1–1000 chars), `durationsMs` (1–16), `playback` | Text describes motion, not new character identity |
| `animate_skeleton` | `motionRevisionId` (approved), `actionText` (1–1000 chars), `playback` | `appearance` (1–300 chars); direction, action, and target poses/timing come from the motion |
| `rotate_views` | `view` (target direction) | `asymmetries` (up to 8 strings of 1–200 chars), `projection` |
| `create_state` | `sourceRevisionId` (approved base/state), `stateKey` (Slug), `description` (1–1000 chars), `directions` (1–8) | State is new candidate art, not motion |
| `animate_object` | `objectRevisionId`, `direction`, `action` (Slug), `description` (1–1000 chars), `durationsMs` (1–40 generated frames), `playback` | `keepFirstFrame` (boolean; default keeps the reference for `once`), `firstFrameMs`, `endFrame: {revisionId, direction}` |
| `interpolate_frames` | `start`, `end` (keyframes), `action` (1–500 chars), `transitionMs` (total in-between duration) | `count` (1–14 requested intermediates on generic route; native determines count), `newClip: {action, startMs, endMs, playback}` for interpolation between views |
| `edit_animation` | `clipRevisionId`, `frameIds` (1–16), `description` (1–2000 chars) | Segment edit is not a masked edit |
| `transfer_outfit` | `clipRevisionId`, `outfitRevisionId`, `outfitFileKey` | `frameIds` (1–16), `stateKey` (Slug), `instructions` (up to 2000 chars); result is a dressed clip, not a modular overlay |
| `correct_frame` | `clipRevisionId`, `frameId`, `instruction` (1–1000 chars), `mode` (`native-mask` or `candidate-composite`) | `partId` (Slug), `maskUploadId` (nullable), `contextFrameIds` (up to 2; defaults to adjacent frames). A supplied binary mask uses 255 to edit, 0 to protect, at clip cell size; an empty mask is rejected before dispatch. Without a mask the target is the whole frame. `candidate-composite` is local cropping/compositing of an edited candidate, not native mask conditioning. |

Keyframes are `{kind:"clip_frame", clipRevisionId, frameId}` or `{kind:"view", baseRevisionId, direction}`. Use either two adjacent frames in order from the same approved clip revision, or views from two distinct approved revisions with the same direction, logical cell and pivot. The latter creates a clip, optionally configured with `newClip`. See the validators for [preset/text/skeleton/views](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/animation/plans.ts), [temporal operations](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/animation/temporal-plans.ts), and [motion geometry](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/motion.ts).

### Local bases, states, and directional selection

These publish 201 candidates without provider charges. Review the resulting revision before sourcing it in generation.

- `animation/objects`: `{name, image, direction?, groundOrigin?, state?}` → `{asset, revision}`. `image` is `{from:"upload", uploadId}`, `{from:"revision", revisionId, fileKey}`, or `{from:"job_output", jobId, outputIndex}` (zero-based index). Source must be a nonempty PNG with measured dimensions; creates a base without a humanoid rig. Direction defaults to `S`, state Slug to `default`, and `groundOrigin` (a nonnegative integer grid point `[x,y]`) defaults to content bottom-center.
- `animation/states`: `{revisionId, keep:[direction,...], reject?:[{direction, reason},...]}` → `{revision, gaps}`. Use a non-rejected character base, object, or state revision; `keep` has 1–8 directions, `reject` defaults to `[]` and allows up to 8 with nonempty reasons. Reuses blobs; rejected directions are explicit holes, not new jobs.
- `animation/views`: `{baseAssetId, picks:[{direction, revisionId},...]}` → `{revision}`. Select 1–8 views present in revisions of the **same** character base asset; does not redraft any pixels.

## Equipment: generate or extract → resolve → compose → publish

`GET $P/equipment` returns `rigs`, `clips`, `overlays`, `loadouts`, `items`, `profiles`, `jobs`, `demo.seeded`, and `genericCapabilities`. Use a compatible approved rig and approved clips for that exact rig revision. Covered parts and slots must exist on the rig, and clips need compatible stances. Rigid views need valid socket IDs and in-bounds grip pixels; actual placement needs the required clip sockets and compatible stance. A motion skeleton alone is not an equipment rig; animated clips can lack sockets. Use the catalog's rig and clip revision contracts for authored data ([sprites](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/sprites.ts), [equipment](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/equipment.ts)). `POST $P/equipment/demo` takes no body and idempotently seeds approved synthetic examples in the project (201; includes `created`, `baseRevisionId`, `rigRevisionId`, `clips`, `overlays`, `loadouts`). Use only when seeding is wanted.

To link a newly generated character clip to a rig, approve a `character/rig` before generation with `baseRevisionId` equal to the input base revision, the same logical cell, and a `body` part. The pipeline links a matching active rig if it finds one; it does not populate frame sockets. For rigid gear, make sure the approved clip revisions actually declare the relevant frame sockets rather than assuming the rig or motion poses supply them.
There is no standalone HTTP rig editor. Reuse a rig from the equipment catalog or import a valid portable package with the rig and its dependencies, then review the imported revisions. The demo endpoint is for synthetic fixtures, not for rigging an existing character automatically.

### Coverage preview and submission

`POST $P/equipment/coverage/plan` (also accepted bare at `POST $P/generation-plans`) takes an object with `operation: "generate_overlay_coverage"`, `providerProfileId`, `rigRevisionId`, `description` (1–500 chars), and `mode: "coverage"` or `"rigid_view"`. Existing extensions use approved `overlayRevisionId` on that rig; otherwise omit it or send `null` and provide `item: {slots: [Slug,...], stances: [Slug,...]}` (1–4 slots, 1–8 stances). Shared options: `materialReference: {revisionId, fileKey}` (approved PNG), `language`, and nullable `costCeiling`.

- **Coverage:** `parts` (up to 8 named rig parts; if omitted/empty, reuse the existing piece's parts), `clips: [{clipRevisionId, frameIds?}, ...]` (1–12 clips for this mode; omit/empty `frameIds` selects every frame, up to 64 explicit IDs). Optional `proofPose: {clipRevisionId, frameId}` (defaults to `null`), `framesPerStrip` (1–9, default 4), `zones`, `protect`, `growZonePx` (0–8, default 1), `regenerate` (default false). `zones` has `{clipRevisionId, frameId, partId, rects}` entries (1–16 rects per entry); `protect` has `{clipRevisionId, frameId, rects}` entries (up to 32 rects per entry); up to 512 entries per array. Each rect is `[x,y,width,height]` with nonnegative origin and positive integer size. Explicit zones override zone derivation; review the preview's warnings, especially estimated zones. A proof pose limits generation to the selected frame; normally only gaps need generation. The generic route uses reference images to generate a dressed candidate and extracts coverage locally. This is neither native overlay generation nor native mask conditioning.
- **Rigid view:** require `view: {viewId, size:[width,height], grips:[{socketId,at:[x,y]},...], mirrorAllowed?, orientation?}` (1–2 grips). `mirrorAllowed` defaults to false, and `orientation` accepts `vertical_up` (default), `vertical_down`, `horizontal_right`, `horizontal_left`, `diagonal_up`, or `diagonal_down`. This requests a single generated view, not a set of animated weapon poses. Set or correct per-frame placements separately.

Example coverage preview input (replace all IDs and rig-specific keys):

```json
{
  "operation":"generate_overlay_coverage","providerProfileId":"PROFILE","rigRevisionId":"RIG_REV",
  "description":"Blue leather vest","mode":"coverage","item":{"slots":["torso"],"stances":["neutral"]},
  "parts":["torso"],"clips":[{"clipRevisionId":"CLIP_REV","frameIds":["f1","f2"]}],
  "proofPose":{"clipRevisionId":"CLIP_REV","frameId":"f1"},
  "zones":[{"clipRevisionId":"CLIP_REV","frameId":"f1","partId":"torso","rects":[[6,5,12,15]]}]
}
```

The preview is free: inspect `plan`, `digest`, `destination`, `costCheck`, and `summary` (mode, route label, counts, coverage cells and their fates `existing`/`empty`/`reused`/`generate`/`later`, strips, warnings). Inspect `plan.limits` and the server-selected requirements. If there is nothing to generate, the planner returns `validation_failed` with details `nothingToGenerate: true`, `reused`, and `cells` instead of a plan. Apply nonempty `reused` via `overlays/reuse` on the existing piece. If a plan does succeed, equivalent cells are listed at `plan.params.reused` in coverage mode. See the [coverage planner](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/equipment/plans.ts) for full request and computed-plan validation.

`POST $P/equipment/coverage/run` takes `{plan: <same bare input>, newItemName?, allowUnknownCost?: false, variation?: 0}`. `newItemName` is a 1–120 character name for a new piece (defaults to a description prefix); leave it unchanged when retrying. The server rebuilds the plan, blocks unknown cost unless allowed and rejects estimates above the authorized ceiling. The response is 202 with the project job `Location` and the same preview metadata plus `job`, `created`, `targetAssetId`, `idempotencyKey`. The key is `equipment:<plan digest>:<variation>`; repeating the same frozen plan and variation returns the same job with `created: false` and no new charge. Increment variation (integer 0–999) only for an intentional new run. Poll the job and inspect/review the candidate overlay; incomplete coverage or rejected pixels are not automatically ready for a loadout.

When extending covered gear, preview the remaining cells after approving the proof-pose result, passing that approved `overlayRevisionId`. When generating a rigid view, use `overlays` with `op: "set_placement"` as needed to bind the view to clip frames, then approve the edited revision and include it in the draft config.

### Local extraction and authoring

These endpoints make no paid provider calls. They produce candidate revisions (201) for review; a local revision write is not a generation submission and does not use the digest/variation keys above.

- `equipment/extract`: `{targetClipRevisionId, source, overlayRevisionId?, item?, parts, frameIds?, zones?, protect?, growZonePx?, tolerance?}` → `{revision, report, warnings, previews}`. The target is the approved clean clip; `source` is `{kind:"clip", clipRevisionId}` for a dressed clip with matching frame IDs and cell size, or `{kind:"uploads", frames:[{frameId,uploadId},...]}` for 1–64 images already sized to the target cell. Supply 1–8 part keys, optional up to 64 `frameIds`, and the same zoned geometry as coverage planning. `growZonePx` defaults to 1 (0–8), `tolerance` defaults to 24 (0–128). To update an overlay cite its revision; otherwise omit `overlayRevisionId` or use `null` and give `item: {name, slots, stances}`.
- `equipment/overlays`: exact discriminator `op`, plus `overlayRevisionId` and the keys below; returns `{revision, summary}`. Marking a cell empty means deliberate occlusion, while removing it leaves a gap. For `mark_empty`/`remove_cell`, `partId: "rigid"` refers to rigid placement.

  | `op` | Additional keys |
  | --- | --- |
  | `mark_empty` | `clipRevisionId`, `frameId`, `partId` |
  | `remove_cell` | `clipRevisionId`, `frameId`, `partId` |
  | `set_draw_index` | `clipRevisionId`, `frameId`, `partId`, `drawIndex` (integer −16 to 64) |
  | `set_grips` | `viewId`, `grips` (1–2 `{socketId, at:[x,y]}`) |
  | `set_item` | `itemRevisionId` (nullable; link or clear inventory item) |
  | `set_placement` | `clipRevisionId`, `frameId`, `viewId` (nullable to hide), `anchorSocketId`, `drawIndex` (integer −16 to 64), `mirrored?` (boolean, default false) |

- `equipment/overlays/reuse`: `{overlayRevisionId, reused:[{clipRevisionId,frameId,partId,from:{clipRevisionId,frameId},reason},...]}` (1–512; `reason` is `existing` or `equivalent_pose`) → `{revision, applied}`.
- `equipment/overlays/rebind`: `{overlayRevisionId, toClipRevisionId, fromClipRevisionId?}` → `{revision, rebound, review, digests:{from,to}}`. If omitted, finds the most recent covered source revision of the same clip. Copies cells where frame ID and geometry digest still match, retaining previous bindings. Review mismatches before approval.
- `equipment/clips/share`: `{clipRevisionId, stance}` → `{revision}`. Explicitly shares a clip with another rig stance; does not generate missing variants.
- `equipment/cell`: `{clips:[{clipRevisionId,margins:{left,right,top,bottom}},...], overlayRevisionIds?}` → `{clips:[{from,revision},...], overlays}`. Margins are nonnegative integers; send 1–16 clips, optionally select up to 32 overlay revisions. Omitting overlays follows applicable active (or latest) overlays. Expands the cell and shifts layers, pivots, sockets and bound coverage consistently.

### Resolve and compose

`ResolveRequest` is exactly one of `{loadoutRevisionId}` or `{config}`. A draft `config` has required `rigRevisionId`, `overlayRevisionIds` (up to 16, can be empty), plus:

- `stance?`: nullable Slug, defaults to `null` for automatic stance selection.
- `pins?`: up to 64 `{action,direction,clipRevisionId}` (default `[]`) to pin clip revisions.
- `combos?`: up to 64 `{action,direction}`; if absent, the server considers approved actions across rig directions.
- `drawOrder?`: up to 256 `{clipRevisionId, frameId, layers}` entries. Each `layers` has 1–32 references: `{kind:"base",partId}`, `{kind:"part",overlayRevisionId,partId}`, or `{kind:"rigid",overlayRevisionId}`.

`POST $P/equipment/resolve` takes `{request, equip?}` and returns `{view}`. `equip` is an incoming overlay revision ID for a **draft** only; it evicts conflicts and returns `config` and `replacement` alongside `view`. Read `view.stance`, `occupancy`, `combos`, `matrix`, `pendencies`, `blockers`, and `ready`; `snapshot` records pinned resolution. A published loadout resolves its stored clips, not today's automatic picks. Fix missing clips, incompatible revisions, missing coverage, and socket issues instead of silently dropping them. Approval of inputs matters even if a draft can be inspected before it is ready.

`POST $P/equipment/compose` takes `{request, action, direction, baseOnly?}` (`baseOnly` defaults to false). Provide a resolved combination with a clip. Returns `{status, sheet, sheetSha256, frames, warnings, providerCalls:0}`; `sheet` is a PNG data URL, and `frames` contains its frame placement report. Inspect `status`: obtaining a sheet does not mean the combination is complete. Example:

```json
{
  "request":{"config":{"rigRevisionId":"RIG_REV","overlayRevisionIds":["VEST_REV","SWORD_REV"],"combos":[{"action":"idle","direction":"S"}]}},
  "action":"idle","direction":"S","baseOnly":false
}
```

### Publish or swap loadouts

- `POST $P/equipment/loadouts`: `{config, assetId?, name?, flatten?, subset?}`. Omit `assetId` for a new loadout; supply the existing loadout's asset ID to revise it. `flatten` defaults to true and writes a flattened sheet for each included **ready** combination; the snapshot retains modular references. `subset: {combos:[{action,direction},...],reason}` requires 1–64 explicitly ready combinations and a nonempty reason; excluded combinations are recorded, not generated or silently stripped. A resolved stance and a clip for every included combination are required even without a subset. Returns `{revision, view, included, omitted}` (201); review the candidate before activation.
- `POST $P/equipment/loadouts/swap`: `{loadoutRevisionId, incomingOverlayRevisionId, flatten?}` (default true). Removes equipment that competes for the incoming gear's slots, resolves posture and clips, and creates a candidate on the same loadout asset. Adds `replacement` and `droppedOrderOverrides` to the usual publish result. Recheck the matrix before approval. Swapping or composing existing equipment does not generate new art.

For further constraints or detailed nested metadata, see the [resolve/compose helpers](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/equipment/resolve.ts), [loadout publisher](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/equipment/loadouts.ts), and [local overlay edits](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/equipment/overlays.ts).
