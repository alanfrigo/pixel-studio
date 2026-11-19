"use client";

import Link from "next/link";
import { useState } from "react";
import type { MapObjectPayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { createAsset, errorText, fileOf, flatRevisions, mediaUrl, type Profile, type ScenesCatalog, scenesApi } from "./scenes-client";
import { Message, PlanRunner, PointPicker, RevisionCard } from "./shared";

/**
 * Props independentes (06 §props independentes): descrever e gerar (modelo
 * de imagem com alfa ou cor-chave), revisar transparência, apoio e colisão —
 * o prompt não cria colisão confiável — e colocar em mapas do T1.
 */
export function ObjectsPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const usable = profiles.filter((p) => (p.capabilities.generate_map_object?.length ?? 0) > 0 && !p.unavailable);
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("Baú");
  const [brief, setBrief] = useState("baú de madeira com cantos de ferro, fechado");
  const [projection, setProjection] = useState<"top_down" | "three_quarter" | "side">("top_down");
  const [side, setSide] = useState(64);
  const objects = flatRevisions(catalog.objects);
  const [reviewing, setReviewing] = useState<{ asset: AssetView; revision: RevisionView } | null>(null);
  return (
    <>
      <section>
        <h2>Gerar prop</h2>
        <div className="row">
          <label>
            Perfil
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">{usable[0] ? `${usable[0].name} (padrão)` : "—"}</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Vista
            <select value={projection} onChange={(e) => setProjection(e.target.value as typeof projection)}>
              <option value="top_down">top-down</option>
              <option value="three_quarter">três quartos</option>
              <option value="side">lateral</option>
            </select>
          </label>
          <label>
            Tamanho
            <select value={side} onChange={(e) => setSide(Number(e.target.value))}>
              {[32, 48, 64, 96, 128].map((s) => (
                <option key={s} value={s}>
                  {s}×{s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Descrição
          <input value={brief} onChange={(e) => setBrief(e.target.value)} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label="Prop"
          disabled={!usable.length}
          body={() => ({ operation: "generate_map_object", providerProfileId: profileId || usable[0]?.id, brief, projection, logicalSize: [side, side] })}
          target={async () => (await createAsset(projectId, "object", name)).id}
          onDone={refresh}
        />
        <p className="small muted">
          Depois de aprovado, coloque o prop em quantos mapas quiser no <Link href={`/projects/${projectId}/world?tab=maps`}>editor de mapas do T1</Link>.
        </p>
      </section>
      <section>
        <h2>Props e móveis</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          {objects.map(({ asset, revision }) => {
            const p = revision.payload as MapObjectPayload;
            const img = fileOf(revision, p.fileId);
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={img ? mediaUrl(projectId, img.id) : null} width={Math.min(192, p.logicalSize[0] * 3)} refresh={refresh}>
                <div className="muted">
                  apoio {p.supportPoint.join(",")} · footprint {p.footprintCells.join("×")} · {p.collision.length ? `${p.collision.length} colisão(ões)` : "sem colisão"} {p.shadow ? "· sombra separada" : ""} {p.sourceRoom ? "· da sala (recorte local)" : ""}
                </div>
                <button type="button" className="secondary" onClick={() => setReviewing({ asset, revision })}>
                  Revisar apoio e colisão
                </button>
              </RevisionCard>
            );
          })}
        </div>
      </section>
      {reviewing && <ReviewObject key={reviewing.revision.id} projectId={projectId} revision={reviewing.revision} onDone={() => (setReviewing(null), refresh())} />}
    </>
  );
}

function ReviewObject({ projectId, revision, onDone }: { projectId: string; revision: RevisionView; onDone: () => void }) {
  const p = revision.payload as MapObjectPayload;
  const img = fileOf(revision, p.fileId);
  const [support, setSupport] = useState<[number, number]>(p.supportPoint);
  const [footprint, setFootprint] = useState<[number, number]>(p.footprintCells);
  const [collision, setCollision] = useState(p.collision.map((r) => r.join(",")).join("; "));
  const [occlusion, setOcclusion] = useState(p.occlusionAboveY === null ? "" : String(p.occlusionAboveY));
  const [message, setMessage] = useState<string | null>(null);
  async function save() {
    try {
      const rects = collision
        .split(";")
        .map((s) => s.split(",").map((n) => Number(n.trim())))
        .filter((r) => r.length === 4 && r.every(Number.isFinite));
      await apiFetch(scenesApi(projectId, "/objects/review"), { method: "POST", json: { baseRevisionId: revision.id, supportPoint: support, footprintCells: footprint, collision: rects, occlusionAboveY: occlusion === "" ? null : Number(occlusion) } });
      onDone();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>Revisar prop r{revision.number}</h2>
      <p className="small muted">Clique na imagem para o ponto de apoio (onde o prop pousa no chão).</p>
      {img && <PointPicker src={mediaUrl(projectId, img.id)} size={p.logicalSize} points={[{ at: support, label: "apoio" }]} onPick={setSupport} zoom={6} />}
      <div className="row small">
        apoio {support.join(",")}
        <label>
          footprint
          <input type="number" min={1} value={footprint[0]} style={{ width: 40 }} onChange={(e) => setFootprint([Math.max(1, Number(e.target.value)), footprint[1]])} />×
          <input type="number" min={1} value={footprint[1]} style={{ width: 40 }} onChange={(e) => setFootprint([footprint[0], Math.max(1, Number(e.target.value))])} />
        </label>
        <label>
          colisão (x,y,w,h; …)
          <input value={collision} onChange={(e) => setCollision(e.target.value)} />
        </label>
        <label>
          oclusão acima de y
          <input value={occlusion} onChange={(e) => setOcclusion(e.target.value.replace(/\D/g, ""))} style={{ width: 50 }} />
        </label>
        <button type="button" onClick={save}>
          Publicar revisão
        </button>
      </div>
      <Message text={message} error />
    </section>
  );
}
