"use client";

import { useState } from "react";
import type { ExpressionPayload, PortraitPayload, Rect, VisemeId } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useMessages } from "@/i18n/client";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { RevisionView } from "@/server/catalog/catalog";
import { allRevisions, approvedRevisions, type DialogueCatalog, dialogueApi, errorText, fileOf, mediaUrl, pct, type Profile } from "./dialogue-client";
import { createAsset } from "./portrait-panel";
import { PlanRunner, ProfileSelect, RevisionCard, usableProfile, ZoomSelect } from "./shared";

const PRESETS = ["neutral", "happy", "sad", "angry", "surprised"] as const;

/** Um quadro recortado de uma folha (atlas), ampliado por fator inteiro sem reamostrar. */
export function FrameCrop({ src, rect, sheet, zoom, title }: { src: string; rect: Rect; sheet: [number, number]; zoom: number; title?: string }) {
  return (
    <div
      title={title}
      className="bg-checker"
      style={{
        width: rect[2] * zoom,
        height: rect[3] * zoom,
        backgroundImage: `url(${src})`,
        backgroundSize: `${sheet[0] * zoom}px ${sheet[1] * zoom}px`,
        backgroundPosition: `${-rect[0] * zoom}px ${-rect[1] * zoom}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}

/** Folha de uma expressão: visemes na ordem declarada, com nome e o arquivo da folha. */
export function sheetOf(revision: RevisionView) {
  const payload = revision.payload as ExpressionPayload;
  const file = fileOf(revision, payload.visemes[0]?.fileId ?? "sheet");
  const grid = payload.grid;
  const sheet: [number, number] = grid ? [grid.columns * grid.cell[0], grid.rows * grid.cell[1]] : [Math.max(...payload.visemes.map((v) => v.rect[0] + v.rect[2])), Math.max(...payload.visemes.map((v) => v.rect[1] + v.rect[3]))];
  return { payload, file, sheet };
}

/** Expressões e bocas: uma folha por job, mesmas posições de boca lado a lado e estabilidade do rosto. */
export function ExpressionsPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: DialogueCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(dialogueMessages);
  const e = m.expressions;
  const portraits = approvedRevisions(catalog.portraits).filter(({ revision }) => Boolean((revision.payload as PortraitPayload).mouthRect));
  const [profileId, setProfileId] = useState("");
  const [portraitId, setPortraitId] = useState("");
  const [key, setKey] = useState("neutral");
  const [brief, setBrief] = useState("");
  const [zoom, setZoom] = useState(2);
  const portrait = portraits.find((p) => p.revision.id === portraitId) ?? portraits[0];
  const profile = usableProfile(profiles, "generate_visemes", profileId);
  const label = (k: string) => (PRESETS as readonly string[]).includes(k) ? e.presets[k as (typeof PRESETS)[number]] : k;
  return (
    <>
      <section>
        <h2>{e.heading}</h2>
        {!portraits.length && <p className="muted">{e.noPortrait}</p>}
        <div className="row">
          <ProfileSelect profiles={profiles} operation="generate_visemes" value={profileId} onChange={setProfileId} />
          <label>
            {e.portrait}
            <select value={portrait?.revision.id ?? ""} onChange={(ev) => setPortraitId(ev.target.value)}>
              {portraits.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {asset.name} r{revision.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            {e.key}
            <input list="expression-presets" value={key} onChange={(ev) => setKey(ev.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))} style={{ width: 120 }} />
            <datalist id="expression-presets">
              {PRESETS.map((k) => (
                <option key={k} value={k}>
                  {e.presets[k]}
                </option>
              ))}
            </datalist>
          </label>
        </div>
        <label>
          {e.brief}
          <input value={brief} onChange={(ev) => setBrief(ev.target.value)} style={{ width: "100%" }} />
        </label>
        <p className="small muted">{e.grid(4, 2, catalog.visemes.ids.length)}</p>
        <PlanRunner
          projectId={projectId}
          label={e.generate}
          disabled={!portrait || !profile || !key}
          body={() => (portrait && profile && key ? { operation: "generate_visemes", providerProfileId: profile, portraitRevisionId: portrait.revision.id, expressionKey: key, expressionBrief: brief } : null)}
          target={() => createAsset(projectId, "portrait", "expression", `${portrait?.asset.name ?? "?"} · ${label(key)}`)}
          onDone={refresh}
        />
      </section>
      <section>
        <div className="row">
          <h2 style={{ margin: 0 }}>{e.sets}</h2>
          <ZoomSelect value={zoom} onChange={setZoom} max={6} />
        </div>
        {!catalog.expressions.length && <p className="muted">{m.shared.noRevisions}</p>}
        {allRevisions(catalog.expressions).map(({ asset, revision }) => {
          const { payload, file, sheet } = sheetOf(revision);
          const tr = revision.technicalReport as { stability?: { maxOutsideMouth: number; outsideFace: number | null; complete: boolean } } | null;
          return (
            <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={null} width={payload.visemes.length * ((payload.visemes[0]?.rect[2] ?? 32) * zoom + 12)} refresh={refresh}>
              <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap", overflowX: "auto" }}>
                {file &&
                  payload.visemes.map((v) => (
                    <figure key={v.visemeId} style={{ margin: 0, textAlign: "center" }}>
                      <FrameCrop src={mediaUrl(projectId, file.id)} rect={v.rect} sheet={sheet} zoom={zoom} title={v.visemeId} />
                      <figcaption className="muted">{e.visemes[v.visemeId as VisemeId] ?? v.visemeId}</figcaption>
                    </figure>
                  ))}
              </div>
              <div>
                {payload.expressionKey} · {payload.visemeSet ?? ""}
              </div>
              {tr?.stability && <div className="muted">{e.stability(pct(tr.stability.maxOutsideMouth), pct(tr.stability.outsideFace))}</div>}
              {tr?.stability?.complete === false && <div className="error">{e.incomplete}</div>}
            </RevisionCard>
          );
        })}
      </section>
      <CompareExpressions projectId={projectId} catalog={catalog} />
    </>
  );
}

function CompareExpressions({ projectId, catalog }: { projectId: string; catalog: DialogueCatalog }) {
  const e = useMessages(dialogueMessages).expressions;
  const options = allRevisions(catalog.expressions);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [result, setResult] = useState<{ report: { outsideMouth: number; changedPixels: number }; compatibility: { compatible: boolean }; preview: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (options.length < 2) return null;
  const pick = (value: string, fallback: number) => value || options[fallback]!.revision.id;
  async function compare() {
    setMessage(null);
    try {
      setResult(await apiFetch(dialogueApi(projectId, "/expressions/compare"), { method: "POST", json: { a: pick(a, 0), b: pick(b, 1) } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const select = (value: string, set: (v: string) => void, fallback: number) => (
    <select value={pick(value, fallback)} onChange={(ev) => set(ev.target.value)}>
      {options.map(({ asset, revision }) => (
        <option key={revision.id} value={revision.id}>
          {asset.name} r{revision.number}
        </option>
      ))}
    </select>
  );
  return (
    <section>
      <h2>{e.compare}</h2>
      <div className="row">
        {select(a, setA, 0)}
        {select(b, setB, 1)}
        <button type="button" onClick={compare}>
          {e.compareRun}
        </button>
      </div>
      {result && (
        <div className="small">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={result.preview} alt="" className="pixel" style={{ imageRendering: "pixelated", maxWidth: "100%" }} />
          <div>{e.compareResult(pct(result.report.outsideMouth), result.report.changedPixels)}</div>
          <div className={result.compatibility.compatible ? "muted" : "error"}>{result.compatibility.compatible ? e.compatible : e.incompatible}</div>
        </div>
      )}
      {message && <p className="error">{message}</p>}
    </section>
  );
}
