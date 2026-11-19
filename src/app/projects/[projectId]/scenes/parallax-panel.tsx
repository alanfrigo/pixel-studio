"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneLayerPayload, ScenePayload } from "@/contracts";
import { cameraSpan, layerCopies } from "@/domain/scenes/parallax";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { scenesMessages } from "@/i18n/messages/scenes";
import { createAsset, errorText, fileOf, flatRevisions, mediaUrl, PIXEL, type Profile, type ScenesCatalog, scenesApi, uploadImage } from "./scenes-client";
import { MaskPainter, Message, PlanRunner, RevisionCard } from "./shared";

/**
 * Planos de paralaxe declarados (06 §perspectivas, lateral): cada plano é um
 * arquivo próprio (gerado separadamente, importado ou derivado com máscara
 * revisada), com offset, fator e repetição por eixo. Prévia com a câmera
 * percorrendo duas larguras do fundo, teste do loop e continuidade do chão.
 */

const DEPTHS = ["sky", "far", "mid", "near", "ground"] as const;

export function ParallaxPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const { parallax: m, shared: sm } = useMessages(scenesMessages);
  const usable = profiles.filter((p) => (p.capabilities.generate_scene?.length ?? 0) > 0 && !p.unavailable);
  const [profileId, setProfileId] = useState("");
  const [brief, setBrief] = useState(m.defaultBrief);
  const [layerName, setLayerName] = useState(m.defaultLayerName);
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>("sky");
  const [repeatX, setRepeatX] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [size, setSize] = useState<[number, number]>([240, 160]);
  const layers = flatRevisions(catalog.layers);
  return (
    <>
      <section>
        <h2>{m.generateTitle}</h2>
        <div className="row">
          <label>
            {sm.profile}
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">{usable[0] ? sm.defaultProfile(usable[0].name) : "—"}</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.layer}
            <input value={layerName} onChange={(e) => setLayerName(e.target.value)} />
          </label>
          <label>
            {m.depth}
            <select value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
              {DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {m.depths[d]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={repeatX} onChange={(e) => setRepeatX(e.target.checked)} /> {m.repeatX}
          </label>
          <label>
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> {m.transparentBg}
          </label>
          <label>
            {sm.size}
            <select value={size.join("x")} onChange={(e) => setSize(e.target.value.split("x").map(Number) as [number, number])}>
              <option value="240x160">240×160</option>
              <option value="288x192">288×192</option>
              <option value="256x256">256×256</option>
            </select>
          </label>
        </div>
        <label>
          {m.scene}
          <input value={brief} onChange={(e) => setBrief(e.target.value)} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label={m.layer}
          disabled={!usable.length}
          body={() => ({ operation: "generate_scene", providerProfileId: profileId || usable[0]?.id, brief, projection: "side", logicalSize: size, layer: { name: layerName, depth, repeatX, transparent } })}
          target={async () => (await createAsset(projectId, "scene_layer", layerName)).id}
          onDone={refresh}
        />
        <ImportLayer projectId={projectId} refresh={refresh} />
      </section>
      <section>
        <h2>{m.listTitle}</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          {layers.length === 0 && <p className="muted small">{m.empty}</p>}
          {layers.map(({ asset, revision }) => {
            const p = revision.payload as SceneLayerPayload;
            const img = fileOf(revision, "mosaic-lines") ?? fileOf(revision, p.fileId);
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={img ? mediaUrl(projectId, img.id) : null} width={240} refresh={refresh}>
                <div>
                  <span className="badge">{m.depths[p.depth]}</span> <span className="badge">{p.obtained === "generated_separately" ? m.obtained.generated_separately : p.obtained === "imported" ? m.obtained.imported : m.obtained.derived}</span>{" "}
                  {p.requestedRepeat.x && <span className={`badge ${p.repeat.x ? "state-approved" : "state-rejected"}`}>{p.repeat.x ? m.repeats : m.seamFailed}</span>}{" "}
                  {p.groundLineY !== null && <span className="badge">{m.groundAt(p.groundLineY)}</span>}
                </div>
                {revision.status === "approved" && p.requestedRepeat.x && !p.repeat.x && <SeamFix projectId={projectId} catalog={catalog} profiles={profiles} assetId={asset.id} revisionId={revision.id} depth={p.depth} refresh={refresh} />}
              </RevisionCard>
            );
          })}
        </div>
      </section>
      <Compose projectId={projectId} catalog={catalog} refresh={refresh} />
      <DeriveFromFlat projectId={projectId} catalog={catalog} profiles={profiles} refresh={refresh} />
    </>
  );
}

function ImportLayer({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const m = useMessages(scenesMessages).parallax;
  const locale = useLocale();
  const [file, setFile] = useState<File | null>(null);
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>("far");
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    if (!file) return;
    try {
      const uploadId = await uploadImage(projectId, file, file.name, locale);
      await apiFetch(scenesApi(projectId, "/layers"), { method: "POST", json: { target: { name: file.name.replace(/\.png$/i, "") }, layer: { image: { from: "upload", uploadId }, depth, repeatX: true } } });
      setMessage(m.imported);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <div className="row small" style={{ marginTop: 8 }}>
      <strong>{m.importLayer}</strong>
      <input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <select value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
        {DEPTHS.map((d) => (
          <option key={d} value={d}>
            {m.depths[d]}
          </option>
        ))}
      </select>
      <button type="button" onClick={submit} disabled={!file}>
        {m.import}
      </button>
      <Message text={message} />
    </div>
  );
}

interface ComposeLayer {
  layerId: string;
  name: string;
  layerRevisionId: string;
  offset: [number, number];
  parallax: { x: number; y: number };
  repeat: { x: boolean; y: boolean };
}

function Compose({ projectId, catalog, refresh }: { projectId: string; catalog: ScenesCatalog; refresh: () => void }) {
  const { parallax: m, shared: sm } = useMessages(scenesMessages);
  const text = useText();
  const approved = flatRevisions(catalog.layers, (r) => r.status === "approved");
  const [stack, setStack] = useState<ComposeLayer[]>([]);
  const [viewport, setViewport] = useState<[number, number]>([240, 160]);
  const [groundY, setGroundY] = useState("");
  const [name, setName] = useState(m.defaultComposeName);
  const [result, setResult] = useState<{ strip: string; cameraTest: { spanPx: number; uncoveredFrames: number; loopPassed: boolean; groundContinuous: boolean | null }; warnings: TextValue[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const body = () => ({ logicalSize: viewport, layers: stack, groundLineY: groundY === "" ? null : Number(groundY) });
  const add = (revisionId: string) => {
    const entry = approved.find((a) => a.revision.id === revisionId);
    if (!entry) return;
    const p = entry.revision.payload as SceneLayerPayload;
    const factor = { sky: 0.1, far: 0.25, mid: 0.5, near: 1.4, ground: 1 }[p.depth];
    setStack((s) => [...s, { layerId: `plano-${s.length + 1}`, name: entry.asset.name.slice(0, 64), layerRevisionId: revisionId, offset: [0, Math.max(0, viewport[1] - p.logicalSize[1])], parallax: { x: factor, y: 0 }, repeat: { x: p.repeat.x, y: false } }]);
    if (p.groundLineY !== null && groundY === "") setGroundY(String(Math.max(0, viewport[1] - p.logicalSize[1]) + p.groundLineY));
  };
  async function preview() {
    setMessage(null);
    try {
      const r = await apiFetch<{ previews: { strip: string }; cameraTest: NonNullable<typeof result>["cameraTest"]; warnings: TextValue[] }>(scenesApi(projectId, "/compose/preview"), { method: "POST", json: body() });
      setResult({ strip: r.previews.strip, cameraTest: r.cameraTest, warnings: r.warnings });
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish() {
    try {
      await apiFetch(scenesApi(projectId, "/compose"), { method: "POST", json: { target: { name }, scene: body() } });
      setMessage(m.composed);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const images = stack.map((l) => {
    const entry = approved.find((a) => a.revision.id === l.layerRevisionId);
    const p = entry?.revision.payload as SceneLayerPayload | undefined;
    const f = entry && p ? fileOf(entry.revision, p.fileId) : null;
    return { layer: l, src: f ? mediaUrl(projectId, f.id) : null, size: p?.logicalSize ?? ([1, 1] as [number, number]) };
  });
  return (
    <section>
      <h2>{m.composeTitle}</h2>
      <div className="row">
        <select value="" onChange={(e) => add(e.target.value)}>
          <option value="">{m.addApprovedLayer}</option>
          {approved.map(({ asset, revision }) => (
            <option key={revision.id} value={revision.id}>
              {asset.name} r{revision.number}
            </option>
          ))}
        </select>
        <label>
          {m.viewport}
          <select value={viewport.join("x")} onChange={(e) => setViewport(e.target.value.split("x").map(Number) as [number, number])}>
            <option value="240x160">240×160</option>
            <option value="288x192">288×192</option>
            <option value="320x180">320×180</option>
          </select>
        </label>
        <label>
          {m.groundLine}
          <input value={groundY} onChange={(e) => setGroundY(e.target.value.replace(/\D/g, ""))} style={{ width: 60 }} />
        </label>
        <label>
          {sm.name}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <table className="small">
        <tbody>
          {stack.map((l, i) => (
            <tr key={l.layerId}>
              <td>{l.name}</td>
              <td>
                {m.factorX} <input type="number" step={0.05} min={0} max={4} value={l.parallax.x} style={{ width: 60 }} onChange={(e) => setStack((s) => s.map((x, j) => (j === i ? { ...x, parallax: { x: Number(e.target.value), y: 0 } } : x)))} />
              </td>
              <td>
                {m.offset} <input type="number" value={l.offset[0]} style={{ width: 50 }} onChange={(e) => setStack((s) => s.map((x, j) => (j === i ? { ...x, offset: [Number(e.target.value), x.offset[1]] } : x)))} />
                <input type="number" value={l.offset[1]} style={{ width: 50 }} onChange={(e) => setStack((s) => s.map((x, j) => (j === i ? { ...x, offset: [x.offset[0], Number(e.target.value)] } : x)))} />
              </td>
              <td>
                <label>
                  <input type="checkbox" checked={l.repeat.x} onChange={(e) => setStack((s) => s.map((x, j) => (j === i ? { ...x, repeat: { x: e.target.checked, y: false } } : x)))} /> {m.repeatXShort}
                </label>
              </td>
              <td>
                <button type="button" className="secondary" onClick={() => setStack((s) => s.filter((_, j) => j !== i))}>
                  {m.remove}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stack.length >= 2 && <CameraPreview images={images} viewport={viewport} groundY={groundY === "" ? null : Number(groundY)} />}
      <div className="row">
        <button type="button" onClick={preview} disabled={stack.length < 2}>
          {m.testLoop}
        </button>
        <button type="button" onClick={publish} disabled={!result}>
          {m.publishLayered}
        </button>
      </div>
      {result && (
        <div className="small">
          <div>
            {m.cameraSpan(result.cameraTest.spanPx)} ·{" "}
            <span className={`badge ${result.cameraTest.loopPassed ? "state-approved" : "state-rejected"}`}>{result.cameraTest.loopPassed ? m.loopOk : m.loopFailed}</span> · {m.holes(result.cameraTest.uncoveredFrames)} ·{" "}
            {result.cameraTest.groundContinuous === null ? m.groundUndeclared : result.cameraTest.groundContinuous ? m.groundContinuous : m.groundBroken}
          </div>
          {result.warnings.map((w, i) => (
            <div key={i} className="muted">
              ⚠ {text(w)}
            </div>
          ))}
          <details>
            <summary>{m.frameStrip}</summary>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.strip} alt={m.frameStripAlt} className="pixel" style={{ ...PIXEL, maxWidth: "100%" }} />
          </details>
        </div>
      )}
      <Message text={message} />
    </section>
  );
}

/** Câmera móvel no navegador: mesma regra (offset − ⌊câmera × fator⌋, cópias por período) do servidor e do leitor. */
function CameraPreview({ images, viewport, groundY }: { images: { layer: ComposeLayer; src: string | null; size: [number, number] }[]; viewport: [number, number]; groundY: number | null }) {
  const m = useMessages(scenesMessages).parallax;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  const [camera, setCamera] = useState(0);
  const [playing, setPlaying] = useState(true);
  const geometry = images.map((i) => ({ size: i.size, offset: i.layer.offset, parallax: i.layer.parallax, repeat: i.layer.repeat }));
  const span = cameraSpan(geometry, viewport);
  useEffect(() => {
    for (const i of images) {
      if (!i.src || loaded[i.src]) continue;
      const img = new Image();
      img.onload = () => setLoaded((l) => ({ ...l, [i.src!]: img }));
      img.src = i.src;
    }
  }, [images, loaded]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setCamera((c) => (c + ((now - last) / 1000) * 60) % (span + 1));
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, span]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const z = 2;
    canvas.width = viewport[0] * z;
    canvas.height = viewport[1] * z;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    images.forEach((i, n) => {
      const img = i.src ? loaded[i.src] : undefined;
      if (!img) return;
      for (const [x, y] of layerCopies(geometry[n]!, [Math.floor(camera), 0], viewport)) ctx.drawImage(img, x * z, y * z, img.width * z, img.height * z);
    });
    if (groundY !== null) {
      ctx.strokeStyle = "rgba(255,200,0,0.7)";
      ctx.beginPath();
      ctx.moveTo(0, groundY * z + 0.5);
      ctx.lineTo(canvas.width, groundY * z + 0.5);
      ctx.stroke();
    }
  });
  return (
    <div className="small">
      <canvas ref={canvasRef} className="pixel bg-checker" style={{ ...PIXEL, maxWidth: "100%" }} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => setPlaying((p) => !p)}>
          {playing ? m.pause : m.play}
        </button>
        <input type="range" min={0} max={span} value={Math.floor(camera)} onChange={(e) => (setPlaying(false), setCamera(Number(e.target.value)))} style={{ flex: 1 }} />
        <span>{m.cameraPosition(Math.floor(camera), span)}</span>
      </div>
    </div>
  );
}

/** Derivação local revisada de uma imagem plana: recorte com máscara + fundo reconstruído por inpainting (E1). */
function DeriveFromFlat({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const { parallax: m, shared: sm } = useMessages(scenesMessages);
  const c = useMessages(commonMessages);
  const locale = useLocale();
  const flats = flatRevisions(catalog.scenes, (r) => r.status === "approved" && (r.payload as ScenePayload).outputKind === "flat_image");
  const [sceneId, setSceneId] = useState("");
  const [mask, setMask] = useState<Blob | null>(null);
  const [cut, setCut] = useState<{ pieceUploadId: string; areaMaskUploadId: string; previews: { piece: string; area: string }; report: { needsReconstruction: boolean; contextOpaque: number }; inpaint: { sourceRevisionId: string; sourceFileKey: string } } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inpaintProfiles = profiles.filter((p) => (p.capabilities.inpaint?.length ?? 0) > 0 && !p.unavailable);
  const entry = flats.find((f) => f.revision.id === sceneId);
  const sp = entry?.revision.payload as ScenePayload | undefined;
  const img = entry && sp ? fileOf(entry.revision, sp.image.fileId) : null;
  const inpaints = entry ? (catalog.scenes.find((s) => s.asset.id === entry.asset.id)?.revisions ?? []).filter((r) => r.predecessorId === entry.revision.id && (r.technicalReport as { operation?: string } | null)?.operation === "inpaint") : [];
  async function doCut() {
    if (!mask) return;
    try {
      const maskUploadId = await uploadImage(projectId, mask, "mascara-plano.png", locale);
      setCut(await apiFetch(scenesApi(projectId, "/layers/cut"), { method: "POST", json: { sceneRevisionId: sceneId, maskUploadId } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish(kind: "front" | "back", inpaintRevisionId?: string) {
    if (!cut) return;
    try {
      const image = kind === "front" ? { from: "upload", uploadId: cut.pieceUploadId } : { from: "revision", revisionId: inpaintRevisionId, fileKey: cut.inpaint.sourceFileKey };
      await apiFetch(scenesApi(projectId, "/layers"), {
        method: "POST",
        json: {
          target: { name: kind === "front" ? m.cutLayerName : m.rebuiltBgName },
          layer: { image, depth: kind === "front" ? "near" : "far", repeatX: false, derivation: { sourceRevisionId: sceneId, maskUploadId: cut.areaMaskUploadId, hiddenAreas: kind === "front" ? "transparent_reviewed" : "reconstructed_inpaint", inpaintRevisionId: inpaintRevisionId ?? null } },
        },
      });
      setMessage(kind === "front" ? m.cutPublished : m.bgPublished);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.deriveTitle}</h2>
      <p className="small muted">{m.deriveIntro}</p>
      <select value={sceneId} onChange={(e) => (setSceneId(e.target.value), setCut(null))}>
        <option value="">{m.approvedFlatOption}</option>
        {flats.map(({ asset, revision }) => (
          <option key={revision.id} value={revision.id}>
            {asset.name} r{revision.number}
          </option>
        ))}
      </select>
      {img && sp && <MaskPainter src={mediaUrl(projectId, img.id)} size={sp.logicalSize} onChange={(b) => setMask(b)} />}
      {img && (
        <button type="button" onClick={doCut} disabled={!mask}>
          {m.cutAndMeasure}
        </button>
      )}
      {cut && (
        <div className="small">
          <div className="row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cut.previews.piece} alt={m.cutAlt} className="pixel bg-checker" style={{ ...PIXEL, height: 96 }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cut.previews.area} alt={sm.previouslyHidden} className="pixel" style={{ ...PIXEL, height: 96 }} />
          </div>
          <div>
            {m.outlinePainted(Math.round(cut.report.contextOpaque * 100))} → {cut.report.needsReconstruction ? m.needsRebuild : m.nothingToRebuild}
          </div>
          <button type="button" onClick={() => publish("front")}>
            {m.publishCut}
          </button>
          <PlanRunner
            projectId={projectId}
            label={m.rebuildBg}
            disabled={!inpaintProfiles.length}
            body={() => ({ operation: "inpaint", providerProfileId: inpaintProfiles[0]?.id, sourceRevisionId: cut.inpaint.sourceRevisionId, sourceFileKey: cut.inpaint.sourceFileKey, maskUploadId: cut.areaMaskUploadId, instruction: "continue o cenário de fundo onde estava o plano recortado, sem ele", mode: inpaintProfiles[0]?.capabilities.inpaint?.includes("native_mask") ? "native-mask" : "candidate-composite" })}
            target={async () => entry!.asset.id}
            onDone={refresh}
          />
          {inpaints.map((r) => (
            <div key={r.id}>
              Inpainting r{r.number} <span className={`badge state-${r.status}`}>{labelOf(c.revisionStatus, r.status)}</span>{" "}
              <button type="button" disabled={r.status !== "approved"} onClick={() => publish("back", r.id)}>
                {m.publishAsBg}
              </button>
              {r.status !== "approved" && <span className="muted">{m.approveInSceneTab}</span>}
            </div>
          ))}
        </div>
      )}
      <Message text={message} />
    </section>
  );
}

/**
 * Correção da emenda (mesmo fluxo da textura do T1): deslocar meia largura,
 * reconstruir a faixa central por inpainting (E1), desfazer o deslocamento e
 * revalidar a continuidade. Plano reprovado continua não repetível até lá.
 */
function SeamFix({ projectId, catalog, profiles, assetId, revisionId, depth, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; assetId: string; revisionId: string; depth: (typeof DEPTHS)[number]; refresh: () => void }) {
  const m = useMessages(scenesMessages).parallax;
  const c = useMessages(commonMessages);
  const [step, setStep] = useState<{ revision: { id: string }; maskUploadId: string; inpaint: { sourceRevisionId: string; sourceFileKey: string }; previews: { shifted: string } } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inpaintProfiles = profiles.filter((p) => (p.capabilities.inpaint?.length ?? 0) > 0 && !p.unavailable);
  const revisions = catalog.layers.find((l) => l.asset.id === assetId)?.revisions ?? [];
  const shiftedRev = step ? revisions.find((r) => r.id === step.revision.id) : undefined;
  const inpaints = step ? revisions.filter((r) => r.predecessorId === step.revision.id && (r.technicalReport as { operation?: string } | null)?.operation === "inpaint") : [];
  async function shift() {
    try {
      setStep(await apiFetch(scenesApi(projectId, "/layers/shift"), { method: "POST", json: { layerRevisionId: revisionId } }));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish(inpaintRevisionId: string) {
    try {
      await apiFetch(scenesApi(projectId, "/layers"), { method: "POST", json: { target: { assetId }, layer: { image: { from: "revision", revisionId: inpaintRevisionId, fileKey: "layer" }, depth, repeatX: true, unshift: true, sourceRevisionId: revisionId } } });
      setMessage(m.seamFixed);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  if (!step) {
    return (
      <button type="button" className="secondary" onClick={shift}>
        {m.fixSeam}
      </button>
    );
  }
  return (
    <div className="small">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={step.previews.shifted} alt={m.shiftedAlt} className="pixel bg-checker" style={{ ...PIXEL, width: 200 }} />
      <div className="muted">
        {m.seamCentered} {shiftedRev?.status === "approved" ? "" : m.approveShifted}
      </div>
      <PlanRunner
        projectId={projectId}
        label={m.rebuildStrip}
        disabled={!inpaintProfiles.length || shiftedRev?.status !== "approved"}
        body={() => ({ operation: "inpaint", providerProfileId: inpaintProfiles[0]?.id, sourceRevisionId: step.inpaint.sourceRevisionId, sourceFileKey: step.inpaint.sourceFileKey, maskUploadId: step.maskUploadId, instruction: "una as duas metades sem costura, continuando formas e cores dos dois lados", mode: inpaintProfiles[0]?.capabilities.inpaint?.includes("native_mask") ? "native-mask" : "candidate-composite" })}
        target={async () => assetId}
        onDone={refresh}
      />
      {inpaints.map((r) => (
        <div key={r.id}>
          Inpainting r{r.number} <span className={`badge state-${r.status}`}>{labelOf(c.revisionStatus, r.status)}</span>{" "}
          <button type="button" disabled={r.status !== "approved"} onClick={() => publish(r.id)}>
            {m.unshift}
          </button>
        </div>
      ))}
      <Message text={message} />
    </div>
  );
}
