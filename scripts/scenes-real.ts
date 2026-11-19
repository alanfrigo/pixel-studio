/**
 * Ensaio real do cartão T2 (cenas e salas) pelo OpenRouter (rota genérica).
 *
 *   npx tsx scripts/scenes-real.ts [--max-usd=0.9] [--yes]                      # etapa 1
 *   npx tsx scripts/scenes-real.ts --stage=2 --table=x,y,w,h [--table-mask-file=png] [--shadow=x,y,w,h] --yes  # etapa 2
 *   npx tsx scripts/scenes-real.ts --stage=3 --yes                              # etapa 3
 *
 * Sem --yes só descobre as rotas (grátis), estima o custo máximo e confere o
 * saldo da chave (`limit_remaining`); nada é enviado.
 *
 * Etapa 1 (pagas: 2 cenas planas, 3 planos de paralaxe, 2 salas, 1 prop):
 * "Ponte em floresta ao entardecer" em cena plana (flare e mini), planos de
 * paralaxe lateral gerados separadamente (mini) e compostos com a câmera,
 * duas salas do mesmo edifício (flare, planta como guia raster; a segunda usa
 * a primeira como referência de estilo) e um prop independente (mini, alfa).
 * Depois de olhar `sala-a.png`, a etapa 2 recorta a mesa pelo retângulo
 * informado (máscara explícita, como o artista faria), mede a área antes
 * oculta, reconstrói por inpainting (E1, 1 chamada paga no flare), compõe a
 * sala com a mesa como prop, move a mesa, reutiliza-a na segunda sala com a
 * porta ligada e exporta pelo X1 com o leitor independente.
 *
 * Etapa 3 (até 6 pagas no flare): planos de paralaxe de novo, com a receita
 * revisada (o que cada plano NÃO desenha), e correção das emendas reprovadas
 * pela bancada (deslocar meia largura → inpainting E1 da faixa central →
 * desfazer → revalidar), recompondo a cena com a câmera.
 *
 * `--rooms-only` (etapa 1): só as duas salas, em reports/cenas/<data>-salas-v2/.
 * Resultados em reports/cenas/<data>/ (results.json + imagens).
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  MapObjectPayload,
  RoomPayload,
  SceneLayerPayload,
} from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import {
  createAsset,
  createProject,
  getAsset,
  getRevision,
  reviewRevision,
} from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import {
  exportFilePath,
  getExport,
  requestExport,
} from "@/server/export/exports";
import { importPortablePackage } from "@/server/export/import";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import {
  composeExtracted,
  editRoom,
  previewLink,
  previewRoom,
  publishCutout,
} from "@/server/scenes/rooms";
import {
  annotateScene,
  composeScene,
  previewScene,
  publishSceneLayer,
  shiftLayerForSeam,
} from "@/server/scenes/scenes";
import { ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;
const MAX_USD = Number(arg("max-usd", "0.9"));
const STAGE = Number(arg("stage", "1"));
const CONFIRMED = process.argv.includes("--yes");
/** Etapa 1 só com as duas salas (reensaio da receita de portas), em pasta própria. */
const ROOMS_ONLY = process.argv.includes("--rooms-only");
const BASE = "https://openrouter.ai/api/v1";
const MINI = "openai/gpt-image-1-mini";
const FLARE = "openai/gpt-image-2.6-flare";
/** Teto por imagem quando o catálogo cobra por token (conservador). */
const TOKEN_ESTIMATE: Record<string, number> = { [MINI]: 0.05, [FLARE]: 0.1 };
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const READER = path.join(
  REPO_ROOT,
  "consumers",
  "portable_reader",
  "read_portable.py",
);
const today = new Date().toLocaleDateString("sv-SE");
const outDir = path.join(
  REPO_ROOT,
  "reports",
  "cenas",
  ROOMS_ONLY ? `${today}-salas-v2` : today,
);
const statePath = path.join(outDir, "state.json");
const log = (m: string) => console.log(`[cenas] ${m}`);

const STAGE1: { model: string; label: string }[] = [
  { model: FLARE, label: "cena plana (flare)" },
  { model: MINI, label: "cena plana (mini)" },
  { model: MINI, label: "plano céu" },
  { model: MINI, label: "plano morros" },
  { model: MINI, label: "plano chão" },
  { model: FLARE, label: "sala A" },
  { model: FLARE, label: "sala B" },
  { model: MINI, label: "prop" },
];
const STAGE2: { model: string; label: string }[] = [
  { model: FLARE, label: "inpainting da área da mesa" },
];
const STAGE3: { model: string; label: string }[] = [
  { model: FLARE, label: "plano céu v2" },
  { model: FLARE, label: "plano morros v2" },
  { model: FLARE, label: "plano chão v2" },
  { model: FLARE, label: "emenda céu" },
  { model: FLARE, label: "emenda morros" },
  { model: FLARE, label: "emenda chão" },
];

// ---- 1. Descoberta gratuita, estimativa e saldo ----
const routes: Record<
  string,
  { tag: string | null; maxReferences: number; price: number | null }
> = {};
for (const model of [MINI, FLARE]) {
  const found = await new OpenRouterAdapter(
    { id: "d", baseUrl: BASE, secretRef: null, model },
    {},
  ).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag) ?? found[0];
  if (!ep) throw new Error(`${model}: sem rota no catálogo`);
  const pricing = ep.pricing as {
    billable: string;
    unit: string;
    cost_usd: number;
  }[];
  const perImage = pricing
    .filter((p) => p.billable === "output_image" && p.unit === "image")
    .map((p) => p.cost_usd);
  routes[model] = {
    tag: ep.providerTag,
    maxReferences: ep.maxReferences,
    price: perImage.length ? Math.max(...perImage) : null,
  };
  log(
    `${model} · rota ${ep.providerTag} · refs ≤ ${ep.maxReferences} · ${routes[model].price !== null ? `US$ ${routes[model].price}/imagem` : "por token"}`,
  );
}
const calls =
  STAGE === 4
    ? []
    : STAGE === 3
      ? STAGE3
      : STAGE === 2
        ? STAGE2
        : ROOMS_ONLY
          ? STAGE1.filter((c) => c.label.startsWith("sala"))
          : STAGE1;
const maxCost = calls.reduce(
  (n, c) => n + (routes[c.model]!.price ?? TOKEN_ESTIMATE[c.model]!),
  0,
);
const key = (
  (await (
    await fetch(`${BASE}/key`, {
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
      },
    })
  ).json()) as { data: { limit_remaining: number | null; usage: number } }
).data;
log(
  `etapa ${STAGE}: ${calls.length} chamada(s) (${calls.map((c) => c.label).join(", ")}) · custo máximo estimado US$ ${maxCost.toFixed(3)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${key.limit_remaining} (uso ${key.usage})`,
);
if (maxCost > MAX_USD)
  throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < maxCost)
  throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto dedicado no diretório de dados padrão ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const worker = new JobRunner(
  { ...studio, log: () => undefined },
  { workerId: "scenes-real", heartbeatMs: 10_000 },
);
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa ingestões e gerações pendentes */
  }
};
await mkdir(outDir, { recursive: true });
const save = (sha: string, name: string) =>
  copyFile(studio.blobs.pathFor(sha), path.join(outDir, name));
const saveDataUrl = (url: string, name: string) =>
  writeFile(
    path.join(outDir, name),
    Buffer.from(url.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
const fileSha = (revisionId: string, key: string) =>
  getRevision(studio.db, projectId, revisionId).files.find(
    (f) => f.fileKey === key,
  )?.sha256;
const approve = (revisionId: string) => {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  reviewRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    revisionId,
    decision: "approve",
    reason: null,
    expectedActiveRevisionId: asset.approvedRevisionId,
  });
};
const profileFor = (model: string) => {
  const id = model === MINI ? "cenas-mini" : "cenas-flare";
  const r = routes[model]!;
  saveProfile(studio.db, studio.clock, {
    id,
    name: `Cenas · ${model}`,
    transport: "openrouter_images",
    secretRef: "OPENROUTER_API_KEY",
    model,
    config: {
      maxReferences: r.maxReferences,
      transparent: true,
      quality: "medium",
      ...(r.tag ? { provider: { only: [r.tag], allow_fallbacks: false } } : {}),
      ...(r.price !== null ? { pricePerImageUsd: r.price } : {}),
    },
  });
  return id;
};
const profiles: Record<string, string> = {
  [MINI]: profileFor(MINI),
  [FLARE]: profileFor(FLARE),
};

interface State {
  projectId: string;
  costs: {
    label: string;
    model: string;
    usd: number | null;
    seconds: number;
    state: string;
    error: string | null;
  }[];
  [key: string]: unknown;
}
const state: State =
  STAGE >= 2
    ? (JSON.parse(await readFile(statePath, "utf8")) as State)
    : { projectId: "", costs: [] };
let projectId = state.projectId;

async function run(
  label: string,
  model: string,
  body: Record<string, unknown>,
  targetAssetId: string,
) {
  const planned = await buildPlan(studio, projectId, body as never);
  const started = Date.now();
  const { job } = submitJob(
    studio,
    projectId,
    {
      kind: "generation",
      request: {
        plan: planned.plan,
        planDigest: planned.digest,
        targetAssetId,
      },
    },
    `scenes-real:${label}:${today}:${STAGE}:${(state.attempts as unknown[] | undefined)?.length ?? 0}`,
  );
  await drain();
  const final = studio.queue.get(job.id)!;
  const result = JSON.parse(final.result_json ?? "null") as {
    revisionIds: string[];
    cost: { unit: string; amount: number }[] | null;
  } | null;
  const error =
    (JSON.parse(final.error_json ?? "null") as { message?: string } | null)
      ?.message ?? null;
  const usd = result?.cost?.find((c) => c.unit === "USD")?.amount ?? null;
  state.costs.push({
    label,
    model,
    usd,
    seconds: (Date.now() - started) / 1000,
    state: final.state,
    error,
  });
  log(
    `${label} · ${model}: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s · US$ ${usd ?? "?"}${error ? ` · ${error}` : ""}`,
  );
  return {
    revisionId: result?.revisionIds[0] ?? null,
    prompt: planned.plan.prompt.compiled,
  };
}

if (STAGE === 1) {
  const project = createProject(studio.db, studio.clock, {
    name: `Cenas real · ${today}`,
  });
  projectId = state.projectId = project.id;
  // Personagem de escala: guerreiro da fixture (aprovado ao importar).
  const fixture = buildClareira();
  const zip = writeZip(
    fixture.packageFiles.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      compress: false,
    })),
  );
  const { revisionMap } = await importPortablePackage(
    studio,
    projectId,
    readZip(zip),
    { approve: true },
  );
  const warrior = revisionMap["warrior-base-v1"]!;

  if (!ROOMS_ONLY) {
    // ---- A. "Ponte em floresta ao entardecer" em cena plana ----
    const sceneBody = (model: string) => ({
      operation: "generate_scene",
      providerProfileId: profiles[model]!,
      brief: "ponte de madeira sobre um rio numa floresta ao entardecer",
      composition:
        "a ponte atravessa o terço inferior da imagem da esquerda para a direita; árvores altas emolduram os dois lados; o rio passa por baixo refletindo o céu",
      lighting:
        "sol baixo à esquerda, céu laranja e roxo, sombras longas e azuladas",
      requiredElements: [
        "ponte de madeira",
        "rio",
        "árvores da floresta",
        "céu do entardecer",
      ],
      projection: "side",
      logicalSize: [288, 192],
    });
    const scenes: Record<string, unknown> = {};
    for (const model of [FLARE, MINI]) {
      const tag = model === FLARE ? "flare" : "mini";
      const asset = createAsset(studio.db, studio.clock, {
        projectId,
        family: "map",
        kind: "scene",
        name: `Ponte ao entardecer (${tag})`,
      });
      const r = await run(
        `cena plana (${tag})`,
        model,
        sceneBody(model),
        asset.id,
      );
      if (!r.revisionId) continue;
      await save(fileSha(r.revisionId, "image")!, `cena-ponte-${tag}.png`);
      await save(fileSha(r.revisionId, "raw")!, `cena-ponte-${tag}-bruta.png`);
      approve(r.revisionId);
      const rev = getRevision(studio.db, projectId, r.revisionId);
      scenes[tag] = {
        revisionId: r.revisionId,
        prompt: r.prompt,
        payload: rev.payload,
        report: rev.technicalReport,
      };
      const annotated = await annotateScene(studio, projectId, {
        sceneRevisionId: r.revisionId,
        characterRevisionId: warrior,
        supportPoints: [
          { pointId: "ponte", label: "Meio da ponte", at: [144, 150] },
          { pointId: "margem", label: "Margem", at: [40, 176] },
        ],
      });
      await save(
        annotated.revision.files.find((f) => f.fileKey === "scale-overlay")!
          .sha256,
        `cena-ponte-${tag}-escala.png`,
      );
      (scenes[tag] as Record<string, unknown>).scale = annotated.report;
    }
    state.scenes = scenes;

    // ---- B. Planos de paralaxe gerados separadamente ----
    const layerDefs = [
      {
        key: "ceu",
        name: "céu ao entardecer",
        depth: "sky",
        transparent: false,
        factor: 0.15,
      },
      {
        key: "morros",
        name: "morros e árvores distantes",
        depth: "mid",
        transparent: true,
        factor: 0.5,
      },
      {
        key: "chao",
        name: "chão de terra com grama, caminhável",
        depth: "ground",
        transparent: true,
        factor: 1,
      },
    ] as const;
    const layers: Record<
      string,
      { revisionId: string; payload: SceneLayerPayload; prompt: string }
    > = {};
    for (const l of layerDefs) {
      const asset = createAsset(studio.db, studio.clock, {
        projectId,
        family: "map",
        kind: "scene_layer",
        name: `Plano ${l.name}`,
      });
      const r = await run(
        `plano ${l.key}`,
        MINI,
        {
          operation: "generate_scene",
          providerProfileId: profiles[MINI]!,
          brief: "floresta ao entardecer para um jogo de plataforma lateral",
          projection: "side",
          logicalSize: [288, 192],
          layer: {
            name: l.name,
            depth: l.depth,
            repeatX: true,
            transparent: l.transparent,
          },
        },
        asset.id,
      );
      if (!r.revisionId) continue;
      approve(r.revisionId);
      layers[l.key] = {
        revisionId: r.revisionId,
        payload: getRevision(studio.db, projectId, r.revisionId)
          .payload as SceneLayerPayload,
        prompt: r.prompt,
      };
      await save(fileSha(r.revisionId, "layer")!, `plano-${l.key}.png`);
      await save(
        fileSha(r.revisionId, "mosaic-lines")!,
        `plano-${l.key}-mosaico.png`,
      );
      await save(fileSha(r.revisionId, "raw")!, `plano-${l.key}-bruto.png`);
    }
    state.layers = Object.fromEntries(
      Object.entries(layers).map(([k, v]) => [
        k,
        {
          revisionId: v.revisionId,
          repeat: v.payload.repeat,
          continuity: v.payload.continuity,
          groundLineY: v.payload.groundLineY,
          prompt: v.prompt,
        },
      ]),
    );
    if (Object.keys(layers).length >= 2) {
      const stack = layerDefs
        .filter((l) => layers[l.key])
        .map((l) => ({
          layerId: l.key,
          name: l.name.slice(0, 64),
          layerRevisionId: layers[l.key]!.revisionId,
          offset: [0, 0] as [number, number],
          parallax: { x: l.factor, y: 0 },
          repeat: { x: layers[l.key]!.payload.repeat.x, y: false },
        }));
      const ground = layers.chao?.payload.groundLineY ?? null;
      const preview = await previewScene(studio, projectId, {
        logicalSize: [288, 192],
        layers: stack,
        groundLineY: ground,
        steps: 8,
      });
      await saveDataUrl(preview.previews.strip, "paralaxe-camera.png");
      const sceneAsset = createAsset(studio.db, studio.clock, {
        projectId,
        family: "map",
        kind: "scene",
        name: "Floresta lateral em camadas",
      });
      const composed = await composeScene(studio, projectId, sceneAsset.id, {
        logicalSize: [288, 192],
        layers: stack,
        groundLineY: ground,
        steps: 8,
      });
      approve(composed.revision.id);
      await save(
        fileSha(composed.revision.id, "image")!,
        "paralaxe-composta.png",
      );
      state.parallax = {
        revisionId: composed.revision.id,
        cameraTest: composed.cameraTest,
        warnings: preview.warnings,
        stack,
      };
    }
  }

  // ---- C. Duas salas do mesmo edifício (rota genérica: planta como guia raster) ----
  const roomA = createAsset(studio.db, studio.clock, {
    projectId,
    family: "map",
    kind: "room",
    name: "Biblioteca",
  });
  const a = await run(
    "sala A",
    FLARE,
    {
      operation: "generate_room",
      providerProfileId: profiles[FLARE]!,
      theme:
        "biblioteca de um castelo de pedra, estantes de livros nas paredes e uma mesa de leitura de madeira no meio",
      doors: [
        { doorId: "porta-sul", cell: [3, 5], side: "S" },
        { doorId: "porta-leste", cell: [6, 2], side: "E" },
      ],
    },
    roomA.id,
  );
  if (a.revisionId) {
    approve(a.revisionId);
    await save(fileSha(a.revisionId, "picture")!, "sala-a.png");
    await save(fileSha(a.revisionId, "guide")!, "sala-a-guia.png");
    await save(fileSha(a.revisionId, "raw")!, "sala-a-bruta.png");
    state.roomA = {
      revisionId: a.revisionId,
      prompt: a.prompt,
      report: getRevision(studio.db, projectId, a.revisionId).technicalReport,
    };
    const roomB = createAsset(studio.db, studio.clock, {
      projectId,
      family: "map",
      kind: "room",
      name: "Sala de estudo",
    });
    const b = await run(
      "sala B",
      FLARE,
      {
        operation: "generate_room",
        providerProfileId: profiles[FLARE]!,
        theme: "sala de estudo do mesmo castelo, poltronas e uma lareira",
        doors: [{ doorId: "porta-oeste", cell: [0, 2], side: "W" }],
        styleRoomRevisionId: a.revisionId,
      },
      roomB.id,
    );
    if (b.revisionId) {
      approve(b.revisionId);
      await save(fileSha(b.revisionId, "picture")!, "sala-b.png");
      state.roomB = { revisionId: b.revisionId, prompt: b.prompt };
      const link = await previewLink(studio, projectId, {
        aRevisionId: a.revisionId,
        aDoorId: "porta-leste",
        bRevisionId: b.revisionId,
        bDoorId: "porta-oeste",
      });
      if (link.preview) await saveDataUrl(link.preview, "salas-ligadas.png");
      state.link = link.link;
    }
  }

  if (!ROOMS_ONLY) {
    // ---- D. Prop independente ----
    const propAsset = createAsset(studio.db, studio.clock, {
      projectId,
      family: "map",
      kind: "object",
      name: "Baú",
    });
    const prop = await run(
      "prop",
      MINI,
      {
        operation: "generate_map_object",
        providerProfileId: profiles[MINI]!,
        brief: "baú de madeira com cantos de ferro, fechado",
        projection: "top_down",
        logicalSize: [48, 48],
      },
      propAsset.id,
    );
    if (prop.revisionId) {
      await save(fileSha(prop.revisionId, "image")!, "prop-bau.png");
      state.prop = {
        revisionId: prop.revisionId,
        payload: getRevision(studio.db, projectId, prop.revisionId)
          .payload as MapObjectPayload,
      };
    }
  }
  log(
    `etapa 1 pronta. Olhe ${path.relative(REPO_ROOT, outDir)}/sala-a.png e rode a etapa 2 com --table=x,y,w,h da mesa.`,
  );
}

if (STAGE === 2) {
  // Retângulos separados por ";" (união): aproximação da silhueta que o artista pintaria com o pincel.
  const parse = (v: string) =>
    v
      .split(";")
      .filter(Boolean)
      .map((r) => r.split(",").map(Number) as [number, number, number, number]);
  const tableRects = parse(arg("table", ""));
  const shadowArg = arg("shadow", "");
  if (
    !tableRects.length ||
    tableRects.some((r) => r.length !== 4 || r.some((n) => !Number.isFinite(n)))
  )
    throw new Error("Informe --table=x,y,w,h[;x,y,w,h…]");
  const xs = tableRects.flatMap((r) => [r[0], r[0] + r[2]]);
  const ys = tableRects.flatMap((r) => [r[1], r[1] + r[3]]);
  const table: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  ];
  const roomA = (state.roomA as { revisionId: string }).revisionId;
  const roomB = (state.roomB as { revisionId: string } | undefined)?.revisionId;
  const rp = getRevision(studio.db, projectId, roomA).payload as RoomPayload;
  const [w, h] = [rp.picture.rect[2], rp.picture.rect[3]];
  const mask = (rects: [number, number, number, number][]) => {
    const img = createImage(w, h);
    fillRect(img, 0, 0, w, h, [0, 0, 0, 255]);
    for (const r of rects)
      fillRect(img, r[0], r[1], r[2], r[3], [255, 255, 255, 255]);
    return encodePng(img);
  };
  const up = async (name: string, bytes: Uint8Array) => {
    const { upload } = await ingestUpload(studio, projectId, { name, bytes });
    await drain();
    return upload.id;
  };
  if (state.cutout) {
    // Nova tentativa: guarda a anterior (com o que a inspeção da área mostrou) e segue a partir da sala original.
    const attempts = (state.attempts as unknown[] | undefined) ?? [];
    attempts.push({
      cutout: state.cutout,
      inpaint: state.inpaint,
      moved: state.moved,
      reused: state.reused,
      export: state.export,
    });
    state.attempts = attempts;
  }
  // Máscara pintada pelo artista (PNG preto/branco) ou a união dos retângulos de --table (que dão a caixa).
  const tableMaskFile = arg("table-mask-file", "");
  const tableMask = tableMaskFile ? new Uint8Array(await readFile(tableMaskFile)) : mask(tableRects);
  const maskId = await up("mesa.png", tableMask);
  await writeFile(path.join(outDir, "mesa-mascara.png"), tableMask);
  // Sombra projetada medida na pintura (arquivo PNG preto/branco) ou aproximada por retângulos.
  const shadowFile = arg("shadow-mask-file", "");
  const shadowId = shadowFile
    ? await up("sombra.png", new Uint8Array(await readFile(shadowFile)))
    : shadowArg
      ? await up("sombra.png", mask(parse(shadowArg)))
      : null;
  // Colisão e footprint revisados pelo "artista" do ensaio (px da peça / células); o recorte não os inventa.
  const collisionArg = arg("collision", "");
  const collision = collisionArg
    ? parse(collisionArg)
    : [
        [0, Math.max(0, table[3] - 6), table[2], Math.min(6, table[3])] as [
          number,
          number,
          number,
          number,
        ],
      ];
  const footprint = arg("footprint", "1,1").split(",").map(Number) as [
    number,
    number,
  ];
  const cut = await publishCutout(studio, projectId, {
    roomRevisionId: roomA,
    maskUploadId: maskId,
    shadowMaskUploadId: shadowId,
    name: "mesa",
    collision,
    footprintCells: footprint,
  });
  approve(cut.object.id);
  await save(fileSha(cut.object.id, "image")!, "mesa-prop.png");
  if (fileSha(cut.object.id, "shadow"))
    await save(fileSha(cut.object.id, "shadow")!, "mesa-sombra.png");
  state.cutout = {
    objectRevisionId: cut.object.id,
    report: cut.report,
    warnings: cut.warnings,
  };
  let composed;
  if (cut.needsReconstruction) {
    const inpaintAsset = getRevision(studio.db, projectId, roomA).assetId;
    const r = await run(
      "inpainting da área da mesa",
      FLARE,
      {
        operation: "inpaint",
        providerProfileId: profiles[FLARE]!,
        sourceRevisionId: cut.inpaint.sourceRevisionId,
        sourceFileKey: cut.inpaint.sourceFileKey,
        maskUploadId: cut.areaMaskUploadId,
        instruction: arg(
          "inpaint-instruction",
          "piso de pedra/madeira contínuo onde estava a mesa, sem a mesa, com a mesma luz",
        ),
        mode: "candidate-composite",
      },
      inpaintAsset,
    );
    if (!r.revisionId)
      throw new Error("Inpainting falhou; a área não foi reconstruída");
    approve(r.revisionId);
    await save(fileSha(r.revisionId, "picture")!, "sala-a-sem-mesa.png");
    await save(
      fileSha(r.revisionId, "inpaint-candidate")!,
      "sala-a-sem-mesa-candidato.png",
    );
    state.inpaint = {
      revisionId: r.revisionId,
      prompt: r.prompt,
      report: getRevision(studio.db, projectId, r.revisionId).technicalReport,
    };
    composed = composeExtracted(studio, projectId, {
      roomRevisionId: roomA,
      areaMaskUploadId: cut.areaMaskUploadId,
      reconstruction: { kind: "inpaint", inpaintRevisionId: r.revisionId },
    });
  } else {
    composed = composeExtracted(studio, projectId, {
      roomRevisionId: roomA,
      areaMaskUploadId: cut.areaMaskUploadId,
      reconstruction: { kind: "transparent" },
    });
  }
  approve(composed.id);
  const furniture = (composed.payload as RoomPayload).furniture[0]!;
  // Deslocamento da mesa movida e ponto de apoio na sala B (padrões da primeira rodada).
  const moveBy = arg("move", "-48,32").split(",").map(Number) as [number, number];
  const reuseAt = arg("reuse-at", "128,168").split(",").map(Number) as [number, number];
  const moved = editRoom(studio, projectId, {
    baseRevisionId: composed.id,
    furniture: [
      {
        ...furniture,
        supportAtPx: [
          furniture.supportAtPx[0] + moveBy[0],
          furniture.supportAtPx[1] + moveBy[1],
        ],
      },
    ],
    note: "Mesa movida",
  });
  approve(moved.revision.id);
  await saveDataUrl(
    (await previewRoom(studio, projectId, moved.revision.id)).previews.room,
    "sala-a-mesa-movida.png",
  );
  state.moved = {
    revisionId: moved.revision.id,
    furniture: moved.furniture.map((f) => ({
      placementId: f.placementId,
      problems: f.problems,
    })),
  };
  let exportIds = [moved.revision.id];
  if (roomB) {
    const reused = editRoom(studio, projectId, {
      baseRevisionId: roomB,
      furniture: [
        {
          placementId: "mesa",
          objectRevisionId: cut.object.id,
          supportAtPx: reuseAt,
          label: "mesa reutilizada",
        },
      ],
      connections: [
        {
          doorId: "porta-oeste",
          toRoomRevisionId: moved.revision.id,
          toDoorId: "porta-leste",
        },
      ],
      note: "Mesa reutilizada e porta ligada",
    });
    approve(reused.revision.id);
    await saveDataUrl(
      (await previewRoom(studio, projectId, reused.revision.id)).previews.room,
      "sala-b-mesa-reutilizada.png",
    );
    const link = await previewLink(studio, projectId, {
      aRevisionId: moved.revision.id,
      aDoorId: "porta-leste",
      bRevisionId: reused.revision.id,
      bDoorId: "porta-oeste",
    });
    if (link.preview)
      await saveDataUrl(link.preview, "salas-ligadas-mobiliadas.png");
    state.reused = {
      revisionId: reused.revision.id,
      connections: reused.connections.map((c) => ({
        doorId: c.doorId,
        ok: c.ok,
        offsetPx: c.offsetPx,
        method: c.method,
      })),
    };
    exportIds = [reused.revision.id];
  }
  const parallax = (state.parallax as { revisionId: string } | undefined)
    ?.revisionId;
  if (parallax) exportIds.push(parallax);
  const flat = (
    state.scenes as Record<string, { revisionId: string }> | undefined
  )?.flare?.revisionId;
  if (flat) exportIds.push(flat);
  const { export: requested } = requestExport(studio, projectId, {
    revisionIds: exportIds,
    profile: "portable-v1",
  });
  await drain();
  const ready = getExport(studio.db, projectId, requested.id);
  state.export = {
    state: ready.state,
    report: ready.report,
    error: ready.error,
  };
  if (ready.state === "ready" && existsSync(PYTHON)) {
    const zipPath = path.join(outDir, "pacote-cenas.zip");
    await copyFile(exportFilePath(studio.config.paths.exports, ready), zipPath);
    const readerOut = path.join(outDir, "leitor");
    await rm(readerOut, { recursive: true, force: true }); // o leitor exige pasta limpa
    const reader = spawnSync(PYTHON, [READER, zipPath, readerOut], {
      encoding: "utf8",
    });
    state.reader = {
      status: reader.status,
      stdout: reader.stdout.trim(),
      stderr: reader.stderr.trim().slice(0, 500),
    };
    log(
      `leitor independente: ${reader.status === 0 ? reader.stdout.trim() : reader.stderr.trim()}`,
    );
  }
}

if (STAGE === 3) {
  const defs = [
    {
      key: "ceu",
      name: "céu ao entardecer",
      depth: "sky",
      transparent: false,
      factor: 0.15,
    },
    {
      key: "morros",
      name: "morros e árvores distantes",
      depth: "mid",
      transparent: true,
      factor: 0.5,
    },
    {
      key: "chao",
      name: "chão de terra com grama, caminhável",
      depth: "ground",
      transparent: true,
      factor: 1,
    },
  ] as const;
  const v2: Record<
    string,
    {
      assetId: string;
      revisionId: string;
      payload: SceneLayerPayload;
      repaired: boolean;
      prompt: string;
    }
  > = {};
  for (const l of defs) {
    const asset = createAsset(studio.db, studio.clock, {
      projectId,
      family: "map",
      kind: "scene_layer",
      name: `Plano ${l.name} (v2)`,
    });
    const r = await run(
      `plano ${l.key} v2`,
      FLARE,
      {
        operation: "generate_scene",
        providerProfileId: profiles[FLARE]!,
        brief: "floresta ao entardecer para um jogo de plataforma lateral",
        projection: "side",
        logicalSize: [288, 192],
        layer: {
          name: l.name,
          depth: l.depth,
          repeatX: true,
          transparent: l.transparent,
        },
      },
      asset.id,
    );
    if (!r.revisionId) continue;
    approve(r.revisionId);
    await save(fileSha(r.revisionId, "layer")!, `v2-plano-${l.key}.png`);
    await save(
      fileSha(r.revisionId, "mosaic-lines")!,
      `v2-plano-${l.key}-mosaico.png`,
    );
    v2[l.key] = {
      assetId: asset.id,
      revisionId: r.revisionId,
      payload: getRevision(studio.db, projectId, r.revisionId)
        .payload as SceneLayerPayload,
      repaired: false,
      prompt: r.prompt,
    };
  }
  // Bancada da emenda para cada plano reprovado: deslocar → E1 na faixa central → desfazer → revalidar.
  const repairs: Record<string, unknown> = {};
  for (const l of defs) {
    const layer = v2[l.key];
    if (!layer || layer.payload.repeat.x) continue;
    const shifted = await shiftLayerForSeam(studio, projectId, {
      layerRevisionId: layer.revisionId,
      bandPx: 8,
    });
    approve(shifted.revision.id);
    const fix = await run(
      `emenda ${l.key}`,
      FLARE,
      {
        operation: "inpaint",
        providerProfileId: profiles[FLARE]!,
        sourceRevisionId: shifted.inpaint.sourceRevisionId,
        sourceFileKey: shifted.inpaint.sourceFileKey,
        maskUploadId: shifted.maskUploadId,
        instruction:
          "una as duas metades sem costura vertical, continuando formas, linha do horizonte e cores dos dois lados",
        mode: "candidate-composite",
      },
      layer.assetId,
    );
    if (!fix.revisionId) continue;
    approve(fix.revisionId);
    const fixed = await publishSceneLayer(studio, projectId, layer.assetId, {
      image: { from: "revision", revisionId: fix.revisionId, fileKey: "layer" },
      depth: l.depth,
      repeatX: true,
      unshift: true,
      sourceRevisionId: layer.revisionId,
    });
    approve(fixed.revision.id);
    await save(
      fileSha(fixed.revision.id, "layer")!,
      `v2-plano-${l.key}-corrigido.png`,
    );
    await save(
      fileSha(fixed.revision.id, "mosaic-lines")!,
      `v2-plano-${l.key}-corrigido-mosaico.png`,
    );
    repairs[l.key] = {
      before: layer.payload.continuity.x,
      after: (fixed.revision.payload as SceneLayerPayload).continuity.x,
      verdict: fixed.verdict,
    };
    v2[l.key] = {
      ...layer,
      revisionId: fixed.revision.id,
      payload: fixed.revision.payload as SceneLayerPayload,
      repaired: true,
    };
  }
  state.layersV2 = Object.fromEntries(
    Object.entries(v2).map(([k, v]) => [
      k,
      {
        revisionId: v.revisionId,
        repaired: v.repaired,
        repeat: v.payload.repeat,
        continuity: v.payload.continuity,
        groundLineY: v.payload.groundLineY,
        prompt: v.prompt,
      },
    ]),
  );
  state.repairs = repairs;
  if (Object.keys(v2).length >= 2) {
    const stack = defs
      .filter((l) => v2[l.key])
      .map((l) => ({
        layerId: l.key,
        name: l.name.slice(0, 64),
        layerRevisionId: v2[l.key]!.revisionId,
        offset: [0, 0] as [number, number],
        parallax: { x: l.factor, y: 0 },
        repeat: { x: v2[l.key]!.payload.repeat.x, y: false },
      }));
    const ground = v2.chao?.payload.groundLineY ?? null;
    const preview = await previewScene(studio, projectId, {
      logicalSize: [288, 192],
      layers: stack,
      groundLineY: ground,
      steps: 8,
    });
    await saveDataUrl(preview.previews.strip, "v2-paralaxe-camera.png");
    const sceneAsset = createAsset(studio.db, studio.clock, {
      projectId,
      family: "map",
      kind: "scene",
      name: "Floresta lateral em camadas (v2)",
    });
    const composed = await composeScene(studio, projectId, sceneAsset.id, {
      logicalSize: [288, 192],
      layers: stack,
      groundLineY: ground,
      steps: 8,
    });
    approve(composed.revision.id);
    await save(
      fileSha(composed.revision.id, "image")!,
      "v2-paralaxe-composta.png",
    );
    state.parallaxV2 = {
      revisionId: composed.revision.id,
      cameraTest: composed.cameraTest,
      warnings: preview.warnings,
      stack,
    };
  }
}

if (STAGE === 4) {
  // Só local (sem chamadas): recompor com os planos reais que passaram na bancada e alinhar o chão à base da tela.
  const v1 = state.layers as Record<string, { revisionId: string }>;
  const v2 = state.layersV2 as Record<string, { revisionId: string }>;
  const content = (rid: string) =>
    (
      getRevision(studio.db, projectId, rid).technicalReport as {
        check?: {
          contentRows?: [number, number] | null;
          solidFromY?: number | null;
        };
      }
    ).check;
  const groundRev = v2.chao!.revisionId;
  const groundCheck = content(groundRev);
  // A bancada desta revisão é anterior à medida `contentRows`: mede de novo, sem custo.
  const { runLayerCheck } = await import("@/server/scenes/layer-check");
  const groundFile = getRevision(studio.db, projectId, groundRev).files.find(
    (f) => f.fileKey === "layer",
  )!;
  const measured = (
    await runLayerCheck(studio, groundFile.sha256, { x: true, y: false }, true)
  ).report;
  const bottom =
    measured.contentRows?.[1] ?? groundCheck?.contentRows?.[1] ?? 191;
  const top = measured.solidFromY ?? 0;
  const groundOffset = 191 - bottom;
  const compose = async (
    label: string,
    layers: { key: string; rev: string; factor: number; offsetY?: number }[],
  ) => {
    const stack = layers.map((l) => ({
      layerId: l.key,
      name: l.key,
      layerRevisionId: l.rev,
      offset: [0, l.offsetY ?? 0] as [number, number],
      parallax: { x: l.factor, y: 0 },
      repeat: {
        x: (
          getRevision(studio.db, projectId, l.rev).payload as SceneLayerPayload
        ).repeat.x,
        y: false,
      },
    }));
    const preview = await previewScene(studio, projectId, {
      logicalSize: [288, 192],
      layers: stack,
      groundLineY: top + groundOffset,
      steps: 8,
    });
    await saveDataUrl(preview.previews.strip, `${label}-camera.png`);
    await saveDataUrl(preview.previews.image, `${label}.png`);
    return {
      cameraTest: preview.cameraTest,
      warnings: preview.warnings,
      stack,
    };
  };
  state.recompose = {
    groundAlign: {
      contentRows: measured.contentRows,
      solidFromY: measured.solidFromY,
      offsetY: groundOffset,
      groundLineY: top + groundOffset,
    },
    tresPlanos: await compose("v3-paralaxe-tres-planos", [
      { key: "ceu-v1", rev: v1.ceu!.revisionId, factor: 0.15 },
      {
        key: "morros-v2-corrigido",
        rev: v2.morros!.revisionId,
        factor: 0.5,
        offsetY: groundOffset,
      },
      { key: "chao-v2", rev: groundRev, factor: 1, offsetY: groundOffset },
    ]),
    doisPlanos: await compose("v3-paralaxe-dois-planos", [
      { key: "ceu-v1", rev: v1.ceu!.revisionId, factor: 0.15 },
      { key: "chao-v2", rev: groundRev, factor: 1, offsetY: groundOffset },
    ]),
  };
}

state.date = iso(studio.clock.now());
state.routes = routes;
state.totalUsd =
  Math.round(state.costs.reduce((n, c) => n + (c.usd ?? 0), 0) * 1e6) / 1e6;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
await writeFile(
  path.join(outDir, "results.json"),
  `${JSON.stringify(state, null, 2)}\n`,
);
log(
  `gasto real acumulado: US$ ${state.totalUsd} (de usage.cost) · resultados em ${path.relative(REPO_ROOT, outDir)}`,
);
studio.db.close();
