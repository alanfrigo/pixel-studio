# Repository Guidelines

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project Overview

Pixel Studio is a local-first pixel-art studio for 2D game developers. It turns model outputs and imported art into editable, reviewable assets on an exact pixel grid. The simulated provider supports offline development; it is not a source of production art.

## Architecture & Data Flow

- Next.js App Router pages pass data to React editors; client code uses `apiFetch` and `usePoll` in `src/app/client/` for `/api/v1` and durable job status. Keep HTTP handlers thin; delegate to services and catalogs.
- Generation is **preview → submit → process → review**. `src/server/plan-builders.ts` registers operations. A preview returns the plan (pinned input hashes, revisions, capabilities, and limits) and its canonical digest. Submit both unchanged with an `Idempotency-Key`; reuse that key only for the same request.
- Web and worker share `Studio` dependencies: SQLite for catalog, revisions, and jobs; SHA-256-addressed files for media. The worker journals provider submissions, saves raw results, calls Python, and publishes candidate revisions. Preserve lease fencing, cancellation checkpoints, and recovery from ambiguous submissions; never silently resend a potentially charged request.
- Approval is explicit. Export resolves approved runtime dependencies, validates the manifest and file bytes, then promotes the ZIP. Native targets add destination files without replacing the `portable-v1` manifest.

## Key Directories

| Path | Put or find here |
| --- | --- |
| `src/contracts/`, `schemas/v1/` | Strict Zod wire contracts and generated JSON Schemas. Zod and domain validation are authoritative. |
| `src/domain/` | Pure rules for geometry, animation, maps, manifest validation, and references; no Next, database, or provider I/O. |
| `src/server/`, `src/worker/` | Services, catalogs, provider adapters, durable jobs, storage, and export orchestration. |
| `src/app/`, `src/i18n/` | App Router UI and API adapters; typed English and Brazilian Portuguese catalogs. |
| `python/pixel_pipeline/`, `consumers/portable_reader/` | Deterministic raster processing and an independent ZIP consumer. |
| `src/fixtures/`, `fixtures/clareira/`, `skills/pixel-studio/references/` | Fixture generator and checked-in sample; published agent API references and schema snapshot. |

## Development Commands

```sh
npm ci
npm run python:setup -- --locked --python 3.14
npm run dev             # migrates, then starts Next + worker on 127.0.0.1:3000
npm run build           # Next production build
npm run typecheck       # next typegen + tsc; no prior build required
npm run lint            # ESLint
npx playwright install --only-shell chromium
npm run check           # typecheck + lint + TS/Python coverage + browser E2E
```

- Use `PORT=3001 npm run dev` for another port. Check `/api/v1/health` for current schema, `python.ok`, and `worker.online`. For a split production launch, run `npm run db:migrate` first, then run `npm start` and `npm run worker` separately.
- After changing versioned contracts, run `npm run schemas:export`. For generation-preview or local-recipe inputs, also run `npx tsx scripts/export-skill-schemas.ts > skills/pixel-studio/references/schemas.json`. Update the matching skill route table when its API changes.
- Run `npm run fixtures:build` only when changing the deterministic fixture; it replaces `fixtures/clareira/`. Keep the README usage in sync with changes to installation or workflows.

## Code Conventions & Common Patterns

- Match surrounding style: two-space indentation, double quotes, and semicolons in TypeScript; `@/` imports resolve to `src/`. Use strict discriminated unions and shared `Id`, `Slug`, `Rect`, and `DurationMs` contracts. Use integer logical pixels and per-frame milliseconds; do not infer missing views by mirroring.
- Wrap routes with `api`, parse with `readJson`, and return `json` (`src/server/http.ts`). Use `DomainFailure(code, tx(ptBR, en), details)` for structured failures. Add matching UI message keys in both locales; keep localization at presentation boundaries.
- Inject `Studio`, `WorkerDeps`, or narrower dependencies in services and handlers. Use `webStudio()` at the Next boundary. Keep SQLite transactions synchronous and short; do network, filesystem, and raster work outside them. Add contiguous `NNNN_name.sql` migrations under `src/server/db/migrations/`; never change the SQL of an applied migration.
- Keep editor state in React; reuse the existing API and polling helpers rather than adding a global store. Persist durable state in the catalog or job queue, not in the browser. Keep credentials and filesystem dependencies out of client bundles.

## Important Files

- `scripts/dev.ts`, `src/worker/main.ts`, `src/server/studio.ts` — launch, worker entry point, and dependency composition.
- `src/server/services.ts`, `src/server/catalog/catalog.ts`, `src/server/jobs/queue.ts` — orchestration, review rules, and job ownership.
- `src/server/jobs/handlers/pipelines/index.ts`, `src/server/python/bridge.ts` — processing dispatch and isolated JSON-over-stdio bridge. Keep paths inside the attempt directory; the bridge verifies output hashes and dimensions.
- `src/server/export/{profiles,exports,package}.ts`, `src/server/export/targets/` — destination support, job lifecycle, portable package, and format-specific output.
- `package.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `python/pyproject.toml`, `.env.example` — commands and runtime configuration.

## Runtime/Tooling Preferences

- Use Node.js **24+** with bundled SQLite **3.51.3+**, npm and `package-lock.json`, and Python **3.14** via `uv` and `python/uv.lock`. Do not substitute Bun for Node. Follow the installed Next.js docs noted above.
- Web and worker must use the same `PIXEL_STUDIO_DATA_DIR` (default `./data`). For manual QA, use a fresh temp directory. The app binds to loopback; preserve Host and origin checks. Provider profiles store env var names, never secret values. Do not commit `.env`, local data, build outputs, or generated benchmark reports.
- Use the simulated provider for QA. Real-provider trials in `scripts/` are not tests; some dry runs still query provider APIs. Check `MODELS.md` and the script before running it. Do not authorize `--yes` or spend API/ChatGPT quota without the user's approval.

## Testing & QA

- **Automated regression tests are mandatory.** Every feature, bug fix, change to an existing behavior, or new edge case must add or update a test in the same change. A bug test must fail without the fix. Refactors must preserve and run coverage for the affected contracts; add tests before refactoring any behavior not already covered.
- Exercise each affected public contract at the right layer: unit tests for pure rules, integration tests for API/SQLite/worker/Python and file formats, and Playwright for user-facing workflows. Cover the success path and relevant boundary, failure, and recovery paths. Assert consumer-visible outcomes: decoded pixels, timings, dependency closure, persisted state, structured errors, or downloadable files. Do not skip, weaken, or replace meaningful assertions to make a change pass.
- Keep the [feature regression matrix](README.md#feature-regression-coverage) current. Map each new feature to tests that assert a user-visible result; a component or API smoke test alone does not establish a workflow. Keep offline coverage distinct from paid provider trials and native editor import checks.
- Run the narrowest relevant check while iterating: `npm test -- src/server/export/export.test.ts`, `cd python && uv run pytest -q tests/test_protocol.py`, or `npm run test:e2e -- e2e/studio.spec.ts`. Before delivering a behavior change, run `npm run check` when possible and state any checks not run. CI runs it on pushes and pull requests.
- Set up `python/.venv/bin/python` first: several Vitest suites otherwise skip Python-backed cases. Use `makeTestStudio()` (`src/server/testing.ts`) with a temporary migrated DB, manual clock, and simulated provider. Browser tests use a real production build and worker with isolated data. Keep tests deterministic, offline, and independent; do not use real credentials or provider calls.
- `npm run test:coverage` measures TypeScript; `npm run test:python:coverage` measures the raster pipeline and standalone reader, including Python subprocesses. Both enforce coverage floors; do not lower them to make a change pass. Playwright exercises browser behavior separately. CI also tests the generated Godot project: `PIXEL_STUDIO_TEST_GODOT=/path/to/godot npm test -- src/server/export/targets/godot.test.ts`. Distinguish archive/descriptor checks from opening a project in the target editor.
- Python coverage must stay at **100% of lines and branches** (`npm run test:python:coverage`). Use `npm run test:coverage:100` to verify the full TypeScript target; CI keeps a separate TypeScript floor until the strict check passes. Do not exclude production files or mark uncovered branches as ignored to meet the target.
