# Core API: projects, sprites, processing and export

Set `API=http://127.0.0.1:3000/api/v1` and `P="$API/projects/$PROJECT"`. Paths below are relative to `API`. JSON inputs reject unknown fields; send `Content-Type: application/json` except for multipart uploads. Errors include `code`, `message`, and, when available, `details.issues` with field paths. Use `curl --fail-with-body -sS` and check the command status. A resource belonging to another project is treated as not found. Do not retry version conflicts without re-reading current state.

## Project, provider and library inventory

| Method | Path | Request or result |
| --- | --- | --- |
| GET | /health | `{ok,worker,python,sqlite,storage,providers}`. Check `worker.online` and `python.ok` before queuing. |
| GET | /settings/providers | `{profiles}` with IDs, `capabilities` keyed by operation, declared `matrix`, and `unavailable`. `?for=creation` narrows to sprite creation and checks Codex CLI readiness. |
| POST | /settings/providers | Create or replace a profile by ID; see below. Returns `{profile}`. |
| POST | /settings/providers/{profileId}/check | No body; connectivity check, not a generation. Read response `ok`, not just HTTP 200. |
| GET | /projects | `{projects}`. Select an existing project by ID. |
| POST | /projects | `{name}` → `{project}` with default style. |
| GET | /projects/{projectId} | `{project,style}`. Read `project.activeStyleRevisionId` and `style.payload`. |
| PUT | /projects/{projectId}/style | `{payload,expectedActiveStyleRevisionId}` → `{style}`. Start with the live payload, change intended fields only, and send the current style ID (nullable). This doesn't restyle old revisions. |
| GET | /projects/{projectId}/assets | `{assets}`; optional `?family=character` (or another family). |
| POST | /projects/{projectId}/assets | `{family,kind,name}` → `{asset}`. Match the operation's exact family/kind before creating a target. |
| GET | /projects/{projectId}/assets/{assetId} | `{asset,revisions,lineage}`. `asset.approvedRevisionId` is the current approved revision; older approved revisions can still exist. |
| GET | /projects/{projectId}/assets/{assetId}/revisions | `{revisions}` including files, payload, status and technical report. |
| POST | /projects/{projectId}/assets/{assetId}/revisions | Publish a candidate from upload, compatible local job output, or UI component. See below. |
| POST | /projects/{projectId}/assets/{assetId}/reviews | `{revisionId,decision,expectedActiveRevisionId,reason?}` → `{asset,revision,affectedDependents}`. |
| GET | /projects/{projectId}/assets/{assetId}/draft | `{draft}`; null or `{version,payload}`. A draft is not an approved revision. |
| PUT | /projects/{projectId}/assets/{assetId}/draft | `{expectedVersion,payload}` → `{draft}`. Use version `0` when absent. For maps, keep the typed payload returned by the World map editor. |
| GET | /projects/{projectId}/revisions/{revisionId}/dependents | `{dependents}`: revisions referring to this revision. |
| GET | /projects/{projectId}/library/tags | `{tags}` with counts; `?tag=<encoded-tag>` yields `{tag,assetIds}`. |
| PUT | /projects/{projectId}/library/tags | `{assetId,tags}`; replaces all tags, up to 20; `[]` clears them. No new revision. |
| GET | /projects/{projectId}/library/affected | Query `clipRevisionId` and repeat `frameId` for each frame. Shows events and overlay coverage or rigid placements. |
| POST | /projects/{projectId}/library/duplicate | `{revisionId,name?}` → `{asset,revision}`; reuses blobs without mutating the source. |
| POST | /projects/{projectId}/library/ungroup | `{revisionId,directions?}` → `{created}`; a `character/base` becomes one new asset per selected view (default all). |
| POST | /projects/{projectId}/library/remove | `{revisionId,directions?,frameIds?,partId?,eventRemap?}` → `{revision}`. Remove directions from a base, or frames/layers from a clip. Check affected first. `eventRemap` maps affected event IDs to replacement frame IDs or `null` to drop explicitly. Keeps older revisions. |
| POST | /projects/{projectId}/library/mirror | `{revisionId,source?,confirmAsymmetric?}`. For bases supply a lateral `source` direction. Asymmetry requires `{confirmAsymmetric:{reason}}` based on explicit approval. |
| POST | /projects/{projectId}/library/canvas | `{revisionId,margins:{left,right,top,bottom}}`; signed integer pixel margins. Moves pivots, sockets, events and layers consistently without generating art. |

Profile fields: `id`, `name`, `transport`, optional `config`. `openrouter_images` requires `model` and `secretRef`, with optional `baseUrl`; `openai_images` requires all three. `codex_cli` uses a local `codex login`, takes optional `model`, and accepts no `baseUrl` or `secretRef`. `secretRef` is a server environment variable **name**, never its value. Don't overwrite user profiles to make a job fit. `simulated` is a reserved ID. See [transport configuration](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/providers/adapters.ts) and [Codex configuration](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/providers/codex-cli.ts) when setting up profiles.

The asset families are `character`, `item`, `equipment`, `vfx`, `texture`, `tileset`, `ui`, `portrait`, `font`, `audio`, and `map`. The family and kind pair is checked by the domain; use the pair documented for the chosen workflow. See the [style contract](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/style.ts) for geometry and palette rules.

An `assetId` identifies the stable entry; a `revisionId` identifies one immutable version. `revision.files[].fileKey` is used in operation inputs. `revision.files[].id` is the `fileId` for `/media`, not the logical file key or hash. For review, pass `asset.approvedRevisionId` as `expectedActiveRevisionId` (null for the first active version). `approve` makes the revision approved and active, `promote` switches to an already approved revision, `reject` needs a reason and cannot target the active revision.

## Uploads, plans, jobs and packages

| Method | Path | Request or result |
| --- | --- | --- |
| GET | /projects/{projectId}/uploads | `{uploads}`. |
| POST | /projects/{projectId}/uploads | Multipart field `file` → `{upload,job}`, 202. Queues ingestion. |
| GET | /projects/{projectId}/uploads/{uploadId} | `{upload}`; inspect `status`, `modality`, `normalizedSha256`, `metadata` and `error`. |
| GET | /projects/{projectId}/media/{fileId} | Stream revision file bytes by returned file ID or an upload by upload ID. Use `?variant=original` for original upload bytes instead of a normalized derivative. |
| POST | /projects/{projectId}/generation-plans | Validated, no-charge preview by `operation`; returns `plan`, `digest` and operation-specific metadata. |
| GET | /projects/{projectId}/jobs | `{jobs}`; optional `?active=true`. |
| POST | /projects/{projectId}/jobs | Queue `generation`, `local_process` or `ingest`; mandatory `Idempotency-Key` (1–200 chars); `{job,created}`, 202. |
| GET | /projects/{projectId}/jobs/{jobId} | `{job}` including `state`, `stage`, `result`, `error`, `summary` and `actions`. |
| POST | /projects/{projectId}/jobs/{jobId}/cancel | No body. Request cancellation if allowed; not a refund or guarantee of stopping an accepted provider request. |
| POST | /projects/{projectId}/jobs/{jobId}/retry | `{acknowledgePossibleCharge?:boolean}`; defaults to false. Inspect `job.actions.canRetry` and `retryMayCharge`; authorize any possible duplicate charge first. |
| GET | /projects/{projectId}/jobs/{jobId}/outputs/{index} | Stream PNG for a successful `local_process` job's zero-based output index, not a generic generation result. |
| GET | /export-profiles | `{profiles}`; currently `portable-v1` only. |
| GET | /projects/{projectId}/exports | `{exports}`. |
| POST | /projects/{projectId}/exports | `{revisionIds,profile?:"portable-v1"}` → `{export,created}`, 202; optional `Idempotency-Key`, otherwise same selection deduplicates. Free, local job. |
| GET | /projects/{projectId}/exports/{exportId} | `{export}`; poll `state` until `ready` or `failed`, inspect `report`/`error`. |
| GET | /projects/{projectId}/exports/{exportId}/download | ZIP when ready. Use a destination path the user requested. |

Accepted uploads: PNG, JPEG, GIF, WebP, PCM WAV, TTF/OTF, and an exported portable ZIP. Wait for `upload.status == "ready"`; raster inputs for generation need `normalizedSha256`. Uploading a portable ZIP reopens the revisions as candidates; use ingest `job.result.revisionMap` and `assetIds`. An upload already queues ingestion; a direct `/jobs` ingest body is `{"kind":"ingest","request":{"uploadId":"…"}}` and is not needed for normal uploads.

`POST …/assets/{assetId}/revisions` variants:

- `{"from":"upload","uploadId":"…"}` for a normalized raster → item icon candidate only. Uploading a PNG by itself doesn't create a character base.
- `{"from":"job_output","jobId":"…","outputIndex":0,"baseRevisionId":"…","fileKey":"image"}` → candidate replacing one file of the same size within a base revision of that asset. Resizing/cropping that changes its grid is not publishable through this route.
- `{"from":"ui_component","component":{…}}` for a button or panel. An image source is `{from:"upload",uploadId}`, `{from:"revision",revisionId,fileKey}` or `{from:"job_output",jobId,outputIndex}`. Insets are `{left,right,top,bottom}`. A panel is `{kind:"panel",image,nineSlice,contentPadding,stretch?}`. A button is `{kind:"button",states:[{state,image}],requiredStates?,focus,nineSlice,contentPadding,stretch?,text,accessibleName?}`. All state images and focus must match the `normal` image size; default required states are `normal`, `hover`, `pressed`, `disabled`. `focus` is `null` or `{mode:"overlay"|"full_image",image}`; `nineSlice` can be null for buttons. `stretch` defaults to `{center:"stretch",edges:"stretch"}`; each field accepts `stretch` or `tile`. `text` is `null` or `{key,sample,align?,verticalAlign?,wrap?,overflow?,fontRevisionId?}` (same keys as [UI menu text](ui-dialogue.md#local-ui-contracts), but this route defaults `overflow` to `grow`). Use `ui/panel` or `ui/button` as the target.

### Sprite from text or image references

`POST "$P/generation-plans"` takes this input shape (substitute actual profile ID):

```json
{
  "operation": "generate_asset",
  "providerProfileId": "simulated",
  "brief": "A small isolated blue potion bottle, transparent background, no slot frame or lettering",
  "language": "en",
  "params": { "family": "item", "kind": "consumable", "logicalSize": [32,32], "transparent": true, "variants": 1 }
}
```

`character/base` uses `transparent:true` and produces one full-body front (`S`) base per variant. Item kinds are `consumable`, `gear`, `key_item`, `material`, and `misc`. `language` is optional (`en` or `pt-BR`, otherwise project style). `variants` is 1–4.

For image references, use a capable real profile and add an ordered `references` array containing `{"uploadId":"…","role":"identity","instruction":"Keep the helmet and proportions"}` and/or `{"revisionId":"…","fileKey":"…","role":"palette"}`. The revision must be approved and both sources must belong to the project. Roles: `identity`, `style`, `pose`, `material`, `palette`, `equipment`, `silhouette`, `composition`; `instruction` is optional (300 characters max). The API caps references at 16 and the profile may cap it lower. For one character, describe what must stay the same separately from what may change. For strict pixel preservation use a mask instead of relying on wording.

After inspecting the preview, pass the exact response through `jq` to the queue. With `preview.json` saved from the plan endpoint, `ASSET` the matching target ID, and `KEY` the key for this logical job:

```sh
jq --arg asset "$ASSET" '{kind:"generation",request:{plan:.plan,planDigest:.digest,targetAssetId:$asset}}' preview.json |
  curl --fail-with-body -sS "$P/jobs" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" --data-binary @-
```

Poll the job endpoint; on success inspect `job.result.revisionIds` then `GET …/assets/{assetId}` and download the normalized candidate's `view` or `normalized` media, not the raw output. Review the revision and approve only as authorized. Export the **revision IDs**, not asset IDs: the server validates approved runtime dependencies and coverage before packaging. `portable-v1` supplies `manifest.json` with pinned revisions and assets, not engine-specific Godot, Tiled, or Aseprite files. Reuse exact export selection on retry.

### Inpaint an approved revision

Upload a binary mask at the source image's exact dimensions (`255` / white edits, `0` / black protects). Preview with `operation:"inpaint"`, `providerProfileId`, `sourceRevisionId`, `sourceFileKey`, `maskUploadId`, `instruction`, `mode`, and optional `language`. Modes: `native-mask` uses the provider's mask capability, whereas `candidate-composite` sends source + guide and restores protected pixels locally. The preview returns `mask`, `scope`, and `modeLabel`; an empty mask is rejected and a full mask has no protected pixels. Submit to `/jobs` with the **source asset** as target, not a fresh unrelated asset. Inspect the report and candidate before review.

### Deterministic local image operations

`POST "$P/jobs"` with a unique `Idempotency-Key` and body like:

```json
{
  "kind": "local_process",
  "request": {
    "operation": "crop_to_content",
    "inputs": [{ "role": "source", "ref": { "kind": "upload", "uploadId": "…" } }],
    "recipe": { "version": 1, "padding": 1, "alphaThreshold": 0 }
  }
}
```

Input `ref` also supports `{kind:"revision",revisionId,fileKey}` or `{kind:"job_output",jobId,outputIndex}`. Use returned IDs; the server resolves hashes. Processor roles are `source`, `candidate`, `poseGuide`, `editMask`, `keepMask`, `removeMask`, `palette`, and `layer`; choose the roles the recipe consumes. All seven exposed operations are in `schemas.json`: `slice_grid` (grid and frame IDs/timing), `remove_background_flood` (source with optional keep/remove masks), `crop_to_content`, `make_thumbnail`, `apply_palette`, `compose_layers` (ordered layers), and `composite_protected` (source, candidate and binary edit mask). Inspect one with `jq '.localRecipes.remove_background_flood' "$SKILL_DIR/references/schemas.json"`. Successful jobs expose `result.outputs`, `report`, `status` and `warnings`; a `needs_review` result warrants review even when the job state is `succeeded`.
