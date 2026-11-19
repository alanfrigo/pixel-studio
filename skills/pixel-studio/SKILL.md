---
name: pixel-studio
description: Use the local Pixel Studio HTTP API to create and edit pixel art game assets, generate characters and item icons from text or image references, animate sprites, dress characters, build tilesets and maps, create scenes and room kits, make game UI, portraits, lip-sync and bitmap fonts, and export game-ready assets. Use when asked to work on a Pixel Studio project or automate its asset pipeline.
license: MIT
compatibility: Requires a running Pixel Studio app and worker reachable on loopback, plus a shell with curl and jq for the examples. Real image generation requires a compatible provider configured in the Studio.
---

# Pixel Studio

Use the Studio API, not direct database writes, provider calls, or changes to the user's game engine. Keep IDs returned by the API; file keys inside a revision are not the file IDs used for download.

## Start here

```sh
API=http://127.0.0.1:3000/api/v1  # use the actual local port if different
curl --fail-with-body -sS "$API/health" | jq '{ok, worker: .worker.online, python: .python.ok}'
curl --fail-with-body -sS "$API/projects" | jq '.projects[] | {id,name}'
```

If the service is down, use the repository's [local installation instructions](https://github.com/alanfrigo/pixel-studio#local-installation) and start `npm run dev` from the Studio checkout. The skill does not include the server. Don't expose it publicly or bypass its loopback and origin checks. A live web server with an offline worker can accept jobs that never progress.

Reuse the requested project and its active style. Read `GET /projects/{projectId}` for style, palette and camera, and list assets or a domain catalog before creating or replacing anything. Create a separate project only when requested or needed to avoid touching existing work. If the brief leaves generation details open, use the project's style and approved sprites instead of guessing a new palette, direction or scale.

## Choose the workflow

| Task | Read this |
| --- | --- |
| Projects, profiles, imports, sprites from text or references, inpainting, local processing, reviews, library edits, exports | [Core API](references/core.md) |
| Directions, clips, retiming, states, interpolation, outfit transfer, equipment coverage and loadouts | [Animation and equipment](references/motion-equipment.md) |
| Seamless textures, tilesets, maps, isometric props, parallax, rooms and room kits | [World and scenes](references/world-scenes.md) |
| Game UI kits, buttons and screens, portraits, expressions, speech timing and bitmap fonts | [UI and dialogue](references/ui-dialogue.md) |
| Exact request shapes for all plan operations and local processor recipes | [Bundled JSON schemas](references/schemas.json) |

## Plan, run, review, export

1. **Check capabilities.** `GET /settings/providers` lists configured profile IDs, capabilities, and availability. Prefer a compatible profile for the task; never assume a model ID is a profile ID. With a ready Flare route, start there for keeping a character recognizable in an identity-guided recolor; use Gemini as a starting point for reference-guided small icons and Mini for text-only icon batches. Those are [limited benchmark results](https://github.com/alanfrigo/pixel-studio/blob/main/MODELS.md), not guarantees. `simulated` produces test output only; use it for an explicit offline workflow or smoke test, not as a fallback for final art.
2. **Freeze the inputs.** Upload user-authorized files with the `file` multipart field, then wait for ready. Use approved revisions for generation dependencies where required. Request a preview (`POST /projects/{projectId}/generation-plans` or the operation-specific preview) and inspect the returned prompt, source order, provider destination, parts and estimate. A preview does not submit image generation. Inspect an exact input shape with `jq '.plans.generate_asset' "$SKILL_DIR/references/schemas.json"`, where `SKILL_DIR` is this installed skill's directory. The server still validates relationships and provider limits.
3. **Submit intentionally.** Do not send files or spend credits/plan quota outside the user's authorization. Treat an unknown estimate as unknown, not free. Use the preview's exact `plan` and `digest` (`planDigest` when submitting); don't hand-build, edit, or recompute them. Use an `Idempotency-Key` per logical job. Use the same key and request after an ambiguous HTTP response, and a new key only for a deliberately new job. Follow a specialized `run` endpoint when the reference specifies it.
4. **Wait and inspect.** Poll the job by ID at a modest interval with a deadline. `queued` and `running` are not success. Stop at `failed`, `cancelled`, or `needs_attention` and inspect the error, partial outputs and retry/charge flags. For `succeeded`, inspect the candidate image, technical report and producer warnings; verify the requested pixel grid, alpha, silhouette, animation pivots/foot placement, or seams as relevant. Never claim a result from a preview alone.
5. **Publish deliberately.** Return reviewable candidates unless the user asked you to approve or export them. For an approved deliverable, use the actual active revision ID when reviewing, then export the intended approved revisions using `portable-v1`. Report candidate/approved revision IDs, usable file paths when requested, and known actual costs by unit. Don't promise engine-native exports, native masks, skeletal generation, or recorded audio unless the chosen API and provider actually implement them.
