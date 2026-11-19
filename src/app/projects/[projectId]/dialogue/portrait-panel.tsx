"use client";

import { useState } from "react";
import type { BasePayload, PortraitPayload } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useMessages } from "@/i18n/client";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { allRevisions, approvedRevisions, type DialogueCatalog, dialogueApi, errorText, fileOf, mediaUrl, parseRect, PIXEL, type Profile, rectText } from "./dialogue-client";
import { PlanRunner, ProfileSelect, RevisionCard, usableProfile } from "./shared";

export async function createAsset(projectId: string, family: "portrait" | "font", kind: string, name: string): Promise<string> {
  const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family, kind, name } });
  return asset.id;
}

/** Retrato ligado à revisão do personagem: gerar, conferir paleta/escala lado a lado e revisar âncora e regiões. */
export function PortraitPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: DialogueCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(dialogueMessages);
  const p = m.portrait;
  const characters = approvedRevisions(catalog.characters);
  const [profileId, setProfileId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [size, setSize] = useState(64);
  const [framing, setFraming] = useState<"bust" | "head">("bust");
  const [brief, setBrief] = useState("");
  const [reviewing, setReviewing] = useState<RevisionView | null>(null);
  const character = characters.find((c) => c.revision.id === characterId) ?? characters[0];
  const profile = usableProfile(profiles, "generate_portrait", profileId);
  return (
    <>
      <section>
        <h2>{p.heading}</h2>
        {!characters.length && <p className="muted">{p.noCharacter}</p>}
        <div className="row">
          <ProfileSelect profiles={profiles} operation="generate_portrait" value={profileId} onChange={setProfileId} />
          <label>
            {p.character}
            <select value={character?.revision.id ?? ""} onChange={(e) => setCharacterId(e.target.value)}>
              {characters.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {asset.name} r{revision.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            {p.size}
            <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {[48, 64, 96].map((s) => (
                <option key={s} value={s}>
                  {s}×{s}
                </option>
              ))}
            </select>
          </label>
          <label>
            {p.framing}
            <select value={framing} onChange={(e) => setFraming(e.target.value as "bust" | "head")}>
              <option value="bust">{p.framings.bust}</option>
              <option value="head">{p.framings.head}</option>
            </select>
          </label>
          {character && <CharacterThumb projectId={projectId} revision={character.revision} />}
        </div>
        <label>
          {p.brief}
          <input value={brief} placeholder={p.briefPlaceholder} onChange={(e) => setBrief(e.target.value)} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label={p.generate}
          disabled={!character || !profile}
          body={() => (character && profile ? { operation: "generate_portrait", providerProfileId: profile, characterRevisionId: character.revision.id, logicalSize: [size, size], framing, brief } : null)}
          target={() => createAsset(projectId, "portrait", "portrait", `${character?.asset.name ?? "?"} · ${p.generate.toLowerCase()}`)}
          onDone={refresh}
        />
      </section>
      <section>
        <h2>{p.candidates}</h2>
        {!catalog.portraits.length && <p className="muted">{m.shared.noRevisions}</p>}
        <div className="row" style={{ alignItems: "flex-start" }}>
          {allRevisions(catalog.portraits).map(({ asset, revision }) => {
            const payload = revision.payload as PortraitPayload;
            const img = fileOf(revision, payload.fileId);
            const compare = fileOf(revision, "compare");
            const tr = revision.technicalReport as { palette?: { nearReferenceRatio: number } | null; scale?: { spriteHeightPx: number; portraitHeightPx: number } | null; regions?: { reviewed: boolean } } | null;
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={img ? mediaUrl(projectId, img.id) : null} width={payload.logicalSize[0] * 3} refresh={refresh}>
                {tr?.palette && <div>{p.palette(Math.round(tr.palette.nearReferenceRatio * 100))}</div>}
                {tr?.scale && <div>{p.scale(tr.scale.spriteHeightPx, tr.scale.portraitHeightPx)}</div>}
                <div className="muted">{tr?.regions?.reviewed ? p.regionsReviewed : p.regionsSuggested}</div>
                {compare && (
                  <details>
                    <summary>{p.sideBySide}</summary>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mediaUrl(projectId, compare.id)} alt={p.sideBySide} className="pixel bg-checker" style={{ ...PIXEL, maxWidth: "100%" }} />
                  </details>
                )}
                <button type="button" className="secondary" onClick={() => setReviewing(revision)}>
                  {p.reviewRegions}
                </button>
              </RevisionCard>
            );
          })}
        </div>
      </section>
      {reviewing && <ReviewRegions key={reviewing.id} projectId={projectId} revision={reviewing} onDone={() => (setReviewing(null), refresh())} />}
    </>
  );
}

function CharacterThumb({ projectId, revision }: { projectId: string; revision: RevisionView }) {
  const base = revision.payload as BasePayload;
  const view = base.views.find((v) => v.direction === "S") ?? base.views[0];
  const file = view ? fileOf(revision, view.fileId) : null;
  if (!file) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={mediaUrl(projectId, file.id)} alt="" className="pixel bg-checker" style={{ ...PIXEL, height: base.logicalSize[1] * 3 }} />;
}

/** Âncora facial (clique) e regiões do rosto e da boca desenhadas sobre o retrato ampliado. */
function ReviewRegions({ projectId, revision, onDone }: { projectId: string; revision: RevisionView; onDone: () => void }) {
  const p = useMessages(dialogueMessages).portrait;
  const payload = revision.payload as PortraitPayload;
  const img = fileOf(revision, payload.fileId);
  const [w, h] = payload.logicalSize;
  const zoom = Math.max(2, Math.floor(384 / Math.max(w, h)));
  const [anchor, setAnchor] = useState<[number, number]>(payload.faceAnchor);
  const [face, setFace] = useState(rectText(payload.faceRect));
  const [mouth, setMouth] = useState(rectText(payload.mouthRect));
  const [message, setMessage] = useState<string | null>(null);
  const faceRect = parseRect(face);
  const mouthRect = parseRect(mouth);
  async function save() {
    try {
      await apiFetch(dialogueApi(projectId, "/portraits/review"), { method: "POST", json: { revisionId: revision.id, faceAnchor: anchor, faceRect, mouthRect } });
      onDone();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const box = (r: [number, number, number, number] | null, color: string) =>
    r && <rect x={r[0] * zoom} y={r[1] * zoom} width={r[2] * zoom} height={r[3] * zoom} fill="none" stroke={color} strokeWidth={2} />;
  return (
    <section>
      <h2>{p.reviewHeading(revision.number)}</h2>
      <p className="small muted">{p.reviewHelp}</p>
      <div style={{ position: "relative", display: "inline-block" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {img && <img src={mediaUrl(projectId, img.id)} alt="" className="pixel bg-checker" style={{ ...PIXEL, width: w * zoom, height: h * zoom, display: "block" }} />}
        <svg
          width={w * zoom}
          height={h * zoom}
          style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor([Math.min(w - 1, Math.floor((e.clientX - r.left) / zoom)), Math.min(h - 1, Math.floor((e.clientY - r.top) / zoom))]);
          }}
        >
          {box(faceRect, "#ffd600")}
          {box(mouthRect, "#ff00c8")}
          <circle cx={(anchor[0] + 0.5) * zoom} cy={(anchor[1] + 0.5) * zoom} r={4} fill="#00e0ff" stroke="#000" />
        </svg>
      </div>
      <div className="row small">
        <span>
          {p.anchor} {anchor.join(",")}
        </span>
        <label>
          {p.faceRect}
          <input value={face} onChange={(e) => setFace(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          {p.mouthRect}
          <input value={mouth} onChange={(e) => setMouth(e.target.value)} style={{ width: 110 }} />
        </label>
        <button type="button" onClick={save} disabled={!faceRect || !mouthRect}>
          {p.publishReview}
        </button>
      </div>
      {message && <p className="error">{message}</p>}
    </section>
  );
}
