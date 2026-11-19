# UI kits, screens, dialogue, and bitmap fonts

All paths below are relative to `/api/v1`. Use actual IDs from the project catalog; asset IDs identify containers, revision IDs pin immutable inputs. Rectangles are `[x,y,width,height]` in logical pixels from the top left, and pixel anchors are `[x,y]`. `TextKey` is lowercase letters/digits/underscores in dot-separated segments, e.g. `npc.greeting`.

## Route inventory

| Method | Path | Use |
| --- | --- | --- |
| GET | /projects/{projectId}/ui | UI catalog |
| POST | /projects/{projectId}/ui/split | Crop an approved template into candidate components |
| POST | /projects/{projectId}/ui/states/local | Derive a component state by a local transform |
| POST | /projects/{projectId}/ui/states/focus | Draw a button focus overlay locally |
| POST | /projects/{projectId}/ui/menu-items | Compose a menu item without generating art |
| POST | /projects/{projectId}/ui/screens | Save a screen candidate and check its layout |
| POST | /projects/{projectId}/ui/screens/rebind | Replace pinned component/icon revisions on a screen |
| GET | /projects/{projectId}/dialogue | Dialogue catalog |
| POST | /projects/{projectId}/dialogue/portraits/review | Publish reviewed face geometry without changing pixels |
| POST | /projects/{projectId}/dialogue/expressions/compare | Compare resting expressions and viseme compatibility |
| POST | /projects/{projectId}/dialogue/speech/preview | Compute a deterministic speech timeline without publishing |
| POST | /projects/{projectId}/dialogue/speech | Publish a local speech candidate |
| POST | /projects/{projectId}/dialogue/speech/retarget | Use another compatible expression without changing timing |
| POST | /projects/{projectId}/dialogue/fonts/coverage | Compare required codepoints with measured glyphs |
| POST | /projects/{projectId}/dialogue/fonts/render | Render test text with existing bitmap glyphs |
| POST | /projects/{projectId}/dialogue/fonts/import | Measure and import an existing raster atlas |

These routes do not submit provider work. All POSTs take JSON; the compare, speech preview, coverage and font render routes return 200 and do not publish. Other POSTs return 201 with new `candidate` revisions; they do not replace the approved revision. Approve on the shared `POST /assets/{assetId}/reviews` under the project with `{ "revisionId": "<candidate>", "decision": "approve", "expectedActiveRevisionId": null }` for a first approval, or use the asset's current `approvedRevisionId` rather than `null`. Approve the runtime dependencies as well as the final composition before export. Rebinding creates a new candidate; approving a replacement component does not rewrite an existing screen.

## Provider-backed generation via shared plans and jobs

There are no UI/dialogue-specific generation POSTs. The sanctioned workflow is:

1. Use a project with an active style and a ready `providerProfileId` that offers `text_to_image` and `image_references` for the chosen operation and can accept its guide/reference count. POST the operation's input below to `$P/generation-plans`. The preview is free and returns `plan`, `digest`, `destination` (including `simulated`), and operation-specific fields such as `routeLabel`, `restrictions`, layout/grid/coverage, and sometimes `targetAssetId`. Check `plan.parts`, `plan.limits.estimate` and the destination before asking for approval to incur real provider cost.
2. Reuse the indicated `targetAssetId` when present; otherwise pick or create the matching asset with `POST $P/assets` (`family`, `kind`, `name`). Submit `POST $P/jobs` with `Idempotency-Key` and `{ "kind": "generation", "request": { "plan": <returned plan>, "planDigest": "<returned digest>", "targetAssetId": "<asset ID>" } }`. Pass the validated plan and digest unchanged. A digest is a content check, not authorization to spend. Project, references, target and capabilities are checked again. A `simulated` profile runs the same job flow against simulation, with no external charge; simulated cost/accounting is not real billing. Local routes below are neither paid nor simulated generation.
3. Poll `GET $P/jobs/{jobId}`. A successful generation yields `job.result` with `assetId`, `revisionIds` and `cost`. Fetch and inspect the candidates (including technical reports); job success does not imply approval or completeness. For a multi-component states job use the returned revision IDs rather than assuming every result belongs to `job.result.assetId`.

The plan bodies all require `operation` and `providerProfileId`. They accept optional `language` (`pt-BR` or `en`; defaults from the style). All other keys:

- **`generate_ui_template` → `ui/template`:** required `brief` (1–1000 chars) and `components` (1–12), e.g. `[{"localId":"continue","componentType":"menu_item","logicalSize":[64,14],"requiredStates":["normal","selected"]}]`. IDs are unique, start with a lowercase letter and are at most 32 chars (`a-z`, digits, `_`, `-`); dimensions are integers 4–256. `componentType` is `button`, `panel`, `slot`, `meter`, or `menu_item`. Optional `requiredStates` has up to 7 entries (see state enum below). Optional `referenceRevisionIds` is an ordered list of up to 4 approved revisions with usable images; the raster layout guide consumes one more reference slot. Produces flat art with `payload.cells` and `payload.proposals`, not ready-made components. Review and approve before local splitting.
- **`generate_ui_states` → source `ui/button` or `ui/slot` assets:** required `componentRevisionIds` (1–8 approved revisions). Each needs its base state (`normal` or `empty`) as a standalone image, not a nonzero-offset atlas crop. Optional `states` (1–7) defaults to each component's missing required states; the base is never generated, and every input must have something to generate. Optional `descriptions` (up to 7) contains `{state,description}` objects, 1–300 chars each. One part per component; use the returned first component's `targetAssetId` (the API accepts a target belonging to any source component). States failing local geometry checks can be omitted; inspect completeness and missing-state warnings before approval. Use local transforms instead if they meet the art requirement.
- **`generate_portrait` → `portrait/portrait`:** required `characterRevisionId` of an approved `character/base`. Optional `brief` (up to 500 chars, default `""`), `framing` (`bust` default or `head`), `logicalSize` (dimensions 24–160, default `[64,64]`) and `variants` (1–4, default 1). Uses the south view if present, otherwise the first view, as identity reference. Output has suggested regions, not reviewed geometry. Native alpha is used when offered; otherwise the keyed background is removed locally. Check identity, scale and palette, then review the geometry and approve that new revision.
- **`generate_visemes` → `portrait/expression`:** required `portraitRevisionId` of the approved portrait with reviewed face/mouth regions and `expressionKey` (slug, e.g. `happy`); optional `expressionBrief` (up to 500 chars, default `""`). Needs two reference slots (portrait and guide). Do one job and approval per expression; an existing expression for the same portrait asset and key can be reused via `targetAssetId`. A 4×2 sheet uses the fixed order `rest`, `ai`, `e`, `o`, `u`, `mbp`, `fv`, `cons`. Inspect the candidate's stability report and completeness; this does not generate voice or synchronize audio.
- **`generate_pixel_font` → `font/bitmap`:** optional `brief` (up to 500 chars, default `""`), `weight` (`light`, `regular` default, `bold`), `glyphSize` (integer 5–16, default 8), `kit` (`basic` or `basic_pt` default), `extraText` (up to 4000 chars, default `""`), `mode` (`base` default or `extend`) and `inkColor` (`#rrggbb`, default `#ffffff`). In `extend`, set `baseRevisionId` to an approved bitmap font revision and target the same asset. Extension preserves the base glyph size and requests only missing codepoints; no missing glyphs means no work. The base uses one reference slot and extension uses two. The job has one part per 8×4 glyph page and publishes a bitmap atlas with metrics, not TTF. Inspect actual coverage; a missing glyph is reported, not silently substituted.

See the canonical [UI plan builders](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/ui/plans.ts) and [dialogue plan builders](https://github.com/alanfrigo/pixel-studio/blob/main/src/server/dialogue/plans.ts) for exact validator details and constraints. These are reference-guided image routes, not native UI/portrait/viseme/font provider capabilities.

For example, preview a template job using simulation; this call alone creates no artwork:

```sh
API=http://127.0.0.1:3000/api/v1
P="$API/projects/$PROJECT"
curl -fsS "$P/generation-plans" -H 'Content-Type: application/json' \
  -d '{"operation":"generate_ui_template","providerProfileId":"simulated","brief":"Copper border, empty center, no lettering","components":[{"localId":"continue","componentType":"menu_item","logicalSize":[64,14]}]}' \
  > plan.json
```

## Local UI contracts

**Catalog:** `GET $P/ui` returns `components`, `templates`, and `screens` as `{asset,revisions}` collections, plus `images`, `backgrounds`, `palette` and `focusColor`. Image/background choices are approved and expose `revisionId`, `mediaFileId` and `rect`.

**Split:** `POST $P/ui/split` takes `templateRevisionId` (approved `ui/template`) and `pieces` (1–16): `{componentId,rects:[{localId,rect}],assetId?,name?}`. Each piece must supply all cell IDs for the component, 1–3 rectangles within the template; use the template proposals as a starting point, not as already verified crops. A meter needs its track/fill/frame rectangles and a clear frame interior; a `menu_item` design produces a button, not an actionable menu item. Omit `assetId` to create a component or set it to an existing asset of the matching kind to recrop into a new revision. Response: `{pieces:[{componentId,asset,revision}]}`. Example for a template whose `continue` component has a single `continue` cell:

```json
{"templateRevisionId":"rev_template","pieces":[{"componentId":"continue","rects":[{"localId":"continue","rect":[4,4,64,14]}],"name":"Continue button"}]}
```

**States:** `POST $P/ui/states/local` takes `componentRevisionId` (button or slot with a base state), `state`, optional `fromState` (defaults to `normal` for button or `empty` for slot), and `transform`. `state` and `fromState` use `normal`, `hover`, `pressed`, `disabled`, `selected`, `empty`, `occupied`; the destination cannot be the base state and the source must exist. Transforms: `{kind:"ramp",steps}` (integer −3 to 3), `{kind:"highlight",amount}` (0.05–0.6), `{kind:"offset",dx,dy}` (integers −2 to 2). Response: `{revision,complete,missing}`. Chain local edits using the newest candidate ID so the next revision includes prior changes; these local endpoints do not require an approved source. For example:

```json
{"componentRevisionId":"rev_button","state":"pressed","transform":{"kind":"offset","dx":0,"dy":1}}
```

**Focus:** `POST $P/ui/states/focus` takes `componentRevisionId` (button only), optional `widthPx` (integer 1–3, default 1) and `color` (`#rrggbb`, defaults to the style's reserved focus color or `#ffd600` without style). Returns `{revision}` with an overlay derived from the normal state. Focus is not a state enum value.

**Menu items:** `POST $P/ui/menu-items` requires `buttonRevisionId` (approved button), `actionId` (slug, e.g. `resume`), and `text:{key,sample,align?,verticalAlign?,wrap?,overflow?,fontRevisionId?}`. Required `sample` is 1–500 chars; defaults for the other fields are `center` (`start|center|end`), `middle` (`top|middle|bottom`), `none` (`none|word`), `report` (`grow|paginate|ellipsis|report`), and `null`, respectively. Optional top-level keys: `assetId` (existing `ui/menu_item`), `name`, `iconRevisionId` (approved item, default `null`), `shortcut` (up to 32 chars, default `null`), `selectable` (default `true`). Returns `{asset,revision,warnings}`; a selectable item with no selected button state yields a warning. Approve the item and any font it references before relying on it in an exportable screen.

**Screens:** `POST $P/ui/screens` takes `{payload,assetId?,name?,language?}`; optional `assetId` targets an existing `ui/screen` and `language` selects the preview check language (at most 16 chars). `payload` requires `referenceResolution`, `background` (null or `{revisionId,exported}`), `instances` (nonempty) and `focusOrder`; optional `testedResolutions` lists up to eight sizes, and `textCatalog` is `{languages,entries:[{key,text:{"en":"Sample"}}]}`. Each instance requires `instanceId`, `parentId` (nullable), `componentRevisionId` (nullable), fractional `anchors:{left,top,right,bottom}`, integer `offsets:{left,top,right,bottom}`, `order`, `hidden`, and `overrides` (may be `{}`). Overrides may contain `textKey`, `text`, `iconRevisionId`, `value`, `state`, `quantity`. Optional instance keys: `role`, `text` (full text slot with all alignment/overflow fields and nullable `fontRevisionId`), `layout` (`{kind:"grid",columns,rows,cell,gap}` on a group), `locked`. Parents and focus IDs must exist, and the hierarchy cannot cycle. See [ScreenPayload and nested schemas](https://github.com/alanfrigo/pixel-studio/blob/main/src/contracts/ui.ts#L245) for grid offset rules, roles, catalog limits and refinements. Components may be UI components, items, portraits or character bases; backgrounds may be `map/scene`, `map/room`, `map/scene_layer`, or `texture/material`. Save checks reference kinds; select approved revisions for exported runtime dependencies. Response: `{asset,revision,checks}`, with `resolution`, `offscreen`, `text` overflow entries and `counters` per checked resolution. Example using a pinned menu item:

```json
{
  "name":"Pause menu",
  "payload":{
    "referenceResolution":[320,180],"background":null,"testedResolutions":[[320,180],[400,300]],
    "instances":[{
      "instanceId":"resume","parentId":null,"componentRevisionId":"rev_resume_item",
      "anchors":{"left":0,"top":0,"right":0,"bottom":0},
      "offsets":{"left":16,"top":16,"right":80,"bottom":30},
      "order":0,"hidden":false,"overrides":{}
    }],
    "focusOrder":["resume"]
  }
}
```

**Rebind:** `POST $P/ui/screens/rebind` takes `{screenRevisionId,replacements:[{from,to}]}` (1–32 pairs). Each pair is two revisions of the same asset; at least one instance must match. Rebind changes `componentRevisionId` and matching `overrides.iconRevisionId`, not backgrounds or nested references in component payloads. Response: `{revision,instances}` where `instances` is the number changed, with fresh checks in `revision.technicalReport`.

## Local dialogue contracts

**Catalog:** `GET $P/dialogue` returns `characters`, `portraits`, `expressions`, `speeches`, `fonts` as `{asset,revisions}` collections plus `visemes`, `speechRule`, `fontTestStrings` and `glyphGeometry`. Speech revisions add `verify` (reproducibility and total time when the payload validates).

**Portrait geometry:** `POST $P/dialogue/portraits/review` takes `{revisionId,faceAnchor,faceRect,mouthRect}`. Source is a `portrait/portrait` revision, possibly still a candidate; the mouth must lie within the face and the geometry within the portrait. Example for a 48×48 portrait: `{ "revisionId":"rev_portrait", "faceAnchor":[24,18], "faceRect":[12,8,24,23], "mouthRect":[19,22,10,5] }`. Returns `{revision}` with the same source pixels and `technicalReport.regions.reviewed: true`. Approve this revision, then use its ID for viseme generation.

**Compare:** `POST $P/dialogue/expressions/compare` takes `{a,b}` (two `portrait/expression` revision IDs). Compare expressions from the same portrait for meaningful outside-mouth diagnostics; the comparison uses the mouth region of `a`'s source portrait and reports `samePortrait` rather than rejecting a mismatch. Returns `{report,compatibility,samePortrait,preview}`; the preview is an image data URL and nothing is published.

**Speech:** Both preview and publish require `{expressionRevisionId,textKey,language,text}` and optional `rate` (0.5–2, default 1). `language` is `pt-BR` or `en`; `text` is 1–2000 chars after trimming. Use an approved expression with a complete sheet and all visemes that the text uses. This is a local `letters-v1` timing rule, not speech synthesis. Preview returns `timing`, `timeline`, `frames`, `totalMs`, `unresolved`, `expression` metadata and `generationJobs: 0`. Publish accepts the same body plus optional `assetId` for an existing `portrait/speech` or optional `name` for a new one; returns `{revision,asset,stripPreview}`. The payload's timeline and expression reference are authoritative, not the derived GIF/strip previews.

```sh
API=http://127.0.0.1:3000/api/v1
P="$API/projects/$PROJECT"
curl -sS "$P/dialogue/speech/preview" -H 'Content-Type: application/json' \
  -d '{"expressionRevisionId":"rev_neutral","textKey":"npc.greeting","language":"en","text":"Hello, traveler!","rate":1}'
```

**Retarget speech:** `POST $P/dialogue/speech/retarget` takes `{speechRevisionId,expressionRevisionId}` where the second is the target expression. The approved target must have the same viseme IDs in the same order, cover all steps, and not be reported incomplete. Returns `{revision,stripPreview}`; same speech asset and timeline, new expression reference and previews. Approve the candidate separately when ready; prior speech revision is unchanged.

**Font coverage:** `POST $P/dialogue/fonts/coverage` takes optional `fontRevisionId` (nullable, defaults to `null` to compute requirements without a font), `kit` (`basic` or `basic_pt`, default `basic_pt`), `extraText` (up to 4000 chars, default `""`). Compares measured glyphs with the kit plus project UI/dialogue and test/extra strings. Returns `required`, `present`, `missing` (codepoints), `missingLabels`, `complete`, `codepoints`, `sources`, `origins` (generated/extended/imported counts or null), and `testStrings`.

**Font render:** `POST $P/dialogue/fonts/render` requires `fontRevisionId`. Optional `texts` (1–8 strings, each 1–2000 chars; defaults to test strings), `maxWidth` (integer 8–1024 or `null`, default null), `zoom` (integer 1–8, default 3), `color` and `background` (`#rrggbb` or null, each defaults to null). Returns `metrics`, `zoom`, `maxWidth`, `warnings` and rendered `texts` entries with dimensions, line widths, wrap/overflow, missing glyph positions, and `one`/`zoomed` image data URLs. Render and coverage can inspect candidates before approval.

**Font import:** Upload the atlas first via the shared uploads API and wait for its ingest job to make the raster upload `ready`. `POST $P/dialogue/fonts/import` requires `uploadId`, integer `columns` and `rows` (each 1–16), `cell:[width,height]` (each integer 3–64), integer `baselineY` (1–64, ≤ cell height), integer `capHeight` (3–48, ≤ baseline), `chars` (1–256 chars in reading order, space means an unused cell; must fit the grid), and `license:{name,provenance}` (1–120 and 1–500 chars). Optional `assetId` targets an existing font, `name` names a new font, and integer `tracking` is 0–4 (default 1). Example for an actual 2×2 sheet containing `A`, `B`, blank, `C`:

```json
{"uploadId":"upl_atlas","name":"Tiny caps","columns":2,"rows":2,"cell":[8,10],"baselineY":8,"capHeight":6,"chars":"AB C","license":{"name":"CC0-1.0","provenance":"Project-owned atlas released under CC0"}}
```

Returns `{asset,revision}` with the measured glyphs, metrics, atlas and preview. Empty requested cells do not count as glyphs, and a sheet with no ink in any mapped cell is rejected. Check coverage and render test strings before approving or submitting an extension plan.
