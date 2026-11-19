# Models, evals and benchmarks

Pixel Studio is provider-agnostic: every AI route is a **provider profile** (OpenRouter, OpenAI Images, the local Codex CLI, or the offline simulated provider) with **declared** capabilities. A capability becomes **tested** only after a real run passes. This page summarizes the real-money benchmarks we ran, what they taught us about generating **pixel art with AI**, and which model we recommend for each task.

> All numbers come from real API calls through the full Studio pipeline: the persistent job queue, provider adapter, pixel-grid recovery, background-key removal and fit to logical size. Costs are the provider's billed `usage.cost`, not estimates.
>
> Each case was run once (single seed). Artistic scores are provisional technical readings; final art direction belongs to the artist reviewing the candidates in the app.

**Total spent on all benchmarks below: US$ 5.55.**

| Benchmark | Cost |
|---|---|
| Icons + qualification | US$ 1.99 |
| Inpainting | US$ 0.27 |
| Animation | US$ 0.23 |
| Worlds (textures, tilesets, props) | US$ 0.34 |
| Equipment layering (modular outfits and weapons) | US$ 0.38 |
| States, object animation, interpolation, frame fixes | US$ 0.31 |
| Scenes, parallax, rooms and furniture | US$ 0.87 |
| README showcase gallery (22 images + one inpaint) | US$ 1.16 |
| Codex CLI trial (7 images) | 7 generations of the ChatGPT plan quota |

---

## 1. Pixel art item icons, 32×32 (text-to-image and image references)

**Setup.**
- **Models:** 9 image models available on OpenRouter.
- **Tasks:**
  - green potion from text only;
  - the same potion from **one reference image**;
  - the potion recolored using **two ordered references** (identity + palette);
  - a steel sword from text.
- **Prompts:** in English and Brazilian Portuguese.
- **Target:** a transparent 32×32 sprite. Routes without native alpha get a chroma-key background chosen far from the project palette, removed locally.

| Model (OpenRouter) | OK | US$ / image | Median latency | Native alpha | Exact pixel grid¹ | Reading |
|---|---|---|---|---|---|---|
| `openai/gpt-image-1-mini` | 6/6 | 0.009 | 15 s | yes | 6/6 | Clean and readable. Draws with few cells (often 16–26 px objects) and sometimes ignores the reference shape. |
| `microsoft/mai-image-2.7-flash` | 6/6 | 0.010 | 16 s | yes | 1/6 | Clean and follows references. Fine detail gets dotted outlines after reduction. |
| `black-forest-labs/flux-3-image-klein` | 6/6 | 0.010 | 10 s | no | 0/6 | Good raw drawing and follows references; high detail fragments thin shapes at 32 px. Needs references ≥ 256 px. |
| `bytedance-seed/seedream-5-0-flash` | 6/6 | 0.018 | 19 s | only with exactly 1 reference | 0/6 | Drew **two objects** for the two-reference task. |
| `qwen/qwen-image-2.1-turbo` | 6/6 | 0.018 | 16 s | no | 0/6 | Drew the **warrior instead of the potion** with two references; fragmented sword. |
| `bytedance-seed/seedream-5-5` | 6/6 | 0.025 | 20 s | yes | 0/6 | Random colored specks and invented ornaments. |
| `bytedance-seed/seedream-4.5` | 6/6 | 0.040 | 13 s | no | 2/6 | Follows references with large pixel cells. Requires 2K output (≥ 3,686,400 px). |
| `openai/gpt-image-2.6-flare` | 6/6 | 0.045 | 9 s | yes | 2/6 | Best balance of detail and reference fidelity. |
| `google/gemini-3.1-flash-image` | 6/6 | 0.074 | 11 s | no | 3/6 | Most faithful to references; most expensive. |

¹ The model's art fit in ≤ 32 grid cells, so the result is exact pixel art with no fractional resampling.

**Recommended defaults (provisional):**

| Task | Default | Alternative |
|---|---|---|
| Text-to-icon, cheap, batches | `openai/gpt-image-1-mini` | `microsoft/mai-image-2.7-flash` |
| Variation from reference images | `openai/gpt-image-2.6-flare` | `google/gemini-3.1-flash-image` |
| Cheap reference route | `black-forest-labs/flux-3-image-klein` (review outlines) | — |

**Prompt findings:**
- **Never put hex color codes in image prompts.** Models render them as text inside the image. Pixel Studio names colors instead ("near black", "brown"...).
- Phrases like "inventory icon" make models draw slot frames and borders. Ask for an **isolated item sprite, no frame, no slot, no border, no text**.
- On chroma-key routes, glass and other transparent materials let the key color show through. Asking for a **fully opaque object, glass painted with its own colors** fixed it on Seedream 4.5, Gemini and Qwen.
- English and Portuguese prompts performed the same within seed variation.

## 2. Inpainting (masked edit with exact RGBA protection)

**Setup.**
- **Mode:** candidate edit + local composite. OpenRouter routes only accept reference images, not native masks.
- **Inputs:** the source upscaled by an integer factor, plus a guide image with the editable region painted flat magenta.
- **Output:** the model returns the full canvas. Locally, only masked pixels are copied; every other pixel keeps its original 4 RGBA bytes, including RGB hidden under alpha 0.

| Scenario | Model | US$ | Pixels changed outside the mask² | Candidate matched the source in the protected area |
|---|---|---|---|---|
| Rebuild a lake shore with reeds (128×128 tileset) | `openai/gpt-image-2.6-flare` | 0.061 | **0 / 13,052** | 99.0% |
| Rebuild a lake shore with reeds | `google/gemini-3.1-flash-image` | 0.075 | **0 / 13,052** | 96.4% |
| Remove a wooden sign from a stone wall (64×64, partial alpha outside the mask) | `openai/gpt-image-2.6-flare` | 0.061 | **0 / 3,496** | 98.0% |
| Remove a wooden sign from a stone wall | `google/gemini-3.1-flash-image` | 0.075 | **0 / 3,496** | 98.0% |

² Checked by an independent Pillow script, byte by byte.

- **Semantics:**
  - Both models removed the sign and continued the brick-and-mortar pattern with moss: no transparency left and no repeated patch.
  - For the lake, `gpt-image-2.6-flare` produced coherent reeds and pebbles; Gemini came out darker and noisier.
- **Recommendation for candidate mode:** `openai/gpt-image-2.6-flare`.
- **Native-mask mode** (OpenAI Images edits) is implemented and covered by contract tests against a fake HTTP server. A real run needs an OpenAI key.

## 3. Sprite animation and 4/8-direction views

**Setup.**
- **Base:** an approved 64×64 warrior.
- **Requests:**
  - a one-click `walk` preset (6 frames, 120 ms, loop);
  - a free-text "jump in place";
  - an attack driven by an approved 18-joint pose sequence;
  - a new **east view** that must keep the sword in the right hand and the shield on the left arm.
- **Route:** OpenRouter has image + references only, so every mode ran as a **sprite sheet drawn by the model and sliced locally**. The app labels it as such ("not native animation", "not a structured skeleton").

| Scenario | `openai/gpt-image-1-mini` | `openai/gpt-image-2.6-flare` |
|---|---|---|
| One-click walk (3×2 sheet) | US$ 0.013 · shield disappears in 3/6 frames, legs barely move | US$ 0.037 · readable leg alternation, stable identity |
| Text: jump in place (2×2) | US$ 0.009 · no frame shows a jump | US$ 0.047 · crouch, take-off, apex and landing readable |
| Attack from a pose guide (2×2 + guide) | US$ 0.012 · sword appears and vanishes | US$ 0.055 · a real swing, guide followed loosely |
| East view from the south view | US$ 0.009 · wrong asymmetry (shield near the camera), reject | US$ 0.046 · correct profile and asymmetry |

**Recommendation:** `openai/gpt-image-2.6-flare` for sheet-based animation and new views on generic routes.

**What "real" skeleton animation means here.**
- The skeleton is sent **as data** (per-frame keypoints) only to a profile that declares native skeleton animation. None of the real profiles does today; the simulated provider exercises that path.
- On generic routes, a pose sequence becomes a raster guide image and is labeled accordingly. The trial showed models follow identity more than a raster guide, so the local skeleton estimate must be corrected in the editor before generating.

## 4. Worlds: seamless textures, autotile tilesets and isometric props

**Seamless materials (32×32).** Seams are validated locally against a declared per-material threshold:
- RGBA difference across the wrap seam vs. interior neighbors;
- a row/column color-profile test that catches dark borders hidden by noise;
- a sanity check that the material is opaque and not flat.

| Material (model) | X seam/interior | Y seam/interior | Result |
|---|---|---|---|
| grass (`gpt-image-1-mini`, US$ 0.009) | 0.79 | 0.93 | tileable X and Y |
| water (`gpt-image-1-mini`) | 0.72 | 0.67 | tileable X and Y |
| stone (`gpt-image-1-mini`) | 0.83 | 0.81 | tileable X and Y |
| stone (`gpt-image-2.6-flare`, US$ 0.044) | 1.03 | 1.03 | tileable X and Y |
| stone with a deliberately darkened right edge | 1.45, profile 36.5 vs. limit 10.5 | 1.02 | **X rejected and highlighted**; only Y stays tileable |

**Corner-based autotile (16 masks, top-down).**

| Approach | Seams (128 compatible neighbor pairs) | Art reading |
|---|---|---|
| Local template composed from the approved grass and water | 0 flagged, worst ratio 0.94 | clean, but it is composition, not generation (labeled) |
| Model-guided, locked 4 px border (`gpt-image-2.6-flare`, US$ 0.057 per atlas) | 0 flagged | **visible frame on 11/16 tiles** |
| Model-guided, free mode | 0 flagged, worst 0.79 | best look, but a darker outer line on 12/16 tiles draws a faint grid |

**Honest conclusion:** a generic image model follows the 16-mask layout well. Its atlases still need correction before art approval, by one of these routes:
- inpainting of the flagged tiles;
- variants of the plain tile;
- a profile that declares native tileset generation (none of the current real profiles does).

**Isometric (local composition).**
- The approved grass is projected on 64×32 diamonds: IoU 1.0, 0 holes and 0 overlaps across a 4-diamond patch.
- A tall tree prop (`gpt-image-1-mini`, US$ 0.013) keeps its support point on the cell center: dy 0.
- Draw order hides a character behind the canopy only where expected.

## 5. Equipment layering: outfits and weapons on a character

**Setup.** "Create a piece for this character" on the synthetic demo warrior (south view, 64×64 cell): a 4-frame shield attack and a 6-frame two-handed swing.
- **Piece:** "brown leather jerkin with brass rivets and short leather sleeves", with parts `torso` and `sleeve_near`.
- **Generic route:** the model receives the base frames in a grid on a chroma-key canvas plus a guide with the allowed zone painted, and returns a **dressed candidate**. The piece is then **extracted locally** with an explicit mask: integer registration against the clean base, comparison only inside each part's zone, hands protected, edges validated. The UI labels this as a generic route, never as a native mask or a native modular overlay.

| Model | Cost | Reading |
|---|---|---|
| `openai/gpt-image-2.6-flare` | US$ 0.04–0.06 per strip | Jerkin consistent across all 10 frames; poses respected; registration within 1 px. The sleeve zone, derived from a thin chain-mail piece, was too narrow on the first pass. Re-running only the sleeve gaps with the zone grown by 3 px extracted the sleeve in all 4 frames (US$ 0.06). |
| `openai/gpt-image-1-mini` | US$ 0.009–0.016 | Drew two characters on the proof pose and ignored poses on strips. Only the rigid weapon view was usable. |

After approval, switching loadouts (short sword + shield ↔ longsword, same armor) and exporting made **zero provider calls**; a test asserts it with the adapter switched off.

**Recommendation:** `gpt-image-2.6-flare` for dressed candidates; a wider allowed zone (the "Ampliar zona da roupa" setting, up to +8 px) for sleeves, shoulder pads and capes.

## 6. Character and object states, object animation, interpolation and frame fixes

All runs used the generic route (sheet or single frame drawn by image + references, sliced and matched locally). The UI labels each one as such.

| Scenario | `gpt-image-2.6-flare` | `gpt-image-1-mini` |
|---|---|---|
| Closed chest (object, no humanoid rig) | US$ 0.052, clean | US$ 0.009 |
| "Open" state linked to the closed chest | US$ 0.047: same wood, ironwork and scale, coins revealed. **Usable.** | US$ 0.009, style drift |
| "Open" animation (frame 0 = closed view, 4 generated frames) | US$ 0.049: usable | US$ 0.009: shadow on the floor, drift |
| Interpolation between closed and open | US$ 0.028: 2 in-betweens, extremes kept once | refused for a 2:1 sheet (not charged), then drew across grid cells |
| Fix one arm in one frame of an attack (mask + neighbors as context) | US$ 0.077: **0 protected pixels changed**, 99% candidate agreement; a visible seam on the torso because the mask was wide | US$ 0.019: 0 protected pixels changed, 92% agreement |

Other frames of a fixed clip keep the same geometry digest, and the revision lists the `impact` event and the armor coverage cells that depend on the edited frame.

**Recommendation:** `gpt-image-2.6-flare` for states, object animation and in-betweens.

## 7. Scenes, parallax backgrounds, rooms and furniture

| Output | Model and cost | Reading |
|---|---|---|
| Flat scene "bridge in a forest at sunset" (288×192) | flare US$ 0.05, mini US$ 0.01 | Flare: coherent composition, light and reflection at 1×. Published as a **flat image**: trees and bridge are not objects, collisions or terrain. |
| Parallax planes generated separately (sky, hills, ground) | first recipe: mini; revised recipe: flare (~US$ 0.04 per plane) | With the first recipe, models painted a whole scene in every plane. The revised recipe says what each plane must **not** draw, and the flare then produced clean separate planes. |
| Two rooms of one building from a floor-plan guide (7×6 cells) | flare ~US$ 0.05 per room | Follows the plan, walls and doors; room B reuses room A's style. The first recipe let the model paint the door marks as yellow blocks; the revised recipe produced real wooden doors. |
| Furniture cut-out and floor rebuild | flare US$ 0.06 per inpaint | Table + chairs cut out on a red rug, rug rebuilt by inpainting with 0 protected pixels changed, table moved and reused as a prop with support point and footprint. |

**Findings.**
- **Seams:** only the sky and the revised ground passed the seam test. Fixing seams by inpainting improved the sky from 16.6× to 2.78× and the hills from 3.2× to 1.50× the interior difference, still above the limit, so neither is promised as repeating. The camera test (two background widths, 3,840 px) approves sky + ground and rejects the stack with the hills.
- **Cut-out masks:** a rectangle mask drags rug pixels into the prop. A mask refined by background color (flood fill from the mask border through rug-colored pixels) gives a clean prop. The rebuild instruction must name the surface ("the same red rug"); "rug and floor continue" made the model paint floor tiles in the middle of the rug.

## 8. README showcase gallery

- **Images:** 22, from text prompts only, through the real job queue with `openai/gpt-image-2.6-flare`, at US$ 0.044 each.
- **Icons, characters and props:** all usable at the first attempt. Lossless grid recovery happened when the model drew on a clean grid (mushroom, gem). Other images needed a block-majority reduction, flagged in the technical report.
- **Seamless textures:** at 32×32 the reduction erased the stone shapes (the model drew on a ~4 px grid), so they were redone at 64×64. Cobblestone and lava pass on both axes. Grass fails the Y profile test and is kept as a sample.
- **Inpainting:** recoloring the knight's cape inside a mask changed 570 pixels inside it and **0 outside** (US$ 0.06).

## 9. Local Codex CLI (ChatGPT plan, no API key)

| | |
|---|---|
| Route | Codex CLI 0.169 logged in with ChatGPT; built-in image tool via the `imagegen` skill; one `codex exec` turn per image, read-only sandbox, reasoning effort `low` |
| Cost | 7 generations of the plan quota (no USD charge) |
| Time | 33–53 s per image, 2 in parallel |

| Case | Result |
|---|---|
| Icons 32×32 (potion, sword), text only, transparent | clean outline and palette; native alpha (1254×1254 PNG) reduced with a block-majority step (flagged) |
| Mana potion with the red potion as **style reference** | same outline, highlight and pixel size as the reference |
| Knight and oak 64×64 | full figure and readable silhouette at 1× |
| Cobblestone texture 64×64 | passes X, **fails the Y seam test**, so it is not promised as two-axis tiling |
| Inpaint: knight's cape to blue (candidate + local composite) | 691 pixels changed inside the mask, **0 outside**. The candidate redrew the figure (18% agreement in the protected area), which the composite discards. |

**Reading.** On these cases the quality is at the level of `gpt-image-2.6-flare` through OpenRouter, with these trade-offs:
- slower, because a short agent turn wraps each image;
- capped at 5 reference images;
- no per-image price, because it runs on the plan quota.

Use it when you have a ChatGPT plan and do not want to pay per call.

## 10. What the benchmarks changed in the pipeline

| Finding | Fix in Pixel Studio |
|---|---|
| Models draw "pixel art" on their own apparent grid (often fractional cells such as 36.6 px), not the requested size | Grid detection ("unzoom"): edge-profile period candidates, phase estimation and agreement validation measured on the object only. The art is recovered at its native resolution before fitting. |
| Large flat areas let a too-coarse grid pass validation | A grid that would leave the object with fewer cells than half the logical size is rejected in favor of a finer one. |
| Native-alpha routes return semi-transparent edges, faint haze or the whole sprite at alpha ≈ 250 | Alpha binarized at 128 before cropping, so pixel art ends up fully opaque or fully transparent. |
| Fractional upscaling mixes pixel sizes | Only integer upscaling; when a model draws with few cells, the icon is centered at 1× with a warning. |
| Edit candidates off an exact grid | Downscale by per-block majority color, not block center (cleaner, robust to noise). |
| Seedream 4.5 rejects outputs < 3,686,400 px even though the catalog lists 1K | The profile uses 2K; the validation error is free. |
| Seedream 5.0 Flash makes transparent images only with exactly one reference | `transparent: "single_reference"` profile setting; other requests use chroma key. |
| Black Forest Labs rejects references < 256×256 | References are upscaled by an integer factor until the short side is ≥ 256 px. |
| OpenRouter 402 "would exceed your available credits given your current in-flight requests" | Classified as transient: retried after backoff, never charged. |
| Models place sprite-sheet frames with positional noise (±2 px rows, −11 px drift in an in-place walk) | Each row's lowest frame rests on the base ground line; loops pin the foot to the pivot; one common scale factor per sheet. |
| `gpt-image-1-mini` returned an almost fully transparent "grass" material, and a naive seam test approved it | World operations request `background: "opaque"`; materials must be ≥ 99% opaque with more than 2 colors. |
| A dark border hidden by stone noise passed a per-pixel seam test | Added a row/column color-profile seam test. |
| A declared prop support point was 3 px off | Default support comes from the measured visual base; an isometric check reports dx/dy. |
| OpenAI image routes refuse 2:1 and 4:3 canvases (free refusal) | Generic sheets, outfit strips and in-between grids use only 1:1, 3:2 or 2:3 canvases, with empty cells declared. |
| Object frames shrank ~17% when a chest lid opened (scale by median height) | Objects and states scale by body width, with one common factor per sheet. |
| A model drew in-betweens across sheet cells, and slicing cut the chest in half | The pipeline measures content crossing inner grid lines and flags the candidate for review. |
| Anti-aliased chroma-key residue (245,26,214 vs. key 255,0,255) survived a per-channel tolerance in outfit layers | Saturated pixels with the key's hue are also removed as residue, and the count is reported. |
| The parallax camera test did not catch a non-repeating plane leaving the screen | The test now fails the loop when any plane leaves the viewport. |
| Room door marks were painted as yellow blocks | The room recipe says the marks only locate doorways and must become a real door or opening. |

## Reproduce

Every paid script estimates first and only spends with `--yes`. It enforces `--max-usd` and checks the key's remaining limit before sending anything.

```sh
npx tsx scripts/qualify-openrouter.ts --model=bytedance-seed/seedream-4.5   # qualify one model on a profile
npx tsx scripts/evaluate-models.ts                                          # models × tasks × prompt language (dry run)
npx tsx scripts/evaluate-models.ts --yes --max-usd=3
npx tsx scripts/reprocess-eval.ts <results-folder>                          # re-run local processing on paid outputs, free
npx tsx scripts/inpaint-real.ts --yes --max-usd=1                           # real inpainting trial with independent RGBA check
npx tsx scripts/animation-real.ts                                           # animation modes + new view (dry run)
npx tsx scripts/world-real.ts                                               # materials, guided tileset, prop (dry run)
npx tsx scripts/equipment-real.ts                                           # outfit coverage + rigid weapon (dry run)
npx tsx scripts/states-real.ts                                              # states, object animation, interpolation, frame fix (dry run)
npx tsx scripts/scenes-real.ts                                              # flat scene, parallax planes, rooms (dry run)
npx tsx scripts/showcase-real.ts                                            # README gallery (dry run)
npx tsx scripts/codex-real.ts                                               # Codex CLI: version, login and skill check (no generation)
npx tsx scripts/codex-real.ts --yes                                         # 7 images on your ChatGPT plan quota
```

Raw outputs, contact sheets and per-case technical reports are written to `reports/` (git-ignored).
