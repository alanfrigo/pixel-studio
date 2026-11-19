"use client";

import { useState } from "react";
import type { ScenePayload } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useMessages } from "@/i18n/client";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { scenesMessages } from "@/i18n/messages/scenes";
import { createAsset, errorText, fileOf, flatRevisions, mediaUrl, PIXEL, type Profile, type ScenesCatalog, scenesApi } from "./scenes-client";
import { Message, PlanRunner, PointPicker, RevisionCard } from "./shared";

/**
 * Cena ilustrada (06 §cena completa): composição, perspectiva, iluminação,
 * resolução e elementos obrigatórios → imagem plana rotulada como tal; revisão
 * com personagem sobreposto em escala e pontos de apoio anotados.
 */

const SIZES: [string, [number, number]][] = [
  ["240×160 (3:2)", [240, 160]],
  ["288×192 (3:2)", [288, 192]],
  ["256×256 (1:1)", [256, 256]],
  ["320×180 (16:9)", [320, 180]],
];

export function ScenePanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const { scene: m, shared: sm } = useMessages(scenesMessages);
  const usable = profiles.filter((p) => (p.capabilities.generate_scene?.length ?? 0) > 0 && !p.unavailable);
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState(m.defaultName);
  const [brief, setBrief] = useState(m.defaultBrief);
  const [composition, setComposition] = useState(m.defaultComposition);
  const [lighting, setLighting] = useState(m.defaultLighting);
  const [elements, setElements] = useState(m.defaultElements);
  const [projection, setProjection] = useState<"side" | "top_down" | "three_quarter" | "isometric">("side");
  const [size, setSize] = useState(0);
  const scenes = flatRevisions(catalog.scenes);
  return (
    <>
      <section>
        <h2>{m.generateTitle}</h2>
        <p className="small muted">{m.generateIntro}</p>
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
            {sm.name}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {m.perspective}
            <select value={projection} onChange={(e) => setProjection(e.target.value as typeof projection)}>
              {(["side", "top_down", "three_quarter", "isometric"] as const).map((v) => (
                <option key={v} value={v}>
                  {sm.projections[v]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.resolution}
            <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {SIZES.map(([l], i) => (
                <option key={l} value={i}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {sm.description}
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} style={{ width: "100%" }} />
        </label>
        <div className="grid2">
          <label>
            {m.composition}
            <textarea value={composition} onChange={(e) => setComposition(e.target.value)} rows={2} style={{ width: "100%" }} />
          </label>
          <label>
            {m.lighting}
            <textarea value={lighting} onChange={(e) => setLighting(e.target.value)} rows={2} style={{ width: "100%" }} />
          </label>
        </div>
        <label>
          {m.requiredElements}
          <textarea value={elements} onChange={(e) => setElements(e.target.value)} rows={3} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label={m.runLabel}
          disabled={!usable.length}
          body={() => ({
            operation: "generate_scene",
            providerProfileId: profileId || usable[0]?.id,
            brief,
            composition,
            lighting,
            requiredElements: elements.split("\n").map((s) => s.trim()).filter(Boolean),
            projection,
            logicalSize: SIZES[size]![1],
          })}
          target={async () => (await createAsset(projectId, "scene", name)).id}
          onDone={refresh}
        />
      </section>
      <section>
        <h2>{m.listTitle}</h2>
        {scenes.length === 0 && <p className="muted small">{m.empty}</p>}
        <div className="row" style={{ alignItems: "flex-start" }}>
          {scenes.map(({ asset, revision }) => {
            const p = revision.payload as ScenePayload;
            const img = fileOf(revision, p.image.fileId);
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={img ? mediaUrl(projectId, img.id) : null} width={Math.min(480, p.logicalSize[0] * 2)} refresh={refresh}>
                <div>
                  {p.outputKind === "flat_image" ? <span className="badge">{m.flatImageBadge}</span> : <span className="badge">{m.parallaxLayers(p.layers.length)}</span>}{" "}
                  {p.supportPoints.length > 0 && <span className="badge">{m.supportPoints(p.supportPoints.length)}</span>}{" "}
                  {p.characterScale && <span className="badge">{m.characterHeight(p.characterScale.heightPx)}</span>}
                </div>
              </RevisionCard>
            );
          })}
        </div>
      </section>
      <ScaleReview projectId={projectId} catalog={catalog} refresh={refresh} />
    </>
  );
}

function ScaleReview({ projectId, catalog, refresh }: { projectId: string; catalog: ScenesCatalog; refresh: () => void }) {
  const m = useMessages(scenesMessages).scene;
  const c = useMessages(commonMessages);
  const scenes = flatRevisions(catalog.scenes);
  const characters = flatRevisions(catalog.characters, (r) => r.status === "approved");
  const [sceneId, setSceneId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [points, setPoints] = useState<{ pointId: string; label: string; at: [number, number] }[]>([]);
  const [preview, setPreview] = useState<{ zoom: string; height: number; view: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scene = scenes.find((s) => s.revision.id === sceneId);
  const sp = scene?.revision.payload as ScenePayload | undefined;
  const img = scene && sp ? fileOf(scene.revision, sp.image.fileId) : null;
  const body = () => ({ sceneRevisionId: sceneId, characterRevisionId: characterId, supportPoints: points });
  async function overlay() {
    setMessage(null);
    try {
      const r = await apiFetch<{ previews: { zoom: string }; report: { characterHeightPx: number }; view: string }>(scenesApi(projectId, "/review/preview"), { method: "POST", json: body() });
      setPreview({ zoom: r.previews.zoom, height: r.report.characterHeightPx, view: r.view });
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish() {
    try {
      await apiFetch(scenesApi(projectId, "/review"), { method: "POST", json: body() });
      setMessage(m.scaledPublished);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.scaleTitle}</h2>
      <div className="row">
        <label>
          {m.scene}
          <select value={sceneId} onChange={(e) => (setSceneId(e.target.value), setPoints([]), setPreview(null))}>
            <option value="">—</option>
            {scenes.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} ({labelOf(c.revisionStatus, revision.status)})
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.approvedCharacter}
          <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
            <option value="">—</option>
            {characters.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number}
              </option>
            ))}
          </select>
        </label>
      </div>
      {img && sp && (
        <>
          <p className="small muted">{m.pointsHint}</p>
          <PointPicker
            src={mediaUrl(projectId, img.id)}
            size={sp.logicalSize}
            points={points}
            onPick={(at) => setPoints((ps) => [...ps, { pointId: `apoio-${ps.length + 1}`, label: m.supportLabel(ps.length + 1), at }])}
          />
          <div className="small">
            {points.map((p) => (
              <span key={p.pointId} className="badge">
                {p.label}: {p.at.join(",")}
              </span>
            ))}{" "}
            {points.length > 0 && (
              <button type="button" className="secondary" onClick={() => setPoints([])}>
                {m.clearPoints}
              </button>
            )}
          </div>
          <div className="row">
            <button type="button" onClick={overlay} disabled={!characterId || !points.length}>
              {m.overlay}
            </button>
            <button type="button" onClick={publish} disabled={!preview}>
              {m.publishScaled}
            </button>
          </div>
          {preview && (
            <div className="small">
              {m.overlayInfo(preview.view, preview.height)}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview.zoom} alt={m.overlayAlt} className="pixel" style={{ ...PIXEL, maxWidth: "100%", display: "block" }} />
            </div>
          )}
        </>
      )}
      <Message text={message} />
    </section>
  );
}
